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

# 한 요청이 만들 수 있는 투여 이벤트 수의 상한.  이벤트 하나가 적분 구간
# 하나이므로, 이 수가 곧 solve_ivp 호출 횟수이자 보간 구간 수다.
_MAX_DOSE_EVENTS = 5_000

# 절대 허용오차의 기준값.  예전에는 이 값 하나를 모든 구획에 그대로 썼다.
# 상태가 O(1)~O(1e12) 일 때는 rtol 이 오차를 지배하므로 문제가 없지만, 상태가
# 1e-9 규모(nmol, µg/L 로 모델을 쓴 경우)면 atol 이 상태보다 커져 솔버가
# "이미 충분히 0 에 가깝다"고 보고 곡선을 대충 따라간다.  같은 1구획 소실을
# 단위만 바꿔 풀면 C(t)/C(0) 의 상대오차가 1e0 규모 4.7e-08 에서 1e-09 규모
# 4.6e-02 로, 10 반감기 꼬리에서는 4.8e+04 로 무너졌다.
_BASE_ATOL = 1e-11
#: atol 이 subnormal 로 내려가지 않게 하는 바닥.
_MIN_ATOL = 1e-300

# 적분 한 번이 할 수 있는 일의 상한.  유입 속도가 약 1e145 를 넘으면(투여든
# `dAdt = -k*A + R`, R=1e150 같은 파라미터든) LSODA 의 걸음 폭이 t=0 에서
# 정확히 0 이 되어 시간이 전혀 나아가지 않은 채 RHS 만 초당 13만 번 부른다 —
# 끝나지 않는다.  Render 의 gunicorn --timeout 180 이 워커를 죽일 때까지 요청
# 하나가 서비스를 붙잡았다.  입력 값의 상한만으로는 막을 수 없다(식이 값을
# 키울 수 있다).  그래서 원인이 아니라 증상을 본다.
#
# 측정한 정상 부하의 최대 평가 수 (solve_ode_system 한 번):
#   stiff 2구획(k=1e4 / 1e-3) 5000회 투여   1,630,010   19.6 s
#   PBPK 14구획 5000회 투여                   756,957   40.8 s
#   2구획 주입 이벤트 5000                    330,184    4.1 s
#: 시간이 나아가지 않은 채 이만큼 평가하면 멈춘 것으로 본다.  정상 적분은
#: 한 걸음에 수~수십 번(야코비안 추정이 구획 수+1 번) 평가하므로 닿지 않는다.
_STALL_EVALS = 100_000
#: 전체 평가 수 상한 — 멈춤 판정을 피해 가는 경우의 마지막 방어선.
#: 정상 최대의 약 6배, 멈춘 경우의 평가 속도로 약 75 초.
_MAX_RHS_EVALS = 10_000_000


class IntegrationStalled(ValueError):
    """적분이 진행하지 못하거나 예산을 넘었다.  요청 잘못이므로 400 이다."""


class _RhsBudget:
    """RHS 평가를 세며 멈춤과 과다 평가를 잡는다."""

    __slots__ = ("calls", "best_t", "since_progress")

    def __init__(self):
        self.calls = 0
        self.best_t = -np.inf
        self.since_progress = 0

    def tick(self, t: float) -> None:
        self.calls += 1
        if t > self.best_t:
            self.best_t = t
            self.since_progress = 0
        else:
            self.since_progress += 1
            if self.since_progress > _STALL_EVALS:
                raise IntegrationStalled(
                    f"The integration stopped advancing at t={self.best_t:g}: the "
                    f"solver's step size shrank to zero. This usually means a rate "
                    f"in the model is far too large (for example above ~1e145); "
                    f"check the parameter values and doses."
                )
        if self.calls > _MAX_RHS_EVALS:
            raise IntegrationStalled(
                f"The integration needed more than {_MAX_RHS_EVALS:,} model "
                f"evaluations and was stopped (reached t={self.best_t:g}). Use "
                f"fewer doses, a shorter time range, or check for extreme values."
            )


