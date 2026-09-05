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
    partial_auc,
    apply_blq,
    BLQPolicy,
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
# Tlast 뒤에 0 이 이어질 때
# ---------------------------------------------------------------------------
class TrailingZeros(unittest.TestCase):
    """정량한계 아래로 떨어져 0 이 기록된 구간을 AUClast 에 넣으면 안 된다.

    넣으면 Clast 에서 0 으로 내려오는 넓이를 사다리꼴로 한 번 세고, 다시
    Clast/λz 로 외삽해 두 번 센다. 해석해가 있으니 몇 %를 더 세는지까지
    확인할 수 있다.
    """

    def setUp(self):
        t = np.array([0, 1, 2, 4, 8, 12, 24], dtype=float)
        c = iv_bolus(t)
        # 48시간 시료는 정량한계 아래여서 0 으로 기록됐다.
        self.t = np.append(t, 48.0)
        self.c = np.append(c, 0.0)
        self.res = nca(self.t, self.c, dose=DOSE,
                       administration=Administration.IV_BOLUS)

    def test_last_measurable_point_is_the_endpoint(self):
        self.assertAlmostEqual(self.res.t_last, 24.0)
        self.assertAlmostEqual(self.res.c_last, float(iv_bolus(24.0)), places=9)

    def test_auc_inf_still_recovers_the_closed_form(self):
        # 두 번 세면 여기서 7% 넘게 부풀어 오른다.
        self.assertAlmostEqual(self.res.auc_inf_obs, DOSE / CL, places=5)

    def test_auc_all_carries_the_zero_tail_and_auc_last_does_not(self):
        tail = 0.5 * (48.0 - 24.0) * float(iv_bolus(24.0))
        self.assertGreater(self.res.auc_all, self.res.auc_last)
        self.assertAlmostEqual(self.res.auc_all - self.res.auc_last, tail, places=9)


# ---------------------------------------------------------------------------
# WinNonlin 이 함께 내보내는 항목들
# ---------------------------------------------------------------------------
class ReportedDiagnostics(unittest.TestCase):
    """값 옆에 붙는 진단 — 이 값을 믿어도 되는지를 말한다."""

    def setUp(self):
        self.t = np.array([0.5, 1, 2, 4, 8, 12, 24, 36, 48], dtype=float)
        self.c = iv_bolus(self.t)
        self.res = nca(self.t, self.c, dose=DOSE,
                       administration=Administration.IV_BOLUS)

    def test_correlation_is_negative_and_matches_r_squared(self):
        self.assertLess(self.res.lambda_z_corr_xy, 0.0)
        self.assertAlmostEqual(
            self.res.lambda_z_corr_xy, -math.sqrt(self.res.lambda_z_r_squared), places=9
        )

    def test_intercept_reconstructs_the_regression_line(self):
        # 순수한 단일지수라 회귀선이 점을 정확히 지난다.
        at = 24.0
        drawn = math.exp(self.res.lambda_z_intercept - self.res.lambda_z * at)
        self.assertAlmostEqual(drawn, float(iv_bolus(at)), places=9)

    def test_predicted_clast_agrees_with_the_observed_one(self):
        self.assertAlmostEqual(self.res.c_last_pred, self.res.c_last, places=9)

    def test_span_counts_half_lives_covered_by_the_fit(self):
        expected = (self.res.lambda_z_t_last - self.res.lambda_z_t_first) / self.res.half_life
        self.assertAlmostEqual(self.res.lambda_z_span, expected, places=9)
        self.assertGreater(self.res.lambda_z_span, 2.0)
        self.assertFalse([w for w in self.res.warnings if "half-lives" in w])

    def test_short_sampling_is_called_out(self):
        t = np.array([0, 1, 2, 3], dtype=float)
        res = nca(t, iv_bolus(t), dose=DOSE, administration=Administration.IV_BOLUS)
        self.assertLess(res.lambda_z_span, 2.0)
        self.assertTrue([w for w in res.warnings if "half-lives" in w])

    def test_aumc_extrapolated_fraction_is_reported(self):
        self.assertGreater(self.res.aumc_extrap_pct, 0.0)
        self.assertLess(self.res.aumc_extrap_pct, 100.0)
        # AUMC 는 시간을 한 번 더 곱하므로 꼬리의 몫이 AUC 보다 늘 크다.
        self.assertGreater(self.res.aumc_extrap_pct, self.res.auc_extrap_pct)

    def test_dose_normalised_values(self):
        self.assertAlmostEqual(self.res.c_max_dn, self.res.c_max / DOSE, places=12)
        self.assertAlmostEqual(self.res.auc_last_dn, self.res.auc_last / DOSE, places=12)
        self.assertAlmostEqual(self.res.auc_inf_obs_dn, self.res.auc_inf_obs / DOSE, places=12)


