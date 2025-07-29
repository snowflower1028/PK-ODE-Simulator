# fitting.py

import numpy as np
import pandas as pd
from scipy.optimize import least_squares
from sympy import symbols, lambdify
from django.core.cache import cache
import hashlib
import math

# 프로젝트의 다른 모듈 임포트
from .solver import solve_ode_system
from .parser import parse_ode_input


def _residuals(vec, fit_keys, fixed_param, equations_callable, all_parameters, comps, initials, fitting_groups, weighting, derived_expressions):
    """
    여러 '피팅 그룹'을 순회하며 전체 잔차를 계산합니다.
    - fitting_groups: 각 그룹은 'doses', 'observed', 'mappings' 데이터를 포함하는 딕셔너리입니다.
    - weighting: 'none', '1/Y', or '1/Y2'
    - derived_expressions: 파생 변수 표현식 딕셔너리
    """
    # 1. 현재 추정치로 전체 파라미터 딕셔너리 재구성
    fit_param = dict(zip(fit_keys, vec))
    all_param_values = {**fixed_param, **fit_param}

    res_all = []
    # 2. 각 피팅 그룹에 대해 시뮬레이션 수행 및 잔차 계산
    for group in fitting_groups:
        obs_df = pd.DataFrame(group['observed'])
        group_doses = group['doses']
        mappings = group.get('mappings', {}) # 매핑 정보 가져오기

        if "Time" not in obs_df.columns or obs_df["Time"].empty or not mappings:
            continue

        t_start = obs_df["Time"].min()
        t_end = obs_df["Time"].max()
        t_eval = obs_df["Time"].to_numpy()

        # 3. solve_ode_system 호출
        sim_df = solve_ode_system(
            equations_callable=equations_callable,
            compartments=comps,
            parameters=all_parameters,
            init_values=initials,
            param_values=all_param_values,
            t_span=[t_start, t_end],
            t_eval=t_eval,
            doses=group_doses
        )

        # 4. 파생 변수 계산 (시뮬레이션 직후)
        available_vars_for_eval = {**sim_df.to_dict(orient='series'), **all_param_values}
        for new_col, expr_str in derived_expressions.items():
            try:
                sim_df[new_col] = pd.eval(expr_str, local_dict=available_vars_for_eval, engine='python')
            except Exception as e:
                print(f"Warning: Could not evaluate derived expression during fitting: '{new_col} = {expr_str}': {e}")

        # 5. 매핑 정보를 기반으로 잔차 계산
        for data_col, model_var in mappings.items():
            # 관측 데이터 컬럼과 매핑된 모델 변수가 모두 존재하는지 확인
            if data_col not in obs_df.columns or model_var not in sim_df.columns:
                continue
            
            observed_values = obs_df[data_col].to_numpy()
            simulated_values = sim_df[model_var].to_numpy()
            
            valid_indices = ~np.isnan(observed_values)
            if not np.any(valid_indices):
                continue

            raw_residuals = simulated_values[valid_indices] - observed_values[valid_indices]
            
            if weighting == '1/Y':
                weights = 1.0 / np.maximum(np.abs(observed_values[valid_indices]), 1e-9)
                weighted_residuals = raw_residuals * weights
            elif weighting == '1/Y2':
                weights = 1.0 / np.maximum(np.abs(observed_values[valid_indices]**2), 1e-9)
                weighted_residuals = raw_residuals * weights
            else: # 'none'
                weighted_residuals = raw_residuals

            res_all.extend(weighted_residuals)

    if not res_all:
        return np.array([1e6] * len(vec)) 

    return np.asarray(res_all)


