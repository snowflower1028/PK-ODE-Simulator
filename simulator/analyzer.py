"""
analyzer.py  ──  앱과 NCA 계산기를 잇는 층
===========================================

실제 계산은 전부 nca.py 가 한다. 이 파일은 "이 앱의 데이터를 어떻게
계산기에 넣을 것인가"만 정한다. 둘을 나눈 이유는 nca.py 를 나중에
별도의 NCA 앱에서 그대로 쓰기 위해서다.

시뮬레이션 곡선과 실측값을 다르게 다룬다
----------------------------------------
시뮬레이션은 촘촘한 격자로 풀어낸 곡선이라 점 사이를 어떻게 이을지
가정할 필요가 없다. 그래서 선형 사다리꼴로 곡선을 그대로 적분한다
(격자가 촘촘하면 이것이 곧 곡선 아래 넓이다).

실측값은 채혈 시점이 드문드문하다. 소실 구간을 직선으로 이으면 넓이가
과대평가되므로 linear-up / log-down 을 쓰고, 마지막 점 이후는 lambda_z 로
외삽한다 — 이것이 NCA 다.
"""

from typing import Dict, Iterable, List, NamedTuple, Optional, Sequence

import math
import re

import numpy as np
import pandas as pd

from .metrics import prediction_error
from .nca import AUCMethod, Administration, NCAResult, nca, nca_steady_state


#: 표에 항상 실어 보내는 항목. 값이 없으면 None 으로 나간다.
SUMMARY_FIELDS = (
    "c_max", "t_max", "c_last", "t_last",
    "lambda_z", "half_life",
    "lambda_z_n_points", "lambda_z_t_first", "lambda_z_t_last", "lambda_z_adj_r_squared",
    "lambda_z_span",
    "auc_last", "auc_inf_obs", "auc_inf_pred", "auc_extrap_pct",
    "aumc_last", "aumc_inf",
    "cl", "vz", "mrt", "vss",
    "c0_back_extrapolated", "direct_integration", "method", "administration",
    "dose", "warnings",
    #: "single-dose" 또는 "steady-state". 표가 어느 열을 보여 줄지 정한다.
    "regimen",
)

#: 반복 투여일 때 추가로 실어 보내는 항목.
SS_FIELDS = (
    "ss_tau", "ss_interval_start", "ss_interval_end", "ss_n_intervals",
    "ss_c_max", "ss_t_max", "ss_c_min", "ss_t_min", "ss_c_trough",
    "ss_auc_tau", "ss_aumc_tau", "ss_c_avg",
    "ss_fluctuation_pct", "ss_swing",
    "ss_accumulation_auc", "ss_accumulation_c_max",
    "ss_cl", "ss_vz",
    "ss_at_steady_state", "ss_interval_change_pct",
)

#: 반복 투여에서 종말상 기울기를 믿을 수 없을 때 함께 비우는 항목.
#: lambda_z 자체가 못 쓸 값이면 그것으로 만든 것도 전부 못 쓴다.
_LAMBDA_Z_DERIVED = (
    "lambda_z", "half_life", "lambda_z_n_points", "lambda_z_t_first",
    "lambda_z_t_last", "lambda_z_adj_r_squared", "lambda_z_span", "ss_vz",
)

#: 반복 투여에서는 뜻을 잃는 단회 항목. 비워서 내보낸다.
_SINGLE_DOSE_ONLY = (
    "c_max", "t_max", "c_last", "t_last",
    "auc_last", "auc_inf_obs", "auc_inf_pred", "auc_extrap_pct",
    "aumc_last", "aumc_inf",
    "cl", "vz", "mrt", "vss",
)


class Regimen(NamedTuple):
    """하나의 반복 투여 일정."""

    tau: float
    first_dose_time: float
    last_dose_time: float
    n_doses: int
    dose: Dict


