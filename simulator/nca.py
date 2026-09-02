"""
nca.py  ──  비구획 분석(NCA) 계산기
====================================

이 모듈은 이 앱에 묶여 있지 않다. Django 도, 이 프로젝트의 다른 모듈도
import 하지 않고 numpy 하나만 쓴다. 시간·농도 배열과 용량만 주면 되므로
나중에 별도의 NCA 앱에서 그대로 가져다 쓸 수 있다.

  from nca import nca, auc_direct, AUCMethod

  result = nca(time, conc, dose=100, method=AUCMethod.LINEAR_LOG)
  result.auc_inf_obs, result.half_life, result.cl

용어와 식은 Phoenix WinNonlin 의 비구획 분석을 기준으로 맞췄다.

시뮬레이션 곡선과 실측값을 구분해서 쓸 것
-----------------------------------------
NCA 는 "점 사이를 어떻게 잇고, 마지막 점 이후를 어떻게 외삽할 것인가"에
대한 가정 위에서 돌아간다. 이 가정은 채혈 시점이 드문드문한 실측값에
필요한 것이고, 촘촘한 격자로 풀어낸 시뮬레이션 곡선에는 필요 없다.
후자는 auc_direct() 로 곡선 자체를 적분하면 된다.
"""

from __future__ import annotations

from dataclasses import dataclass, asdict, field
from enum import Enum
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np


__all__ = [
    "AUCMethod",
    "Administration",
    "LambdaZ",
    "NCAResult",
    "auc_direct",
    "auc",
    "aumc",
    "back_extrapolate_c0",
    "best_fit_lambda_z",
    "nca",
    "clip_interval",
    "SteadyStateResult",
    "nca_steady_state",
]


class AUCMethod(str, Enum):
    """사다리꼴 적분 방식."""

    LINEAR = "linear"
    #: 농도가 올라가는 구간은 선형, 내려가는 구간은 로그.
    #: 소실이 지수적이면 선형 사다리꼴은 AUC 를 과대평가하므로
    #: 희소 표본에서는 이쪽이 더 정확하다. WinNonlin 의 혈관외 기본값.
    LINEAR_LOG = "linear-up-log-down"


class Administration(str, Enum):
    """투여 방식. Vss / MRT 가 유효한지, CL 이 CL/F 인지가 갈린다."""

    IV_BOLUS = "iv_bolus"
    IV_INFUSION = "iv_infusion"
    EXTRAVASCULAR = "extravascular"


# ---------------------------------------------------------------------------
# 기초 적분
# ---------------------------------------------------------------------------
def _clean(time: Sequence[float], conc: Sequence[float]) -> Tuple[np.ndarray, np.ndarray]:
    """시간순으로 정렬하고 결측을 걷어낸다."""
    t = np.asarray(time, dtype=float)
    c = np.asarray(conc, dtype=float)
    if t.shape != c.shape:
        raise ValueError("time and conc must have the same length")

    keep = np.isfinite(t) & np.isfinite(c)
    t, c = t[keep], c[keep]

    order = np.argsort(t, kind="stable")
    return t[order], c[order]


def auc_direct(time: Sequence[float], conc: Sequence[float]) -> float:
    """곡선 자체를 적분한다 (NCA 가정 없음).

    시뮬레이션 결과처럼 촘촘한 격자에서 쓴다. 점 사이를 어떻게 이을지
    고민할 필요가 없을 만큼 촘촘하므로, 사다리꼴 적분이 사실상 곡선 아래
    넓이 그 자체다. 외삽도 하지 않는다 — 돌려주는 값은 주어진 시간 범위
    안의 넓이이고, 그 이상을 알고 싶으면 시뮬레이션 시간을 늘려야 한다.
    """
    t, c = _clean(time, conc)
    if t.size < 2:
        return float("nan")
    return float(np.trapezoid(c, t))


