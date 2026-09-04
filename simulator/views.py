from django.http import JsonResponse
from django.views.decorators.http import require_POST
from django.views.decorators.csrf import csrf_exempt
from django.shortcuts import render
from django.core.cache import cache
from django.conf import settings
from django.contrib.staticfiles import finders
import numpy as np
import pandas as pd
import json
import hashlib
import os
import traceback

# Sympy lambdify를 view에서 직접 사용하기 위해 임포트
from sympy import symbols, lambdify

from .parser import parse_ode_input
from .solver import solve_ode_system
from .analyzer import analyze_observed, analyze_simulated, compare_observed, observed_times


# ---------------------------------------------------------------------------
# 시뮬레이션 한 번을 돌리는 공통부
# ---------------------------------------------------------------------------
# simulate 와 sweep 이 같은 일을 한다. 스윕은 같은 ODE 를 파라미터만 바꿔
# 여러 번 푸는 것이므로, 파싱은 한 번만 하고 적분만 반복하면 된다.

def _parsed_ode(ode_text: str):
    """파싱 결과를 캐시에서 꺼내거나 만들어 둔다."""
    cache_key = 'parsed_ode_sympy_' + hashlib.md5(ode_text.encode('utf-8')).hexdigest()
    parsed = cache.get(cache_key)
    if parsed is None:
        parsed = parse_ode_input(ode_text)
        cache.set(cache_key, parsed, timeout=3600)
    return parsed


def _rhs_callable(parsed):
    """파싱 결과를 수치 적분이 쓸 수 있는 함수로 만든다.

    lambdify 는 값이 아니라 식에만 의존하므로 스윕 동안 한 번만 만들면 된다.
    """
    compartments = parsed.get("compartments", [])
    parameters = parsed.get("parameters", [])
    equations = parsed.get("equations", {})

    comp_syms = symbols(compartments)
    param_syms = symbols(parameters)
    t_sym = symbols('t')
    y_args = tuple(comp_syms) if isinstance(comp_syms, (list, tuple)) else (comp_syms,)
    p_args = tuple(param_syms) if isinstance(param_syms, (list, tuple)) else (param_syms,)

    lambdified = lambdify((t_sym, y_args, p_args),
                          [equations[c] for c in compartments], modules='numpy')

    def equations_callable(t, y_array, p_array):
        return lambdified(t, y_array, p_array)

    return equations_callable


def _solve_profile(parsed, rhs, init_values, param_values,
                   t_start, t_end, t_steps, doses):
    """한 번 풀고 파생 변수까지 붙인 DataFrame 을 돌려준다."""
    df = solve_ode_system(
        equations_callable=rhs,
        compartments=parsed.get("compartments", []),
        parameters=parsed.get("parameters", []),
        init_values=init_values,
        param_values=param_values,
        t_span=[t_start, t_end],
        t_eval=np.linspace(t_start, t_end, t_steps),
        doses=doses,
    )

    available = {**df.to_dict(orient='series'), **param_values}
    for new_col, expr_str in parsed.get("derived_expressions", {}).items():
        try:
            df[new_col] = pd.eval(expr_str, local_dict=available, engine='python')
            available[new_col] = df[new_col]
        except Exception as e:
            print(f"Warning: could not evaluate '{new_col} = {expr_str}': {e}")
    return df


