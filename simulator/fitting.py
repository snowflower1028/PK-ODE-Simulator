# simulator/fitting.py

import numpy as np
import pandas as pd
from scipy.optimize import minimize
from scipy import stats
from sympy import symbols, lambdify
from django.core.cache import cache
import hashlib
import math

from .solver import solve_ode_system
from .parser import parse_ode_input


def _unpack_x(x, fit_keys, param_scopes, error_model, n_groups):
    """
    최적화 변수 벡터 x를 (그룹별 파라미터 맵, sigma_add, sigma_prop)으로 분해한다.
    x 구조: [Model Params..., Error Params...]
      - shared 파라미터는 1개 (모든 그룹이 같은 값을 쓴다)
      - per_group 파라미터는 그룹 수만큼

    "shared / per_group" 이라고 부른다. 최적화에서 global/local 은 전역해를
    찾느냐 근처 극값에 머무느냐를 뜻하므로, 값을 그룹끼리 공유하느냐와는
    다른 이야기다.
    """
    param_map = {}
    cursor = 0
    for key in fit_keys:
        scope = param_scopes.get(key, 'shared')
        if scope == 'shared':
            param_map[key] = [x[cursor]] * n_groups
            cursor += 1
        else:
            param_map[key] = list(x[cursor:cursor + n_groups])
            cursor += n_groups

    sigma_add = 0.0
    sigma_prop = 0.0
    if error_model == 'constant':
        sigma_add = x[cursor]
    elif error_model == 'proportional':
        sigma_prop = x[cursor]
    elif error_model == 'combined':
        sigma_add = x[cursor]
        sigma_prop = x[cursor + 1]

    return param_map, sigma_add, sigma_prop


def _predict_pairs(x, fit_keys, fixed_param, equations_callable, all_parameters,
                   comps, initials, fitting_groups, param_scopes, error_model,
                   derived_expressions):
    """
    현재 파라미터 벡터로 각 그룹을 시뮬레이션하고 (관측값, 예측값) 쌍의 리스트를 돌려준다.
    NLL 계산과 SSR/진단 계산이 같은 경로를 쓰도록 분리해 둔 함수.
    """
    n_groups = len(fitting_groups)
    param_map, _, _ = _unpack_x(x, fit_keys, param_scopes, error_model, n_groups)

    pairs = []
    for g_idx, group in enumerate(fitting_groups):
        current_param_values = fixed_param.copy()
        for key in fit_keys:
            current_param_values[key] = param_map[key][g_idx]

        obs_df = pd.DataFrame(group['observed'])
        if "Time" not in obs_df.columns or obs_df["Time"].empty:
            continue

        t_eval = obs_df["Time"].to_numpy(dtype=float)

        # 시뮬레이션 시작 시각은 "첫 관측시각"이 아니라 "첫 투여시각"이어야 한다.
        # 첫 관측이 t=0.5h이고 투여가 t=0이면, t_span=[0.5, ...]으로는 투여 이벤트가
        # 구간 밖이라 적용되지 않아 예측값이 전부 0이 되고 피팅이 전혀 진행되지 않는다.
        dose_times = []
        for dose_item in (group.get('doses') or []):
            try:
                dose_times.append(float(dose_item.get("start_time", 0) or 0))
            except (TypeError, ValueError):
                continue
        t_begin = min([float(t_eval.min())] + dose_times)

        sim_df = solve_ode_system(
            equations_callable=equations_callable,
            compartments=comps,
            parameters=all_parameters,
            init_values=initials,
            param_values=current_param_values,
            t_span=[t_begin, float(t_eval.max())],
            t_eval=t_eval,
            doses=group['doses']
        )

        # 파생 변수(예: C2 = A2/V) 계산
        available_vars = {**sim_df.to_dict(orient='series'), **current_param_values}
        for new_col, expr_str in derived_expressions.items():
            try:
                sim_df[new_col] = pd.eval(expr_str, local_dict=available_vars, engine='python')
            except Exception:
                pass

        mappings = group.get('mappings', {})
        for data_col, model_var in mappings.items():
            if data_col not in obs_df.columns or model_var not in sim_df.columns:
                continue

            y_obs = obs_df[data_col].to_numpy(dtype=float)
            y_pred = sim_df[model_var].to_numpy(dtype=float)

            n = min(len(y_obs), len(y_pred))
            y_obs, y_pred = y_obs[:n], y_pred[:n]

            mask = ~np.isnan(y_obs) & ~np.isnan(y_pred)
            y_obs, y_pred = y_obs[mask], y_pred[mask]
            if len(y_obs) == 0:
                continue

            pairs.append((y_obs, y_pred))

    return pairs


