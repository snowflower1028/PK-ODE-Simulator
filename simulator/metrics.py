"""
metrics.py  ──  예측값과 관측값이 얼마나 맞는가
==============================================

이 모듈도 nca.py 처럼 이 앱에 묶여 있지 않다. Django 도, 이 프로젝트의 다른
모듈도 import 하지 않고 numpy 하나만 쓴다.

  from metrics import prediction_error
  result = prediction_error(observed, predicted)
  result.afe, result.aafe, result.within_2fold_pct

두 가지를 서로 다른 축에서 본다
-------------------------------
AFE 와 AAFE 는 로그 축에서 치우침과 정밀도를 잰다. 농도처럼 몇 자릿수를
오가는 값에는 "몇 배 틀렸나"가 "얼마나 틀렸나"보다 뜻이 분명하기 때문이다.
다만 배수는 무차원이라, 자료의 단위로 얼마나 벗어났는지는 RMSE 로 따로 본다.

여기에 2배 이내 비율을 더한다. AFE 와 AAFE 만으로는 분포를 알 수 없다 —
AAFE 1.5 는 모든 점이 1.5배 어긋난 경우일 수도, 절반은 딱 맞고 절반은
2.5배 어긋난 경우일 수도 있다. 둘은 전혀 다른 상황이고 후자가 훨씬 나쁘다.
"""

from __future__ import annotations

from dataclasses import dataclass, asdict
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np

__all__ = ["PredictionError", "prediction_error"]


@dataclass
class PredictionError:
    """관측-예측 한 쌍의 묶음에 대한 요약. 값이 정의되지 않으면 None 이다."""

    #: 실제로 쓴 점의 수
    n: int = 0
    #: 짝은 지었지만 로그를 못 취해 뺀 점의 수 (0 이하)
    n_excluded: int = 0

    #: 치우침. 1 이면 편향 없음, >1 과대예측, <1 과소예측
    afe: Optional[float] = None
    #: 전형적인 어긋남의 배수. 항상 >= 1, 1 이면 완벽
    aafe: Optional[float] = None
    #: 2배 이내에 든 점의 비율(%)
    within_2fold_pct: Optional[float] = None
    #: 가장 크게 어긋난 점의 배수와 그 시각
    max_fold_error: Optional[float] = None
    max_fold_error_time: Optional[float] = None

    #: 자료의 단위 그대로인 오차
    rmse: Optional[float] = None

    warnings: List[str] = None

    def __post_init__(self):
        if self.warnings is None:
            self.warnings = []

    def as_dict(self) -> Dict[str, object]:
        return asdict(self)


def _finite(value) -> Optional[float]:
    if value is None:
        return None
    value = float(value)
    return value if np.isfinite(value) else None


def _pair(observed, predicted, times) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """길이를 맞추고 결측을 걷어 낸다."""
    obs = np.asarray(observed, dtype=float)
    pred = np.asarray(predicted, dtype=float)
    n = min(obs.size, pred.size)
    obs, pred = obs[:n], pred[:n]

    if times is None:
        t = np.full(n, np.nan)
    else:
        t = np.asarray(times, dtype=float)[:n]

    keep = np.isfinite(obs) & np.isfinite(pred)
    return obs[keep], pred[keep], t[keep]


def prediction_error(
    observed: Sequence[float],
    predicted: Sequence[float],
    times: Optional[Sequence[float]] = None,
    fold: float = 2.0,
) -> PredictionError:
    """관측값과 그 시각의 예측값을 견준다.

    predicted 는 observed 와 같은 시각에서 뽑은 값이어야 한다. 촘촘한
    시뮬레이션 격자에서 가장 가까운 점을 집는 것으로는 부족하고, 채혈
    시각을 격자에 넣어 그대로 푸는 편이 맞다 (views.py 참고).

    RMSE 는 짝지어진 모든 점에서 계산한다. AFE·AAFE·2배 비율은 로그를
    취하므로 0 이하인 점을 뺄 수밖에 없는데, 몇 개를 뺐는지 함께 돌려준다 —
    조용히 빼 버리면 남은 숫자를 믿을 근거가 없다.
    """
    obs, pred, t = _pair(observed, predicted, times)
    result = PredictionError()

    if obs.size == 0:
        result.warnings.append("No paired points — check the column mapping and the time range.")
        return result

    residual = pred - obs
    result.rmse = _finite(np.sqrt(np.mean(residual ** 2)))

    # 로그를 취할 수 있는 점만 배수 지표에 쓴다.
    usable = (obs > 0) & (pred > 0)
    result.n = int(np.count_nonzero(usable))
    result.n_excluded = int(obs.size - result.n)

    if result.n_excluded:
        result.warnings.append(
            f"{result.n_excluded} of {obs.size} points are at or below zero and are left out of "
            "the fold-error metrics, which need a logarithm."
        )

    if result.n == 0:
        result.warnings.append("No positive pairs — fold-error metrics need both values above zero.")
        return result

    log_ratio = np.log10(pred[usable] / obs[usable])
    result.afe = _finite(10.0 ** np.mean(log_ratio))
    result.aafe = _finite(10.0 ** np.mean(np.abs(log_ratio)))

    within = np.abs(log_ratio) <= np.log10(fold)
    result.within_2fold_pct = _finite(100.0 * np.count_nonzero(within) / result.n)

    worst = int(np.argmax(np.abs(log_ratio)))
    result.max_fold_error = _finite(10.0 ** np.abs(log_ratio[worst]))
    worst_time = t[usable][worst]
    result.max_fold_error_time = _finite(worst_time) if np.isfinite(worst_time) else None

    return result