@require_POST
def sweep(request):
    """모델을 여러 번 다시 풀어 무엇이 곡선을 움직이는지 본다.

    솔버 한 번이 수십 밀리초라 (2-compartment / 500점 기준 42ms) 마흔 번을
    돌아도 2초를 넘지 않는다. 그래서 한 요청에서 전부 계산해 한 번에 돌려준다.

    두 가지를 묻는다.
      scan      한 가지 값을 훑으며 곡선이 어떻게 움직이는지
      tornado   파라미터를 조금씩 흔들어 어느 것이 가장 크게 움직이는지
    """
    try:
        data = json.loads(request.body)
        spec = data.get("sweep") or {}

        ode_text = data.get("equations", "")
        if not ode_text.strip():
            return JsonResponse({"status": "error", "message": "ODE input cannot be empty."}, status=400)

        parsed = _parsed_ode(ode_text)
        if not parsed.get("compartments") or not parsed.get("equations"):
            return JsonResponse({"status": "error", "message": "Failed to parse the ODE system."}, status=400)

        ctx = {
            "parsed": parsed,
            "rhs": _rhs_callable(parsed),
            "derived": parsed.get("derived_expressions", {}),
            "params": dict(data.get("parameters", {})),
            "initials": dict(data.get("initials", {})),
            "doses": list(data.get("doses", [])),
            "t_start": float(data.get("t_start", 0)),
            "t_end": float(data.get("t_end", 48)),
            "t_steps": int(data.get("t_steps", 200)),
        }

        # 그릴 변수 하나만 다룬다. 스윕은 값마다 곡선이 하나씩 늘어나므로
        # 변수까지 여러 개면 화면에서도 응답 크기에서도 감당이 안 된다.
        plottable = list(parsed["compartments"]) + list(ctx["derived"].keys())
        variable = spec.get("variable")
        if variable not in plottable:
            variable = plottable[0] if plottable else None
        ctx["variable"] = variable

        mode = spec.get("mode") or "scan"
        if mode == "tornado":
            return _tornado(ctx, spec)
        if mode == "scan":
            return _scan(ctx, spec)
        return JsonResponse({"status": "error", "message": f"Unknown sweep mode '{mode}'."}, status=400)

    except Exception as e:
        traceback.print_exc()
        return JsonResponse({"status": "error", "message": str(e)}, status=500)


def _run_once(ctx, initials, params, doses):
    """한 번 풀고 그릴 변수의 프로파일과 PK 지표를 함께 돌려준다."""
    df = _solve_profile(ctx["parsed"], ctx["rhs"], initials, params,
                        ctx["t_start"], ctx["t_end"], ctx["t_steps"], doses)
    variable = ctx["variable"]
    if variable not in df.columns:
        return None, {}
    pk = analyze_simulated(
        df, [variable], doses,
        concentration_vars=set(ctx["derived"].keys()),
        derived_expressions=ctx["derived"],
    )
    return df, pk.get(variable, {})


# ---------------------------------------------------------------------------
# scan — 한 가지 값을 훑는다
# ---------------------------------------------------------------------------
def _scan(ctx, spec):
    """훑을 수 있는 대상은 세 가지다.

      parameter   모델 파라미터 (CL, ka, ...)
      initial     구획의 초기값
      dose        등록된 투여 중 하나의 용량

    용량을 훑을 때는 그 값이 NCA 의 dose 로도 그대로 들어간다. 선형 모델이면
    CL 이 용량과 무관하게 일정하게 나오고 포화가 있는 모델이면 용량을 따라
    움직이는데, 그 차이를 보는 것이 용량 스윕의 목적이다.
    """
    parsed = ctx["parsed"]
    target = spec.get("target")
    values = spec.get("values") or []

    if target is None or target == "":
        return JsonResponse({"status": "error", "message": "Nothing chosen to sweep."}, status=400)
    if not values:
        return JsonResponse({"status": "error", "message": "No values to sweep over."}, status=400)
    if len(values) > 40:
        return JsonResponse({"status": "error", "message": "Too many sweep points (max 40)."}, status=400)

    base_params, base_initials, base_doses = ctx["params"], ctx["initials"], ctx["doses"]

    # 대상마다 다른 것은 두 가지뿐이다 — 기준값이 무엇인가, 값 하나를
    # 어디에 꽂아 넣는가. 그 둘만 정하고 나면 아래 루프는 똑같다.
    kind = spec.get("kind") or "parameter"

    if kind == "parameter":
        if target not in parsed.get("parameters", []):
            return JsonResponse(
                {"status": "error", "message": f"'{target}' is not a parameter of this model."}, status=400)
        label = str(target)
        baseline = base_params.get(target)

        def apply(value):
            params = dict(base_params)
            params[target] = value
            return base_initials, params, base_doses

    elif kind == "initial":
        if target not in parsed.get("compartments", []):
            return JsonResponse(
                {"status": "error", "message": f"'{target}' is not a compartment of this model."}, status=400)
        label = f"{target}(0)"
        baseline = base_initials.get(target)

        def apply(value):
            initials = dict(base_initials)
            initials[target] = value
            return initials, base_params, base_doses

    elif kind == "dose":
        try:
            index = int(target)
        except (TypeError, ValueError):
            index = -1
        if not 0 <= index < len(base_doses):
            return JsonResponse(
                {"status": "error", "message": "That dose is no longer registered."}, status=400)
        label = f"{base_doses[index].get('compartment', 'dose')} dose"
        baseline = base_doses[index].get("amount")

        def apply(value):
            doses = [dict(d) for d in base_doses]
            doses[index]["amount"] = value
            return base_initials, base_params, doses

    else:
        return JsonResponse({"status": "error", "message": f"Cannot sweep '{kind}'."}, status=400)

    variable = ctx["variable"]
    runs = []
    for raw in values:
        value = float(raw)
        df, pk = _run_once(ctx, *apply(value))
        if df is None:
            continue
        runs.append({
            "value": value,
            "label": f"{label} = {value:g}",
            "profile": {
                "Time": df["Time"].tolist(),
                variable: df[variable].tolist(),
            },
            "pk": pk,
        })

    # 기준값에 해당하는 지점을 굵게 그리기 위해 알려 준다. 가장 가까운
    # 점이 아니라 실제로 같은 점이어야 한다 — 5~40 을 훑는데 현재값이
    # 0 이면 50 짜리 곡선을 "여기서 출발했다"고 표시해서는 안 된다.
    baseline_index = None
    if baseline is not None and runs:
        try:
            base = float(baseline)
        except (TypeError, ValueError):
            base = None
        if base is not None:
            near = min(range(len(runs)), key=lambda i: abs(runs[i]["value"] - base))
            if abs(runs[near]["value"] - base) <= 1e-4 * max(abs(base), 1e-12):
                baseline_index = near

    return JsonResponse({
        "status": "ok",
        "data": {
            "mode": "scan",
            "kind": kind,
            "target": label,
            "variable": variable,
            "baseline": baseline,
            "baseline_index": baseline_index,
            "runs": runs,
        },
    })