def auc(
    time: Sequence[float],
    conc: Sequence[float],
    method: AUCMethod = AUCMethod.LINEAR_LOG,
) -> float:
    """AUC(0-tlast) — 사다리꼴 적분."""
    t, c = _clean(time, conc)
    if t.size < 2:
        return float("nan")

    total = 0.0
    for i in range(t.size - 1):
        dt = t[i + 1] - t[i]
        if dt <= 0:
            continue
        c0, c1 = c[i], c[i + 1]

        use_log = (
            method is AUCMethod.LINEAR_LOG
            and c1 < c0            # 내려가는 구간에서만
            and c0 > 0 and c1 > 0  # 로그를 취할 수 있어야
        )
        if use_log:
            total += dt * (c0 - c1) / np.log(c0 / c1)
        else:
            total += dt * (c0 + c1) / 2.0
    return float(total)


def aumc(
    time: Sequence[float],
    conc: Sequence[float],
    method: AUCMethod = AUCMethod.LINEAR_LOG,
) -> float:
    """AUMC(0-tlast) — 1차 모멘트 t·C 의 사다리꼴 적분."""
    t, c = _clean(time, conc)
    if t.size < 2:
        return float("nan")

    total = 0.0
    for i in range(t.size - 1):
        dt = t[i + 1] - t[i]
        if dt <= 0:
            continue
        c0, c1 = c[i], c[i + 1]
        t0, t1 = t[i], t[i + 1]

        use_log = (
            method is AUCMethod.LINEAR_LOG
            and c1 < c0
            and c0 > 0 and c1 > 0
        )
        if use_log:
            # C(t) = c0 * exp(-k (t - t0)) 를 t*C 로 적분해 직접 유도한 식.
            #   ∫ t·C dt = t0(c0-c1)/k + (c0-c1)/k² - c1·Δt/k
            # 흔히 인용되는 (t0·c0 - t1·c1)/ln(c0/c1) 꼴은 부호가 뒤집혀
            # 음수가 나온다 — 수치적분과 대조해 확인했다.
            k = np.log(c0 / c1) / dt
            total += t0 * (c0 - c1) / k + (c0 - c1) / k ** 2 - c1 * dt / k
        else:
            total += dt * (t0 * c0 + t1 * c1) / 2.0
    return float(total)


# ---------------------------------------------------------------------------
# 말기 구간 (lambda_z)
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class LambdaZ:
    """말기 소실 속도상수와, 그 값을 믿을지 판단할 근거."""

    value: Optional[float] = None          #: lambda_z (1/time)
    intercept: Optional[float] = None      #: ln C 절편 — 예측 Clast 를 만들 때 쓴다
    n_points: int = 0
    t_first: Optional[float] = None
    t_last: Optional[float] = None
    r_squared: Optional[float] = None
    adj_r_squared: Optional[float] = None

    @property
    def ok(self) -> bool:
        return self.value is not None and self.value > 0

    def predict(self, t: float) -> float:
        """회귀선 위의 농도. AUC(0-inf, pred) 에 쓴다."""
        if self.intercept is None or self.value is None:
            return float("nan")
        return float(np.exp(self.intercept - self.value * t))


def _ols_log_linear(t: np.ndarray, c: np.ndarray) -> Tuple[float, float, float]:
    """ln C ~ t 최소제곱. (slope, intercept, r_squared) 를 돌려준다.

    numpy 만으로 계산해 이 모듈이 scipy 에 기대지 않게 한다.
    """
    y = np.log(c)
    n = t.size
    t_mean, y_mean = t.mean(), y.mean()
    st = t - t_mean
    denom = float(np.dot(st, st))
    if denom == 0.0:
        return float("nan"), float("nan"), float("nan")

    slope = float(np.dot(st, y - y_mean) / denom)
    intercept = float(y_mean - slope * t_mean)

    resid = y - (intercept + slope * t)
    ss_res = float(np.dot(resid, resid))
    ss_tot = float(np.dot(y - y_mean, y - y_mean))
    r2 = 1.0 - ss_res / ss_tot if ss_tot > 0 else float("nan")
    return slope, intercept, r2