def dosing_regimen(doses: Sequence[Dict]) -> Optional[Regimen]:
    """반복 투여 일정 하나를 읽어 낸다. 아니면 None.

    "투여 간격" 이라는 말이 성립하려면 반복이 하나여야 한다. 서로 다른 주기가
    섞여 있으면 어느 것이 τ 인지 정할 수 없고, 그때는 정상상태 요약을 내지
    않는 편이 맞다.
    """
    repeating = [d for d in doses or [] if d.get("repeat_every")]
    if len(repeating) != 1:
        return None

    d = repeating[0]
    try:
        tau = float(d.get("repeat_every") or 0)
        first = float(d.get("start_time") or 0)
        until = d.get("repeat_until")
        until = float(until) if until not in (None, "") else None
    except (TypeError, ValueError):
        return None
    if tau <= 0 or until is None or until <= first:
        return None

    # 솔버와 같은 규칙으로 마지막 투여 시각을 센다.
    n = int(math.floor((until - first) / tau + 1e-9))
    return Regimen(tau=tau, first_dose_time=first,
                   last_dose_time=first + n * tau, n_doses=n + 1, dose=d)


def _steady_state(
    time: np.ndarray,
    conc: np.ndarray,
    regimen: Regimen,
    variable: str,
    dose: Optional[float],
    lambda_z: Optional[float],
    method: AUCMethod,
) -> Dict[str, object]:
    """정상상태 결과를 표에 실을 모양으로 바꾼다."""
    ss = nca_steady_state(
        time, conc,
        tau=regimen.tau,
        dose=dose,
        first_dose_time=regimen.first_dose_time,
        last_dose_time=regimen.last_dose_time,
        lambda_z=lambda_z,
        method=method,
    )
    data = ss.as_dict()

    # Tmax 는 투여 후 경과시간으로 바꿔서 내보낸다. "120.0" 이 아니라
    # "2.1" 이라야 읽을 수 있고, 절대 시각은 interval_start 가 들고 있다.
    origin = data.get("interval_start")

    def since_dose(key):
        value = data.get(key)
        if value is None or origin is None:
            return None
        return value - origin

    row: Dict[str, object] = {
        "ss_tau": _round(data.get("tau")),
        "ss_interval_start": _round(data.get("interval_start")),
        "ss_interval_end": _round(data.get("interval_end")),
        "ss_n_intervals": data.get("n_intervals"),
        "ss_c_max": _round(data.get("c_max")),
        "ss_t_max": _round(since_dose("t_max")),
        "ss_c_min": _round(data.get("c_min")),
        "ss_t_min": _round(since_dose("t_min")),
        "ss_c_trough": _round(data.get("c_trough")),
        "ss_auc_tau": _round(data.get("auc_tau")),
        "ss_aumc_tau": _round(data.get("aumc_tau")),
        "ss_c_avg": _round(data.get("c_avg")),
        "ss_fluctuation_pct": _round(data.get("fluctuation_pct")),
        "ss_swing": _round(data.get("swing")),
        "ss_accumulation_auc": _round(data.get("accumulation_auc")),
        "ss_accumulation_c_max": _round(data.get("accumulation_c_max")),
        "ss_cl": _round(data.get("cl_ss")),
        "ss_vz": _round(data.get("vz_ss")),
        "ss_at_steady_state": data.get("at_steady_state"),
        "ss_interval_change_pct": _round(data.get("interval_change_pct")),
    }
    row["_warnings"] = list(ss.warnings)
    return row


_TOKEN = re.compile(r"[A-Za-z_][\w]*")


def _round(value, digits: int = 6):
    """JSON 으로 내보내기 좋게 다듬는다. NaN/inf 는 None."""
    if value is None or isinstance(value, (bool, str, list)):
        return value
    if isinstance(value, (int,)) and not isinstance(value, bool):
        return value
    try:
        v = float(value)
    except (TypeError, ValueError):
        return value
    if not math.isfinite(v):
        return None
    return round(v, digits)


def _to_row(result: NCAResult) -> Dict[str, object]:
    data = result.as_dict()
    return {key: _round(data.get(key)) for key in SUMMARY_FIELDS}


