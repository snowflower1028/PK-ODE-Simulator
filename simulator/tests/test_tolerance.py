"""솔버의 절대 허용오차(atol)가 상태의 규모를 따라가는가.

예전에는 모든 구획에 `atol=1e-11` 하나를 썼다.  상태가 1e-9 규모(nmol,
µg/L 로 쓴 모델)면 atol 이 상태보다 커서 솔버가 곡선을 대충 따라갔다.
같은 1구획 소실을 단위만 바꿔 푼 측정값 (C(t)/C(0) 의 최대 상대오차):

    A(0)=1e+00   4.74e-08
    A(0)=1e-09   4.56e-02      ← 4.6% 틀림
    A(0)=1e-09, 10 반감기까지   4.79e+04  ← 소실 꼬리가 무의미한 숫자

규칙은 `atol_i = min(1e-11, scale_i * 1e-11)` 이라 **느슨해지는 구획은 없다**.
그래서 여기 시험은 두 방향을 모두 본다 — 작은 규모가 살아나는지, 그리고
큰 규모의 결과가 한 비트도 움직이지 않는지.
"""
import numpy as np
from django.test import SimpleTestCase

from simulator.parser import parse_ode_input
from simulator.solver import (
    _BASE_ATOL,
    _absolute_tolerances,
    generate_rhs_function,
    solve_ode_system,
)


def _run(ode, params, init, t_span, t_eval, doses=()):
    parsed = parse_ode_input(ode)
    rhs = generate_rhs_function(
        parsed["equations"], parsed["compartments"], parsed["parameters"]
    )
    return solve_ode_system(
        rhs, parsed["compartments"], parsed["parameters"], init, params,
        t_span, np.asarray(t_eval, dtype=float), list(doses),
    )


#: 수정 전 솔버(b793b80, 공통 atol=1e-11)로 `test_mg_규모_결과가_한_비트도_움직이지_않는다`
#: 의 입력을 풀어 얻은 Ac(24).  mg 규모에서는 atol 이 그대로이므로 비트 단위로
#: 같아야 한다.  이 값이 바뀌면 규칙이 기준 규모를 건드린 것이다.
REFERENCE_AC_24 = 80.93189477558998


class 규모에_따른_정확도(SimpleTestCase):
    K = 0.1

    def _decay_error(self, a0, t_end=60.0, n=7):
        t = np.linspace(0.0, t_end, n)
        df = _run("dAdt = -k*A", {"k": self.K}, {"A": a0}, (0.0, t_end), t)
        got = df["A"].to_numpy()
        want = a0 * np.exp(-self.K * t)
        return float(np.max(np.abs(got - want) / want))

    def test_nmol_규모의_1구획_소실이_mg_규모와_같은_정확도(self):
        """예전 4.56e-02 → 지금 mg 규모와 같은 1e-7 이하."""
        for a0 in (1e-12, 1e-9, 1e-6, 1e-3):
            with self.subTest(a0=a0):
                self.assertLess(self._decay_error(a0), 1e-7)

    def test_nmol_규모의_소실_꼬리(self):
        """10 반감기 꼬리. 예전 4.79e+04 — λz·반감기가 여기서 나온다."""
        self.assertLess(self._decay_error(1e-9, t_end=200.0, n=11), 1e-3)
        # mg 규모와 같은 수준이어야 한다
        self.assertAlmostEqual(
            self._decay_error(1e-9, t_end=200.0, n=11),
            self._decay_error(1.0, t_end=200.0, n=11),
            delta=1e-6,
        )

    def test_경구_nmol_중심구획은_투여받지_않아도_조여진다(self):
        """중심 구획은 초기값 0 에 직접 투여도 없어 규모를 모른다.

        이 구획이 1e-11 을 쓰면 흡수 구획만 조여지고 정작 관측하는 곡선은
        그대로 무너진다(해석해 대비 3.8e-01).  알려진 가장 작은 규모를
        물려받아야 한다.
        """
        ka, k, dose = 1.2, 0.1, 1e-9
        t = np.array([1.0, 5.0, 20.0, 60.0])
        df = _run(
            "dAgdt = -ka*Ag\ndAcdt = ka*Ag - k*Ac",
            {"ka": ka, "k": k}, {"Ag": 0.0, "Ac": 0.0}, (0.0, 60.0), t,
            [{"compartment": "Ag", "type": "bolus", "amount": dose, "start_time": 0}],
        )
        want = dose * ka / (ka - k) * (np.exp(-k * t) - np.exp(-ka * t))
        err = np.max(np.abs(df["Ac"].to_numpy() - want) / want)
        self.assertLess(err, 1e-6)

    def test_nmol_주입(self):
        """주입도 투여량에서 규모를 얻는다."""
        k, amount, dur = 0.1, 1e-9, 2.0
        t = np.array([1.0, 2.0, 10.0, 40.0])
        df = _run(
            "dAdt = -k*A", {"k": k}, {"A": 0.0}, (0.0, 40.0), t,
            [{"compartment": "A", "type": "infusion", "amount": amount,
              "duration": dur, "start_time": 0}],
        )
        r = amount / dur
        want = np.where(
            t <= dur,
            r / k * (1 - np.exp(-k * t)),
            r / k * (1 - np.exp(-k * dur)) * np.exp(-k * (t - dur)),
        )
        err = np.max(np.abs(df["A"].to_numpy() - want) / want)
        self.assertLess(err, 1e-6)


