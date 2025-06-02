from typing import Callable, Dict, List, Sequence, Union
import numpy as np
import pandas as pd
from sympy import lambdify, symbols, Expr
from scipy.integrate import solve_ivp


def generate_rhs_function(
    equations: Dict[str, Expr],
    compartments: List[str],
    parameters: List[str]
) -> Callable:
    """
    Generate a numerical RHS function for solve_ivp using sympy.lambdify.

    Parameters
    ----------
    equations : Dict[str, Expr]
        ODE system as a dictionary mapping compartment names to their equations.
    compartments : list
        List of compartment names.
    parameters : dict
        Mapping from parameter name to its value.

    Returns
    -------
    Callable
        A function f(t, y, param_values) that computes dy/dt.
    """
    y_syms = symbols(compartments)
    param_syms = symbols(parameters)
    
    # 각 컴파트먼트별 방정식 추출
    rhs_funcs = [
        lambdify((y_syms, param_syms), equations[comp], modules='numpy')
        for comp in compartments
    ]
    
    def dydt(t, y, param_values):
        return [rhs_func(y, param_values) for rhs_func in rhs_funcs]
    
    return dydt


def solve_ode_system(
    equations: Dict[str, Expr],
    compartments: List[str],
    parameters: List[str],
    init_values: Dict[str, float],
    param_values: Dict[str, float],
    t_span: Sequence[float],
    t_eval: Union[Sequence[float], np.ndarray],
    doses: List[Dict] = None
) -> pd.DataFrame:
    """
    Solve ODE system using scipy.solve_ivp and return result as DataFrame.

    Parameters
    ----------
    equations : dict
        Compartment → sympy expression mapping.
    compartments : list
        Compartment names.
    parameters : dict
        Mapping from parameter name to its value.
    init_values : dict
        Initial values for each compartment.
    param_values : dict
        Parameter values.
    t_span : list
        [start, end] time.
    t_eval : list
        Evaluation time points.
    doses : list
        List of dosing instructions (bolus/infusion).

    Returns
    -------
    pd.DataFrame
        Time-course of each compartment.
    """
    dydt = generate_rhs_function(equations, compartments, parameters)

    applied_bolus = set()
    y0 = [init_values[c] for c in compartments]
    p_vals = [param_values[p] for p in parameters]

    def is_dose_time(t, start, every=None, until=None):
        if every is not None and until is not None:
            if t < start or t > until:
                return False
            return np.isclose((t - start) % every, 0, atol=1e-6)
        return np.isclose(t, start, atol=1e-6)

    def wrapped_dydt(t, y):
        dy = dydt(t, y, p_vals)

        if doses:
            for dose in doses:
                comp = dose["compartment"]
                idx = compartments.index(comp)
                typ = dose["type"]
                amount = dose["amount"]
                start = dose["start_time"]
                duration = dose.get("duration", 0)
                every = dose.get("repeat_every")
                until = dose.get("repeat_until")

                if typ == "bolus":
                    key = (comp, round(t, 4))  # ← 소수 4째자리까지 기준으로 동일 t 방지
                    if key in applied_bolus:
                        continue
                    if is_dose_time(t, start, every, until):
                        y[idx] += amount
                        applied_bolus.add(key)

                elif typ == "infusion":
                    # 시간 구간 내부인지 확인
                    infusion_times = []
                    if every is not None and until is not None:
                        t_dose = start
                        while t_dose <= until:
                            infusion_times.append((t_dose, t_dose + duration))
                            t_dose += every
                    else:
                        infusion_times.append((start, start + duration))

                    for t0, t1 in infusion_times:
                        if t0 <= t <= t1:
                            dy[idx] += amount / duration
                            break

        return dy

    sol = solve_ivp(
        fun=wrapped_dydt,
        t_span=tuple(t_span),
        y0=y0,
        t_eval=t_eval,
        vectorized=False
    )

    df = pd.DataFrame(sol.y.T, columns=compartments)
    df.insert(0, 'Time', sol.t)

    return df