def infer_administration(
    variable: str,
    doses: Sequence[Dict],
    derived_expressions: Optional[Dict[str, str]] = None,
) -> Administration:
    """이 변수 입장에서 투여가 혈관 내인지 밖인지 추정한다.

    Vss 와 MRT 는 투여된 약이 관찰 구획에 곧바로 들어갔을 때만 뜻이 있다.
    흡수 구획을 거쳐 들어오면 흡수 과정이 체류시간에 섞이기 때문이다.

    판단 기준은 "투여 구획이 이 변수 자신이거나, 이 변수를 만드는 식에
    들어 있는가" 이다. C1 = A1/V 이고 A1 에 투여했다면 혈관 내로 본다.
    확실하지 않으면 혈관외로 둔다 — 틀린 Vss 를 내놓느니 비우는 편이 낫다.
    """
    if not doses:
        return Administration.EXTRAVASCULAR

    derived_expressions = derived_expressions or {}
    expression = derived_expressions.get(variable, "")
    sources = {variable} | set(_TOKEN.findall(expression))

    direct = [d for d in doses if d.get("compartment") in sources]
    if not direct:
        return Administration.EXTRAVASCULAR

    if any(d.get("type") == "infusion" and (d.get("duration") or 0) > 0 for d in direct):
        return Administration.IV_INFUSION
    return Administration.IV_BOLUS


def infusion_duration_for(
    variable: str,
    doses: Sequence[Dict],
    derived_expressions: Optional[Dict[str, str]] = None,
) -> float:
    """이 변수로 직접 들어가는 주입의 길이.

    MRT 는 약이 몸에 머문 평균 시간인데, 주입은 투여 자체가 시간을 쓰므로
    그 절반이 섞여 들어간다.  `nca()` 는 `infusion_duration` 을 받아 빼 줄
    준비가 되어 있었지만 이 자리에서 넘겨주지 않아, 기본값 0 으로 보정이
    한 번도 일어나지 않았다 — 2시간 주입에서 MRT 와 Vss 가 나란히 12.5%
    높게 나왔다(측정: 9.000/36.00, 참값 8.000/32.00).

    길이가 서로 다른 주입이 같은 구획에 겹쳐 있으면 뺄 값이 하나로 정해지지
    않는다.  그럴 때는 0 을 돌려주고 보정하지 않는다 — 틀린 값을 빼느니
    보정하지 않는 편이 낫다.
    """
    if not doses:
        return 0.0

    derived_expressions = derived_expressions or {}
    expression = derived_expressions.get(variable, "")
    sources = {variable} | set(_TOKEN.findall(expression))

    durations = {
        float(d.get("duration") or 0)
        for d in doses
        if d.get("compartment") in sources
        and d.get("type") == "infusion"
        and (d.get("duration") or 0) > 0
    }
    return durations.pop() if len(durations) == 1 else 0.0


def dose_for(variable: str,
             doses: Sequence[Dict],
             derived_expressions: Optional[Dict[str, str]] = None) -> Optional[float]:
    """이 변수에 대응하는 투여량.

    반복 투여는 단회 NCA 공식이 성립하지 않으므로 None 을 돌려준다.
    (정상상태 파라미터는 별도 항목으로 다뤄야 한다.)
    """
    if not doses:
        return None
    if any(d.get("repeat_every") for d in doses):
        return None

    derived_expressions = derived_expressions or {}
    expression = derived_expressions.get(variable, "")
    sources = {variable} | set(_TOKEN.findall(expression))

    relevant = [float(d.get("amount", 0) or 0) for d in doses if d.get("compartment") in sources]
    if relevant:
        return sum(relevant)

    # 이 변수로 직접 들어간 투여가 없으면(흡수 구획을 거치는 경우)
    # 전체 투여량을 쓴다 — CL/F, Vz/F 의 분자가 된다.
    total = sum(float(d.get("amount", 0) or 0) for d in doses)
    return total or None


