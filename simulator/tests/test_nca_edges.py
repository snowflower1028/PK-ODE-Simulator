"""NCA 의 가장자리 — 드물지만 조용히 틀린 값을 만들던 입력들.

`test_nca.py` 가 본류(촘촘한 격자, 깨끗한 자료)를 덮는다면 여기는 그 바깥이다.
반복 측정으로 시각이 겹치거나, 꼬리에 BLQ 를 0 으로 적어 두거나, 구간 안에
점이 거의 없거나, 자료보다 긴 주입을 붙이거나 하는 경우.  전부 실제로 값을
재 본 뒤에 쓴 것이고, 각 시험의 설명에 그 값을 남겨 두었다.
"""

import unittest

import numpy as np

from simulator.nca import (
    AUCMethod,
    Administration,
    back_extrapolate_c0,
    clip_interval,
    nca,
    nca_steady_state,
)


class TiedSampleTimes(unittest.TestCase):
    """같은 시각이 두 번 나오면 역외삽이 0 으로 나눈다."""

    TIME = np.array([0.5, 0.5, 1, 2, 4, 8], dtype=float)
    CONC = np.array([8, 7.6, 6, 4, 2, 1], dtype=float)

    def test_c0_uses_the_first_distinct_time(self):
        c0 = back_extrapolate_c0(self.TIME, self.CONC)
        # 8 과 6 (t=0.5, 1) 으로 기울기를 잡으면 C0 = 8·exp(0.5754·0.5) = 10.67
        self.assertIsNotNone(c0)
        self.assertAlmostEqual(c0, 10.667, places=2)

    def test_the_wedge_before_the_first_sample_is_not_lost(self):
        """예전에는 C0 가 무한대가 되어 _clean 에서 조용히 걸러졌다.

        그 결과 0-t_first 쐐기가 통째로 빠져 auc_last 19.858 / CL 4.262 가
        나왔다. 제대로 세우면 24.49 / 3.56 이다.
        """
        result = nca(self.TIME, self.CONC, dose=100,
                     administration=Administration.IV_BOLUS)
        self.assertAlmostEqual(result.auc_last, 24.493, places=2)
        self.assertAlmostEqual(result.cl, 3.559, places=2)


class TrailingZeros(unittest.TestCase):
    """꼬리의 BLQ 0 을 실측처럼 다루면 구간 넓이가 어긋난다."""

    @classmethod
    def setUpClass(cls):
        t = np.array([0, 1, 2, 4, 8, 12, 24, 48], dtype=float)
        c = np.array([3.125 * np.exp(-0.125 * x) for x in t[:-1]] + [0.0])
        cls.result = nca(t, c, dose=100, administration=Administration.IV_BOLUS,
                         method=AUCMethod.LINEAR, partial_times=(48, 72))

    def test_lambda_z_is_still_found(self):
        self.assertAlmostEqual(self.result.lambda_z, 0.125, places=4)

    def test_a_partial_auc_past_the_last_sample_is_computed(self):
        """예전에는 c[-1] 이 0 이라 "말기 기울기가 없다"며 None 을 돌려줬다.

        λz 는 멀쩡히 추정돼 있었으므로 경고 문구도 사실이 아니었다.
        """
        self.assertIsNotNone(self.result.partial_auc.get("0-72"))

    def test_the_partial_auc_extrapolates_from_the_last_quantifiable_point(self):
        """AUC(0-48) = AUC(0-Tlast) + Clast/λz·(1-e^(-λz·Δ)) 여야 한다.

        예전에는 0 까지 사다리꼴로 이어 붙여 auc_all 과 같은 값이 나왔다.
        """
        tail = (0.15558 / 0.125) * (1.0 - np.exp(-0.125 * 24.0))
        self.assertAlmostEqual(
            self.result.partial_auc["0-48"], self.result.auc_last + tail, places=2
        )
        self.assertNotAlmostEqual(
            self.result.partial_auc["0-48"], self.result.auc_all, places=2
        )


class NegativeConcentrations(unittest.TestCase):
    def test_they_are_flagged_rather_than_integrated_in_silence(self):
        """빼지는 않는다 — 어떤 규칙으로 뺄지는 자료를 만든 사람이 정한다.

        다만 음의 넓이가 아무 말 없이 AUC 에 더해지던 것은 고친다.
        """
        result = nca(np.array([0, 1, 2, 4, 8], dtype=float),
                     np.array([10, 5, -1, 2, 1], dtype=float), dose=100)
        self.assertTrue(
            any("below zero" in w for w in result.warnings),
            f"음수 농도를 말해야 한다: {result.warnings}",
        )


