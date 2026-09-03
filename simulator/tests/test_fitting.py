"""fitting.py 의 목적함수 검증.

test_nca.py 와 달리 이쪽은 Django 설정이 필요하다 — fitting.py 가 파싱 결과를
캐시에 담기 때문이다. 두 실행 경로 모두에서 돌도록 설정이 없으면 여기서
띄운다.

    python -m unittest discover -t . -s simulator
    python manage.py test simulator
"""

import math
import os
import unittest

import numpy as np
from django.conf import settings

if not settings.configured:  # pragma: no cover - manage.py 로 돌 때는 이미 되어 있다
    import django

    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "pk_simulator.settings")
    django.setup()

from simulator.fitting import _weights, fit


# 참값을 아는 자료 — examples/data/02-oral-1c.csv (비례오차 CV 10%)
TRUE = {"CL": 4.0, "V": 32.0, "ka": 1.2}
DOSE = 250.0
OBSERVED = {
    "Time": [0.25, 0.5, 1.0, 1.5, 2.0, 3.0, 4.0, 6.0, 8.0, 12.0, 18.0, 24.0, 36.0],
    "Plasma": [1.64645, 3.38799, 5.46738, 4.85948, 6.48472, 5.43368, 5.17148,
               3.23285, 3.65423, 2.03215, 0.81942, 0.46362, 0.09913],
}


def fit_request(**overrides):
    payload = dict(
        equations="dAgdt = -ka*Ag\ndA1dt = ka*Ag - (CL/V)*A1\nC1 = A1/V",
        initials={"Ag": 0, "A1": 0},
        # 참값에서 흔들어 놓고 시작한다. 그냥 두면 이미 정답에서 출발하는 셈이다.
        parameters={"CL": 6, "ka": 0.8, "V": 20},
        fit_params=["CL", "V", "ka"],
        param_scopes={"CL": "shared", "V": "shared", "ka": "shared"},
        bounds={"CL": [0.6, 60], "V": [2, 200], "ka": [0.08, 8]},
        fitting_groups=[{
            "doses": [{"compartment": "Ag", "type": "bolus",
                       "amount": DOSE, "start_time": 0}],
            "observed": OBSERVED,
            "mappings": {"Plasma": "C1"},
        }],
    )
    payload.update(overrides)
    return fit(payload)


def shared_of(result):
    return {p["base_name"]: p["value"] for p in result["params"] if p["scope"] == "shared"}


class Weights(unittest.TestCase):
    def test_none_weights_everything_equally(self):
        y = np.array([1.0, 4.0, 25.0])
        np.testing.assert_allclose(_weights(y, "none"), [1.0, 1.0, 1.0])

    def test_one_over_y(self):
        y = np.array([1.0, 4.0, 25.0])
        np.testing.assert_allclose(_weights(y, "1/Y"), [1.0, 0.25, 0.04])

    def test_one_over_y_squared(self):
        y = np.array([1.0, 4.0, 25.0])
        np.testing.assert_allclose(_weights(y, "1/Y2"), [1.0, 1 / 16, 1 / 625])

    def test_a_zero_observation_is_dropped_not_floored(self):
        """0 에 작은 수를 깔아 나누면 그 한 점이 목적함수를 통째로 지배한다."""
        y = np.array([0.0, 2.0])
        for scheme in ("1/Y", "1/Y2"):
            with self.subTest(scheme=scheme):
                w = _weights(y, scheme)
                self.assertEqual(w[0], 0.0)
                self.assertGreater(w[1], 0.0)

    def test_an_unknown_scheme_falls_back_to_equal_weights(self):
        np.testing.assert_allclose(_weights(np.array([2.0, 8.0]), "1/Z"), [1.0, 1.0])


