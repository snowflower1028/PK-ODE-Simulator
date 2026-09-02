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

from typing import Dict, Iterable, List, Optional, Sequence

import math
import re

import numpy as np
import pandas as pd

from .nca import AUCMethod, Administration, NCAResult, nca


#: 표에 항상 실어 보내는 항목. 값이 없으면 None 으로 나간다.
SUMMARY_FIELDS = (
    "c_max", "t_max", "c_last", "t_last",
    "lambda_z", "half_life",
    "lambda_z_n_points", "lambda_z_t_first", "lambda_z_t_last", "lambda_z_adj_r_squared",
    "auc_last", "auc_inf_obs", "auc_inf_pred", "auc_extrap_pct",
    "aumc_last", "aumc_inf",
    "cl", "vz", "mrt", "vss",
    "c0_back_extrapolated", "direct_integration", "method", "administration",
    "dose", "warnings",
)

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
    concentration_vars: Optional[Iterable[str]] = None,
    derived_expressions: Optional[Dict[str, str]] = None,
) -> Dict[str, Dict[str, object]]:
    """시뮬레이션 곡선의 요약.

    격자가 촘촘하므로 선형 사다리꼴이 곧 직접 적분이다. 보간 방식을
    고를 일이 없고, 0 시점부터 시작하므로 역외삽도 필요 없다.

    concentration_vars 에 없는 변수(구획 내 '양')는 용량이 필요한 항목
    (CL, Vz, Vss)을 비워 둔다. 양을 AUC 로 나눈 값은 청소율이 아니다.
    """
    concentration_vars = set(concentration_vars or [])
    derived_expressions = derived_expressions or {}
    time = df["Time"].to_numpy()

    results: Dict[str, Dict[str, object]] = {}
    for var in variables:
        if var not in df.columns:
            continue
        conc = df[var].to_numpy()

        is_conc = var in concentration_vars
        result = nca(
            time,
            conc,
            dose=dose_for(var, doses, derived_expressions) if is_conc else None,
            method=AUCMethod.LINEAR,
            administration=infer_administration(var, doses, derived_expressions),
        )
        result.direct_integration = True
        if not is_conc:
            result.warnings.append(
                "Amount, not concentration — clearance and volumes are left blank."
            )
        results[var] = _to_row(result)

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
            )
            if dose is None:
                result.warnings.append(
                    "No dose given for this dataset — clearance and volumes need one."
                )
            results[f"{variable} · {name}"] = _to_row(result)

    return results


def analyze_pk(df: pd.DataFrame, compartments: list, total_dose: float) -> Dict[str, Dict[str, float]]:
    """예전 시그니처. 아직 이 함수를 부르는 코드가 있을 때를 위해 남겨 둔다."""
    doses = [{"compartment": c, "type": "bolus", "amount": total_dose} for c in compartments[:1]]
    return analyze_simulated(df, compartments, doses, concentration_vars=compartments)
