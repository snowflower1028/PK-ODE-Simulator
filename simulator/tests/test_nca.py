"""nca.py 검증.

이 모듈은 Django 를 import 하지 않는다. nca.py 자체가 numpy 하나만 쓰도록
만들어져 있고, 나중에 별도의 NCA 앱으로 옮길 때 이 시험도 그대로 따라가야
하기 때문이다. 저장소 루트에서 아래 어느 쪽으로도 돌아간다.

    python -m unittest discover
    python manage.py test simulator

값을 눈으로 확인해 둔 기록이 아니라, 답을 아는 문제로 검증한다. 1-구획
모델은 해석해가 있으므로 AUC, 반감기, CL, Vz, MRT, Vss, 축적비를 전부
닫힌 식과 맞대 볼 수 있다.
"""

import math
import unittest

import numpy as np

from simulator.nca import (
    AUCMethod,
    Administration,
    aumc,
    auc,
    auc_direct,
    back_extrapolate_c0,
    best_fit_lambda_z,
    clip_interval,
    nca,
    nca_steady_state,
)


# ---------------------------------------------------------------------------
# 검증에 쓰는 해석해
# ---------------------------------------------------------------------------
CL, V, KA, DOSE, TAU = 4.0, 32.0, 1.2, 100.0, 12.0
K = CL / V  # 0.125


def iv_bolus(t, dose=DOSE, v=V, k=K):
    """1-구획 정맥 볼루스."""
    return dose / v * np.exp(-k * np.asarray(t, dtype=float))


def oral(t, dose=DOSE, v=V, k=K, ka=KA):
    """1-구획 경구 (1차 흡수). t < 0 이면 0."""
    t = np.asarray(t, dtype=float)
    return np.where(t > 0, dose * ka / (v * (ka - k)) * (np.exp(-k * t) - np.exp(-ka * t)), 0.0)


class AucPrimitives(unittest.TestCase):
    """사다리꼴 적분."""

    def test_auc_direct_matches_analytic_area(self):
        t = np.linspace(0, 48, 4801)
        got = auc_direct(t, iv_bolus(t))
        want = DOSE / V / K * (1 - math.exp(-K * 48))
        self.assertAlmostEqual(got, want, places=5)

    def test_linear_overestimates_a_convex_decay_and_log_does_not(self):
        """소실이 지수적일 때 선형 사다리꼴은 위로 치우친다.

        희소 표본에서 linear-up/log-down 을 기본값으로 두는 이유다.
        """
        t = np.array([0.0, 6.0, 12.0, 24.0, 48.0])
        c = iv_bolus(t)
        exact = DOSE / V / K * (1 - math.exp(-K * 48))
        linear = auc(t, c, method=AUCMethod.LINEAR)
        loglin = auc(t, c, method=AUCMethod.LINEAR_LOG)
        self.assertGreater(linear, exact)
        self.assertAlmostEqual(loglin, exact, places=6)

    def test_log_trapezoid_aumc_is_positive_and_matches_numeric(self):
        """널리 인용되는 (t0*c0 - t1*c1)/ln(c0/c1) 꼴은 부호가 뒤집혀 음수가 된다.

        nca.py 는 그 식을 쓰지 않고 t*C 를 직접 적분해 유도한 식을 쓴다.
        여기서는 촘촘한 수치적분을 정답으로 놓고 맞대 본다.
        """
        t = np.array([0.5, 2.0, 6.0, 12.0, 24.0])
        c = iv_bolus(t)

        dense_t = np.linspace(t[0], t[-1], 200001)
        truth = np.trapezoid(dense_t * iv_bolus(dense_t), dense_t)

        got = aumc(t, c, method=AUCMethod.LINEAR_LOG)
        self.assertGreater(got, 0.0)
        self.assertLess(abs(got - truth) / truth, 0.01)