def analyze_simulated(
    df: pd.DataFrame,
    variables: Iterable[str],
    doses: Sequence[Dict],
    derived_expressions: Optional[Dict[str, str]] = None,
) -> Dict[str, Dict[str, object]]:
    """시뮬레이션 곡선의 요약.

    격자가 촘촘하므로 선형 사다리꼴이 곧 직접 적분이다. 보간 방식을
    고를 일이 없고, 0 시점부터 시작하므로 역외삽도 필요 없다.

    ``variables`` 로 넘어온 것을 그대로 계산한다 — 화면에서 그리기로 고른
    변수들이다.  한때 이 자리에 "농도라고 선언된 변수만" 이라는 관문이
    있었지만 걷어냈다.  출력이 늘 농도인 것도 아니고(양을 추적하는 것도
    정당한 목적이다), 이 앱이 하려는 일은 모든 경우에 들어맞는 PK 파라미터를
    내주는 것이 아니라 ODE 시뮬레이션·피팅·민감도 분석을 PK 연구에 맞게
    쉽게 해 주는 것이기 때문이다.  그 관문은 아무것도 막지 못하면서 — 양을
    농도로 선언하는 것을 막을 방법은 없다 — 화면만 무겁게 만들었다.

    CL 이나 Vz 가 이 변수에 대해 뜻이 있는 값인지는 연구자가 판단한다.
    표의 각 열에 달린 정보 팝업이 무엇을 조심해야 하는지 말해 준다.
    """
    derived_expressions = derived_expressions or {}
    time = df["Time"].to_numpy()
    regimen = dosing_regimen(doses)

    results: Dict[str, Dict[str, object]] = {}
    for var in variables:
        if var not in df.columns:
            continue
        conc = df[var].to_numpy()

        result = nca(
            time,
            conc,
            dose=dose_for(var, doses, derived_expressions),
            method=AUCMethod.LINEAR,
            administration=infer_administration(var, doses, derived_expressions),
            infusion_duration=infusion_duration_for(var, doses, derived_expressions),
        )
        result.direct_integration = True
        row = _to_row(result)
        row["regimen"] = "single-dose"

        if regimen is not None:
            # 반복 투여에서는 단회 지표가 뜻을 잃는다. 전체를 적분한 AUC 는
            # 노출량이 아니라 시뮬레이션을 얼마나 오래 돌렸는지이고, Tmax 는
            # 그저 마지막 투여의 봉우리다. 비우고 정상상태 값으로 갈아 끼운다.
            per_dose = dose_for(
                var, [dict(regimen.dose, repeat_every=None)], derived_expressions
            )
            ss = _steady_state(
                time, conc, regimen, var,
                dose=per_dose,
                lambda_z=result.lambda_z,
                method=AUCMethod.LINEAR,
            )
            warnings = list(row.get("warnings") or []) + ss.pop("_warnings", [])
            for key in _SINGLE_DOSE_ONLY:
                row[key] = None
            row.update(ss)

            # 종말상 기울기는 마지막 투여 뒤의 세척 구간에서만 뜻이 있다.
            # 그 구간이 없으면 탐색은 마지막 몇 점 — 아직 흡수가 끝나지도
            # 않은 톱니의 한 조각 — 에 직선을 맞추고, 그 결과가 half-life
            # 로 표에 실린다.  측정: 마지막 투여 2시간 뒤에 끝나는 12회
            # 투여 모의에서 t½ 이 44.8시간(참값 5.545), Vz,ss 가 258.6
            # (참값 32.0)으로 나왔다.  8배 틀린 값이 경고 한 줄과 함께
            # 조용히 게시된 셈이다.
            #
            # 세척이 실제로 있으면 지금 탐색도 제자리를 찾는다(같은 모델을
            # 마지막 투여 48시간 뒤까지 돌리면 t½ 5.557, Vz,ss 32.07).
            # 그러니 값을 다시 맞출 일이 아니라, 근거가 없을 때 내보내지
            # 않으면 된다.  근거는 두 가지다 — 창이 마지막 투여 뒤에
            # 있는가, 그리고 반감기 하나만큼은 감쇠를 봤는가.
            span = row.get("lambda_z_span")
            window_start = row.get("lambda_z_t_first")
            after_last_dose = (
                window_start is not None
                and window_start >= regimen.last_dose_time - 1e-9
            )
            if row.get("lambda_z") is not None and not (
                after_last_dose and span is not None and span >= 1.0
            ):
                for key in _LAMBDA_Z_DERIVED:
                    row[key] = None
                warnings.append(
                    "The terminal slope was not estimated: this run does not "
                    "contain a washout after the last dose that is long enough "
                    "to see the drug decline. Half-life and Vz,ss need one."
                )
            row["regimen"] = "steady-state"
            row["dose"] = _round(per_dose)
            row["warnings"] = warnings

        elif any(d.get("repeat_every") for d in doses or []):
            # 반복은 하는데 주기가 하나로 정해지지 않는 경우. 단회 값을
            # 그대로 두되, 그것이 여러 번 투여된 곡선 위에서 계산된
            # 것이라고 말해 준다.
            row["warnings"] = list(row.get("warnings") or []) + [
                "Dosing repeats on more than one schedule, so there is no single "
                "dosing interval — these are single-dose formulas applied to a "
                "multiple-dose curve and do not mean what they usually mean."
            ]

        results[var] = row

    return results