class MeanResidenceTime(unittest.TestCase):
    """MRT 는 넓이의 비다 — 용량을 몰라도 나와야 한다."""

    def setUp(self):
        self.t = np.array([0.5, 1, 2, 4, 8, 12, 24, 36, 48], dtype=float)
        self.c = iv_bolus(self.t)

    def test_available_without_a_dose(self):
        res = nca(self.t, self.c, dose=None, administration=Administration.IV_BOLUS)
        self.assertIsNone(res.cl)
        self.assertAlmostEqual(res.mrt, 1.0 / K, places=4)

    def test_mrt_last_is_shorter_than_mrt_infinity(self):
        res = nca(self.t, self.c, dose=DOSE, administration=Administration.IV_BOLUS)
        self.assertLess(res.mrt_last, res.mrt)

    def test_infusion_subtracts_half_the_duration_from_both(self):
        free = nca(self.t, self.c, dose=DOSE, administration=Administration.IV_INFUSION)
        held = nca(self.t, self.c, dose=DOSE, administration=Administration.IV_INFUSION,
                   infusion_duration=2.0)
        self.assertAlmostEqual(free.mrt - held.mrt, 1.0, places=9)
        self.assertAlmostEqual(free.mrt_last - held.mrt_last, 1.0, places=9)


# ---------------------------------------------------------------------------
# 정량한계 아래
# ---------------------------------------------------------------------------
class BlqRules(unittest.TestCase):
    """어느 규칙을 고르는지가 AUC 를 실제로 바꾼다. 얼마나 바꾸는지 못박아 둔다."""

    def setUp(self):
        # 0, 1, 2, 4, 8, 12, 24 — 4시간 시료가 정량한계 아래로 보고됐다.
        self.t = np.array([0, 1, 2, 4, 8, 12, 24], dtype=float)
        self.c = iv_bolus(self.t)
        self.blq = np.array([False, False, False, True, False, False, False])

    def _auc(self, **rules):
        res = nca(self.t, self.c, dose=DOSE,
                  administration=Administration.IV_BOLUS,
                  blq=self.blq, blq_policy=BLQPolicy(**rules))
        return res.auc_last

    def test_leaving_it_out_keeps_the_closed_form(self):
        # 점을 빼고 2시간과 8시간을 바로 이으면 로그 사다리꼴이 단일지수를
        # 정확히 재현하므로 해석해가 그대로 나온다.
        want = (DOSE / V) / K * (1 - math.exp(-K * 24.0))
        self.assertAlmostEqual(self._auc(between="missing"), want, places=6)

    def test_calling_it_zero_digs_a_hole(self):
        missing = self._auc(between="missing")
        zero = self._auc(between="zero")
        self.assertLess(zero, missing)
        # 없는 골을 파는 것이라 오차가 작지 않다.
        self.assertGreater(100 * (missing - zero) / missing, 5.0)

    def test_a_below_limit_sample_at_time_zero_reads_the_same_either_way(self):
        # 혈관외는 투여 전에 약이 없으므로 t=0 은 0 이다. 그 0 을 남기든 빼든
        # 같은 프로파일이 된다 — 빼면 t=0 을 세워 넣는 쪽이 같은 자리를 메운다.
        t = np.array([0, 1, 2, 4, 8, 12, 24], dtype=float)
        c = oral(t)
        blq = np.array([True, False, False, False, False, False, False])
        as_zero = nca(t, c, dose=DOSE, administration=Administration.EXTRAVASCULAR,
                      blq=blq, blq_policy=BLQPolicy(before="zero")).auc_last
        as_missing = nca(t, c, dose=DOSE, administration=Administration.EXTRAVASCULAR,
                         blq=blq, blq_policy=BLQPolicy(before="missing")).auc_last
        self.assertAlmostEqual(as_missing, as_zero, places=12)

    def test_before_the_first_measurable_point(self):
        # 한계 아래 시료가 0시점보다 뒤에 있으면 규칙이 갈린다. 0 으로 두면
        # 곡선이 그 시각까지 바닥에 붙어 있고, 빼면 원점에서 첫 정량점까지
        # 곧장 이으므로 넓이가 더 나온다.
        t = np.array([0.25, 0.5, 1, 2, 4, 8, 12, 24], dtype=float)
        c = oral(t)
        blq = np.array([True] + [False] * 7)
        as_zero = nca(t, c, dose=DOSE, administration=Administration.EXTRAVASCULAR,
                      blq=blq, blq_policy=BLQPolicy(before="zero")).auc_last
        as_missing = nca(t, c, dose=DOSE, administration=Administration.EXTRAVASCULAR,
                         blq=blq, blq_policy=BLQPolicy(before="missing")).auc_last
        self.assertGreater(as_missing, as_zero)

    def test_after_the_last_measurable_point_only_moves_auc_all(self):
        t = np.append(self.t, 48.0)
        c = np.append(iv_bolus(self.t), 0.0)
        blq = np.array([False] * 7 + [True])
        kept = nca(t, c, dose=DOSE, administration=Administration.IV_BOLUS,
                   blq=blq, blq_policy=BLQPolicy(after="zero"))
        dropped = nca(t, c, dose=DOSE, administration=Administration.IV_BOLUS,
                      blq=blq, blq_policy=BLQPolicy(after="drop"))
        # AUClast 와 CL 은 어느 쪽이든 같다 — 마지막 정량점에서 끊기기 때문.
        self.assertAlmostEqual(kept.auc_last, dropped.auc_last, places=12)
        self.assertAlmostEqual(kept.cl, dropped.cl, places=12)
        # 갈리는 것은 AUCall 뿐이고, 버리면 AUClast 와 같아져 쓸모가 없어진다.
        self.assertGreater(kept.auc_all, kept.auc_last)
        self.assertAlmostEqual(dropped.auc_all, dropped.auc_last, places=12)

    def test_a_threshold_can_mark_the_points(self):
        out = apply_blq(self.t, self.c, loq=1.0)
        # 1 ng/mL 아래로 내려간 뒤 시료가 몇 개인지
        self.assertEqual(out.n_after, int((self.c < 1.0).sum()))

    def test_unknown_rule_is_refused_by_name(self):
        with self.assertRaises(ValueError) as caught:
            apply_blq(self.t, self.c, policy=BLQPolicy(between="interpolate"))
        self.assertIn("between", str(caught.exception))
        self.assertIn("interpolate", str(caught.exception))

    def test_a_profile_that_is_entirely_below_the_limit(self):
        t = np.array([0, 1, 2, 4], dtype=float)
        out = apply_blq(t, np.zeros_like(t))
        self.assertEqual(out.n_total, 0)
        self.assertTrue([n for n in out.notes if "Every sample" in n])

    def test_nothing_changes_unless_blq_is_asked_for(self):
        plain = nca(self.t, self.c, dose=DOSE, administration=Administration.IV_BOLUS)
        asked = nca(self.t, self.c, dose=DOSE, administration=Administration.IV_BOLUS,
                    blq=np.zeros(self.t.size, dtype=bool))
        self.assertAlmostEqual(plain.auc_last, asked.auc_last, places=12)


