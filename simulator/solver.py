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
    equations_callable: Callable, # parser.py에서 생성: f(t, y_arr, p_arr) -> dy_arr
    compartments: List[str],
    parameters: List[str],        # 파라미터 이름 리스트 (순서 중요)
    init_values: Dict[str, float],# 초기값 딕셔너리
    param_values: Dict[str, float],# 파라미터 값 딕셔너리
    t_span: Sequence[float],
    t_eval: Union[Sequence[float], np.ndarray],
    doses: List[Dict] = None
) -> pd.DataFrame:
    """
    Solves an ODE system with dosing events using scipy.solve_ivp's event handling feature.
    """
    if doses is None:
        doses = []

    # --- 1. 설정 및 변수 초기화 ---
    p_values_arr = np.array([param_values.get(p_name, 0) for p_name in parameters])
    comp_map_idx = {name: i for i, name in enumerate(compartments)}
    y_current = np.array([init_values.get(c, 0) for c in compartments])
    t_current = t_span[0]
    
    # 현재 활성화된 infusion rate 저장 배열
    active_infusion_rates = np.zeros(len(compartments))

    # --- 2. 모든 투여 이벤트를 시간순으로 사전 처리 ---
    processed_dose_events = []
    for dose_item in doses:
        start_time = dose_item.get("start_time", 0)
        # ... (이전 답변과 동일한 Dose 전처리 로직) ...
        current_t = start_time
        typ = dose_item.get("type")
        amount = dose_item.get("amount", 0)
        comp_name = dose_item.get("compartment")
        if comp_name not in comp_map_idx: continue
        comp_idx = comp_map_idx[comp_name]
        duration = dose_item.get("duration", 0)
        repeat_every = dose_item.get("repeat_every")
        repeat_until = dose_item.get("repeat_until")

        while True:
            if current_t > t_span[1] + 1e-9: break
            
            if typ == "bolus":
                processed_dose_events.append({"time": current_t, "type": "bolus", "comp_idx": comp_idx, "value": amount})
            elif typ == "infusion" and duration > 0:
                infusion_end_time = current_t + duration
                rate = amount / duration
                processed_dose_events.append({"time": current_t, "type": "infusion_start", "comp_idx": comp_idx, "value": rate})
                if infusion_end_time <= t_span[1] + 1e-9:
                    processed_dose_events.append({"time": infusion_end_time, "type": "infusion_end", "comp_idx": comp_idx, "value": rate})

            if repeat_every and repeat_every > 0 and repeat_until and current_t < repeat_until:
                current_t += repeat_every
                if current_t > repeat_until + 1e-9: break
            else:
                break
    
    # 시간순으로 이벤트 정렬
    processed_dose_events.sort(key=lambda x: x["time"])
    
    # --- 3. RHS 함수 정의 (Infusion 포함) ---
    def effective_rhs(t, y_arr):
        base_dy = equations_callable(t, y_arr, p_values_arr)
        return np.array(base_dy) + active_infusion_rates

    # --- 4. 이벤트 기반 시뮬레이션 루프 ---
    all_solutions = [] # 각 구간의 solution 객체를 저장할 리스트
    
    while t_current < t_span[1]:
        # 현재 시간에서 발생하는 모든 이벤트 적용
        events_at_this_time = [e for e in processed_dose_events if np.isclose(e['time'], t_current)]
        for event in events_at_this_time:
            if event["type"] == "bolus":
                y_current[event["comp_idx"]] += event["value"]
            elif event["type"] == "infusion_start":
                active_infusion_rates[event["comp_idx"]] += event["value"]
            elif event["type"] == "infusion_end":
                active_infusion_rates[event["comp_idx"]] -= event["value"]
                active_infusion_rates[event["comp_idx"]] = max(0, active_infusion_rates[event["comp_idx"]])

        # 다음 이벤트 시간 찾기
        upcoming_event_times = [event['time'] for event in processed_dose_events if event['time'] > t_current + 1e-9]
        t_next_event = upcoming_event_times[0] if upcoming_event_times else t_span[1]
        
        # 현재 구간 [t_current, t_next_event]에 대해 시뮬레이션
        sol_segment = solve_ivp(
            fun=effective_rhs,
            t_span=(t_current, t_next_event),
            y0=y_current,
            method='LSODA',       # Stiff 시스템에 강건한 솔버
            dense_output=True,    # 보간을 위해 dense_output 활성화
        )
        
        all_solutions.append(sol_segment.sol) # 보간 함수(dense output) 저장
        
        # 다음 루프를 위해 현재 상태 업데이트
        t_current = sol_segment.t[-1]
        y_current = sol_segment.y[:, -1].copy()

        if sol_segment.status != 0 and sol_segment.status != 1: # 솔버 실패 시
            print(f"Warning: ODE solver failed at t={t_current}. Message: {sol_segment.message}")
            break

    # --- 5. 최종 결과 생성 ---
    # 요청된 t_eval 시간점들에 대한 값을 각 구간의 보간 함수를 사용하여 계산
    final_y_values = np.zeros((len(compartments), len(t_eval)))

    for i, t_point in enumerate(t_eval):
        # t_point가 포함된 solution segment 찾기
        found = False
        for sol_func in all_solutions:
            if sol_func.t_min - 1e-9 <= t_point <= sol_func.t_max + 1e-9:
                final_y_values[:, i] = sol_func(t_point)
                found = True
                break
        if not found and t_point > t_span[0]: # 모든 구간 이후의 시간점이라면 마지막 값 사용
             if all_solutions:
                 final_y_values[:, i] = all_solutions[-1](all_solutions[-1].t_max)

    # DataFrame으로 변환하여 반환
    df_output = pd.DataFrame(final_y_values.T, columns=compartments)
    df_output.insert(0, 'Time', t_eval)
    
    return df_output

def solve_ode_system_old(
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
