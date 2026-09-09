from typing import Callable, Dict, List, Sequence, Union
import numpy as np
import pandas as pd
from sympy import lambdify, symbols, Expr
from scipy.integrate import solve_ivp
import threading

# scipy 의 LSODA 는 ODEPACK 의 Fortran 루틴을 감싼 것이라 프로세스 안에서
# 재진입(reentrant)이 되지 않는다. 한 프로세스에서 두 요청이 동시에 적분을 돌리면
#   "Integrator `lsoda` can be used to solve only a single problem at a time."
# 로 500 이 난다. gunicorn 을 스레드 모드로 돌리거나 개발서버에 동시 접속이
# 몰리면 실제로 발생하므로, 적분 구간 전체를 프로세스 단위 락으로 직렬화한다.
_INTEGRATOR_LOCK = threading.RLock()


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
    # dtype 을 명시하지 않으면 numpy 가 입력에서 추론한다.  JSON 의 `0` 은 파이썬
    # int 로 들어오므로 모든 값이 정수면 배열이 int64 가 되고, 그 뒤 `+= 0.25`
    # 같은 소수 용량이 0 으로 잘려 투여가 통째로 사라진다.  예외도 경고도 없이
    # 전 구간이 0 이 되므로, 항상 float 으로 고정한다.
    p_values_arr = np.array([param_values.get(p_name, 0) for p_name in parameters], dtype=float)
    comp_map_idx = {name: i for i, name in enumerate(compartments)}
    y_current = np.array([init_values.get(c, 0) for c in compartments], dtype=float)
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
    
    # 시간순으로 정렬해 두고, 아래에서 포인터로 하나씩 소비한다.
    processed_dose_events.sort(key=lambda x: x["time"])

    # 시각 비교용 허용오차.  예전에는 np.isclose 를 썼는데 기본 rtol=1e-5 라
    # t=1.0 과 t=1.000005 를 같은 시각으로 봤고, 두 구간 모두에서 두 이벤트가
    # 다 발화해 10 mg 이 두 번 더해졌다.  시각은 상대오차로 비교할 값이 아니다.
    time_tol = 1e-9 * max(1.0, abs(float(t_span[1])), abs(float(t_span[0])))

    def _apply(event):
        idx = event["comp_idx"]
        if event["type"] == "bolus":
            y_current[idx] += event["value"]
        elif event["type"] == "infusion_start":
            active_infusion_rates[idx] += event["value"]
        elif event["type"] == "infusion_end":
            active_infusion_rates[idx] = max(0.0, active_infusion_rates[idx] - event["value"])

    # --- 3. RHS 함수 정의 (Infusion 포함) ---
    def effective_rhs(t, y_arr):
        base_dy = equations_callable(t, y_arr, p_values_arr)
        return np.array(base_dy) + active_infusion_rates

    # --- 4. 이벤트 기반 시뮬레이션 루프 ---
    t_start, t_end = float(t_span[0]), float(t_span[1])
    cursor = 0

    # 관찰 창이 시작되기 *전에* 일어난 일을 반영한다.  창 이전에 시작해 아직
    # 진행 중인 주입은 계속 흘러야 한다(예전에는 통째로 무시돼서, 정상상태
    # 구간만 떼어 보면 유입이 0 이었다).  창 이전의 볼루스는 이미 초기값에
    # 반영돼 있다고 보고 다시 더하지 않는다 — 더하면 이중 투여가 된다.
    while cursor < len(processed_dose_events) and processed_dose_events[cursor]["time"] < t_start - time_tol:
        event = processed_dose_events[cursor]
        if event["type"] in ("infusion_start", "infusion_end"):
            _apply(event)
        cursor += 1

    all_solutions = []   # 각 구간의 보간 함수
    segment_spans = []   # 그 구간의 [t0, t1]

    while True:
        # 지금 시각에 걸린 이벤트를 소비한다.  포인터로 지우며 나아가므로
        # 같은 이벤트가 두 구간에서 다시 발화하지 않는다.
        while cursor < len(processed_dose_events) and processed_dose_events[cursor]["time"] <= t_current + time_tol:
            _apply(processed_dose_events[cursor])
            cursor += 1

        if t_current >= t_end - time_tol:
            break

        if cursor < len(processed_dose_events):
            t_next_event = min(processed_dose_events[cursor]["time"], t_end)
        else:
            t_next_event = t_end
        if t_next_event <= t_current + time_tol:
            t_next_event = t_end

        with _INTEGRATOR_LOCK:
            sol_segment = solve_ivp(
                fun=effective_rhs,
                t_span=(t_current, t_next_event),
                y0=y_current,
                method='LSODA',       # Stiff 시스템에 강건한 솔버
                dense_output=True,    # 보간을 위해 dense_output 활성화
                # solve_ivp 의 기본값은 rtol=1e-3 이다. 그래프로 보기에는
                # 멀쩡하지만 NCA 지표를 뽑거나 파라미터를 적합할 때는 너무
                # 성기다 — 반복 투여는 구간마다 새로 적분하므로 오차가 쌓여
                # 11회 투여 뒤 잔여량이 0.14% 어긋나고, AUCtau 도 격자를
                # 아무리 촘촘히 해도 0.1% 아래로 내려가지 않는다.
                # 값은 요청당 1-comp +3ms, 2-comp 는 차이 없음.
                rtol=1e-8,
                atol=1e-11,
            )

        all_solutions.append(sol_segment.sol)
        segment_spans.append((t_current, float(sol_segment.t[-1])))

        t_current = float(sol_segment.t[-1])
        y_current = sol_segment.y[:, -1].copy()

        if sol_segment.status != 0 and sol_segment.status != 1:  # 솔버 실패 시
            print(f"Warning: ODE solver failed at t={t_current}. Message: {sol_segment.message}")
            break

    # 마지막 시각의 상태.  구간 끝에 놓인 투여는 어떤 적분 구간에도 담기지
    # 않으므로(적분할 길이가 없다) 따로 들고 있어야 한다 — 예전에는 t_end 의
    # 투여가 결과에서 사라졌다.
    final_state = (t_current, y_current.copy())

    # --- 5. 최종 결과 생성 ---
    final_y_values = np.zeros((len(compartments), len(t_eval)))

    for i, t_point in enumerate(t_eval):
        t_point = float(t_point)

        if t_point >= final_state[0] - time_tol:
            final_y_values[:, i] = final_state[1]
            continue

        # 구간 경계에 정확히 놓인 시각은 *뒤* 구간의 값을 쓴다.  투여 시각에
        # 채혈하면 투여 후 농도가 나와야 한다(우연속).  앞에서부터 찾으면
        # 이전 구간이 먼저 걸려 투여 전 값이 나왔다.
        placed = False
        for (seg_t0, seg_t1), sol_func in zip(reversed(segment_spans), reversed(all_solutions)):
            if seg_t0 - time_tol <= t_point <= seg_t1 + time_tol:
                final_y_values[:, i] = sol_func(t_point)
                placed = True
                break
        if not placed and all_solutions and t_point > t_start:
            final_y_values[:, i] = all_solutions[-1](segment_spans[-1][1])

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
    y0 = np.array([init_values[c] for c in compartments], dtype=float)
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

    with _INTEGRATOR_LOCK:
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
