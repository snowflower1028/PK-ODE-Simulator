from typing import List, Dict
import numpy as np
from scipy.integrate import solve_ivp
import sympy as sp


def simulate_custom_ode(
    equations_str: str,
    compartments: List[str],
    parameters: Dict[str, float],
    initials: Dict[str, float],
    doses: List[Dict],
    t_start: float = 0,
    t_end: float = 48,
    t_points: int = 200
) -> Dict[str, Dict[str, float]]:
    # 1. Define symbols
    t = sp.Symbol("t")
    sym_vars = {c: sp.Symbol(f"{c}_var") for c in compartments}  # avoid name conflict
    sym_params = {p: sp.Symbol(p) for p in parameters}
    all_symbols = {**sym_vars, **sym_params}

    # 2. Parse equations
    dydt_exprs = []
    lines = equations_str.strip().split("\n")
    for line in lines:
        lhs, rhs = line.split("=")
        comp_name = lhs.strip()[1:-2]  # "dCdt" → "C"
        expr = sp.sympify(rhs.strip(), locals=all_symbols)
        dydt_exprs.append((comp_name, expr))

    # 3. Lambdify RHS expressions
    ordered_comps = [c for c, _ in dydt_exprs]
    rhs_funcs = [
        sp.lambdify(
            [t] + list(sym_vars.values()) + list(sym_params.values()),
            expr,
            modules="numpy"
        )
        for _, expr in dydt_exprs
    ]

    comp_index = {c: i for i, c in enumerate(ordered_comps)}

    # 4. Define dydt
    def dydt(t_val, y):
        dydt_out = np.zeros_like(y)

        args = [t_val] + list(y) + [parameters[p] for p in sym_params]

        for i, f in enumerate(rhs_funcs):
            dydt_out[i] = f(*args)

        # 5. Apply dosing
        for d in doses:
            comp = d["compartment"]
            if comp not in comp_index:
                continue
            i = comp_index[comp]

            # Bolus dosing
            if d["type"] == "bolus" and np.isclose(t_val, d["start_time"], atol=1e-2):
                dydt_out[i] += d["amount"]

            # Infusion dosing
            elif d["type"] == "infusion":
                dur = d.get("duration", 0)
                if d["start_time"] <= t_val <= d["start_time"] + dur:
                    rate = d["amount"] / dur if dur > 0 else 0
                    dydt_out[i] += rate

            # Repeated dosing
            if d.get("repeat_every") and d.get("repeat_until"):
                rep = d["repeat_every"]
                until = d["repeat_until"]
                if d["type"] == "bolus":
                    times = np.arange(d["start_time"], until + 0.01, rep)
                    if any(np.isclose(t_val, rt, atol=1e-2) for rt in times):
                        dydt_out[i] += d["amount"]
                elif d["type"] == "infusion":
                    reps = np.arange(d["start_time"], until + 0.01, rep)
                    for r_start in reps:
                        if r_start <= t_val <= r_start + dur:
                            rate = d["amount"] / dur if dur > 0 else 0
                            dydt_out[i] += rate

        return dydt_out

    # 6. Initial values
    y0 = [initials.get(c, 0.0) for c in ordered_comps]
    t_eval = np.linspace(t_start, t_end, t_points)

    # 7. Solve
    sol = solve_ivp(dydt, (t_start, t_end), y0, t_eval=t_eval)

    # 8. Return result + PK summary
    result = {"Time": sol.t.tolist()}
    pk_summary = {}

    for i, c in enumerate(ordered_comps):
        conc_list = sol.y[i].tolist()
        result[c] = conc_list
        pk_summary[c] = compute_pk_metrics(sol.t, conc_list)

    return {"profile": result, "pk": pk_summary}

def compute_pk_metrics(time: List[float], conc: List[float]) -> Dict[str, float]:
    conc_array = np.array(conc)
    time_array = np.array(time)
    
    cmax = np.max(conc_array)
    tmax = float(time_array[np.argmax(conc_array)])
    auc = float(np.trapz(conc_array, time_array))  # 선형 trapezoid integration

    return {"Cmax": cmax, "Tmax": tmax, "AUC": auc}