# ---------------------------------------------------------------------------
# tornado — 무엇이 가장 크게 움직이는가
# ---------------------------------------------------------------------------
TORNADO_METRICS = ("c_max", "t_max", "auc_last", "auc_inf_obs", "half_life")


def _tornado(ctx, spec):
    """파라미터를 하나씩 ±delta 만큼 흔들어 지표가 얼마나 움직이는지 잰다.

    지표별로 정규화 민감도 S = (ΔY/Y) / (Δθ/θ) 를 함께 낸다. 중심차분이라
    Δθ/θ 는 2·delta 이고, S 는 무차원이라 단위도 크기도 다른 파라미터끼리
    바로 비교된다. S = 1 이면 파라미터를 1% 올릴 때 지표도 1% 오른다는 뜻이다.

    값이 0 인 파라미터는 제외한다. 배수로 흔드는 방식이라 0 은 흔들리지 않고,
    절대량으로 흔들면 그 크기를 정할 근거가 없다.
    """
    # `or` 로 기본값을 주면 0 을 보냈을 때 말없이 10% 가 되어 버린다.
    raw_delta = spec.get("delta")
    delta = 0.1 if raw_delta is None else float(raw_delta)
    if not 0 < delta < 1:
        return JsonResponse(
            {"status": "error", "message": "The perturbation must be between 0 and 100%."}, status=400)

    names = [n for n in ctx["parsed"].get("parameters", [])
             if isinstance(ctx["params"].get(n), (int, float)) and ctx["params"][n] != 0]
    if not names:
        return JsonResponse(
            {"status": "error", "message": "No non-zero parameters to perturb."}, status=400)
    if len(names) > 20:
        return JsonResponse(
            {"status": "error", "message": "Too many parameters for a tornado (max 20)."}, status=400)

    _, base_pk = _run_once(ctx, ctx["initials"], ctx["params"], ctx["doses"])
    baseline = {k: base_pk.get(k) for k in TORNADO_METRICS}

    def solved(name, factor):
        params = dict(ctx["params"])
        params[name] = ctx["params"][name] * factor
        _, pk = _run_once(ctx, ctx["initials"], params, ctx["doses"])
        return {k: pk.get(k) for k in TORNADO_METRICS}

    items = []
    for name in names:
        low = solved(name, 1.0 - delta)
        high = solved(name, 1.0 + delta)

        sensitivity, swing = {}, {}
        for k in TORNADO_METRICS:
            lo, hi, b = low.get(k), high.get(k), baseline.get(k)
            usable = all(isinstance(v, (int, float)) for v in (lo, hi, b)) and b
            sensitivity[k] = (hi - lo) / (2.0 * delta * b) if usable else None
            # 그림에 쓸 값은 기준 대비 % 변화. 양끝을 따로 두어야 비대칭이 보인다.
            swing[k] = [(lo - b) / b * 100.0, (hi - b) / b * 100.0] if usable else None

        items.append({
            "label": name,
            "base": ctx["params"][name],
            "low_value": ctx["params"][name] * (1.0 - delta),
            "high_value": ctx["params"][name] * (1.0 + delta),
            "low": low,
            "high": high,
            "sensitivity": sensitivity,
            "swing": swing,
        })

    return JsonResponse({
        "status": "ok",
        "data": {
            "mode": "tornado",
            "variable": ctx["variable"],
            "delta": delta,
            # Tmax 는 출력 격자 위에서 읽히므로 분해능이 격자 간격을 넘지
            # 못한다. 흔들린 폭이 이보다 작으면 순위가 아니라 반올림이다.
            "time_step": (ctx["t_end"] - ctx["t_start"]) / max(ctx["t_steps"] - 1, 1),
            "metrics": list(TORNADO_METRICS),
            "baseline": baseline,
            "items": items,
        },
    })