def best_fit_lambda_z(
    time: Sequence[float],
    conc: Sequence[float],
    min_points: int = 3,
    exclude_tmax: bool = True,
) -> LambdaZ:
    """말기 구간을 자동으로 골라 lambda_z 를 추정한다 (WinNonlin Best Fit).

    마지막 3점에서 시작해 앞으로 한 점씩 넓혀 가며 조정 결정계수를 비교하고,
    가장 좋은 조합을 고른다. 동점에 가까우면(0.0001 이내) 점이 많은 쪽을
    택한다 — 같은 설명력이면 표본이 큰 쪽이 안정적이기 때문이다.

    Tmax 는 기본적으로 제외한다. 흡수가 끝나기 전 지점이 말기 기울기에
    섞이면 t½ 가 짧게 나온다.
    """
    t, c = _clean(time, conc)
    if t.size < min_points:
        return LambdaZ()

    i_tmax = int(np.argmax(c))
    start = i_tmax + 1 if exclude_tmax else i_tmax

    # 말기 후보는 Tmax 이후이면서 농도가 0 보다 큰 점들
    idx = np.array([i for i in range(start, t.size) if c[i] > 0], dtype=int)
    if idx.size < min_points:
        return LambdaZ()

    best: Optional[LambdaZ] = None
    # 마지막 점은 항상 포함한다. 뒤에서부터 n 개씩 늘려 간다.
    for n in range(min_points, idx.size + 1):
        sel = idx[-n:]
        ts, cs = t[sel], c[sel]
        slope, intercept, r2 = _ols_log_linear(ts, cs)
        if not np.isfinite(slope) or slope >= 0:
            continue  # 올라가는 구간은 말기가 아니다
        if n <= 2 or not np.isfinite(r2):
            continue

        adj = 1.0 - (1.0 - r2) * (n - 1) / (n - 2)
        candidate = LambdaZ(
            value=-slope,
            intercept=intercept,
            n_points=n,
            t_first=float(ts[0]),
            t_last=float(ts[-1]),
            r_squared=r2,
            adj_r_squared=adj,
        )
        if best is None or adj > (best.adj_r_squared or -np.inf) + 1e-4:
            best = candidate
        elif abs(adj - (best.adj_r_squared or -np.inf)) <= 1e-4 and n > best.n_points:
            best = candidate

    return best or LambdaZ()


def back_extrapolate_c0(
    time: Sequence[float], conc: Sequence[float]
) -> Optional[float]:
    """정맥 볼루스에서 t=0 농도를 역외삽한다.

    첫 채혈이 0시점이 아니면 그 앞의 넓이가 통째로 빠진다. 볼루스는 t=0 에
    최고 농도를 갖는 것이 정의이므로, 감소하는 첫 두 점의 로그선형 기울기로
    C0 를 되돌려 그 구간을 메운다. WinNonlin 도 같은 방식을 쓴다.

    되돌릴 수 없으면(첫 두 점이 감소하지 않는 등) None.
    """
    t, c = _clean(time, conc)
    if t.size < 2 or t[0] <= 0:
        return None
    if not (c[0] > 0 and c[1] > 0 and c[1] < c[0]):
        return None
    k = (np.log(c[0]) - np.log(c[1])) / (t[1] - t[0])
    return float(np.exp(np.log(c[0]) + k * t[0]))


