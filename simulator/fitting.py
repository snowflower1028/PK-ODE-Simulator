import numpy as np
import pandas as pd
from scipy.optimize import least_squares
from sympy import symbols, lambdify
from django.core.cache import cache
import hashlib

# 프로젝트의 다른 모듈 임포트
from .solver import solve_ode_system
from .parser import parse_ode_input


def _residuals(vec, fit_keys, fixed_param, equations_callable, all_parameters, comps, initials, fitting_groups, weighting):
    """
    여러 '피팅 그룹'을 순회하며 전체 잔차를 계산합니다.
    - fitting_groups: 각 그룹은 'doses'와 'observed' 데이터를 포함하는 딕셔너리입니다.
    - weighting: 'none', '1/Y', or '1/Y2'
    """
    # 1. 현재 추정치로 전체 파라미터 딕셔너리 재구성
    fit_param = dict(zip(fit_keys, vec))
    all_param_values = {**fixed_param, **fit_param}

    res_all = []
    # 2. 각 피팅 그룹에 대해 시뮬레이션 수행 및 잔차 계산
    for group in fitting_groups:
        obs_df = pd.DataFrame(group['observed'])
        group_doses = group['doses']

        if "Time" not in obs_df.columns or obs_df["Time"].empty:
            continue

        # 각 그룹의 관찰 데이터 시간 범위에 맞춰 시뮬레이션 수행
        t_start = obs_df["Time"].min()
        t_end = obs_df["Time"].max()
        t_eval = obs_df["Time"].to_numpy()

        # 3. solve_ode_system 호출 (그룹별 Dose 사용)
        sim_df = solve_ode_system(
            equations_callable=equations_callable,
            compartments=comps,
            parameters=all_parameters,
            init_values=initials,
            param_values=all_param_values,
            t_span=[t_start, t_end],
            t_eval=t_eval,
            doses=group_doses # <-- 그룹별 Dosing 정보 전달
        )

        # 4. 각 관찰 컬럼에 대한 잔차 계산 및 가중치 적용
        for col in obs_df.columns:
            if col.lower() == "time" or col not in sim_df.columns:
                continue
            
            observed_values = obs_df[col].to_numpy()
            simulated_values = sim_df[col].to_numpy()
            
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
        # 잔차 계산이 불가능한 경우, 최적화가 진행되지 않도록 큰 값 반환
        return np.array([1e6] * len(vec)) 

    return np.asarray(res_all)


def fit(data: dict) -> dict:
    """
    여러 실험 그룹 데이터를 사용하여 파라미터 피팅을 수행합니다.
    """
    # 1) 캐싱을 사용하여 ODE 파싱 및 lambdify
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

        comp_syms, param_syms, t_sym = symbols(all_compartments), symbols(all_parameters), symbols('t')
        y_args = tuple(comp_syms) if isinstance(comp_syms, (list, tuple)) else (comp_syms,)
        p_args = tuple(param_syms) if isinstance(param_syms, (list, tuple)) else (param_syms,)
        rhs_exprs = [equations[c] for c in all_compartments]
        
        rhs_callable_lambdified = lambdify((t_sym, y_args, p_args), rhs_exprs, modules='numpy')
        def equations_callable(t, y_array, p_array): return rhs_callable_lambdified(t, y_array, p_array)
    except Exception as e:
        return {"status": "error", "message": f"ODE Parsing/Compilation Error: {e}"}

    # 2) 피팅을 위한 값들 준비
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
                fitting_groups=fitting_groups, # <-- 수정된 부분
                weighting=weighting
            ),
            bounds=actual_bounds,
            verbose=0
        )
    except Exception as e:
         return {"status": "error", "message": f"Optimization algorithm failed: {e}"}


    fitted_params = dict(zip(fit_keys, result.x))

    # 4) 최종 파라미터로 "가중되지 않은" SSR 계산
    final_residuals_unweighted = _residuals(
        result.x, fit_keys, fixed_param, equations_callable, all_parameters, all_compartments, initials, 
        fitting_groups, weighting='none' # weighting='none'으로 강제하여 unweighted SSR 계산
    )
    total_ssr = np.sum(np.square(final_residuals_unweighted))

    # 5) 최종 반환값
    return {
        "status": "ok",
        "params": fitted_params,
        "cost": result.cost,
        "ssr_total": total_ssr,
        "nfev": result.nfev,
        "message": result.message,
        "status_code": result.status,
    }
