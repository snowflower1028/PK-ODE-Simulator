"""
units.py  ──  NCA 결과의 단위 셈
=================================

nca.py 와 같은 규칙으로 만들었다. Django 도, 이 프로젝트의 다른 모듈도
import 하지 않는다 — numpy 조차 쓰지 않는다.

왜 이렇게 만들었나
------------------
NCA 가 내놓는 값은 하나도 빠짐없이 세 단위의 곱이다. 농도(C), 시간(T),
용량(D) 세 개뿐이다.

    Cmax = C          AUC  = C·T        CL = D/(C·T)
    t½   = T          AUMC = C·T²       Vz = D/C
    λz   = 1/T        Cmax/D = C/D      MRT = T

그래서 각 항목의 단위를 (C 의 지수, T 의 지수, D 의 지수) 세 정수로 적을 수
있다. 식을 파싱할 필요도, 단위 대수를 일반적으로 구현할 필요도 없다.

이 표현이 주는 것이 하나 더 있다. 단위를 바꿀 때 필요한 것이 곱셈 하나뿐이
된다는 것이다:

    value × (C_입력/C_표시)^c · (T_입력/T_표시)^t · (D_입력/D_표시)^d

계산을 다시 돌리지 않아도 된다는 뜻이고, 그래서 사용자가 손으로 고른 λz
구간이 단위를 바꿨다고 흐트러지지 않는다.

질량과 몰
---------
두 계열은 분자량 없이는 오갈 수 없다. 분자량을 주지 않으면 환산을 거절한다.
틀린 숫자를 조용히 내놓느니 못 한다고 말하는 편이 낫다.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

__all__ = [
    "Dimension",
    "Unit",
    "Composed",
    "FIELD_UNITS",
    "parse_unit",
    "concentration_unit",
    "field_unit",
    "convert",
    "scale_factor",
    "display_options",
    "UnitError",
]


class UnitError(ValueError):
    """단위를 세울 수 없거나, 세울 수 있어도 오갈 수 없을 때."""


# ---------------------------------------------------------------------------
# 차원
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class Dimension:
    """기준 차원의 지수. 질량과 몰은 분자량 없이 섞이지 않으므로 따로 센다."""

    mass: int = 0
    mole: int = 0
    volume: int = 0
    time: int = 0

    def __mul__(self, other: "Dimension") -> "Dimension":
        return Dimension(self.mass + other.mass, self.mole + other.mole,
                         self.volume + other.volume, self.time + other.time)

    def __truediv__(self, other: "Dimension") -> "Dimension":
        return Dimension(self.mass - other.mass, self.mole - other.mole,
                         self.volume - other.volume, self.time - other.time)

    def __pow__(self, n: int) -> "Dimension":
        return Dimension(self.mass * n, self.mole * n,
                         self.volume * n, self.time * n)

    @property
    def is_dimensionless(self) -> bool:
        return self == Dimension()


#: 기준 단위 — mg, µmol, L, h. 어떤 조합이든 일관되기만 하면 된다.
MASS = Dimension(mass=1)
MOLE = Dimension(mole=1)
VOLUME = Dimension(volume=1)
TIME = Dimension(time=1)


@dataclass(frozen=True)
class Unit:
    """이름과, 기준 단위로 재었을 때의 크기와, 차원."""

    label: str
    factor: float
    dim: Dimension

    def __mul__(self, other: "Unit") -> "Unit":
        return Unit(f"{self.label}·{other.label}", self.factor * other.factor,
                    self.dim * other.dim)

    def __pow__(self, n: int) -> "Unit":
        label = self.label if n == 1 else f"{self.label}^{n}"
        return Unit(label, self.factor ** n, self.dim ** n)


# ---------------------------------------------------------------------------
# 등록된 단위
# ---------------------------------------------------------------------------
def _u(label: str, factor: float, dim: Dimension) -> Unit:
    return Unit(label, factor, dim)


_MASS: Dict[str, Unit] = {
    "pg": _u("pg", 1e-9, MASS), "ng": _u("ng", 1e-6, MASS),
    "ug": _u("µg", 1e-3, MASS), "mg": _u("mg", 1.0, MASS),
    "g": _u("g", 1e3, MASS), "kg": _u("kg", 1e6, MASS),
}
_MOLE: Dict[str, Unit] = {
    "pmol": _u("pmol", 1e-6, MOLE), "nmol": _u("nmol", 1e-3, MOLE),
    "umol": _u("µmol", 1.0, MOLE), "mmol": _u("mmol", 1e3, MOLE),
    "mol": _u("mol", 1e6, MOLE),
}
_VOLUME: Dict[str, Unit] = {
    "ul": _u("µL", 1e-6, VOLUME), "ml": _u("mL", 1e-3, VOLUME),
    "dl": _u("dL", 1e-1, VOLUME), "l": _u("L", 1.0, VOLUME),
}
_TIME: Dict[str, Unit] = {
    "s": _u("s", 1.0 / 3600.0, TIME), "sec": _u("s", 1.0 / 3600.0, TIME),
    "min": _u("min", 1.0 / 60.0, TIME),
    "h": _u("h", 1.0, TIME), "hr": _u("h", 1.0, TIME),
    "day": _u("day", 24.0, TIME), "d": _u("day", 24.0, TIME),
    "week": _u("week", 168.0, TIME),
}

#: 몰농도 약칭. nM 은 nmol/L 이다.
_MOLAR_SHORTHAND = {
    "pm": ("pmol", "l"), "nm": ("nmol", "l"),
    "um": ("umol", "l"), "mm": ("mmol", "l"), "m": ("mol", "l"),
}


def _normalise(text: str) -> str:
    """µ 의 여러 표기와 대소문자를 하나로 모은다."""
    return (
        str(text).strip()
        .replace("μ", "u")   # 그리스 소문자 뮤
        .replace("µ", "u")   # MICRO SIGN
        .lower()
    )


def _simple(key: str) -> Optional[Unit]:
    """등록된 홑단위 하나를 찾는다."""
    for table in (_MASS, _MOLE, _VOLUME, _TIME):
        if key in table:
            return table[key]
    return None


def parse_unit(text: str) -> Unit:
    """단위 하나를 세운다.

    홑단위(mg, L, h)와 'a/b' 꼴을 모두 받는다. 뒤쪽은 농도(ng/mL)만이 아니라
    청소율(L/h)도 같은 자리에 들어오므로 두 홑단위의 나눗셈으로 일반화했다.
    """
    key = _normalise(text)
    if not key:
        raise UnitError("A unit is required.")

    found = _simple(key)
    if found is not None:
        return found

    if key in _MOLAR_SHORTHAND:
        amount, volume = _MOLAR_SHORTHAND[key]
        return concentration_unit(amount, volume)

    if "/" in key:
        top_key, _, bottom_key = key.partition("/")
        top, bottom = _simple(top_key), _simple(bottom_key)
        if top is None:
            raise UnitError(f"Unrecognised unit: {top_key!r} in {text!r}")
        if bottom is None:
            raise UnitError(f"Unrecognised unit: {bottom_key!r} in {text!r}")
        return Unit(f"{top.label}/{bottom.label}",
                    top.factor / bottom.factor, top.dim / bottom.dim)

    raise UnitError(f"Unrecognised unit: {text!r}")


def concentration_unit(amount: str, volume: str) -> Unit:
    """농도 = 양/부피."""
    a_key, v_key = _normalise(amount), _normalise(volume)
    a = _MASS.get(a_key) or _MOLE.get(a_key)
    v = _VOLUME.get(v_key)
    if a is None:
        raise UnitError(f"Unrecognised amount unit: {amount!r}")
    if v is None:
        raise UnitError(f"Unrecognised volume unit: {volume!r}")
    return Unit(f"{a.label}/{v.label}", a.factor / v.factor, a.dim / v.dim)


# ---------------------------------------------------------------------------
# 각 항목이 C·T·D 를 몇 제곱씩 쓰는가
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class Composed:
    """농도·시간·용량의 지수. 이 셋이면 NCA 의 모든 출력을 적을 수 있다."""

    conc: int = 0
    time: int = 0
    dose: int = 0

    @property
    def is_dimensionless(self) -> bool:
        return self == Composed()


_C = Composed(conc=1)
_T = Composed(time=1)

#: 항목 이름 → 단위 조합. 여기 없는 항목은 무차원(비율·백분율·개수)이다.
FIELD_UNITS: Dict[str, Composed] = {
    # 농도
    "c_max": _C, "c_last": _C, "c_last_pred": _C, "c0_back_extrapolated": _C,
    "ss_c_max": _C, "ss_c_min": _C, "ss_c_trough": _C, "ss_c_avg": _C,
    # 시간
    "t_max": _T, "t_last": _T, "half_life": _T, "mrt": _T, "mrt_last": _T,
    "lambda_z_t_first": _T, "lambda_z_t_last": _T,
    "ss_t_max": _T, "ss_t_min": _T, "ss_tau": _T,
    "ss_interval_start": _T, "ss_interval_end": _T,
    # 1/시간
    "lambda_z": Composed(time=-1),
    # 넓이
    "auc_last": Composed(conc=1, time=1),
    "auc_all": Composed(conc=1, time=1),
    "auc_inf_obs": Composed(conc=1, time=1),
    "auc_inf_pred": Composed(conc=1, time=1),
    "ss_auc_tau": Composed(conc=1, time=1),
    "aumc_last": Composed(conc=1, time=2),
    "aumc_inf": Composed(conc=1, time=2),
    "ss_aumc_tau": Composed(conc=1, time=2),
    # 용량
    "dose": Composed(dose=1),
    # 청소율과 분포용적
    "cl": Composed(dose=1, conc=-1, time=-1),
    "ss_cl": Composed(dose=1, conc=-1, time=-1),
    "vz": Composed(dose=1, conc=-1),
    "vss": Composed(dose=1, conc=-1),
    "ss_vz": Composed(dose=1, conc=-1),
    # 용량으로 나눈 값
    "c_max_dn": Composed(conc=1, dose=-1),
    "auc_last_dn": Composed(conc=1, time=1, dose=-1),
    "auc_inf_obs_dn": Composed(conc=1, time=1, dose=-1),
}


def field_unit(field: str, conc: Unit, time: Unit, dose: Unit) -> Optional[Unit]:
    """항목 하나의 단위를 입력 단위로부터 조립한다. 무차원이면 None."""
    shape = FIELD_UNITS.get(field)
    if shape is None or shape.is_dimensionless:
        return None
    return _compose(shape, conc, time, dose)


def _compose(shape: Composed, conc: Unit, time: Unit, dose: Unit) -> Unit:
    factor = (conc.factor ** shape.conc) * (time.factor ** shape.time) * (
        dose.factor ** shape.dose)
    dim = (conc.dim ** shape.conc) * (time.dim ** shape.time) * (
        dose.dim ** shape.dose)
    return Unit(_label(shape, conc, time, dose), factor, dim)


def _label(shape: Composed, conc: Unit, time: Unit, dose: Unit) -> str:
    top: List[str] = []
    bottom: List[str] = []
    for unit, power in ((dose, shape.dose), (conc, shape.conc), (time, shape.time)):
        if power == 0:
            continue
        piece = unit.label if abs(power) == 1 else f"{unit.label}^{abs(power)}"
        if "/" in piece:
            piece = f"({piece})"
        (top if power > 0 else bottom).append(piece)

    head = "·".join(top) if top else "1"
    if not bottom:
        return head
    tail = "·".join(bottom)
    if len(bottom) > 1:
        tail = f"({tail})"
    return f"{head}/{tail}"


# ---------------------------------------------------------------------------
# 환산
# ---------------------------------------------------------------------------
def scale_factor(frm: Unit, to: Unit, mw: Optional[float] = None) -> float:
    """frm 으로 잰 값에 곱하면 to 로 잰 값이 되는 수.

    질량과 몰이 갈리면 분자량(g/mol)이 필요하다. 없으면 거절한다.
    """
    gap = frm.dim / to.dim
    if gap.volume or gap.time:
        raise UnitError(
            f"{frm.label} and {to.label} are not the same kind of quantity."
        )

    if gap.mass == 0 and gap.mole == 0:
        return frm.factor / to.factor

    if gap.mass != -gap.mole:
        raise UnitError(
            f"{frm.label} and {to.label} are not the same kind of quantity."
        )
    if not mw or mw <= 0:
        raise UnitError(
            f"Converting {frm.label} to {to.label} crosses mass and moles, "
            "which needs a molecular weight."
        )

    # 기준 질량은 mg, 기준 몰은 µmol.  1 mg = (1e3 / MW) µmol
    per_mg = 1e3 / float(mw)
    return (frm.factor / to.factor) * (per_mg ** gap.mass)


def convert(value: Optional[float], frm: Unit, to: Unit,
            mw: Optional[float] = None) -> Optional[float]:
    """값 하나를 옮긴다. None 은 None 으로 둔다."""
    if value is None:
        return None
    return float(value) * scale_factor(frm, to, mw)


# ---------------------------------------------------------------------------
# 고를 수 있는 단위 목록 (드롭다운용)
# ---------------------------------------------------------------------------
CONCENTRATION_CHOICES: Tuple[str, ...] = (
    "ng/mL", "µg/mL", "mg/L", "µg/L", "ng/L", "pg/mL", "mg/mL", "g/L",
    "nmol/L", "µmol/L", "mmol/L", "pmol/mL",
)
TIME_CHOICES: Tuple[str, ...] = ("h", "min", "day", "s", "week")
DOSE_CHOICES: Tuple[str, ...] = (
    "mg", "µg", "ng", "g", "nmol", "µmol", "mmol", "mol",
)
#: 조합해 놓으면 읽기 어려운 항목은 이 목록에서 고르게 한다.
VOLUME_CHOICES: Tuple[str, ...] = ("L", "mL", "dL")
CLEARANCE_CHOICES: Tuple[str, ...] = ("L/h", "mL/h", "mL/min", "L/day")


def _catalogue(field: str) -> Tuple[str, ...]:
    """이 항목에 어울리는 단위 후보.

    CL 과 Vz 는 조합한 이름이 mg/((ng/mL)·h) 처럼 읽기 어려워진다. 차원은
    부피/시간과 부피라서, 그 자리에는 익숙한 이름을 내놓는다.
    """
    shape = FIELD_UNITS.get(field)
    if shape is None or shape.is_dimensionless:
        return ()
    if shape == Composed(dose=1, conc=-1, time=-1):
        return CLEARANCE_CHOICES
    if shape == Composed(dose=1, conc=-1):
        return VOLUME_CHOICES
    if shape == _C:
        return CONCENTRATION_CHOICES
    if shape == _T:
        return TIME_CHOICES
    if shape == Composed(dose=1):
        return DOSE_CHOICES
    return ()


def display_options(field: str, native: Optional[Unit] = None,
                    mw: Optional[float] = None) -> Tuple[str, ...]:
    """이 항목을 어떤 단위로 보여 줄 수 있는지.

    native 를 주면 실제로 갈 수 있는 곳만 남긴다. 질량으로 잰 농도에 분자량
    없이 nmol/L 을 권해 놓고 고르는 순간 거절하면, 막는다는 약속이 사용자
    눈에는 그냥 고장으로 보인다. 고를 수 없는 것은 아예 내놓지 않는다.
    """
    choices = _catalogue(field)
    if native is None:
        return choices

    reachable: List[str] = []
    for choice in choices:
        try:
            scale_factor(native, parse_unit(choice), mw)
        except UnitError:
            continue
        reachable.append(choice)
    return tuple(reachable)