# ---------------------------------------------------------------------------
# 결과
# ---------------------------------------------------------------------------
@dataclass
class NCAResult:
    """한 프로파일의 NCA 결과. 값이 정의되지 않으면 None 이다."""

    # 관찰값에서 직접
    c_max: Optional[float] = None
    t_max: Optional[float] = None
    c_last: Optional[float] = None
    t_last: Optional[float] = None

    # 말기 구간
    lambda_z: Optional[float] = None
    half_life: Optional[float] = None
    lambda_z_n_points: int = 0
    lambda_z_t_first: Optional[float] = None
    lambda_z_t_last: Optional[float] = None
    lambda_z_adj_r_squared: Optional[float] = None

    # 노출량
    auc_last: Optional[float] = None
    auc_inf_obs: Optional[float] = None
    auc_inf_pred: Optional[float] = None
    auc_extrap_pct: Optional[float] = None
    aumc_last: Optional[float] = None
    aumc_inf: Optional[float] = None

    # 용량이 필요한 항목
    cl: Optional[float] = None
    vz: Optional[float] = None
    mrt: Optional[float] = None
    vss: Optional[float] = None

    # 어떻게 계산했는지
    method: str = AUCMethod.LINEAR_LOG.value
    administration: str = Administration.IV_BOLUS.value
    dose: Optional[float] = None
    #: IV 볼루스에서 t=0 농도를 역외삽했다면 그 값
    c0_back_extrapolated: Optional[float] = None
    #: 이 결과가 곡선 직접 적분인지(NCA 가정 없음) 표시
    direct_integration: bool = False
    warnings: List[str] = field(default_factory=list)

    def as_dict(self) -> Dict[str, object]:
        return asdict(self)


def _f(x) -> Optional[float]:
    """유한한 값만 남기고 나머지는 None (JSON 으로 그대로 나가도록)."""
    if x is None:
        return None
    x = float(x)
    return x if np.isfinite(x) else None


def nca(
    time: Sequence[float],
    conc: Sequence[float],
    dose: Optional[float] = None,
    method: AUCMethod = AUCMethod.LINEAR_LOG,
    administration: Administration = Administration.IV_BOLUS,
    infusion_duration: float = 0.0,
    min_lambda_z_points: int = 3,
) -> NCAResult:
    """시간-농도 프로파일 하나에 대한 비구획 분석.

    dose 를 주지 않으면 용량이 필요한 항목(CL, Vz, Vss)은 None 으로 남고
    나머지는 모두 계산된다.
    """
    t, c = _clean(time, conc)
    res = NCAResult(
        method=method.value,
        administration=administration.value,
        dose=_f(dose),
    )
    if t.size < 2:
        res.warnings.append("Not enough points to analyse.")
        return res

    # --- 볼루스면 t=0 을 되살린다 -----------------------------------------
    if administration is Administration.IV_BOLUS and t[0] > 0:
        c0 = back_extrapolate_c0(t, c)
        if c0 is not None:
            res.c0_back_extrapolated = _f(c0)
            t = np.concatenate(([0.0], t))
            c = np.concatenate(([c0], c))
        else:
            res.warnings.append(
                "No sample at time 0 and C0 could not be back-extrapolated; "
                "AUC misses the interval before the first sample."
            )

    # --- 관찰값에서 직접 -----------------------------------------------
    i_max = int(np.argmax(c))
    res.c_max = _f(c[i_max])
    res.t_max = _f(t[i_max])

    positive = np.flatnonzero(c > 0)
    if positive.size:
        i_last = int(positive[-1])
        res.c_last = _f(c[i_last])
        res.t_last = _f(t[i_last])

    # --- 말기 구간 -------------------------------------------------------
    lz = best_fit_lambda_z(t, c, min_points=min_lambda_z_points)
    if lz.ok:
        res.lambda_z = _f(lz.value)
        res.half_life = _f(np.log(2.0) / lz.value)
        res.lambda_z_n_points = lz.n_points
        res.lambda_z_t_first = _f(lz.t_first)
        res.lambda_z_t_last = _f(lz.t_last)
        res.lambda_z_adj_r_squared = _f(lz.adj_r_squared)
    else:
        res.warnings.append("Terminal slope could not be estimated.")

    # --- 노출량 -----------------------------------------------------------
    res.auc_last = _f(auc(t, c, method))
    res.aumc_last = _f(aumc(t, c, method))

    if lz.ok and res.auc_last is not None and res.c_last is not None:
        res.auc_inf_obs = _f(res.auc_last + res.c_last / lz.value)
        c_last_pred = lz.predict(res.t_last)
        res.auc_inf_pred = _f(res.auc_last + c_last_pred / lz.value)

        if res.aumc_last is not None:
            res.aumc_inf = _f(
                res.aumc_last
                + res.t_last * res.c_last / lz.value
                + res.c_last / lz.value ** 2
            )

        if res.auc_inf_obs:
            extrap = 100.0 * (res.auc_inf_obs - res.auc_last) / res.auc_inf_obs
            res.auc_extrap_pct = _f(extrap)
            if extrap > 20.0:
                res.warnings.append(
                    f"{extrap:.0f}% of AUC is extrapolated — observe longer if you can."
                )

    # --- 용량이 필요한 항목 ------------------------------------------------
    if dose and dose > 0 and res.auc_inf_obs:
        res.cl = _f(dose / res.auc_inf_obs)
        if lz.ok:
            res.vz = _f(dose / (lz.value * res.auc_inf_obs))

        if res.aumc_inf is not None:
            mrt = res.aumc_inf / res.auc_inf_obs
            # 주입은 투여 자체가 시간을 쓰므로 그만큼 빼 준다.
            if administration is Administration.IV_INFUSION and infusion_duration > 0:
                mrt -= infusion_duration / 2.0
            res.mrt = _f(mrt)

            # Vss 는 정맥 투여에서만 뜻이 있다. 혈관외는 F 를 모르기 때문.
            if administration is not Administration.EXTRAVASCULAR and res.cl and res.mrt:
                res.vss = _f(res.cl * res.mrt)

    return res