def _fitted_curves(x, fit_keys, fixed_param, equations_callable, all_parameters,
                   comps, initials, fitting_groups, param_scopes, error_model,
                   derived_expressions, n_points=240):
    """최적해에서 그룹별 곡선을 촘촘히 뽑는다.

    _predict_pairs 는 관측 시각에서만 풀기 때문에 그릴 곡선이 없다 — 점 열세
    개를 이으면 곡선이 아니라 꺾은선이다. 최적화가 끝난 뒤 그룹당 한 번만
    더 적분한다 (수십 밀리초).

    적합값을 사이드바에 써 넣지 않기로 했으므로, 적합된 곡선을 볼 수 있는
    길은 이것뿐이다.
    """
    n_groups = len(fitting_groups)
    param_map, _, _ = _unpack_x(x, fit_keys, param_scopes, error_model, n_groups)

    def clean(values):
        return [None if v is None or not np.isfinite(v) else float(v) for v in values]

    curves = []
    for g_idx, group in enumerate(fitting_groups):
        current_param_values = fixed_param.copy()
        for key in fit_keys:
            current_param_values[key] = param_map[key][g_idx]

        obs_df = pd.DataFrame(group['observed'])
        if "Time" not in obs_df.columns or obs_df["Time"].empty:
            continue
        obs_times = obs_df["Time"].to_numpy(dtype=float)

        dose_times = []
        for dose_item in (group.get('doses') or []):
            try:
                dose_times.append(float(dose_item.get("start_time", 0) or 0))
            except (TypeError, ValueError):
                continue
        t_begin = min([float(obs_times.min())] + dose_times)
        t_end = float(obs_times.max())
        if not t_end > t_begin:
            continue

        t_eval = np.linspace(t_begin, t_end, n_points)
        try:
            sim_df = solve_ode_system(
                equations_callable=equations_callable,
                compartments=comps,
                parameters=all_parameters,
                init_values=initials,
                param_values=current_param_values,
                t_span=[t_begin, t_end],
                t_eval=t_eval,
                doses=group['doses'],
            )
        except Exception:
            continue

        available_vars = {**sim_df.to_dict(orient='series'), **current_param_values}
        for new_col, expr_str in derived_expressions.items():
            try:
                sim_df[new_col] = pd.eval(expr_str, local_dict=available_vars, engine='python')
            except Exception:
                pass

        for data_col, model_var in (group.get('mappings') or {}).items():
            if data_col not in obs_df.columns or model_var not in sim_df.columns:
                continue
            curves.append({
                "group": g_idx + 1,
                "variable": model_var,
                "column": data_col,
                "time": clean(t_eval),
                "fitted": clean(sim_df[model_var].to_numpy(dtype=float)),
                "observed_time": clean(obs_times),
                "observed": clean(obs_df[data_col].to_numpy(dtype=float)),
            })

    return curves


