"""metrics.py 검증.

nca.py 의 시험처럼 Django 를 import 하지 않는다 — 모듈 자체가 numpy 하나만
쓰므로 시험도 그래야 옮겨 갈 때 따라간다.

값을 눈으로 확인해 둔 기록이 아니라 답을 아는 문제로 검증한다. 모든 점이
정확히 k 배 어긋나면 AFE 와 AAFE 는 정의상 k 여야 한다.
"""

import math
import unittest

import numpy as np

from simulator.metrics import prediction_error


OBS = [1.0, 2.0, 5.0, 10.0, 20.0]


class PerfectAgreement(unittest.TestCase):
    def test_identical_values_give_one(self):
        r = prediction_error(OBS, OBS)
        self.assertAlmostEqual(r.afe, 1.0, places=12)
        self.assertAlmostEqual(r.aafe, 1.0, places=12)
        self.assertAlmostEqual(r.rmse, 0.0, places=12)
        self.assertAlmostEqual(r.within_2fold_pct, 100.0)
        self.assertEqual(r.n, len(OBS))
        self.assertEqual(r.n_excluded, 0)


class ConstantFoldError(unittest.TestCase):
    """모든 점이 같은 배수로 어긋나면 AFE 도 AAFE 도 그 배수가 된다."""

    def test_uniform_over_prediction(self):
        r = prediction_error(OBS, [v * 3 for v in OBS])
        self.assertAlmostEqual(r.afe, 3.0, places=12)
        self.assertAlmostEqual(r.aafe, 3.0, places=12)

    def test_uniform_under_prediction(self):
        r = prediction_error(OBS, [v / 3 for v in OBS])
        self.assertAlmostEqual(r.afe, 1 / 3, places=12)
        self.assertAlmostEqual(r.aafe, 3.0, places=12)

    def test_afe_cancels_where_aafe_does_not(self):
        """AFE 는 방향이 있어 상쇄되고, AAFE 는 크기만 보므로 남는다.

        둘을 함께 봐야 하는 이유다 — AFE 1.0 은 편향이 없다는 뜻이지
        잘 맞는다는 뜻이 아니다.
        """
        r = prediction_error([10.0, 10.0], [20.0, 5.0])   # 2배 위, 2배 아래
        self.assertAlmostEqual(r.afe, 1.0, places=12)
        self.assertAlmostEqual(r.aafe, 2.0, places=12)


class TwoFoldBand(unittest.TestCase):
    def test_boundary_counts_as_inside(self):
        r = prediction_error([10.0, 10.0], [20.0, 5.0])   # 정확히 2배
        self.assertAlmostEqual(r.within_2fold_pct, 100.0)

    def test_just_outside_is_excluded(self):
        r = prediction_error([10.0, 10.0], [20.1, 10.0])
        self.assertAlmostEqual(r.within_2fold_pct, 50.0)

    def test_distribution_is_not_visible_from_aafe_alone(self):
        """같은 AAFE 가 전혀 다른 분포에서 나온다.

        모두 조금씩 어긋난 쪽과, 절반은 완벽하고 절반은 크게 어긋난 쪽의
        AAFE 를 같게 맞춰 두고 2배 비율이 그 차이를 잡아내는지 본다.
        """
        spread = prediction_error([10.0] * 4, [10.0, 10.0, 10.0 * 16, 10.0 * 16])
        even = prediction_error([10.0] * 4, [10.0 * 4] * 4)
        self.assertAlmostEqual(spread.aafe, even.aafe, places=9)
        self.assertAlmostEqual(even.within_2fold_pct, 0.0)
        self.assertAlmostEqual(spread.within_2fold_pct, 50.0)


class WorstPoint(unittest.TestCase):
    def test_it_reports_the_worst_fold_and_when(self):
        r = prediction_error([10.0, 10.0, 10.0], [11.0, 50.0, 9.0], times=[1.0, 2.0, 3.0])
        self.assertAlmostEqual(r.max_fold_error, 5.0, places=12)
        self.assertAlmostEqual(r.max_fold_error_time, 2.0)

    def test_under_prediction_is_reported_as_a_fold_above_one(self):
        r = prediction_error([10.0], [2.0], times=[7.0])
        self.assertAlmostEqual(r.max_fold_error, 5.0, places=12)


class NonPositiveValues(unittest.TestCase):
    """로그를 쓰므로 0 이하는 뺄 수밖에 없다. 조용히 빼서는 안 된다."""

    def test_zero_observations_are_excluded_and_counted(self):
        r = prediction_error([0.0, 10.0, 20.0], [1.0, 10.0, 20.0])
        self.assertEqual(r.n, 2)
        self.assertEqual(r.n_excluded, 1)
        self.assertAlmostEqual(r.afe, 1.0, places=12)
        self.assertTrue(any("zero" in w for w in r.warnings))

    def test_rmse_still_uses_every_paired_point(self):
        """RMSE 는 로그가 필요 없으므로 0 인 점도 센다."""
        r = prediction_error([0.0, 10.0], [3.0, 10.0])
        self.assertAlmostEqual(r.rmse, math.sqrt((9.0 + 0.0) / 2), places=12)

    def test_all_non_positive_leaves_fold_metrics_blank(self):
        r = prediction_error([0.0, 0.0], [0.0, 1.0])
        self.assertEqual(r.n, 0)
        self.assertIsNone(r.afe)
        self.assertIsNone(r.aafe)
        self.assertTrue(r.warnings)


class MissingAndMismatched(unittest.TestCase):
    def test_nan_pairs_are_dropped(self):
        r = prediction_error([1.0, float("nan"), 4.0], [1.0, 2.0, 4.0])
        self.assertEqual(r.n, 2)
        self.assertAlmostEqual(r.afe, 1.0, places=12)

    def test_unequal_lengths_use_the_overlap(self):
        r = prediction_error([1.0, 2.0, 4.0], [1.0, 2.0])
        self.assertEqual(r.n, 2)

    def test_no_pairs_says_so(self):
        r = prediction_error([], [])
        self.assertEqual(r.n, 0)
        self.assertIsNone(r.rmse)
        self.assertTrue(r.warnings)


class Rmse(unittest.TestCase):
    def test_matches_the_definition(self):
        obs = np.array([1.0, 2.0, 3.0])
        pred = np.array([2.0, 4.0, 3.0])
        r = prediction_error(obs, pred)
        self.assertAlmostEqual(r.rmse, math.sqrt((1 + 4 + 0) / 3), places=12)

    def test_it_is_not_scale_free_where_the_fold_metrics_are(self):
        """배수 지표만 보면 크기를 놓친다 — 그래서 RMSE 를 함께 낸다."""
        small = prediction_error([0.01, 0.02], [0.02, 0.04])
        large = prediction_error([100.0, 200.0], [200.0, 400.0])
        self.assertAlmostEqual(small.aafe, large.aafe, places=12)
        self.assertLess(small.rmse, large.rmse)


if __name__ == "__main__":
    unittest.main()
