import numpy as np, pandas as pd
from scipy.optimize import least_squares
from .solver   import solve_ode_system
from .parser   import parse_ode_input

def _residuals(vec, fit_keys, fixed_param, eq, comps, initials, obs):
    # vec → dict
    fit_param = dict(zip(fit_keys, vec))
    all_param = {**fixed_param, **fit_param}

    sim = solve_ode_system(
        equations   = eq,
        compartments= comps,
        parameters  = list(all_param.keys()),
        init_values = initials,
        param_values= all_param,
        t_span      = [obs["Time"].iloc[0], obs["Time"].iloc[-1]],
        t_eval      = obs["Time"].to_numpy(),
        doses       = []                # 피팅엔 보통 dose도 고려하지만 필요 시 전달
    )

    res = []
    for col in obs.columns:
        if col == "Time": continue
        res.extend(sim[col] - obs[col])
    return np.asarray(res)

def fit(data: dict) -> dict:
    # 1) ODE 파싱 (원본 식 전달)
    parsed      = parse_ode_input(data["equations"])
    eq          = parsed["equations"]; comps = parsed["compartments"]

    initials    = data["initials"]
    full_param  = data["parameters"]          # dict
    fit_keys    = data["fit_params"]          # list

    fixed_param = {k:v for k,v in full_param.items() if k not in fit_keys}
    p0          = np.array([full_param[k] for k in fit_keys])

    obs_df      = pd.DataFrame(data["observed"])

    result = least_squares(
        _residuals, p0,
        kwargs=dict(
            fit_keys=fit_keys, fixed_param=fixed_param,
            eq=eq, comps=comps, initials=initials, obs=obs_df),
        bounds=(-np.inf, np.inf),
        max_nfev=10,
        verbose=2
    )

    fitted = dict(zip(fit_keys, result.x))
    return {"params": fitted,
            "cost"  : result.cost}