def _neg_log_likelihood(x, fit_keys, fixed_param, equations_callable, all_parameters,
                        comps, initials, fitting_groups, param_scopes, error_model,
                        derived_expressions):
    """
    Negative Log-Likelihood (minimize 대상).
    """
    n_groups = len(fitting_groups)
    _, sigma_add, sigma_prop = _unpack_x(x, fit_keys, param_scopes, error_model, n_groups)

    try:
        pairs = _predict_pairs(x, fit_keys, fixed_param, equations_callable, all_parameters,
                               comps, initials, fitting_groups, param_scopes, error_model,
                               derived_expressions)
    except Exception:
        # 적분 실패 등은 매우 나쁜 해로 취급해 optimizer가 피해가도록 한다.
        return 1e12

    total_nll = 0.0
    for y_obs, y_pred in pairs:
        if error_model == 'constant':
            sigma_i = np.full_like(y_pred, max(sigma_add, 1e-9))
        elif error_model == 'proportional':
            sigma_i = np.abs(y_pred * sigma_prop) + 1e-9
        elif error_model == 'combined':
            sigma_i = np.sqrt(sigma_add ** 2 + (y_pred * sigma_prop) ** 2) + 1e-9
        else:
            sigma_i = np.ones_like(y_pred)

        res = y_obs - y_pred
        nll_term = np.log(sigma_i ** 2) + (res / sigma_i) ** 2
        total_nll += 0.5 * float(np.sum(nll_term))

    if not np.isfinite(total_nll):
        return 1e12
    return total_nll


def _weights(y_obs, weighting):
    """관측값에서 가중치를 만든다.

    가중치는 **관측값** 으로 정한다. MLE 쪽이 예측값 ŷ 로 sigma 를 만드는 것과
    반대인데, 이것이 1/Y 라는 이름이 뜻하는 바이기도 하고, 반복 중에 가중치가
    따라 움직이지 않아 목적함수가 고정된 가중최소제곱으로 잘 정의되기 때문이다.

    농도 0 은 나눌 수 없으므로 그 점은 가중치 0 으로 빼 버린다 — 임의의 작은
    수로 바닥을 깔면 그 한 점이 목적함수를 통째로 지배한다.
    """
    y = np.abs(np.asarray(y_obs, dtype=float))
    if weighting == '1/Y':
        power = 1.0
    elif weighting == '1/Y2':
        power = 2.0
    else:
        return np.ones_like(y)

    w = np.zeros_like(y)
    usable = y > 0
    w[usable] = 1.0 / y[usable] ** power
    return w


def _weighted_ssr(x, fit_keys, fixed_param, equations_callable, all_parameters,
                  comps, initials, fitting_groups, param_scopes, weighting,
                  derived_expressions):
    """가중 잔차제곱합 (minimize 대상).

    sum(w_i * (y_i - yhat_i)^2). MLE 와 달리 추정할 sigma 가 없으므로 x 는
    모델 파라미터만 담는다.
    """
    try:
        pairs = _predict_pairs(x, fit_keys, fixed_param, equations_callable, all_parameters,
                               comps, initials, fitting_groups, param_scopes, None,
                               derived_expressions)
    except Exception:
        # 적분 실패 등은 매우 나쁜 해로 취급해 optimizer가 피해가도록 한다.
        return 1e12

    total = 0.0
    for y_obs, y_pred in pairs:
        w = _weights(y_obs, weighting)
        total += float(np.sum(w * (y_obs - y_pred) ** 2))

    if not np.isfinite(total):
        return 1e12
    return total