# ---------------------------------------------------------------------------
# 정상상태 (반복 투여)
# ---------------------------------------------------------------------------
def _limit_from_inside(
    t_in: np.ndarray, c_in: np.ndarray, at: float, from_start: bool
) -> float:
    """구간 안쪽 두 점만으로 경계 농도를 세운다.

    투여 간격의 경계는 투여 시각이라 농도가 불연속일 수 있다. 그런데 격자에
    그 시각의 점이 있어도 그것이 투여 직전 값인지 직후 값인지는 배열만 봐서는
    알 수 없다 — 이 앱의 솔버는 직전 값을 넣고, 손으로 만든 배열은 직후 값을
    넣기도 한다. 어느 쪽을 집어도 절반은 틀린다.

    그래서 경계값을 바깥에서 가져오지 않고 안쪽에서 뻗어 만든다. 시작 경계는
    투여 직후 값이, 끝 경계는 다음 투여 직전 값이 나오는데 둘 다 이 구간에
    속한 값이므로 정의상 맞다. 내려가는 구간에서는 로그선형으로 뻗는다 —
    소실이 지수적이므로 선형보다 정확하고, IV 볼루스 직후의 C0 역외삽과
    같은 계산이다.
    """
    if t_in.size == 0:
        return float("nan")
    if t_in.size == 1:
        return float(c_in[0])

    if from_start:
        ta, ca, tb, cb = t_in[0], c_in[0], t_in[1], c_in[1]
    else:
        ta, ca, tb, cb = t_in[-1], c_in[-1], t_in[-2], c_in[-2]
    if tb == ta:
        return float(ca)

    declining = (ca - cb) / (ta - tb) < 0 if from_start else (cb - ca) / (tb - ta) < 0
    if declining and ca > 0 and cb > 0:
        k = (np.log(cb) - np.log(ca)) / (tb - ta)
        return float(np.exp(np.log(ca) + k * (at - ta)))
    slope = (cb - ca) / (tb - ta)
    return float(ca + slope * (at - ta))


def clip_interval(
    time: Sequence[float], conc: Sequence[float], t0: float, t1: float
) -> Tuple[np.ndarray, np.ndarray]:
    """[t0, t1] 만 잘라 낸다. 양 끝은 구간 안쪽에서 세워 붙인다.

    격자가 경계에 딱 떨어지지 않으면 자투리 사다리꼴이 통째로 빠져 AUCτ 가
    적게 나오므로 경계점은 반드시 있어야 한다. 그 값을 어떻게 정하는지는
    _limit_from_inside 참고 — 경계에 걸친 점은 쓰지 않는다.
    """
    t, c = _clean(time, conc)
    if t.size < 2 or not (t1 > t0):
        return np.empty(0), np.empty(0)
    if t0 < t[0] - 1e-12 or t1 > t[-1] + 1e-12:
        return np.empty(0), np.empty(0)

    eps = 1e-9 * max(abs(t0), abs(t1), 1.0)
    inside = (t > t0 + eps) & (t < t1 - eps)
    t_in, c_in = t[inside], c[inside]
    if t_in.size == 0:
        return np.empty(0), np.empty(0)

    out_t = np.concatenate(([t0], t_in, [t1]))
    out_c = np.concatenate((
        [_limit_from_inside(t_in, c_in, t0, from_start=True)],
        c_in,
        [_limit_from_inside(t_in, c_in, t1, from_start=False)],
    ))
    keep = np.isfinite(out_t) & np.isfinite(out_c)
    return out_t[keep], out_c[keep]