def _absolute_tolerances(y0: np.ndarray, doses, comp_map_idx) -> np.ndarray:
    """구획마다 atol 을 상태의 규모에 맞춘다.  **오늘보다 느슨해지는 일은 없다.**

        scale_i = max(|초기값_i|, 구획 i 로 들어가는 투여 한 번의 양)
        atol_i  = min(_BASE_ATOL, scale_i * _BASE_ATOL)

    `min` 이 핵심이다.  규모가 1 이상인 구획은 예전과 똑같이 1e-11 을 쓰므로,
    지금 맞는 결과가 이 변경으로 움직일 경로가 없다.  작은 규모만 조인다.

    초기값도 직접 투여도 없는 구획(경구 모델의 중심 구획, 대사물 pool)은
    규모를 미리 알 수 없다.  이 구획에 1e-11 을 주면 흡수 구획만 조여지고
    정작 관측하는 곡선은 여전히 무너지므로, 시스템에서 알려진 가장 작은
    규모를 물려준다(가장 보수적인 선택).  아무 정보도 없으면 1e-11 이다.
    """
    scale = np.abs(np.asarray(y0, dtype=float)).copy()
    for dose in doses:
        idx = comp_map_idx.get(dose.get("compartment"))
        if idx is None:
            continue
        amount = abs(float(dose.get("amount") or 0.0))
        if np.isfinite(amount):
            scale[idx] = max(scale[idx], amount)

    known = scale[(scale > 0) & np.isfinite(scale)]
    fallback = float(known.min()) if known.size else 1.0
    scale = np.where((scale > 0) & np.isfinite(scale), scale, fallback)
    return np.maximum(np.minimum(_BASE_ATOL, scale * _BASE_ATOL), _MIN_ATOL)