@require_POST
def simulate(request):
    try:
        data = json.loads(request.body)

        # 1. 사용자 입력에서 모든 값 추출
        ode_text = data.get("equations", "")
        if not ode_text.strip():
            return JsonResponse({"status": "error", "message": "ODE input cannot be empty."}, status=400)

        init_values = data.get("initials", {})
        param_values = data.get("parameters", {})
        t_start = float(data.get("t_start", 0))
        t_end = float(data.get("t_end", 48))
        t_steps = int(data.get("t_steps", 200))
        doses = data.get("doses", [])
        observed_datasets = data.get("observed", []) or []

        # 채혈 시각을 격자에 끼워 넣는다. 관측값과 예측값을 견주려면 같은
        # 시각의 값이 필요한데, 가장 가까운 격자점을 집는 방식은 흡수상처럼
        # 곡선이 가파른 구간에서 눈에 띄게 어긋난다. 구간 밖의 시각은 넣지
        # 않는다 — 풀지 않은 곳을 풀 수는 없다.
        t_eval = np.linspace(t_start, t_end, t_steps)
        samples = [t for t in observed_times(observed_datasets) if t_start <= t <= t_end]
        if samples:
            t_eval = np.unique(np.concatenate([t_eval, np.asarray(samples, dtype=float)]))

        # 2. 캐시에서 파싱된 결과(SymPy 객체) 가져오기
        cache_key = 'parsed_ode_sympy_' + hashlib.md5(ode_text.encode('utf-8')).hexdigest()
        parsed = cache.get(cache_key)

        if parsed is None:
            # Cache Miss: 파싱 수행 및 캐시 저장
            print(f"CACHE MISS: Parsing ODEs for key {cache_key}")
            parsed = parse_ode_input(ode_text)
            cache.set(cache_key, parsed, timeout=3600)
        else:
            print(f"CACHE HIT: Using cached SymPy objects for key {cache_key}")

        # 3. 파싱된 결과를 바탕으로 view에서 lambdify 수행
        all_compartments = parsed.get("compartments", [])
        all_parameters = parsed.get("parameters", [])
        equations = parsed.get("equations", {})

        if not all_compartments or not equations:
            return JsonResponse({"status": "error", "message": "Failed to parse compartments or equations from input."}, status=400)

        # lambdify를 위한 심볼 및 표현식 준비
        comp_syms = symbols(all_compartments)
        param_syms = symbols(all_parameters)
        t_sym = symbols('t')
        
        y_args = tuple(comp_syms) if isinstance(comp_syms, (list, tuple)) else (comp_syms,)
        p_args = tuple(param_syms) if isinstance(param_syms, (list, tuple)) else (param_syms,)
        
        rhs_exprs = [equations[c] for c in all_compartments]
        
        # 실제 수치 계산 함수 생성
        rhs_callable_lambdified = lambdify((t_sym, y_args, p_args), rhs_exprs, modules='numpy')
        def equations_callable(t, y_array, p_array):
            return rhs_callable_lambdified(t, y_array, p_array)

        # 4. solver.py를 사용하여 전체 시스템 시뮬레이션 수행
        df_full = solve_ode_system(
            equations_callable=equations_callable,
            compartments=all_compartments,
            parameters=all_parameters,
            init_values=init_values,
            param_values=param_values,
            t_span=[t_start, t_end],
            t_eval=t_eval,
            doses=doses
        )

        # 4-2. 파생 변수(Derived Variable) 계산 로직
        derived_expressions = parsed.get("derived_expressions", {})
        
        # 계산에 필요한 모든 변수와 파라미터를 하나의 사전으로 합칩니다.
        # DataFrame의 컬럼들과 사용자가 입력한 파라미터 값을 모두 포함합니다.
        available_vars = {**df_full.to_dict(orient='series'), **param_values}
        
        # 각 파생 표현식을 순회하며 계산하고, 결과를 DataFrame에 새 컬럼으로 추가합니다.
        for new_col, expr_str in derived_expressions.items():
            try:
                # pandas.eval을 사용하여 안전하고 효율적으로 표현식을 계산합니다.
                df_full[new_col] = pd.eval(expr_str, local_dict=available_vars, engine='python')
            except Exception as e:
                # 계산 중 오류가 발생하면 경고를 출력하고 넘어갑니다.
                print(f"Warning: Could not evaluate derived expression '{new_col} = {expr_str}': {e}")
        
        # 5. 사용자가 선택한 플로팅 변수 목록 가져오기
        all_plottable_vars = all_compartments + list(derived_expressions.keys())
        selected_vars_raw = data.get("compartments", all_plottable_vars)
        
        # df_full에 실제로 존재하는 컬럼(계산에 성공한 변수)만 필터링합니다.
        valid_selected_vars = [var for var in selected_vars_raw if var in df_full.columns]
        if not valid_selected_vars: # 만약 선택된 유효한 변수가 없다면 기본 Compartment만 사용
            valid_selected_vars = all_compartments

        # 6. PK 파라미터 계산
        #
        # 시뮬레이션 곡선과 관찰 데이터를 다른 방식으로 다룬다. 앞은 촘촘한
        # 격자라 곡선을 그대로 적분하면 되고, 뒤는 채혈 시점이 드문드문해
        # 보간과 외삽 규칙(NCA)이 필요하다. 자세한 이유는 analyzer.py 참고.
        #
        # CL·Vz·Vss 는 농도에만 뜻이 있다. 파생 변수(C = A/V 처럼 사용자가
        # 식으로 정의한 것)를 농도로 보고, 상태 변수(구획 내 양)에는 계산하지
        # 않는다. 양을 AUC 로 나눈 값은 청소율이 아니기 때문이다.
        concentration_vars = set(derived_expressions.keys())

        pk_summary = analyze_simulated(
            df_full,
            valid_selected_vars,
            doses,
            concentration_vars=concentration_vars,
            derived_expressions=derived_expressions,
        )

        # 업로드된 관찰 데이터가 함께 오면 같은 표에 나란히 놓는다.
        observed_summary = analyze_observed(
            observed_datasets,
            doses,
            derived_expressions=derived_expressions,
        )
        pk_summary.update(observed_summary)

        # 그리고 같은 시각끼리 견준다 — 요약을 나란히 놓는 것과, 점마다
        # 얼마나 어긋나는지 재는 것은 다른 질문이다.
        comparison = compare_observed(df_full, observed_datasets)

        # 7. 응답 데이터 필터링
        # 이제 'C1'과 같은 파생 변수도 결과에 포함될 수 있습니다.
        columns_to_return = ["Time"] + valid_selected_vars
        df_filtered = df_full.reindex(columns=columns_to_return, fill_value=np.nan)
        
        # 8. JSON 응답 반환
        return JsonResponse({
            "status": "ok",
            "data": {
                "profile": df_filtered.to_dict(orient="list"),
                "pk": pk_summary,
                "comparison": comparison
            }
        })

    except json.JSONDecodeError:
        return JsonResponse({"status": "error", "message": "Invalid JSON format in request body."}, status=400)
    except Exception as e:
        traceback.print_exc()
        return JsonResponse({"status": "error", "message": f"An unexpected error occurred: {str(e)}"}, status=500)