class LambdaZSelection(unittest.TestCase):
    def test_recovers_the_elimination_rate_constant(self):
        t = np.array([0.5, 1, 2, 4, 8, 12, 24, 36, 48], dtype=float)
        lz = best_fit_lambda_z(t, iv_bolus(t))
        self.assertTrue(lz.ok)
        self.assertAlmostEqual(lz.value, K, places=6)
        self.assertAlmostEqual(math.log(2) / lz.value, math.log(2) / K, places=6)

    def test_excludes_the_absorption_phase(self):
        """Tmax 이전 점이 섞이면 t½ 가 짧게 나온다. 말기만 골라야 한다.

        경구 곡선은 exp(-k t) - exp(-ka t) 이므로 말기에도 흡수 항이 완전히
        사라지지는 않는다. 겉보기 기울기가 k 에서 0.5% 안쪽으로 어긋나는 것은
        모델이 그런 것이지 추정이 틀린 것이 아니다.
        """
        t = np.array([0.25, 0.5, 1, 2, 3, 4, 6, 8, 12, 24, 36, 48], dtype=float)
        lz = best_fit_lambda_z(t, oral(t))
        self.assertTrue(lz.ok)
        self.assertLess(abs(lz.value - K) / K, 0.005)
        t_max = t[int(np.argmax(oral(t)))]
        self.assertGreater(lz.t_first, t_max)

    def test_a_tie_prefers_the_longer_window(self):
        """설명력이 같으면 점이 많은 쪽이 안정적이다.

        완전한 로그선형이라 어느 구간을 골라도 adj R² 가 1 이다. 최소 3점이
        아니라 쓸 수 있는 최대 구간을 잡아야 한다. 볼루스는 첫 점이 곧
        Tmax 이고 Tmax 는 제외되므로, 여섯 점 중 다섯 점이 상한이다.
        """
        t = np.array([4, 8, 12, 24, 36, 48], dtype=float)  # 완전한 로그선형
        lz = best_fit_lambda_z(t, iv_bolus(t))
        self.assertEqual(lz.n_points, t.size - 1)
        self.assertAlmostEqual(lz.t_first, 8.0)

    def test_keeping_tmax_uses_every_point(self):
        t = np.array([4, 8, 12, 24, 36, 48], dtype=float)
        lz = best_fit_lambda_z(t, iv_bolus(t), exclude_tmax=False)
        self.assertEqual(lz.n_points, t.size)
        self.assertAlmostEqual(lz.value, K, places=6)

    def test_returns_empty_when_there_are_too_few_points(self):
        lz = best_fit_lambda_z([1.0, 2.0], [5.0, 4.0])
        self.assertFalse(lz.ok)
        self.assertIsNone(lz.value)


class BackExtrapolation(unittest.TestCase):
    def test_recovers_c0_when_the_first_sample_is_late(self):
        """볼루스인데 0시점 채혈이 없으면 그 앞 넓이가 통째로 빠진다."""
        t = np.array([0.5, 1, 2, 4, 8, 12, 24], dtype=float)
        c0 = back_extrapolate_c0(t, iv_bolus(t))
        self.assertAlmostEqual(c0, DOSE / V, places=6)

    def test_returns_none_when_the_curve_is_still_rising(self):
        t = np.array([0.5, 1.0, 2.0], dtype=float)
        self.assertIsNone(back_extrapolate_c0(t, [1.0, 2.0, 3.0]))


class SingleDoseNca(unittest.TestCase):
    """0시점 채혈이 없는 드문 표본에서도 닫힌 식을 되찾는지."""

    def setUp(self):
        self.t = np.array([0.5, 1, 2, 4, 8, 12, 24, 36, 48], dtype=float)
        self.c = iv_bolus(self.t)
        self.res = nca(self.t, self.c, dose=DOSE,
                       administration=Administration.IV_BOLUS,
                       method=AUCMethod.LINEAR_LOG)

    def test_exposure_and_disposition(self):
        self.assertAlmostEqual(self.res.auc_inf_obs, DOSE / CL, places=5)
        self.assertAlmostEqual(self.res.half_life, math.log(2) / K, places=5)
        self.assertAlmostEqual(self.res.cl, CL, places=5)
        self.assertAlmostEqual(self.res.vz, V, places=4)

    def test_mean_residence_time_and_steady_state_volume(self):
        self.assertAlmostEqual(self.res.mrt, 1.0 / K, places=4)
        self.assertAlmostEqual(self.res.vss, V, places=3)

    def test_c0_is_back_extrapolated_to_the_analytic_value(self):
        self.assertAlmostEqual(self.res.c0_back_extrapolated, DOSE / V, places=5)

    def test_extrapolated_fraction_is_small_for_this_sampling(self):
        self.assertLess(self.res.auc_extrap_pct, 5.0)