class 느슨해지지_않는다(SimpleTestCase):
    """규모가 1 이상이면 예전과 완전히 같은 atol 이다 — 결과가 움직일 수 없다."""

    def _atol(self, y0, doses=(), comps=("A", "B")):
        return _absolute_tolerances(
            np.asarray(y0, dtype=float), list(doses),
            {c: i for i, c in enumerate(comps)},
        )

    def test_어떤_구획도_기준값보다_크지_않다(self):
        for y0 in ([0, 0], [1, 0], [1e12, 5], [1e-9, 1e6], [np.inf, 1]):
            with self.subTest(y0=y0):
                self.assertTrue(np.all(self._atol(y0) <= _BASE_ATOL))

    def test_mg_규모는_기준값_그대로(self):
        np.testing.assert_array_equal(self._atol([100.0, 0.0]), [_BASE_ATOL] * 2)
        np.testing.assert_array_equal(
            self._atol([0, 0], [{"compartment": "A", "amount": 250}]),
            [_BASE_ATOL] * 2,
        )

    def test_정보가_없으면_기준값(self):
        np.testing.assert_array_equal(self._atol([0.0, 0.0]), [_BASE_ATOL] * 2)

    def test_작은_규모만_조이고_미상은_가장_작은_규모를_물려받는다(self):
        atol = self._atol([0, 0], [{"compartment": "A", "amount": 1e-9}])
        np.testing.assert_allclose(atol, [1e-20, 1e-20])
        # 섞인 규모: 큰 쪽은 그대로, 작은 쪽만 조인다
        atol = self._atol([100.0, 1e-9])
        np.testing.assert_allclose(atol, [_BASE_ATOL, 1e-20])

    def test_바닥_아래로_내려가지_않는다(self):
        atol = self._atol([1e-310, 0.0])
        self.assertTrue(np.all(atol >= 1e-300))

    def test_mg_규모_결과가_한_비트도_움직이지_않는다(self):
        """같은 atol 이면 같은 계산이다. 기준 규모의 대표 모델로 확인."""
        t = np.linspace(0, 24, 49)
        doses = [{"compartment": "Ag", "type": "bolus", "amount": 100,
                  "start_time": 0, "repeat_every": 8, "repeat_until": 16}]
        df = _run("dAgdt = -ka*Ag\ndAcdt = ka*Ag - k*Ac",
                  {"ka": 1.2, "k": 0.1}, {"Ag": 0.0, "Ac": 0.0}, (0, 24), t, doses)
        # 수정 전 코드(b793b80)로 같은 입력을 풀어 얻은 값
        self.assertEqual(float(df["Ac"].iloc[-1]), REFERENCE_AC_24)
