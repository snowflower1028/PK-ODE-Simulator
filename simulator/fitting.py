import numpy as np
import pandas as pd
from scipy.optimize import least_squares
from sympy import symbols, lambdify # view와 마찬가지로 lambdify 사용을 위해 임포트
from django.core.cache import cache # view와 마찬가지로 캐싱을 위해 임포트
import hashlib

# 프로젝트의 다른 모듈 임포트
from .solver import solve_ode_system
from .parser import parse_ode_input


def _residuals(vec, fit_keys, fixed_param, equations_callable, all_parameters, comps, initials, obs_sets, doses):
    """
    Residuals function for least_squares.
    - equations_callable: Lambdified function for the ODE system.
    - all_parameters: List of all parameter names in order.
    - doses: List of dosing information.
    """
    # 1. 현재 추정치로 전체 파라미터 딕셔너리 재구성
    fit_param = dict(zip(fit_keys, vec))
    all_param_values = {**fixed_param, **fit_param}

    res_all = []
    # 2. 각 관찰 데이터셋에 대해 시뮬레이션 수행 및 잔차 계산
    for obs_df in obs_sets:
        if "Time" not in obs_df.columns or obs_df["Time"].empty:
            continue

        t_start = obs_df["Time"].iloc[0]
        t_end = obs_df["Time"].iloc[-1]
        t_eval = obs_df["Time"].to_numpy()

        # 3. solve_ode_system 호출 (변경된 인자 사용)
        sim_df = solve_ode_system(
            equations_callable=equations_callable,
            compartments=comps,
            parameters=all_parameters,
            init_values=initials,
            param_values=all_param_values,
            t_span=[t_start, t_end],
            t_eval=t_eval,
            doses=doses # Dosing 정보 전달
        )

        # 4. 각 관찰 컬럼에 대한 잔차 계산
        for col in obs_df.columns:
            if col.lower() == "time" or col not in sim_df.columns:
                continue
            
            observed_values = obs_df[col].to_numpy()
            simulated_values = sim_df[col].to_numpy()
            
            # NaN 값 등 유효하지 않은 데이터 제외
            valid_indices = ~np.isnan(observed_values)
            if np.any(valid_indices):
                res_all.extend(simulated_values[valid_indices] - observed_values[valid_indices])

    if not res_all:
        return np.array([1e6] * len(vec)) # 문제가 발생하여 잔차 계산이 안 된 경우

    return np.asarray(res_all)


def fit(data: dict) -> dict:
    """
    Performs parameter fitting based on the provided data.
    """
    # 1) 캐싱을 사용하여 ODE 파싱
    ode_text = data["equations"]
    cache_key = 'parsed_ode_sympy_' + hashlib.md5(ode_text.encode('utf-8')).hexdigest()
    parsed = cache.get(cache_key)
    if parsed is None:
        parsed = parse_ode_input(ode_text)
        cache.set(cache_key, parsed, timeout=3600)

    # 2) 파싱 결과로부터 lambdify를 사용하여 수치 함수 생성
    all_compartments = parsed["compartments"]
    all_parameters = parsed["parameters"]
    equations = parsed["equations"]

    comp_syms = symbols(all_compartments)
    param_syms = symbols(all_parameters)
    t_sym = symbols('t')
    y_args = tuple(comp_syms) if isinstance(comp_syms, (list, tuple)) else (comp_syms,)
    p_args = tuple(param_syms) if isinstance(param_syms, (list, tuple)) else (param_syms,)
    rhs_exprs = [equations[c] for c in all_compartments]

    rhs_callable_lambdified = lambdify((t_sym, y_args, p_args), rhs_exprs, modules='numpy')
    def equations_callable(t, y_array, p_array):
        return rhs_callable_lambdified(t, y_array, p_array)

    # 3) 피팅을 위한 값들 준비
    initials   = data["initials"]
    full_param = data["parameters"]      # 초기 추정치
    fit_keys   = data["fit_params"]
    param_bounds_dict = data.get("bounds", {})
    doses      = data.get("doses", [])   # Dosing 정보

    fixed_param = {k: v for k, v in full_param.items() if k not in fit_keys}
    p0 = np.array([full_param[k] for k in fit_keys], dtype=float)
    obs_sets = [pd.DataFrame(obs_dict) for obs_dict in data["observed"]]

    # 4) Bounds 처리
    lower_bounds = np.array([-np.inf] * len(fit_keys), dtype=float)
    upper_bounds = np.array([np.inf] * len(fit_keys), dtype=float)
    for i, key in enumerate(fit_keys):
        if key in param_bounds_dict:
            lb_raw, ub_raw = param_bounds_dict[key]
            if lb_raw is not None and str(lb_raw).strip() != '': lower_bounds[i] = float(lb_raw)
            if ub_raw is not None and str(ub_raw).strip() != '': upper_bounds[i] = float(ub_raw)
    actual_bounds = (lower_bounds, upper_bounds)

    # 5) least-squares 피팅 수행
    result = least_squares(
        _residuals,
        p0,
        kwargs=dict( # _residuals 함수에 전달될 인자들
            fit_keys=fit_keys,
            fixed_param=fixed_param,
            equations_callable=equations_callable, # 수정됨
            all_parameters=all_parameters,         # 수정됨 (순서 정보)
            comps=all_compartments,                # 수정됨
            initials=initials,
            obs_sets=obs_sets,
            doses=doses                            # 수정됨
        ),
        bounds=actual_bounds,
        verbose=0 # 서버 콘솔 출력을 원하면 2로 변경
    )

    fitted_params = dict(zip(fit_keys, result.x))

    # 6) (선택 사항) 최종 파라미터로 SSR 다시 계산
    # 이 부분은 _residuals 함수를 재활용하여 단순화 가능
    final_residuals = _residuals(result.x, fit_keys, fixed_param, equations_callable, all_parameters, all_compartments, initials, obs_sets, doses)
    total_ssr = np.sum(np.square(final_residuals))


    # 최종 반환값
    return {
        "params"      : fitted_params,
        "cost"        : result.cost,       # 0.5 * sum_sq_residuals
        "ssr_total"   : total_ssr,
        # "ssr_list"  : ssr_list, # 개별 SSR 계산 로직은 필요시 추가
        "nfev"        : result.nfev,
        "message"     : result.message,
        "status_code" : result.status,
    }