@require_POST
def parse_ode_view(request):
    try:
        data = json.loads(request.body)
        ode_text = data.get("text", "")
        
        # 이 view는 순수하게 파싱 결과만 보여주므로, 캐싱을 적용할 수 있지만 필수는 아님
        # 만약 적용한다면 simulate view와 동일한 캐시 키 사용
        cache_key = 'parsed_ode_sympy_' + hashlib.md5(ode_text.encode('utf-8')).hexdigest()
        parsed = cache.get(cache_key)
        if parsed is None:
            parsed = parse_ode_input(ode_text)
            cache.set(cache_key, parsed, timeout=3600)

        # JSON 응답을 위해 Sympy Expr 객체를 문자열로 변환
        response_data = {k: v for k, v in parsed.items() if k != 'equations'}
        response_data['equations'] = {k: str(v) for k, v in parsed.get('equations', {}).items()}

        return JsonResponse({
            "status": "ok",
            "data": response_data
        })
    except Exception as e:
        traceback.print_exc()
        return JsonResponse({"status": "error", "message": str(e)}, status=500)

@require_POST
def fit(request):
    try:
        data = json.loads(request.body)
        from .fitting import fit as run_fit
        res = run_fit(data)
        
        if res.get("status") == "error":
             return JsonResponse(res, status=400)
        return JsonResponse({"status": "ok", "data": res})
    except Exception as e:
        traceback.print_exc()
        return JsonResponse({"status": "error", "message": str(e)}, status=500)