def analyze_observed(
    datasets: Sequence[Dict],
    doses: Sequence[Dict],
    derived_expressions: Optional[Dict[str, str]] = None,
    method: AUCMethod = AUCMethod.LINEAR_LOG,
) -> Dict[str, Dict[str, object]]:
    """업로드된 관찰 데이터의 NCA.

    datasets 의 각 항목은 화면의 관찰 데이터 하나에 대응한다::

        {"name": "study-a.csv",
         "data": {"Time": [...], "Plasma": [...]},
         "mappings": {"Plasma": "C1"},
         "dose": 100}          # 없으면 용량이 필요한 항목은 비워 둔다

    돌려주는 키는 "C1 · study-a.csv" 처럼 모델 변수와 파일 이름을 합친
    것이라, 시뮬레이션 행과 나란히 놓아도 헷갈리지 않는다.
    """
    derived_expressions = derived_expressions or {}
    results: Dict[str, Dict[str, object]] = {}

    for dataset in datasets or []:
        name = dataset.get("name") or "observed"
        data = dataset.get("data") or {}
        mappings = dataset.get("mappings") or {}

        time_key = next((k for k in data if k.lower() == "time"), None)
        if time_key is None:
            continue
        time = np.asarray(data[time_key], dtype=float)

        for column, values in data.items():
            if column == time_key:
                continue
            variable = mappings.get(column) or column
            conc = np.asarray([np.nan if v is None else v for v in values], dtype=float)

            dose = dataset.get("dose")
            dose = float(dose) if dose not in (None, "") else None

            result = nca(
                time,
                conc,
                dose=dose,
                method=method,
                administration=infer_administration(variable, doses, derived_expressions),
                infusion_duration=infusion_duration_for(variable, doses, derived_expressions),
            )
            if dose is None:
                result.warnings.append(
                    "No dose given for this dataset — clearance and volumes need one."
                )
            row = _to_row(result)
            row["regimen"] = "single-dose"

            # 실측값에는 정상상태 요약을 붙이지 않는다. τ 는 알 수 있지만
            # 이 표본이 어느 간격의 것인지, 시간축이 최초 투여 기준인지
            # 마지막 투여 기준인지를 알 수 없기 때문이다. 그 정보를 받는
            # 화면이 생기기 전까지는 단회 값으로 두고 그렇다고 말한다.
            if dosing_regimen(doses) is not None:
                result.warnings.append(
                    "Dosing repeats, but these are single-dose quantities — "
                    "tell the app which interval this data covers before "
                    "reading AUC or clearance from it."
                )
                row["warnings"] = list(result.warnings)

            results[f"{variable} · {name}"] = row

    return results



