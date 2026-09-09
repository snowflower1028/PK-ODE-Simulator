"""연쇄 파생식(chained derived expression) 회귀 시험.

    fd2 = 1-fd1
    Q2  = fd2 * QCO

예전에는 파생식을 평가하는 루프가 네 군데 복사돼 있었고 그중 셋이 방금 계산한
컬럼을 다음 식의 환경에 되먹이지 않았다.  `/simulate/` 는 HTTP 200 을 주면서
`Q2` 만 빠뜨렸고, 피팅 쪽 두 곳은 예외를 통째로 삼켰다.
"""

import json
import os

import pandas as pd
from django.conf import settings

if not settings.configured:  # pragma: no cover - manage.py 로 돌 때는 이미 되어 있다
    import django

    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "pk_simulator.settings")
    django.setup()

from django.test import SimpleTestCase

from simulator.derived import attach_derived


# 사용자의 mPBPK 참조 모델.  Q1/Q2/fd2 는 이차 파라미터, C1/C2 는 농도다.
MPBPK = (
    "dA1dt = -(CL/V1)*A1 - (Q1/V1)*A1 + (Q2/V2)*A2\n"
    "dA2dt = (Q1/V1)*A1 - (Q2/V2)*A2\n"
    "Q1 = fd1 * QCO\n"
    "Q2 = fd2 * QCO\n"
    "fd2 = 1-fd1\n"
    "C1 = A1/V1\n"
    "C2 = A2/V2"
)
PARAMS = {"CL": 4.0, "V1": 10.0, "V2": 20.0, "QCO": 5.0, "fd1": 0.4}


class AttachDerived(SimpleTestCase):
    def setUp(self):
        self.df = pd.DataFrame({"Time": [0.0, 1.0], "A1": [100.0, 50.0],
                                "A2": [0.0, 20.0]})

    def test_a_chain_resolves(self):
        df, failures = attach_derived(
            self.df,
            {"Q2": "fd2 * QCO", "fd2": "1-fd1"},  # 일부러 순서를 뒤집어 둔다
            {"QCO": 5.0, "fd1": 0.4},
        )
        self.assertEqual(failures, [])
        self.assertAlmostEqual(float(df["fd2"].iloc[0]), 0.6)
        self.assertAlmostEqual(float(df["Q2"].iloc[0]), 3.0)

    def test_declaration_order_does_not_matter(self):
        """위상정렬에 기대지 않는다 — 선언 순서가 어떻든 같은 답이 나와야 한다."""
        forward, f1 = attach_derived(
            self.df.copy(), {"a": "A1*2", "b": "a+1", "c": "b*10"}, {}
        )
        backward, f2 = attach_derived(
            self.df.copy(), {"c": "b*10", "b": "a+1", "a": "A1*2"}, {}
        )
        self.assertEqual(f1, [])
        self.assertEqual(f2, [])
        self.assertAlmostEqual(float(forward["c"].iloc[0]), 2010.0)
        self.assertAlmostEqual(float(backward["c"].iloc[0]), 2010.0)

    def test_an_unresolvable_expression_is_reported_not_swallowed(self):
        df, failures = attach_derived(self.df, {"bad": "nope * 2"}, {})
        self.assertNotIn("bad", df.columns)
        self.assertEqual(len(failures), 1)
        self.assertEqual(failures[0]["name"], "bad")
        self.assertIn("nope", failures[0]["expression"])
        self.assertTrue(failures[0]["error"])

    def test_one_bad_expression_does_not_block_the_good_ones(self):
        df, failures = attach_derived(
            self.df, {"good": "A1/2", "bad": "nope * 2"}, {}
        )
        self.assertIn("good", df.columns)
        self.assertAlmostEqual(float(df["good"].iloc[0]), 50.0)
        self.assertEqual([f["name"] for f in failures], ["bad"])


class SimulateEndpoint(SimpleTestCase):
    """`/simulate/` 가 연쇄 파생식을 끝까지 계산하는지."""

    def _run(self):
        payload = {
            "equations": MPBPK,
            "initials": {"A1": 0, "A2": 0},
            "parameters": PARAMS,
            "t_start": 0, "t_end": 24, "t_steps": 25,
            "doses": [{"compartment": "A1", "type": "bolus",
                       "amount": 100, "start_time": 0}],
        }
        response = self.client.post(
            "/simulate/", data=json.dumps(payload),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        return response.json()["data"]

    def test_the_whole_chain_reaches_the_profile(self):
        data = self._run()
        profile = data["profile"]
        for name in ("A1", "A2", "Q1", "Q2", "fd2", "C1", "C2"):
            self.assertIn(name, profile, f"{name} 이(가) 프로필에서 빠졌다")

    def test_chained_values_are_right(self):
        profile = self._run()["profile"]
        # fd2 = 1-0.4 = 0.6,  Q2 = 0.6*5 = 3.0
        self.assertAlmostEqual(profile["fd2"][0], 0.6)
        self.assertAlmostEqual(profile["Q2"][0], 3.0)

    def test_nothing_failed(self):
        self.assertEqual(self._run()["derived_failures"], [])