# 개발 중에만 쓰는 정적 파일 버전 문자열.
_ASSET_FILES = (
    "simulator/css/style.css",
    "simulator/js/script.js",
    "simulator/js/menubar.js",
    "simulator/js/sensitivity.js",
)


def _asset_version() -> str:
    """CSS/JS 링크 뒤에 붙일 ?v=... 쿼리를 만든다.

    개발 서버는 정적 파일을 원본 그대로 내보내므로 브라우저가 이전 버전을
    계속 재사용해, 고쳐도 화면에 반영되지 않는 일이 잦다. 파일의 최종 수정
    시각을 쿼리로 붙여 그 문제를 없앤다.

    운영에서는 whitenoise 의 ManifestStaticFilesStorage 가 파일명 자체에
    해시를 넣으므로 필요 없다. 그래서 DEBUG 일 때만 붙인다.
    """
    if not settings.DEBUG:
        return ""

    newest = 0.0
    for rel_path in _ASSET_FILES:
        found = finders.find(rel_path)
        if found:
            try:
                newest = max(newest, os.path.getmtime(found))
            except OSError:
                pass
    return f"?v={int(newest)}" if newest else ""


def index(request):
    return render(request, "simulator/index.html", {"asset_v": _asset_version()})


# ---------------------------------------------------------------------------
# NCA 계산기
# ---------------------------------------------------------------------------
def nca_page(request):
    return render(request, "simulator/nca.html", {"asset_v": _asset_version()})


def _blq_policy(spec):
    """요청에 실려 온 BLQ 규칙. 이름이 틀리면 거절한다 — 조용히 기본값으로
    돌아가면 사용자는 자기가 고른 규칙으로 계산됐다고 믿는다."""
    from .nca import BLQPolicy

    spec = spec or {}
    return BLQPolicy(
        before=spec.get("before", "zero"),
        between=spec.get("between", "missing"),
        after=spec.get("after", "zero"),
    ).validated()


def _terminal_line(result, profile, method):
    """플롯에 그릴 회귀선 두 점. 값이 없으면 None."""
    if result.lambda_z is None or result.lambda_z_intercept is None:
        return None
    t0 = result.lambda_z_t_first
    t1 = result.lambda_z_t_last
    if t0 is None or t1 is None:
        return None
    import math

    def at(t):
        return math.exp(result.lambda_z_intercept - result.lambda_z * t)

    return {"t": [t0, t1], "c": [at(t0), at(t1)]}