#: 예측-관측 비교표에 실어 보내는 항목.
COMPARISON_FIELDS = (
    "n", "n_excluded",
    "afe", "aafe", "within_2fold_pct",
    "max_fold_error", "max_fold_error_time",
    "rmse", "warnings",
)


def observed_times(datasets: Sequence[Dict]) -> List[float]:
    """업로드된 관찰 데이터에 들어 있는 모든 채혈 시각.

    시뮬레이션 격자에 이 시각들을 끼워 넣어야 예측값을 보간 없이 그대로
    읽을 수 있다. 촘촘한 격자에서 가장 가까운 점을 집는 방식은 흡수상처럼
    곡선이 가파른 구간에서 눈에 띄게 어긋난다.
    """
    out = set()
    for dataset in datasets or []:
        data = dataset.get("data") or {}
        time_key = next((k for k in data if k.lower() == "time"), None)
        if time_key is None:
            continue
        for value in data[time_key]:
            try:
                t = float(value)
            except (TypeError, ValueError):
                continue
            if math.isfinite(t):
                out.add(t)
    return sorted(out)


def compare_observed(
    df: pd.DataFrame,
    datasets: Sequence[Dict],
) -> Dict[str, Dict[str, object]]:
    """관찰값과 같은 시각의 시뮬레이션 값을 견준다.

    돌려주는 키는 analyze_observed 와 같은 "C1 · study-a.csv" 꼴이라, 같은
    짝을 두 표에서 찾아보기 쉽다.

    예측값은 df 에서 그 시각의 행을 그대로 집는다. views.py 가 채혈 시각을
    t_eval 에 넣어 두므로 보간이 필요 없다. 시각이 시뮬레이션 구간 밖이면
    그 점은 짝을 지을 수 없어 빠진다.
    """
    if df is None or "Time" not in df.columns:
        return {}

    grid = df["Time"].to_numpy(dtype=float)
    results: Dict[str, Dict[str, object]] = {}

    for dataset in datasets or []:
        name = dataset.get("name") or "observed"
        data = dataset.get("data") or {}
        mappings = dataset.get("mappings") or {}

        time_key = next((k for k in data if k.lower() == "time"), None)
        if time_key is None:
            continue
        times = np.asarray(data[time_key], dtype=float)

        for column, model_var in mappings.items():
            if column not in data or model_var not in df.columns:
                continue

            observed = np.asarray(
                [np.nan if v is None else v for v in data[column]], dtype=float)
            n = min(times.size, observed.size)
            t, observed = times[:n], observed[:n]

            # 격자에서 같은 시각의 행을 찾는다. 없으면(구간 밖) 뺀다.
            column_values = df[model_var].to_numpy(dtype=float)
            predicted = np.full(t.shape, np.nan)
            outside = 0
            for i, moment in enumerate(t):
                if not math.isfinite(moment):
                    continue
                hit = np.flatnonzero(np.isclose(grid, moment, rtol=0, atol=1e-9))
                if hit.size:
                    predicted[i] = column_values[hit[0]]
                else:
                    outside += 1

            result = prediction_error(observed, predicted, times=t)
            if outside:
                result.warnings.append(
                    f"{outside} sample times fall outside the simulated range and were skipped — "
                    "widen the simulation time range to include them."
                )

            row = {key: _round(result.as_dict().get(key)) for key in COMPARISON_FIELDS}
            row["warnings"] = result.warnings
            row["variable"] = model_var
            row["dataset"] = name
            row["column"] = column
            results[f"{model_var} · {name}"] = row

    return results


def analyze_pk(df: pd.DataFrame, compartments: list, total_dose: float) -> Dict[str, Dict[str, float]]:
    """예전 시그니처. 아직 이 함수를 부르는 코드가 있을 때를 위해 남겨 둔다."""
    doses = [{"compartment": c, "type": "bolus", "amount": total_dose} for c in compartments[:1]]
    return analyze_simulated(df, compartments, doses)
