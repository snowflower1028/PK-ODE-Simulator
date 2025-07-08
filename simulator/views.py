from django.http import JsonResponse
from django.views.decorators.http import require_POST
from django.views.decorators.csrf import csrf_exempt
from django.shortcuts import render
from django.core.cache import cache
import numpy as np
import pandas as pd
import json
import hashlib
import traceback

# Sympy lambdify를 view에서 직접 사용하기 위해 임포트
from sympy import symbols, lambdify

from .parser import parse_ode_input
from .solver import solve_ode_system
from .analyzer import analyze_pk


@csrf_exempt
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
        t_eval = np.linspace(t_start, t_end, t_steps)

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

        # 6. analyzer.py로 PK 파라미터 계산 (선택된 변수에 대해서만)
        total_dose = sum(dose.get('amount', 0) for dose in data.get('doses', []))
        # PK 분석은 주요 Compartment에 대해서만 수행하는 것이 일반적이므로, all_compartments를 기준으로 필터링
        # pk_analysis_targets = [comp for comp in valid_selected_vars if comp in all_compartments]
        pk_summary = analyze_pk(df_full, valid_selected_vars, total_dose)

        # 7. 응답 데이터 필터링
        # 이제 'C1'과 같은 파생 변수도 결과에 포함될 수 있습니다.
        columns_to_return = ["Time"] + valid_selected_vars
        df_filtered = df_full.reindex(columns=columns_to_return, fill_value=np.nan)
        
        # 8. JSON 응답 반환
        return JsonResponse({
            "status": "ok",
            "data": {
                "profile": df_filtered.to_dict(orient="list"),
                "pk": pk_summary
            }
        })

    except json.JSONDecodeError:
        return JsonResponse({"status": "error", "message": "Invalid JSON format in request body."}, status=400)
    except Exception as e:
        traceback.print_exc()
        return JsonResponse({"status": "error", "message": f"An unexpected error occurred: {str(e)}"}, status=500)

@csrf_exempt
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

@csrf_exempt
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

def index(request):
    return render(request, "simulator/index.html")