@require_POST
def nca_run(request):
    """올라온 프로파일을 한꺼번에 계산한다.

    화면은 하나씩 보여 주지만 계산은 전부 해 둔다. 프로파일을 바꿔 볼 때마다
    왕복하면 느리고, 내보내기는 어차피 전부 필요하다.
    """
    from .nca import AUCMethod, Administration, nca as run_nca

    try:
        data = json.loads(request.body)
        profiles = data.get("profiles") or []
        if not profiles:
            return JsonResponse(
                {"status": "error", "message": "No profiles were sent."}, status=400
            )

        method = AUCMethod(data.get("method") or AUCMethod.LINEAR_LOG.value)
        administration = Administration(data.get("route") or Administration.EXTRAVASCULAR.value)
        dose = data.get("dose")
        dose = float(dose) if dose not in (None, "") else None
        infusion = float(data.get("infusion_duration") or 0.0)
        min_points = int(data.get("min_lambda_z_points") or 3)
        loq = data.get("loq")
        loq = float(loq) if loq not in (None, "") else None
        policy = _blq_policy(data.get("blq"))
        partial_times = [float(x) for x in (data.get("partial_times") or [])]
        #: 프로파일 이름 -> 사람이 고른 말기 구간의 시각들
        chosen = data.get("lambda_z_times") or {}

        rows = []
        for profile in profiles:
            name = str(profile.get("id") or "profile")
            times = profile.get("time") or []
            concs = profile.get("conc") or []
            picked = chosen.get(name)

            # 어느 점이 정량한계 아래인지는 브라우저가 정한다. CSV 에 "BLQ"
            # 처럼 글자로 적힌 것까지 봐야 하는데, 그 글자는 숫자 배열로
            # 바뀌면서 사라지기 때문이다. 마스크가 오면 loq 는 쓰지 않는다.
            mask = profile.get("blq")

            result = run_nca(
                times, concs,
                dose=dose,
                method=method,
                administration=administration,
                infusion_duration=infusion,
                min_lambda_z_points=min_points,
                partial_times=partial_times,
                blq=mask,
                loq=None if mask is not None else loq,
                blq_policy=policy,
                lambda_z_times=picked,
            )
            rows.append({
                "id": name,
                "values": result.as_dict(),
                "terminal_line": _terminal_line(result, profile, method),
            })

        return JsonResponse({"status": "ok", "profiles": rows})

    except ValueError as exc:
        # 알 수 없는 단위·규칙·투여방식은 사용자가 고칠 수 있는 잘못이다.
        return JsonResponse({"status": "error", "message": str(exc)}, status=400)
    except Exception as exc:
        traceback.print_exc()
        return JsonResponse({"status": "error", "message": str(exc)}, status=500)


@require_POST
def nca_units(request):
    """지금 입력 단위에서 각 항목을 어떤 단위로 보여 줄 수 있는지.

    환산 자체는 브라우저에서 곱셈 한 번이면 끝나지만, 어떤 선택지가 실제로
    닿을 수 있는지는 분자량까지 걸린 문제라 여기서 판단한다.
    """
    from . import units as U

    try:
        data = json.loads(request.body)
        conc = U.parse_unit(data.get("conc") or "ng/mL")
        time = U.parse_unit(data.get("time") or "h")
        dose = U.parse_unit(data.get("dose") or "mg")
        mw = data.get("mw")
        mw = float(mw) if mw not in (None, "") else None

        out = {}
        for field in U.FIELD_UNITS:
            native = U.field_unit(field, conc, time, dose)
            if native is None:
                continue
            choices = U.display_options(field, native, mw)
            out[field] = {
                "native": native.label,
                "choices": [
                    {"label": c, "factor": U.scale_factor(native, U.parse_unit(c), mw)}
                    for c in choices
                ],
            }
        return JsonResponse({"status": "ok", "units": out})

    except U.UnitError as exc:
        return JsonResponse({"status": "error", "message": str(exc)}, status=400)
    except Exception as exc:
        traceback.print_exc()
        return JsonResponse({"status": "error", "message": str(exc)}, status=500)