# ---------------------------------------------------------------------------
# 구간 잘라내기 — 경계의 불연속
# ---------------------------------------------------------------------------
class ClipInterval(unittest.TestCase):
    """투여 시각의 격자점이 투여 전 값인지 후 값인지는 배열만 봐서 알 수 없다.

    이 앱의 솔버는 투여 직전 값을 넣고, 손으로 만든 배열은 직후 값을 넣기도
    한다. 어느 쪽이든 같은 답이 나와야 한다.
    """

    def _repeated_bolus(self, boundary_is_post_dose):
        t = np.linspace(0, 48, 4801)
        c = np.zeros_like(t)
        for i in range(4):
            t0 = i * TAU
            live = (t >= t0) if boundary_is_post_dose else (t > t0)
            c += np.where(live, iv_bolus(t - t0), 0.0)
        return t, c

    def test_start_boundary_takes_the_post_dose_value(self):
        for post in (True, False):
            with self.subTest(boundary_is_post_dose=post):
                t, c = self._repeated_bolus(post)
                it, ic = clip_interval(t, c, 24.0, 36.0)
                # 24시점 직후 농도는 세 번의 투여가 쌓인 값이다.
                want = DOSE / V * (1 + math.exp(-K * TAU) + math.exp(-2 * K * TAU))
                self.assertAlmostEqual(ic[0], want, places=4)

    def test_end_boundary_takes_the_pre_dose_value(self):
        for post in (True, False):
            with self.subTest(boundary_is_post_dose=post):
                t, c = self._repeated_bolus(post)
                it, ic = clip_interval(t, c, 24.0, 36.0)
                # 36시점 직전 농도 — 36시점 투여는 이 구간에 속하지 않는다.
                want = DOSE / V * (math.exp(-K * TAU) + math.exp(-2 * K * TAU)
                                   + math.exp(-3 * K * TAU))
                self.assertAlmostEqual(ic[-1], want, places=4)

    def test_the_interval_spans_exactly_the_requested_range(self):
        t, c = self._repeated_bolus(False)
        it, _ = clip_interval(t, c, 24.0, 36.0)
        self.assertAlmostEqual(it[0], 24.0)
        self.assertAlmostEqual(it[-1], 36.0)

    def test_returns_nothing_when_the_range_is_outside_the_data(self):
        t = np.linspace(0, 10, 101)
        it, ic = clip_interval(t, iv_bolus(t), 5.0, 20.0)
        self.assertEqual(it.size, 0)
        self.assertEqual(ic.size, 0)


# ---------------------------------------------------------------------------
# 정상상태
# ---------------------------------------------------------------------------
class SteadyStateIvBolus(unittest.TestCase):
    """정맥 볼루스는 축적비까지 닫힌 식이 있어 가장 엄격하게 볼 수 있다."""

    N_DOSES = 12

    def setUp(self):
        t = np.linspace(0, 180, 18001)
        c = np.zeros_like(t)
        for i in range(self.N_DOSES):
            t0 = i * TAU
            c += np.where(t >= t0, iv_bolus(t - t0), 0.0)
        self.res = nca_steady_state(
            t, c, tau=TAU, dose=DOSE, first_dose_time=0.0,
            last_dose_time=(self.N_DOSES - 1) * TAU, lambda_z=K,
            method=AUCMethod.LINEAR)
        self.r = math.exp(-K * TAU)

    def test_auc_tau_equals_the_single_dose_auc_inf(self):
        """중첩원리: 정상상태 한 간격의 넓이는 단회 투여의 전체 넓이와 같다."""
        self.assertAlmostEqual(self.res.auc_tau, DOSE / CL, places=4)

    def test_peak_and_trough(self):
        self.assertAlmostEqual(self.res.c_max, DOSE / V / (1 - self.r), places=5)
        self.assertAlmostEqual(self.res.c_min, DOSE / V * self.r / (1 - self.r), places=5)
        self.assertAlmostEqual(self.res.c_trough, self.res.c_min, places=5)

    def test_average_concentration_and_clearance(self):
        self.assertAlmostEqual(self.res.c_avg, DOSE / (CL * TAU), places=5)
        self.assertAlmostEqual(self.res.cl_ss, CL, places=4)
        self.assertAlmostEqual(self.res.vz_ss, V, places=3)

    def test_accumulation_ratio_matches_the_closed_form(self):
        want = 1.0 / (1.0 - self.r)
        self.assertAlmostEqual(self.res.accumulation_auc, want, places=4)
        self.assertAlmostEqual(self.res.accumulation_c_max, want, places=4)

    def test_fluctuation_and_swing(self):
        c_max, c_min, c_avg = self.res.c_max, self.res.c_min, self.res.c_avg
        self.assertAlmostEqual(self.res.fluctuation_pct,
                               (c_max - c_min) / c_avg * 100.0, places=6)
        self.assertAlmostEqual(self.res.swing, (c_max - c_min) / c_min, places=6)

    def test_it_reports_having_reached_steady_state(self):
        self.assertIs(self.res.at_steady_state, True)
        self.assertLess(self.res.interval_change_pct, 0.01)
        self.assertEqual(self.res.warnings, [])

    def test_the_analysed_interval_starts_at_the_last_dose(self):
        self.assertAlmostEqual(self.res.interval_start, (self.N_DOSES - 1) * TAU)
        self.assertAlmostEqual(self.res.interval_end, self.N_DOSES * TAU)