def finite_number(value, what: str) -> float:
    """요청에서 온 값 하나를 유한한 실수로 읽는다.  아니면 ValueError.

    JSON 의 `true`/`false` 는 파이썬 bool 이고 bool 은 int 의 하위형이라
    `float(True) == 1.0` 이 된다.  예전에는 그래서 `k=true` 가 k=1 로,
    `t_start=true` 가 관찰 창 시작 1 h 로 조용히 계산됐다(HTTP 200).
    숫자 문자열("12")은 예전처럼 받는다 — 폼 입력이 문자열로 올 수 있다.
    """
    if isinstance(value, (bool, np.bool_)):
        raise ValueError(f"{what} must be a number, not {str(value).lower()}.")
    if value is None or value == "":
        raise ValueError(f"{what} is missing.")
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise ValueError(f"{what} is not a number: {value!r}.")
    if not np.isfinite(number):
        raise ValueError(f"{what} is not finite: {value!r}.")
    return number


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

    # --- 0. 입력 검증 ---
    # 예전에는 이 자리에서 아무것도 보지 않았다.  틀린 입력은 예외가 아니라
    # 그럴듯한 숫자가 되어 나갔다: 값이 빠진 파라미터는 0 으로 채워져
    # (CL 이 없으면 소실이 없는 약이 되고), 모르는 투여 유형은 조용히
    # 건너뛰어 무투여 곡선이 되고, 뒤집힌 t_span 은 빈 결과가 됐다.
    # 사용자가 잘못 넣은 값은 조용한 답이 아니라 오류로 돌려준다.
    if len(t_span) != 2:
        raise ValueError(f"t_span must be a pair of times; got {t_span!r}.")
    t_lo = finite_number(t_span[0], "The start time")
    t_hi = finite_number(t_span[1], "The end time")
    if t_hi <= t_lo:
        raise ValueError(
            f"t_span must run forwards: the end ({t_hi}) has to be later than "
            f"the start ({t_lo})."
        )

    missing_params = [
        name for name in parameters
        if param_values.get(name, None) is None
    ]
    if missing_params:
        raise ValueError(
            "Missing parameter value(s): " + ", ".join(sorted(missing_params))
        )
    checked_params = {
        name: finite_number(param_values[name], f"Parameter {name!r}")
        for name in parameters
    }

    # 초기값.  빠진 구획은 0 에서 시작한다(예전과 같다).  예전에는 여기서
    # 아무것도 보지 않아 `true` 는 1 로 통과했고, 'abc' 나 null 은 numpy·scipy
    # 내부 메시지("could not convert string to float", "y0 must be finite")로
    # 돌아왔다.
    checked_initials = {
        comp: finite_number(init_values[comp], f"The initial value of {comp!r}")
        for comp in compartments
        if comp in init_values
    }

    def _number(dose_item, field, position, default=0.0):
        """투여 항목의 수치 필드. 문자열이 들어오면 500 이 아니라 400 이 되게."""
        raw = dose_item.get(field, default)
        if raw is None or raw == "":
            return default
        if isinstance(raw, (bool, np.bool_)):
            raise ValueError(
                f"Dose #{position} has a {field} of {str(raw).lower()}; it must be a number."
            )
        try:
            value = float(raw)
        except (TypeError, ValueError):
            raise ValueError(
                f"Dose #{position} has a non-numeric {field}: {raw!r}."
            )
        if not np.isfinite(value):
            raise ValueError(f"Dose #{position} has a non-finite {field}: {value!r}.")
        return value

    normalised_doses = []
    for position, dose_item in enumerate(doses, start=1):
        typ = dose_item.get("type")
        if typ not in ("bolus", "infusion"):
            raise ValueError(
                f"Unknown dose type {typ!r} in dose #{position}; "
                f"expected 'bolus' or 'infusion'."
            )
        amount = finite_number(dose_item.get("amount", 0), f"The amount of dose #{position}")
        start_time = _number(dose_item, "start_time", position)
        repeat_every = _number(dose_item, "repeat_every", position, default=0.0)
        repeat_until = _number(dose_item, "repeat_until", position, default=0.0)
        if repeat_every < 0:
            raise ValueError(
                f"Dose #{position} repeats every {repeat_every} — that has to be positive."
            )
        # 반복 간격에 하한이 없으면 이벤트 수가 t_end/repeat_every 로 무한정
        # 늘어난다.  measured: repeat_every=0.002 인 요청 하나가 2분이 넘도록
        # 끝나지 않았다 — 구간마다 적분을 새로 하기 때문이다.  간격 자체를
        # 막기보다 만들어질 이벤트 수를 세어 거절한다.
        if repeat_every > 0:
            span = min(repeat_until, t_hi) - start_time
            if span > 0 and span / repeat_every > _MAX_DOSE_EVENTS:
                raise ValueError(
                    f"Dose #{position} would repeat about {int(span / repeat_every):,} "
                    f"times in this time range; the limit is {_MAX_DOSE_EVENTS:,}. "
                    f"Use a longer interval or a shorter range."
                )
        if typ == "infusion":
            duration = _number(dose_item, "duration", position)
            # 예전에는 duration<=0 인 주입이 이벤트를 하나도 만들지 않아
            # 투여가 통째로 사라졌다.  속도(amount/duration)가 정의되지 않으니
            # 조용히 넘길 수 없는 입력이다.
            if not duration > 0:
                raise ValueError(
                    f"Infusion dose #{position} needs a positive duration; "
                    f"got {duration}."
                )
            # 속도 = 양/시간 이 넘치면 inf 가 되고, 적분은 nan 을 만든 뒤
            # RuntimeWarning 한 줄만 남기고 A=0.0 인 "성공한" 곡선을 돌려줬다
            # (amount=1e308, duration=1e-300).  duration=5e-324 도 같았다.
            with np.errstate(over="ignore", divide="ignore"):
                rate = amount / duration
            if not np.isfinite(rate):
                raise ValueError(
                    f"Infusion dose #{position} has a rate (amount / duration) that "
                    f"is too large to represent: {amount:g} / {duration:g}."
                )
        else:
            duration = 0.0

        # 아래 전처리는 이 사본만 본다. 검증만 하고 원본을 그대로 넘기면
        # 문자열 "12" 가 그대로 흘러가 비교에서 TypeError 로 터졌다.
        normalised_doses.append({
            "compartment": dose_item.get("compartment"),
            "type": typ,
            "amount": amount,
            "start_time": start_time,
            "duration": duration,
            "repeat_every": repeat_every,
            "repeat_until": repeat_until,
        })

    # --- 1. 설정 및 변수 초기화 ---
    # dtype 을 명시하지 않으면 numpy 가 입력에서 추론한다.  JSON 의 `0` 은 파이썬
    # int 로 들어오므로 모든 값이 정수면 배열이 int64 가 되고, 그 뒤 `+= 0.25`
    # 같은 소수 용량이 0 으로 잘려 투여가 통째로 사라진다.  예외도 경고도 없이
    # 전 구간이 0 이 되므로, 항상 float 으로 고정한다.
    p_values_arr = np.array([checked_params[p_name] for p_name in parameters], dtype=float)
    comp_map_idx = {name: i for i, name in enumerate(compartments)}
    y_current = np.array([checked_initials.get(c, 0.0) for c in compartments], dtype=float)
    t_current = t_span[0]
    
    # 현재 활성화된 infusion rate 저장 배열
    active_infusion_rates = np.zeros(len(compartments))

    # --- 2. 모든 투여 이벤트를 시간순으로 사전 처리 ---
    processed_dose_events = []
    for dose_item in normalised_doses:
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
                # 시각이 크면 짧은 주입의 끝이 시작과 같은 부동소수점 값이 된다
                # (1e17 + 1 == 1e17).  그러면 시작·끝 이벤트가 같은 시각에 함께
                # 소비돼 유입이 0 이 되고, 투여가 통째로 사라진 곡선이 200 으로
                # 나갔다.  반복 투여의 뒤쪽 회차에서도 생길 수 있어 여기서 본다.
                if not infusion_end_time > current_t:
                    raise ValueError(
                        f"An infusion to {comp_name!r} starting at t={current_t:g} "
                        f"lasts {duration:g}, which is too short to separate from "
                        f"its start at that time scale."
                    )
                rate = amount / duration
                processed_dose_events.append({"time": current_t, "type": "infusion_start", "comp_idx": comp_idx, "value": rate})
                if infusion_end_time <= t_span[1] + 1e-9:
                    processed_dose_events.append({"time": infusion_end_time, "type": "infusion_end", "comp_idx": comp_idx, "value": rate})

            if repeat_every and repeat_every > 0 and repeat_until and current_t < repeat_until:
                current_t += repeat_every
                if current_t > repeat_until + 1e-9: break
            else:
                break
    
    # 투여 항목 하나씩은 위에서 걸렀지만, 여럿이 합쳐지면 다시 넘칠 수 있다.
    if len(processed_dose_events) > _MAX_DOSE_EVENTS:
        raise ValueError(
            f"These doses produce {len(processed_dose_events):,} dosing events in "
            f"this time range; the limit is {_MAX_DOSE_EVENTS:,}."
        )

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
    budget = _RhsBudget()   # 구간 전체에 걸쳐 센다 — 요청 하나의 총량이다

    def effective_rhs(t, y_arr):
        budget.tick(t)
        base_dy = equations_callable(t, y_arr, p_values_arr)
        return np.array(base_dy) + active_infusion_rates

    # 구획별 절대 허용오차 — 투여가 적용되기 전의 초기값과 투여량으로 정한다.
    atol = _absolute_tolerances(y_current, normalised_doses, comp_map_idx)

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
                atol=atol,   # 구획별, `_absolute_tolerances` 참고
            )

        # 적분 실패는 경고 한 줄로 넘길 일이 아니다.  예전에는 여기서
        # print 하고 루프를 빠져나갔고, 호출자는 마지막 값이 끝까지 평평하게
        # 이어진 "성공한" 프로필을 받았다 — 피팅이 그 곡선에 붙으면 실패가
        # 파라미터 추정치로 둔갑한다.
        if not getattr(sol_segment, "success", True):
            raise RuntimeError(
                f"ODE integration failed at t={t_current}: {sol_segment.message}"
            )

        all_solutions.append(sol_segment.sol)
        segment_spans.append((t_current, float(sol_segment.t[-1])))

        t_current = float(sol_segment.t[-1])
        y_current = sol_segment.y[:, -1].copy()

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
