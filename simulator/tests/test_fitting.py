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

    def test_the_weights_actually_reach_the_objective(self):
        """가중을 바꾸면 추정치가 달라진다 — 가중 벡터가 목적함수까지 간다는 뜻.

        여기서 주장할 수 있는 것은 이것뿐이다.  예전에는 이 자리에
        "균등 가중은 CL 을 25% 이상 틀리게 추정한다"는 시험이 있었는데,
        이 자료에서 실제 오차는 1.5% 였다.  농도 범위가 한 자릿수라
        1/Y 가중이 붙잡을 만큼 큰 점이 없어서, 자료 자체가 두 가중을
        구별하지 못한다.  편향의 크기를 주장하려면 그걸 실제로 드러내는
        자료(넓은 농도 범위 + 큰 비례오차)가 필요하다.
        """
        ols = shared_of(self.ols)
        weighted = shared_of(self.wls_1y)
        self.assertNotAlmostEqual(ols["CL"], weighted["CL"], places=3)

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


class MultipleGroups(unittest.TestCase):
    """그룹 하나가 자료를 못 받으면, 그 그룹의 파라미터는 추정되지 않는다.

    `_predict_pairs` 는 쓸 수 없는 그룹을 조용히 건너뛴다.  예전 관문은
    "어디엔가 쌍이 하나라도 있으면" 통과라, 그룹 하나만 죽어 있으면 그 그룹의
    per_group 파라미터가 사용자의 초기값 그대로 `converged: True` 와 함께
    "추정치"로 돌아왔다.  결과에서 그것이 추정인지 짐작인지 구별할 방법은
    `stderr: None` 뿐이었다.
    """

    GROUP = {
        "doses": [{"compartment": "Ag", "type": "bolus", "amount": DOSE, "start_time": 0}],
        "observed": OBSERVED,
        "mappings": {"Plasma": "C1"},
    }

    def two_groups(self, second):
        return fit_request(
            param_scopes={"CL": "per_group", "V": "shared", "ka": "shared"},
            fitting_groups=[self.GROUP, second],
            objective="mle", error_model="proportional",
        )

    def test_a_group_whose_column_is_all_missing_is_refused(self):
        dead = {**self.GROUP, "observed": {**OBSERVED, "Plasma": [None] * 13}}
        result = self.two_groups(dead)
        self.assertEqual(result["status"], "error")
        self.assertIn("group 2", result["message"])

    def test_a_mistyped_mapping_is_refused_and_names_the_symbol(self):
        typo = {**self.GROUP, "mappings": {"Plasma": "C_typo"}}
        result = self.two_groups(typo)
        self.assertEqual(result["status"], "error")
        self.assertIn("C_typo", result["message"])

    def test_two_usable_groups_still_fit(self):
        result = self.two_groups(self.GROUP)
        self.assertEqual(result["status"], "ok")
        per_group = [p for p in result["params"] if p["base_name"] == "CL"]
        self.assertEqual(len(per_group), 2)
        for p in per_group:
            with self.subTest(parameter=p["name"]):
                self.assertLess(abs(p["value"] - TRUE["CL"]) / TRUE["CL"], 0.10)


class DegreesOfFreedom(unittest.TestCase):
    """가중치 0 인 관측은 자유도를 늘리지 않는다.

    1/Y 가중에서 농도 0 인 점은 목적함수에 아무것도 보태지 않는데, 예전에는
    그것도 n_obs 에 들어가 잔차분산을 너무 작게 만들었다 — 추정치는 소수점
    넷째 자리까지 그대로인데 표준오차만 12% 줄었다.
    """

    @classmethod
    def setUpClass(cls):
        cls.clean = fit_request(objective="wls", weighting="1/Y")
        blq = {
            "Time": OBSERVED["Time"] + [48.0, 60.0, 72.0],
            "Plasma": OBSERVED["Plasma"] + [0.0, 0.0, 0.0],
        }
        cls.with_zeros = fit_request(
            objective="wls", weighting="1/Y",
            fitting_groups=[{**MultipleGroups.GROUP, "observed": blq}],
        )

    @staticmethod
    def _cl(result):
        return next(p for p in result["params"] if p["base_name"] == "CL")

    def test_zero_observations_do_not_shrink_the_standard_error(self):
        clean, padded = self._cl(self.clean), self._cl(self.with_zeros)
        # 점 추정이 사실상 같다는 것이 먼저다 — 0 은 정보를 주지 않았다.
        self.assertAlmostEqual(clean["value"], padded["value"], places=3)
        self.assertAlmostEqual(clean["stderr"], padded["stderr"], places=3)


class ReportedStatistics(unittest.TestCase):
    def test_aic_is_consistent_with_the_reported_nll(self):
        """예전에는 nll 이 상수항을 뺀 값, aic 는 더한 값이라 서로 어긋났다."""
        result = fit_request(objective="mle", error_model="constant")
        k = len(result["params"])
        self.assertAlmostEqual(result["aic"], 2 * k + 2 * result["nll"], places=6)
        self.assertAlmostEqual(
            result["bic"], k * math.log(result["n_obs"]) + 2 * result["nll"], places=6
        )

    def test_a_parameter_pinned_at_a_bound_gets_no_wald_interval(self):
        """경계에 붙으면 대칭 구간이 허용 범위를 넘어간다 — 표준편차에서는 음수 하한.

        combined 오차모형을 비례오차 자료에 맞추면 Sigma(Additive) 가 하한
        1e-6 으로 내려간다. 예전에는 그 자리에서 (-0.02384, +0.02385) 를
        보고했다.
        """
        result = fit_request(objective="mle", error_model="combined")
        pinned = [p for p in result["params"] if p.get("at_bound")]
        self.assertTrue(pinned, "경계에 붙은 파라미터가 있어야 하는 설정이다")
        for p in pinned:
            with self.subTest(parameter=p["name"]):
                self.assertIsNone(p["ci_lower"])
                self.assertIsNone(p["stderr"])
        # 경계에 붙지 않은 것들은 그대로 나와야 한다.
        free = [p for p in result["params"] if not p.get("at_bound")]
        self.assertTrue(all(p["stderr"] is not None for p in free))