class SteadyStateOral(unittest.TestCase):
    def setUp(self):
        t = np.linspace(0, 180, 18001)
        c = sum(oral(t - i * TAU) for i in range(12))
        self.res = nca_steady_state(
            t, c, tau=TAU, dose=DOSE, first_dose_time=0.0,
            last_dose_time=11 * TAU, lambda_z=K, method=AUCMethod.LINEAR)

    def test_auc_tau_equals_the_single_dose_auc_inf(self):
        self.assertAlmostEqual(self.res.auc_tau, DOSE / CL, places=3)

    def test_peak_matches_the_closed_form(self):
        r, ra = math.exp(-K * TAU), math.exp(-KA * TAU)
        t_max = math.log((KA * (1 - r)) / (K * (1 - ra))) / (KA - K)
        c_max = DOSE * KA / (V * (KA - K)) * (
            math.exp(-K * t_max) / (1 - r) - math.exp(-KA * t_max) / (1 - ra))
        self.assertAlmostEqual(self.res.c_max, c_max, places=4)
        self.assertAlmostEqual(self.res.t_max - self.res.interval_start, t_max, places=2)

    def test_accumulation_exceeds_the_iv_bolus_value(self):
        """흡수가 첫 간격의 노출을 뒤로 미루므로 AUC 기준 축적비가 더 크다.

        1/(1-e^-k*tau) 는 볼루스 식이고 경구에는 그대로 쓰이지 않는다.
        """
        iv_value = 1.0 / (1.0 - math.exp(-K * TAU))
        self.assertGreater(self.res.accumulation_auc, iv_value)


class SteadyStateEdges(unittest.TestCase):
    def test_it_says_so_when_steady_state_is_not_reached(self):
        t = np.linspace(0, 24, 2401)
        c = sum(oral(t - i * TAU) for i in range(2))
        res = nca_steady_state(t, c, tau=TAU, dose=DOSE, first_dose_time=0.0,
                               last_dose_time=TAU, method=AUCMethod.LINEAR)
        self.assertIs(res.at_steady_state, False)
        self.assertGreater(res.interval_change_pct, 5.0)
        self.assertTrue(any("steady state" in w for w in res.warnings))

    def test_it_refuses_a_profile_shorter_than_one_interval(self):
        t = np.linspace(0, 6, 601)
        res = nca_steady_state(t, oral(t), tau=TAU, dose=DOSE)
        self.assertIsNone(res.auc_tau)
        self.assertEqual(res.n_intervals, 0)
        self.assertTrue(res.warnings)

    def test_a_single_interval_cannot_confirm_steady_state(self):
        t = np.linspace(0, 12, 1201)
        res = nca_steady_state(t, oral(t), tau=TAU, dose=DOSE, first_dose_time=0.0)
        self.assertIsNotNone(res.auc_tau)
        self.assertIsNone(res.at_steady_state)
        self.assertTrue(any("could not be confirmed" in w for w in res.warnings))

    def test_a_non_positive_interval_is_rejected(self):
        t = np.linspace(0, 48, 481)
        res = nca_steady_state(t, oral(t), tau=0.0, dose=DOSE)
        self.assertIsNone(res.auc_tau)
        self.assertTrue(res.warnings)

    def test_clearance_is_left_blank_without_a_dose(self):
        t = np.linspace(0, 180, 18001)
        c = sum(oral(t - i * TAU) for i in range(12))
        res = nca_steady_state(t, c, tau=TAU, dose=None, first_dose_time=0.0,
                               last_dose_time=11 * TAU)
        self.assertIsNotNone(res.auc_tau)
        self.assertIsNone(res.cl_ss)
        self.assertIsNone(res.vz_ss)


if __name__ == "__main__":
    unittest.main()