# ---------------------------------------------------------------------------
# 구간 넓이
# ---------------------------------------------------------------------------
class PartialAuc(unittest.TestCase):
    """정해진 창까지의 노출량. 채혈이 끝난 시각과 무관하게 견줄 수 있어야 한다."""

    def setUp(self):
        self.t = np.array([0, 0.5, 1, 2, 4, 8, 12, 24, 36, 48], dtype=float)
        self.c = iv_bolus(self.t)

    def test_matches_the_closed_form_on_a_grid_point(self):
        # AUC(0-T) = C0/k · (1 - e^(-kT))
        for T in (12.0, 24.0, 48.0):
            got = partial_auc(self.t, self.c, T)
            want = (DOSE / V) / K * (1 - math.exp(-K * T))
            self.assertAlmostEqual(got, want, places=4, msg=f"T={T}")

    def test_boundary_between_samples_is_interpolated(self):
        # 18시간은 격자에 없다. 12와 24 사이를 로그로 이으므로 해석해와 맞는다.
        got = partial_auc(self.t, self.c, 18.0)
        want = (DOSE / V) / K * (1 - math.exp(-K * 18.0))
        self.assertAlmostEqual(got, want, places=4)

    def test_split_pieces_add_back_up(self):
        whole = partial_auc(self.t, self.c, 48.0)
        left = partial_auc(self.t, self.c, 18.0)
        right = partial_auc(self.t, self.c, 48.0, t_start=18.0)
        self.assertAlmostEqual(left + right, whole, places=9)

    def test_past_the_last_sample_needs_the_terminal_slope(self):
        beyond = 72.0
        self.assertTrue(math.isnan(partial_auc(self.t, self.c, beyond)))
        got = partial_auc(self.t, self.c, beyond, lambda_z=K)
        want = (DOSE / V) / K * (1 - math.exp(-K * beyond))
        self.assertAlmostEqual(got, want, places=4)

    def test_nca_reports_requested_windows(self):
        res = nca(self.t, self.c, dose=DOSE,
                  administration=Administration.IV_BOLUS,
                  partial_times=(12, 24))
        self.assertEqual(sorted(res.partial_auc), ["0-12", "0-24"])
        self.assertAlmostEqual(
            res.partial_auc["0-24"],
            (DOSE / V) / K * (1 - math.exp(-K * 24.0)), places=4)
        # 창이 자료 전체를 덮으면 AUClast 와 같아야 한다.
        full = nca(self.t, self.c, dose=DOSE,
                   administration=Administration.IV_BOLUS, partial_times=(48,))
        self.assertAlmostEqual(full.partial_auc["0-48"], full.auc_last, places=9)