class InfusionLongerThanTheProfile(unittest.TestCase):
    def test_residence_time_is_left_blank_instead_of_going_negative(self):
        """MRT = AUMC/AUC − Tinf/2 가 음수가 되면 뺄 것이 남지 않은 것이다.

        4시간짜리 자료에 20시간 주입을 붙이면 예전에는 MRT −7.44,
        Vss −302.8 을 게시했다. `if res.mrt` 는 음수도 참이라 Vss 까지 따라
        나갔다.
        """
        result = nca(np.array([0, 1, 2, 3, 4], dtype=float),
                     np.array([0, 1.0, 0.6, 0.36, 0.216], dtype=float),
                     dose=100, administration=Administration.IV_INFUSION,
                     infusion_duration=20)
        self.assertIsNone(result.mrt)
        self.assertIsNone(result.vss)
        self.assertTrue(any("residence time" in w for w in result.warnings))

    def test_an_ordinary_infusion_is_untouched(self):
        """회귀 — 자료가 주입을 담고 있으면 그대로 보정된다."""
        t = np.linspace(0, 96, 9601)
        k, cl, duration = 0.125, 4.0, 2.0
        rate = 100.0 / duration
        conc = np.where(
            t <= duration,
            (rate / cl) * (1 - np.exp(-k * np.minimum(t, duration))),
            (rate / cl) * (1 - np.exp(-k * duration)) * np.exp(-k * (t - duration)),
        )
        result = nca(t, conc, dose=100, administration=Administration.IV_INFUSION,
                     infusion_duration=duration, method=AUCMethod.LINEAR)
        self.assertAlmostEqual(result.mrt, 1.0 / k, places=2)


class SparseDosingInterval(unittest.TestCase):
    def test_one_interior_point_is_refused_not_flattened(self):
        """뻗을 기울기가 없으면 구간을 만들지 않는다.

        예전에는 그 한 점의 값을 양 끝에 복사해 직사각형을 만들었다 —
        AUCτ 84.0, Cmin=Cmax=Ctrough=7.0, 변동폭 0%.  자료가 그렇게 말한
        적이 없다.
        """
        t = np.array([0, 6, 12, 18, 24, 30, 36], dtype=float)
        c = np.array([0, 4, 2, 6, 3, 7, 3.5], dtype=float)
        it, ic = clip_interval(t, c, 24.0, 36.0)
        self.assertEqual(it.size, 0)

        result = nca_steady_state(t, c, tau=12, first_dose_time=0,
                                  last_dose_time=24, dose=100,
                                  method=AUCMethod.LINEAR)
        self.assertIsNone(result.auc_tau)
        self.assertTrue(any("isolate" in w for w in result.warnings))


class IntervalsAfterTheLastDose(unittest.TestCase):
    """마지막 투여 뒤에는 투여 간격이 없다."""

    @classmethod
    def setUpClass(cls):
        t = np.linspace(0, 180, 1801)
        c = np.zeros_like(t)
        for i in range(12):                      # q12h, 마지막 투여 132h
            start = i * 12
            mask = t >= start
            c[mask] += (100 / 30) * np.exp(-0.125 * (t[mask] - start))
        cls.t, cls.c = t, c

    def test_the_window_and_the_count_stop_at_the_last_dose(self):
        """예전에는 자료 끝까지 세어 n_intervals 가 15 였고, 고른 구간이
        168-180 (약이 하나도 들어오지 않은 세척 구간) 이 될 수 있었다."""
        result = nca_steady_state(self.t, self.c, tau=12, dose=100,
                                  first_dose_time=0, last_dose_time=132,
                                  method=AUCMethod.LINEAR)
        self.assertEqual(result.n_intervals, 12)
        self.assertAlmostEqual(result.interval_start, 132.0, places=6)
        # CL,ss = Dose/AUCτ = k·V = 0.125 × 30 = 3.75
        self.assertAlmostEqual(result.cl_ss, 3.75, places=2)

    def test_without_a_last_dose_time_the_assumption_is_stated(self):
        result = nca_steady_state(self.t, self.c, tau=12, dose=100,
                                  first_dose_time=0, method=AUCMethod.LINEAR)
        self.assertTrue(
            any("assumed to follow a dose" in w for w in result.warnings),
            f"가정을 밝혀야 한다: {result.warnings}",
        )


if __name__ == "__main__":
    unittest.main()