def _clean_nan(obj):
    """
    딕셔너리나 리스트 내부의 모든 NaN, inf, -inf 값을 None으로 재귀적으로 변환합니다.
    """
    if isinstance(obj, dict):
        return {k: _clean_nan(v) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [_clean_nan(elem) for elem in obj]
    elif isinstance(obj, float) and (math.isnan(obj) or math.isinf(obj)):
        return None
    return obj


def fit(data: dict) -> dict:
    """
    여러 실험 그룹 데이터를 사용하여 파라미터 피팅을 수행합니다.
    """
    # 1) 캐싱을 사용하여 ODE 파싱 및 lambdify (기존과 동일)
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
        derived_expressions = parsed.get("derived_expressions", {}) # 파생 변수 정보 추출

        comp_syms, param_syms, t_sym = symbols(all_compartments), symbols(all_parameters), symbols('t')
        y_args = tuple(comp_syms) if isinstance(comp_syms, (list, tuple)) else (comp_syms,)
        p_args = tuple(param_syms) if isinstance(param_syms, (list, tuple)) else (param_syms,)
        rhs_exprs = [equations[c] for c in all_compartments]
        
        rhs_callable_lambdified = lambdify((t_sym, y_args, p_args), rhs_exprs, modules='numpy')
        def equations_callable(t, y_array, p_array): return rhs_callable_lambdified(t, y_array, p_array)
    except Exception as e:
        return {"status": "error", "message": f"ODE Parsing/Compilation Error: {e}"}

    # 2) 피팅을 위한 값들 준비 (기존과 동일)
    try:
        initials = data["initials"]
        full_param = data["parameters"]
        fit_keys = data["fit_params"]
        fitting_groups = data.get("fitting_groups", [])
        
        if not fitting_groups:
            return {"status": "error", "message": "No fitting groups provided. Please add at least one experimental group."}

        param_bounds_dict = data.get("bounds", {})
        weighting = data.get("weighting", "none")

        fixed_param = {k: v for k, v in full_param.items() if k not in fit_keys}
        p0 = np.array([full_param[k] for k in fit_keys], dtype=float)
        
        lower_bounds, upper_bounds = np.array([-np.inf] * len(fit_keys)), np.array([np.inf] * len(fit_keys))
        for i, key in enumerate(fit_keys):
            if key in param_bounds_dict:
                lb_raw, ub_raw = param_bounds_dict[key]
                if lb_raw is not None and str(lb_raw).strip() != '': lower_bounds[i] = float(lb_raw)
                if ub_raw is not None and str(ub_raw).strip() != '': upper_bounds[i] = float(ub_raw)
        actual_bounds = (lower_bounds, upper_bounds)
    except (KeyError, ValueError) as e:
        return {"status": "error", "message": f"Error preparing fitting parameters: {e}"}


    # 3) least-squares 피팅 수행
    try:
        result = least_squares(
            _residuals,
            p0,
            kwargs=dict(
                fit_keys=fit_keys,
                fixed_param=fixed_param,
                equations_callable=equations_callable,
                all_parameters=all_parameters,
                comps=all_compartments,
                initials=initials,
                fitting_groups=fitting_groups,
                weighting=weighting,
                derived_expressions=derived_expressions # <-- 파생 변수 정보 전달
            ),
            bounds=actual_bounds,
            verbose=0
        )
    except Exception as e:
         return {"status": "error", "message": f"Optimization algorithm failed: {e}"}


    fitted_params = dict(zip(fit_keys, result.x))

    # 4) 최종 파라미터와 잔차, 자유도, 신뢰 구간 계산
    final_residuals_unweighted = _residuals(result.x, fit_keys, fixed_param, equations_callable, all_parameters, all_compartments, initials, fitting_groups, 'none', derived_expressions)
    ssr_total = np.sum(np.square(final_residuals_unweighted))

    n_params = len(fit_keys)
    standard_errors = [np.nan] * n_params
    conf_intervals = [[np.nan, np.nan]] * n_params

    n_obs = len(final_residuals_unweighted)
    dof = n_obs - n_params

    if dof > 0:
        try:
            from scipy.stats import t
            residual_variance = ssr_total / dof
            J = result.jac
            covariance_matrix = np.linalg.inv(J.T @ J) * residual_variance
            valid_variances = np.maximum(np.diag(covariance_matrix), 0)
            standard_errors = np.sqrt(valid_variances)
            
            alpha = 0.05
            t_val = t.ppf(1.0 - alpha / 2.0, dof)
            
            conf_intervals = []
            for i, param_val in enumerate(result.x):
                se = standard_errors[i]
                lower = param_val - t_val * se
                upper = param_val + t_val * se
                conf_intervals.append([lower, upper])
        except Exception as e:
            print(f"Warning: Could not calculate confidence intervals: {e}")

    # params_with_stats를 if 문 바깥에서 생성하여 UnboundLocalError를 방지합니다.
    params_with_stats = []
    for i, key in enumerate(fit_keys):
        params_with_stats.append({
            "name": key,
            "value": fitted_params[key],
            "stderr": standard_errors[i],
            "ci_lower": conf_intervals[i][0],
            "ci_upper": conf_intervals[i][1]
        })

    final_result = {
        "status": "ok",
        "params": params_with_stats,
        "cost": result.cost,
        "ssr_total": ssr_total,
        "nfev": result.nfev,
        "message": result.message,
        "status_code": result.status,
    }

    # 최종 반환 전에 _clean_nan 함수를 호출하여 모든 NaN/inf 값을 None으로 변환합니다.
    return _clean_nan(final_result)