# ---------------------------------------------------------------------------
# t=0 을 세우는 방식
# ---------------------------------------------------------------------------
class BuildingTheOrigin(unittest.TestCase):
    """첫 조각의 넓이는 t=0 에 무엇을 놓느냐로 정해진다.

    투여 방식마다 답이 다르다. 볼루스는 그 순간이 최고 농도라 되돌려 세워야
    하고, 혈관외와 주입은 아직 약이 오지 않았으므로 0 이다. 세우지 않으면
    첫 조각이 통째로 빠진다.
    """

    def test_a_bolus_recorded_as_zero_at_time_zero_is_back_extrapolated(self):
        # 볼루스에서 t=0 의 0 은 측정이 아니라 "아직 재지 않았다" 는 뜻이다.
        # 그대로 믿으면 첫 조각이 삼각형으로 깎인다.
        t = np.array([0, 0.5, 1, 2, 4, 8], dtype=float)
        c = np.array([0.0, *iv_bolus([0.5, 1, 2, 4, 8])])
        res = nca(t, c, dose=DOSE, administration=Administration.IV_BOLUS)

        self.assertIsNotNone(res.c0_back_extrapolated)
        self.assertAlmostEqual(res.c0_back_extrapolated, DOSE / V, places=6)
        # 되돌린 뒤에는 해석해를 되찾는다.
        self.assertAlmostEqual(res.auc_inf_obs, DOSE / CL, places=4)

    def test_the_back_extrapolated_value_never_becomes_cmax(self):
        # Cmax 는 잰 값이다. 세워 넣은 C0 가 그 자리를 차지하면, 보고서에
        # 측정한 적 없는 농도가 최고 농도로 올라간다.
        t = np.array([0.25, 0.5, 1, 2, 4, 8], dtype=float)
        c = iv_bolus(t)
        res = nca(t, c, dose=DOSE, administration=Administration.IV_BOLUS)

        self.assertGreater(res.c0_back_extrapolated, c.max())
        self.assertAlmostEqual(res.c_max, float(c.max()), places=12)
        self.assertAlmostEqual(res.t_max, 0.25, places=12)

    def test_an_extravascular_profile_starts_at_zero(self):
        t = np.array([0.5, 1, 2, 4, 8, 12, 24], dtype=float)
        c = oral(t)
        res = nca(t, c, dose=DOSE, administration=Administration.EXTRAVASCULAR)

        self.assertTrue(res.origin_inserted)
        # 세워 넣은 조각은 원점에서 첫 시료까지의 삼각형이다.
        without = auc(t, c, AUCMethod.LINEAR)
        wedge = 0.5 * t[0] * c[0]
        plain = nca(t, c, dose=DOSE, administration=Administration.EXTRAVASCULAR,
                    method=AUCMethod.LINEAR)
        self.assertAlmostEqual(plain.auc_last - without, wedge, places=9)

    def test_a_late_first_sample_is_called_out(self):
        # 첫 채혈이 늦을수록 그 삼각형은 잰 것이 아니라 가정한 것이고,
        # 늦을수록 커진다. 조용히 넣지 않는다.
        t = np.array([6, 8, 12, 24, 36], dtype=float)
        c = oral(t)
        res = nca(t, c, dose=DOSE, administration=Administration.EXTRAVASCULAR)
        self.assertTrue(res.origin_inserted)
        self.assertTrue([w for w in res.warnings if "time 0" in w],
                        msg=f"warnings: {res.warnings}")

    def test_a_bolus_measured_at_time_zero_is_left_alone(self):
        t = np.array([0, 0.5, 1, 2, 4, 8], dtype=float)
        c = iv_bolus(t)
        res = nca(t, c, dose=DOSE, administration=Administration.IV_BOLUS)
        self.assertIsNone(res.c0_back_extrapolated)
        self.assertFalse(res.origin_inserted)