@dataclass
class SteadyStateResult:
    """한 투여 간격에 대한 정상상태 요약. 값이 정의되지 않으면 None 이다."""

    #: 투여 간격
    tau: Optional[float] = None
    #: 실제로 분석한 구간
    interval_start: Optional[float] = None
    interval_end: Optional[float] = None
    #: 자료 안에 들어 있는 완전한 투여 간격의 수
    n_intervals: int = 0

    # 구간 안에서 직접
    c_max: Optional[float] = None
    t_max: Optional[float] = None
    c_min: Optional[float] = None
    t_min: Optional[float] = None
    #: 다음 투여 직전 농도. 단순한 곡선에서는 c_min 과 같지만 항상은 아니다.
    c_trough: Optional[float] = None

    # 노출량
    auc_tau: Optional[float] = None
    aumc_tau: Optional[float] = None
    c_avg: Optional[float] = None

    # 변동
    fluctuation_pct: Optional[float] = None
    swing: Optional[float] = None

    # 축적
    accumulation_auc: Optional[float] = None
    accumulation_c_max: Optional[float] = None

    # 용량이 필요한 항목
    cl_ss: Optional[float] = None
    vz_ss: Optional[float] = None

    # 정상상태에 도달했는가
    at_steady_state: Optional[bool] = None
    #: 마지막 두 구간의 AUCτ 가 몇 % 차이 나는가
    interval_change_pct: Optional[float] = None

    method: str = AUCMethod.LINEAR_LOG.value
    dose: Optional[float] = None
    warnings: List[str] = field(default_factory=list)

    def as_dict(self) -> Dict[str, object]:
        return asdict(self)