def _numeric_hessian(func, x, args):
    """
    최적해에서 NLL의 수치 Hessian(관측 Fisher 정보행렬)을 중심차분으로 계산한다.
    """
    x = np.asarray(x, dtype=float)
    n = len(x)
    # 스텝은 파라미터 크기에 비례하게. 양수 파라미터가 0 이하로 내려가지 않도록 제한.
    h = np.maximum(np.abs(x) * 1e-4, 1e-7)
    for i in range(n):
        if x[i] > 0:
            h[i] = min(h[i], 0.4 * x[i])

    f0 = func(x, *args)
    H = np.zeros((n, n))

    for i in range(n):
        xp, xm = x.copy(), x.copy()
        xp[i] += h[i]
        xm[i] -= h[i]
        H[i, i] = (func(xp, *args) - 2.0 * f0 + func(xm, *args)) / (h[i] ** 2)

    for i in range(n):
        for j in range(i + 1, n):
            xpp, xpm, xmp, xmm = x.copy(), x.copy(), x.copy(), x.copy()
            xpp[i] += h[i]; xpp[j] += h[j]
            xpm[i] += h[i]; xpm[j] -= h[j]
            xmp[i] -= h[i]; xmp[j] += h[j]
            xmm[i] -= h[i]; xmm[j] -= h[j]
            val = (func(xpp, *args) - func(xpm, *args) - func(xmp, *args) + func(xmm, *args)) \
                / (4.0 * h[i] * h[j])
            H[i, j] = H[j, i] = val

    return H


def _standard_errors(func, x, args, dof, scale=1.0):
    """
    Hessian 역행렬(공분산)에서 표준오차와 95% 신뢰구간을 계산한다.
    계산이 불가능하면 None으로 채운 리스트를 돌려준다.

    scale 은 Hessian 을 공분산으로 바꿀 때 곱하는 상수다. NLL 의 Hessian 은
    그 자체가 관측 Fisher 정보행렬이라 1 이지만, 가중잔차제곱합 f = sum(w r^2)
    는 H ~ 2 J'WJ 이고 공분산이 s^2 (J'WJ)^-1 이므로 2 s^2 이 된다.
    """
    n = len(x)
    blank = [(None, None, None)] * n
    try:
        H = _numeric_hessian(func, x, args)
        if not np.all(np.isfinite(H)):
            return blank
        cov = np.linalg.inv(H) * scale
        var = np.diag(cov)
        tcrit = float(stats.t.ppf(0.975, dof)) if dof and dof > 0 else 1.96

        out = []
        for i in range(n):
            v = var[i]
            if not np.isfinite(v) or v <= 0:
                out.append((None, None, None))
                continue
            se = float(np.sqrt(v))
            out.append((se, float(x[i] - tcrit * se), float(x[i] + tcrit * se)))
        return out
    except Exception:
        return blank


