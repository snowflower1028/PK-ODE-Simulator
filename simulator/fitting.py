import numpy as np
import pandas as pd
from scipy.optimize import least_squares
from .solver import solve_ode_system
from .parser import parse_ode_input

def _residuals(vec, fit_keys, fixed_param, eq, comps, initials, obs_sets):
    """
    vec         : array of current fit parameter guesses
    fit_keys    : names of parameters being fitted
    fixed_param : dict of parameters held fixed
    eq, comps   : parsed ODE equations and compartment list
    initials    : dict of initial values per compartment
    obs_sets    : list of pandas.DataFrame, each with Time + observed columns
    """
    # reconstruct full parameter dict
    fit_param = dict(zip(fit_keys, vec))
    all_param = {**fixed_param, **fit_param}

    res_all = []
    # for each observed dataset, simulate and compute residuals
    for obs in obs_sets:
        # time span for this dataset
        t0 = obs["Time"].iloc[0]
        tN = obs["Time"].iloc[-1]
        t_eval = obs["Time"].to_numpy()

        sim = solve_ode_system(
            equations   = eq,
            compartments= comps,
            parameters  = list(all_param.keys()),
            init_values = initials,
            param_values= all_param,
            t_span      = [t0, tN],
            t_eval      = t_eval,
            doses       = []   # assume no dosing during fitting
        )

        # for each observed column (except Time), accumulate residuals
        for col in obs.columns:
            if col == "Time":
                continue
            # sim[col] is numpy array at t_eval
            # obs[col] is pandas Series
            res_all.extend(sim[col] - obs[col].to_numpy())

    return np.asarray(res_all)


def fit(data: dict) -> dict:
    """
    data keys:
      - "equations": string of ODE system
      - "initials"  : dict of initial values per compartment
      - "parameters": dict of all parameter name→value
      - "fit_params": list of parameter names to fit
      - "observed"  : list of dicts, each dict has "Time" + observed columns
    Returns:
      - "params": dict of fitted parameter values
      - "cost"  : residual sum of squares / 2 returned by least_squares
      - "ssr_list": list of SSR (sum of squared residuals) per dataset
    """
    # 1) parse ODE
    parsed = parse_ode_input(data["equations"])
    eq    = parsed["equations"]
    comps = parsed["compartments"]

    initials   = data["initials"]
    full_param = data["parameters"]      # dict of all parameters
    fit_keys   = data["fit_params"]      # list of names to fit

    # split into fixed vs to-be-fitted
    fixed_param = {k: v for k, v in full_param.items() if k not in fit_keys}
    p0 = np.array([full_param[k] for k in fit_keys], dtype=float)

    # convert list-of-dicts into list-of-DataFrames
    obs_sets = [pd.DataFrame(obs_dict) for obs_dict in data["observed"]]

    # perform least-squares fit
    result = least_squares(
        _residuals,
        p0,
        kwargs=dict(
            fit_keys    = fit_keys,
            fixed_param = fixed_param,
            eq          = eq,
            comps       = comps,
            initials    = initials,
            obs_sets    = obs_sets
        ),
        bounds=(-np.inf, np.inf),
        verbose=2
    )

    # extract fitted parameters
    fitted = dict(zip(fit_keys, result.x))

    # compute SSR per dataset
    ssr_list = []
    for obs in obs_sets:
        # simulate at fitted θ
        all_param = {**fixed_param, **fitted}
        t0 = obs["Time"].iloc[0]
        tN = obs["Time"].iloc[-1]
        t_eval = obs["Time"].to_numpy()
        sim = solve_ode_system(
            equations   = eq,
            compartments= comps,
            parameters  = list(all_param.keys()),
            init_values = initials,
            param_values= all_param,
            t_span      = [t0, tN],
            t_eval      = t_eval,
            doses       = []
        )
        # sum squared residuals for this dataset
        ssr = 0.0
        for col in obs.columns:
            if col == "Time":
                continue
            diff = sim[col] - obs[col].to_numpy()
            ssr += np.sum(diff**2)
        ssr_list.append(ssr)

    return {
        "params"   : fitted,
        "cost"     : result.cost,
        "ssr_list" : ssr_list
    }