# ---------------------------------------------------------------------------
# Phoenix WinNonlin 출력과의 대조
# ---------------------------------------------------------------------------
class WinNonlinAgreement(unittest.TestCase):
    """실제 WinNonlin 실행 결과를 그대로 못박아 둔다.

    해석해 시험은 계산이 스스로 앞뒤가 맞는지를 보지만, 이 시험은 목적 그
    자체를 본다 — 같은 자료를 같은 규칙으로 돌렸을 때 WinNonlin 과 같은
    숫자가 나오는가.

    두 실행 모두 선형 사다리꼴을 썼다. 보고된 값이 3-6 자리라 그 자리까지만
    맞대 본다.
    """

    def _close(self, ours, expected, label):
        self.assertIsNotNone(ours, msg=label)
        self.assertAlmostEqual(ours, expected, delta=abs(expected) * 2e-5, msg=label)

    def test_iv_bolus_one_milligram(self):
        # 시각은 시간, 농도는 ng/mL. t=0 에 0 이 적혀 있는 정맥 볼루스라
        # C0 를 되돌려 세워야 맞는다.
        t = np.array([0, 0.0833, 0.1667, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 5, 8, 14, 24, 48],
                     dtype=float)
        c = np.array([0, 8.12, 7.2, 5.24, 4.64, 2.96, 2.56, 2.16, 1.8, 1.44, 1.24,
                      0.36, 0.16, 0, 0], dtype=float)
        res = nca(t, c, dose=1e6, method=AUCMethod.LINEAR,
                  administration=Administration.IV_BOLUS)

        self._close(res.auc_inf_obs * 60.0, 954.219, "AUCINF_obs (min*ng/mL)")
        self._close(res.aumc_inf * 3600.0, 222543.300, "AUMCINF_obs (min^2*ng/mL)")
        self._close(res.c_max, 8.120, "Cmax (ng/mL)")
        self._close(res.mrt * 60.0, 233.220, "MRTINF_obs (min)")
        self._close(res.cl / 60.0, 1047.978, "CL (mL/min)")
        self._close(res.vss, 244409.850, "Vss (mL)")

    def test_oral_eighty_milligrams(self):
        # 첫 채혈이 0.5h 라 원점을 세워 넣어야 맞는다.
        t = np.array([0.5, 1, 1.5, 2, 3, 4, 6, 8, 12, 24], dtype=float)
        c = np.array([19.649, 63.513, 81.188, 79.154, 70.309, 60.764, 42.634,
                      29.074, 13.803, 4.356], dtype=float)
        res = nca(t, c, dose=80e6, method=AUCMethod.LINEAR,
                  administration=Administration.EXTRAVASCULAR)

        self._close(res.auc_inf_obs * 60.0, 38652.037, "AUCINF_obs (min*ng/mL)")
        self._close(res.aumc_inf * 3600.0, 17865444.0, "AUMCINF_obs (min^2*ng/mL)")
        self._close(res.c_max, 81.188, "Cmax (ng/mL)")
        self._close(res.mrt * 60.0, 462.21223, "MRTINF_obs (min)")
        self._close(res.cl / 60.0, 2069.7486, "Cl_F_obs (mL/min)")
        self._close(res.vz, 916708.27, "Vz_F_obs (mL)")
        self._close(res.lambda_z / 60.0, 0.002257805, "Lambda_z (1/min)")

    def test_the_terminal_phase_is_chosen_the_same_way(self):
        # 경구 자료에서는 자동 선택이 WinNonlin 과 같은 점을 고른다:
        # 2-24h, 7점. 이것이 어긋나면 위 시험의 AUCINF 도 함께 어긋난다.
        t = np.array([0.5, 1, 1.5, 2, 3, 4, 6, 8, 12, 24], dtype=float)
        c = np.array([19.649, 63.513, 81.188, 79.154, 70.309, 60.764, 42.634,
                      29.074, 13.803, 4.356], dtype=float)
        res = nca(t, c, dose=80e6, method=AUCMethod.LINEAR,
                  administration=Administration.EXTRAVASCULAR)
        self.assertEqual(res.lambda_z_n_points, 7)
        self.assertAlmostEqual(res.lambda_z_t_first, 2.0, places=9)
        self.assertAlmostEqual(res.lambda_z_t_last, 24.0, places=9)


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