def fit(data: dict) -> dict:
    # --- 1. ODE 파싱 및 lambdify ---
    try:
        ode_text = data["equations"]
        cache_key = 'parsed_ode_sympy_' + hashlib.md5(ode_text.encode('utf-8')).hexdigest()
        parsed = cache.get(cache_key)
        if parsed is None:
            parsed = parse_ode_input(ode_text)
            cache.set(cache_key, parsed, timeout=3600)

        all_compartments = parsed["compartments"]
        all_parameters = parsed["parameters"]
        equations = parsed["equations"]
        derived_expressions = parsed.get("derived_expressions", {})

        comp_syms, param_syms, t_sym = symbols(all_compartments), symbols(all_parameters), symbols('t')
        y_args = tuple(comp_syms) if isinstance(comp_syms, (list, tuple)) else (comp_syms,)
        p_args = tuple(param_syms) if isinstance(param_syms, (list, tuple)) else (param_syms,)
        rhs_exprs = [equations[c] for c in all_compartments]

        rhs_callable_lambdified = lambdify((t_sym, y_args, p_args), rhs_exprs, modules='numpy')

        def equations_callable(t, y_array, p_array):
            return rhs_callable_lambdified(t, y_array, p_array)
    except Exception as e:
        return {"status": "error", "message": f"ODE Parsing/Compilation Error: {e}"}

    # --- 2. 데이터 언패킹 ---
    try:
        initials = data["initials"]
        full_param = data["parameters"]
        fit_keys = data["fit_params"]
    except KeyError as e:
        return {"status": "error", "message": f"Missing required field: {e}"}

    fitting_groups = data.get("fitting_groups", [])
    param_scopes = data.get("param_scopes", {})

    # 목적함수는 둘 중 하나다. 최대가능도는 sigma 를 함께 추정해 가중치를
    # 스스로 정하고, 가중최소제곱은 관측값에서 가중치를 미리 정한다. 둘을
    # 겹쳐 쓰면 가중이 이중으로 걸리므로 배타적으로 고른다.
    objective = data.get("objective", "mle")
    if objective not in ("mle", "wls"):
        return {"status": "error", "message": f"Unknown objective '{objective}'."}

    # 모르는 scope 를 그냥 두면 else 가지로 떨어져 말없이 그룹별 추정이 된다.
    # 파라미터 개수가 통째로 달라지는 일이라 조용히 넘어가서는 안 된다.
    unknown = sorted({v for v in param_scopes.values()} - {"shared", "per_group"})
    if unknown:
        return {"status": "error",
                "message": f"Unknown parameter scope {unknown[0]!r} — expected 'shared' or 'per_group'."}

    error_model = data.get("error_model", "constant") if objective == "mle" else None
    weighting = data.get("weighting", "none") if objective == "wls" else None
    if objective == "mle" and error_model not in ("constant", "proportional", "combined"):
        return {"status": "error", "message": f"Unknown error model '{error_model}'."}
    if objective == "wls" and weighting not in ("none", "1/Y", "1/Y2"):
        return {"status": "error", "message": f"Unknown weighting '{weighting}'."}

    if not fit_keys:
        return {"status": "error", "message": "No parameters selected to fit."}
    if not fitting_groups:
        return {"status": "error", "message": "No fitting groups provided. Please add at least one experimental group."}

    n_groups = len(fitting_groups)
    fixed_param = {k: v for k, v in full_param.items() if k not in fit_keys}

    def _to_float(v, default):
        if v is None or str(v).strip() == '':
            return default
        try:
            return float(v)
        except (TypeError, ValueError):
            return default

    # --- 3. x0 / bounds 구성 ---
    x0, bounds, labels = [], [], []

    for key in fit_keys:
        try:
            val = float(full_param[key])
        except (KeyError, TypeError, ValueError):
            return {"status": "error", "message": f"Missing or invalid initial value for parameter '{key}'."}

        scope = param_scopes.get(key, 'shared')
        user_bounds = data.get("bounds", {}).get(key) or [None, None]
        lb = _to_float(user_bounds[0] if len(user_bounds) > 0 else None, -np.inf)
        ub = _to_float(user_bounds[1] if len(user_bounds) > 1 else None, np.inf)

        if scope == 'shared':
            x0.append(val); bounds.append((lb, ub)); labels.append((key, 'shared', None))
        else:
            for g_i in range(n_groups):
                x0.append(val); bounds.append((lb, ub)); labels.append((key, 'per_group', g_i))

    if error_model == 'constant':
        x0.append(0.1); bounds.append((1e-6, np.inf)); labels.append(("Sigma (Additive)", 'error', None))
    elif error_model == 'proportional':
        x0.append(0.1); bounds.append((1e-6, np.inf)); labels.append(("Sigma (Proportional)", 'error', None))
    elif error_model == 'combined':
        x0.append(0.1); bounds.append((1e-6, np.inf)); labels.append(("Sigma (Additive)", 'error', None))
        x0.append(0.1); bounds.append((1e-6, np.inf)); labels.append(("Sigma (Proportional)", 'error', None))

    # 두 목적함수는 인자 수가 같아서 Hessian 계산 경로를 공유한다.
    # 아홉 번째 자리만 다르다 — MLE 는 error_model, WLS 는 weighting.
    obj_func = _neg_log_likelihood if objective == "mle" else _weighted_ssr
    obj_args = (fit_keys, fixed_param, equations_callable, all_parameters, all_compartments,
                initials, fitting_groups, param_scopes,
                error_model if objective == "mle" else weighting, derived_expressions)
    nll_args = (fit_keys, fixed_param, equations_callable, all_parameters, all_compartments,
                initials, fitting_groups, param_scopes, error_model, derived_expressions)

    # --- 4. 최적화 ---
    try:
        result = minimize(
            obj_func,
            np.array(x0, dtype=float),
            args=obj_args,
            method='L-BFGS-B',
            bounds=bounds,
            options={'maxiter': 500}
        )
    except Exception as e:
        return {"status": "error", "message": f"Optimization failed: {e}"}

    x_hat = np.asarray(result.x, dtype=float)

    # --- 5. 적합도 지표 (SSR, RMSE, AIC/BIC) ---
    try:
        pairs = _predict_pairs(x_hat, *nll_args)
        residuals = np.concatenate([y_obs - y_pred for y_obs, y_pred in pairs]) if pairs else np.array([])
    except Exception:
        pairs = []
        residuals = np.array([])

    n_obs = int(residuals.size)
    ssr_total = float(np.sum(residuals ** 2)) if n_obs else None
    rmse = float(np.sqrt(ssr_total / n_obs)) if n_obs else None
    n_est = len(x_hat)
    dof = max(n_obs - n_est, 0)

    if objective == "mle":
        nll = float(result.fun)
        # NLL은 상수항 0.5*n*log(2*pi)를 생략한 값이므로 AIC/BIC 계산 시 더해준다.
        full_nll = nll + 0.5 * n_obs * math.log(2.0 * math.pi) if n_obs else nll
        aic = 2.0 * n_est + 2.0 * full_nll
        bic = (n_est * math.log(n_obs) + 2.0 * full_nll) if n_obs > 0 else None
        se_scale = 1.0
    else:
        # 가중최소제곱에는 가능도가 없다. AIC/BIC 를 우도 기반으로 지어내지 않고
        # 비워서 내보낸다. 대신 가중잔차분산 s^2 이 공분산의 배율이 된다.
        nll = aic = bic = None
        wssr = float(result.fun)
        se_scale = (2.0 * wssr / dof) if dof > 0 else None

    # --- 6. 표준오차 / 신뢰구간 ---
    se_ci = (_standard_errors(obj_func, x_hat, obj_args, dof, scale=se_scale)
             if se_scale else [(None, None, None)] * n_est)

    # --- 7. 결과 정리 ---
    params_summary = []
    for i, (base_name, scope, g_idx) in enumerate(labels):
        if scope == 'shared':
            display = f"{base_name} (Shared)"
        elif scope == 'per_group':
            display = f"{base_name} (Group {g_idx + 1})"
        else:
            display = base_name

        se, ci_lo, ci_hi = se_ci[i] if i < len(se_ci) else (None, None, None)
        value = float(x_hat[i])
        cv_pct = float(abs(se / value) * 100.0) if (se is not None and value != 0) else None

        params_summary.append({
            "name": display,
            "base_name": base_name,
            "scope": scope,
            "group": (g_idx + 1) if g_idx is not None else None,
            "value": value,
            "stderr": se,
            "cv_pct": cv_pct,
            "ci_lower": ci_lo,
            "ci_upper": ci_hi,
        })

    try:
        curves = _fitted_curves(x_hat, *nll_args)
    except Exception:
        curves = []

    return {
        "status": "ok",
        "params": params_summary,
        "curves": curves,
        "ssr_total": ssr_total,
        "rmse": rmse,
        "nll": nll,
        "aic": aic,
        "bic": bic,
        "n_obs": n_obs,
        "dof": dof,
        "objective": objective,
        "error_model": error_model,
        "weighting": weighting,
        "converged": bool(result.success),
        "message": result.message if isinstance(result.message, str) else str(result.message),
        "nfev": int(result.nfev),
    }