def nca_steady_state(
    time: Sequence[float],
    conc: Sequence[float],
    tau: float,
    dose: Optional[float] = None,
    first_dose_time: float = 0.0,
    last_dose_time: Optional[float] = None,
    lambda_z: Optional[float] = None,
    method: AUCMethod = AUCMethod.LINEAR_LOG,
    tolerance_pct: float = 1.0,
) -> SteadyStateResult:
    """반복 투여 곡선에서 한 투여 간격을 정상상태로 요약한다.

    단회 투여 지표(AUC0-∞, Vz, MRT)는 반복 투여에서 뜻을 잃는다. 곡선이
    한 번 올라갔다 내려오는 것이 아니라 톱니처럼 이어지므로, 전체를 적분한
    값은 노출량이 아니라 그저 "시뮬레이션을 얼마나 오래 돌렸는가" 이다.
    정상상태에서는 대신 한 투여 간격을 보고, 그 간격이 반복된다고 본다.

    분석하는 구간은 마지막 투여부터 τ 동안이다. 정상상태에서는 모든 간격이
    같으므로 어느 것을 골라도 되지만, 마지막 투여 직후가 도달에 가장 가깝다.
    자료가 거기까지 미치지 않으면 자료 안에 온전히 들어오는 마지막 간격으로
    물러선다.

    도달 여부는 마지막 두 간격의 AUCτ 를 비교해 판정한다. 아직 오르는
    중이면 값은 그대로 돌려주되 정상상태가 아니라고 표시한다 — 계산을
    거절하는 것보다 무엇을 보고 있는지 알려 주는 편이 쓸모 있다.
    """
    res = SteadyStateResult(tau=_f(tau), method=method.value, dose=_f(dose))

    t, c = _clean(time, conc)
    if t.size < 2 or not (tau > 0):
        res.warnings.append("Not enough data, or a non-positive dosing interval.")
        return res

    # 자료 안에 온전히 들어오는 투여 간격들의 시작 시각
    starts: List[float] = []
    k = 0
    while True:
        t0 = first_dose_time + k * tau
        if t0 + tau > t[-1] + 1e-9:
            break
        if t0 >= t[0] - 1e-9:
            starts.append(t0)
        k += 1
        if k > 10000:  # 방어
            break

    if not starts:
        res.warnings.append(
            "The profile does not cover a whole dosing interval — "
            "simulate for at least one interval past the last dose."
        )
        return res

    res.n_intervals = len(starts)

    # 마지막 투여부터 τ 를 우선하되, 자료가 미치지 않으면 마지막 온전한 간격.
    chosen = starts[-1]
    if last_dose_time is not None:
        for t0 in starts:
            if abs(t0 - last_dose_time) < 1e-9:
                chosen = t0
                break

    def interval_auc(t0: float) -> float:
        it, ic = clip_interval(t, c, t0, t0 + tau)
        return auc(it, ic, method=method) if it.size >= 2 else float("nan")

    it, ic = clip_interval(t, c, chosen, chosen + tau)
    if it.size < 2:
        res.warnings.append("Could not isolate the dosing interval.")
        return res

    res.interval_start = _f(chosen)
    res.interval_end = _f(chosen + tau)

    res.auc_tau = _f(auc(it, ic, method=method))
    res.aumc_tau = _f(aumc(it, ic, method=method))

    imax = int(np.argmax(ic))
    imin = int(np.argmin(ic))
    res.c_max = _f(ic[imax])
    res.t_max = _f(it[imax])
    res.c_min = _f(ic[imin])
    res.t_min = _f(it[imin])
    res.c_trough = _f(ic[-1])

    if res.auc_tau:
        res.c_avg = _f(res.auc_tau / tau)
    if res.c_avg and res.c_max is not None and res.c_min is not None:
        res.fluctuation_pct = _f((res.c_max - res.c_min) / res.c_avg * 100.0)
    if res.c_min and res.c_max is not None:
        res.swing = _f((res.c_max - res.c_min) / res.c_min)

    # 축적비 — 첫 간격 대비. 첫 간격이 자료 안에 있어야 낼 수 있다.
    if starts and abs(starts[0] - first_dose_time) < 1e-9 and chosen != starts[0]:
        first_auc = interval_auc(starts[0])
        if np.isfinite(first_auc) and first_auc > 0 and res.auc_tau:
            res.accumulation_auc = _f(res.auc_tau / first_auc)
        ft, fc = clip_interval(t, c, starts[0], starts[0] + tau)
        if fc.size and fc.max() > 0 and res.c_max is not None:
            res.accumulation_c_max = _f(res.c_max / float(fc.max()))

    # 도달 판정 — 분석한 간격과 그 앞 간격의 AUCτ 를 비교한다.
    prev = chosen - tau
    if prev >= first_dose_time - 1e-9 and prev >= t[0] - 1e-9:
        prev_auc = interval_auc(prev)
        if np.isfinite(prev_auc) and prev_auc > 0 and res.auc_tau:
            change = abs(res.auc_tau - prev_auc) / prev_auc * 100.0
            res.interval_change_pct = _f(change)
            res.at_steady_state = bool(change <= tolerance_pct)
            if not res.at_steady_state:
                res.warnings.append(
                    "Not at steady state yet — AUCtau is still changing by "
                    f"{change:.1f}% between consecutive intervals. "
                    "Dose for longer before reading these numbers."
                )
    else:
        res.warnings.append(
            "Only one dosing interval is available, so steady state "
            "could not be confirmed."
        )

    if dose and res.auc_tau:
        res.cl_ss = _f(dose / res.auc_tau)
        if lambda_z:
            res.vz_ss = _f(dose / (lambda_z * res.auc_tau))

    return res