class ObjectiveValidation(unittest.TestCase):
    def test_unknown_objective_is_refused(self):
        r = fit_request(objective="bogus")
        self.assertEqual(r["status"], "error")
        self.assertIn("bogus", r["message"])

    def test_unknown_error_model_is_refused(self):
        r = fit_request(objective="mle", error_model="nope")
        self.assertEqual(r["status"], "error")

    def test_unknown_weighting_is_refused(self):
        r = fit_request(objective="wls", weighting="1/Z")
        self.assertEqual(r["status"], "error")

    def test_unknown_scope_is_refused(self):
        """모르는 scope 가 else 가지로 떨어지면 말없이 그룹별 추정이 된다.

        추정할 파라미터 개수가 통째로 달라지는 일이라, 예전 이름('global')을
        보내는 오래된 클라이언트가 조용히 다른 모델을 적합해서는 안 된다.
        """
        r = fit_request(param_scopes={"CL": "global", "V": "shared", "ka": "shared"})
        self.assertEqual(r["status"], "error")
        self.assertIn("global", r["message"])


class WeightedLeastSquares(unittest.TestCase):
    """자료가 비례오차로 만들어졌으므로, 그 구조를 반영하는 가중만 참값을 되찾는다."""

    @classmethod
    def setUpClass(cls):
        cls.wls_1y = fit_request(objective="wls", weighting="1/Y")
        cls.ols = fit_request(objective="wls", weighting="none")

    def test_it_recovers_the_true_parameters(self):
        got = shared_of(self.wls_1y)
        for key, truth in TRUE.items():
            with self.subTest(parameter=key):
                self.assertLess(abs(got[key] - truth) / truth, 0.10)

    def test_the_confidence_intervals_contain_the_truth(self):
        for p in self.wls_1y["params"]:
            if p["scope"] != "shared":
                continue
            with self.subTest(parameter=p["base_name"]):
                self.assertIsNotNone(p["ci_lower"])
                self.assertLessEqual(p["ci_lower"], TRUE[p["base_name"]])
                self.assertGreaterEqual(p["ci_upper"], TRUE[p["base_name"]])

    def test_no_sigma_is_estimated(self):
        """가중최소제곱에는 추정할 sigma 가 없다."""
        self.assertFalse([p for p in self.wls_1y["params"] if p["scope"] == "error"])

    def test_likelihood_statistics_are_left_blank(self):
        """가능도가 없으므로 AIC/BIC 를 지어내지 않는다."""
        for key in ("nll", "aic", "bic"):
            with self.subTest(statistic=key):
                self.assertIsNone(self.wls_1y[key])
        self.assertIsNotNone(self.wls_1y["rmse"])

    def test_unweighted_least_squares_is_biased_here(self):
        """비례오차 자료에 균등 가중을 쓰면 큰 농도가 적합을 끌고 간다.

        가중이 실제로 뭔가를 하고 있다는 증거이기도 하다 — 아무 일도 하지
        않는다면 두 결과가 같아야 한다.
        """
        ols = shared_of(self.ols)
        weighted = shared_of(self.wls_1y)
        self.assertGreater(abs(ols["CL"] - TRUE["CL"]) / TRUE["CL"], 0.25)
        self.assertLess(abs(weighted["CL"] - TRUE["CL"]) / TRUE["CL"], 0.10)

    def test_it_reports_which_objective_ran(self):
        self.assertEqual(self.wls_1y["objective"], "wls")
        self.assertEqual(self.wls_1y["weighting"], "1/Y")
        self.assertIsNone(self.wls_1y["error_model"])


class MaximumLikelihood(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.prop = fit_request(objective="mle", error_model="proportional")

    def test_it_recovers_the_true_parameters(self):
        got = shared_of(self.prop)
        for key, truth in TRUE.items():
            with self.subTest(parameter=key):
                self.assertLess(abs(got[key] - truth) / truth, 0.10)

    def test_sigma_is_estimated_and_matches_the_noise_it_was_given(self):
        """자료는 CV 10% 로 만들었다. 추정된 비례 sigma 가 그 근처여야 한다."""
        sigmas = [p for p in self.prop["params"] if p["scope"] == "error"]
        self.assertEqual(len(sigmas), 1)
        self.assertAlmostEqual(sigmas[0]["value"], 0.10, delta=0.05)

    def test_likelihood_statistics_are_reported(self):
        for key in ("nll", "aic", "bic"):
            with self.subTest(statistic=key):
                self.assertIsInstance(self.prop[key], float)

    def test_it_reports_which_objective_ran(self):
        self.assertEqual(self.prop["objective"], "mle")
        self.assertEqual(self.prop["error_model"], "proportional")
        self.assertIsNone(self.prop["weighting"])


if __name__ == "__main__":
    unittest.main()
