"""연쇄 파생식(chained derived expression) 회귀 시험.

    fd2 = 1-fd1
    Q2  = fd2 * QCO

예전에는 파생식을 평가하는 루프가 네 군데 복사돼 있었고 그중 셋이 방금 계산한
컬럼을 다음 식의 환경에 되먹이지 않았다.  `/simulate/` 는 HTTP 200 을 주면서
`Q2` 만 빠뜨렸고, 피팅 쪽 두 곳은 예외를 통째로 삼켰다.
"""

import json
import math
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


class OnlyMathGetsThrough(SimpleTestCase):
    """파생식은 파이썬 문법이 아니라 수학 문법으로만 해석된다.

    처음 구현은 `pd.eval(expr, local_dict=env, engine="python")` 이었다.
    engine 이름이 안전해 보이지만 문법을 제한하는 것은 engine 이 아니라
    parser 이고, 기본 parser 는 속성 접근을 명시적으로 허용한다 — 확인해
    보면 `pd.compat.os.system(...)` 이 실제로 실행된다.  오늘 그것이 터지지
    않은 유일한 이유는 여기 들어오는 문자열이 전부 파서의 화이트리스트를
    이미 통과했다는 것뿐이었다.  이제는 텍스트를 파이썬으로 다시 해석하지
    않고, 같은 화이트리스트로 SymPy 식을 만들어 수치 함수로 평가한다.
    """

    def setUp(self):
        self.df = pd.DataFrame({"Time": [0.0, 1.0], "A1": [100.0, 50.0]})

    def test_python_escapes_are_refused(self):
        for expression in (
            "pd",
            'pd.compat.os.system("id")',
            '__import__("os")',
            "A1.__class__",
            "A1[0]",
            "(lambda: 1)()",
            'eval("1")',
            "globals()",
            "A1 if A1 else A1",
        ):
            with self.subTest(expression=expression):
                df, failures = attach_derived(self.df.copy(), {"x": expression}, {})
                self.assertNotIn("x", df.columns)
                self.assertEqual(len(failures), 1)

    def test_the_documented_functions_still_work(self):
        """내장 함수 이름은 인자가 아니다 — 걸러 내지 않으면 멀쩡한 식이 죽는다."""
        cases = {
            "sqrt(A1)": 10.0,
            "exp(0)*A1": 100.0,
            "log(A1)": math.log(100.0),
            "abs(-A1)": 100.0,
            "A1**0.5": 10.0,
        }
        for expression, want in cases.items():
            with self.subTest(expression=expression):
                df, failures = attach_derived(self.df.copy(), {"x": expression}, {})
                self.assertEqual(failures, [])
                self.assertAlmostEqual(float(df["x"].iloc[0]), want)

    def test_a_scalar_expression_becomes_a_full_column(self):
        """Q1 = fd1*QCO 처럼 시간에 의존하지 않는 값도 행마다 있어야 한다."""
        df, failures = attach_derived(
            self.df.copy(), {"Q1": "fd1*QCO"}, {"QCO": 5.0, "fd1": 0.4}
        )
        self.assertEqual(failures, [])
        self.assertEqual(len(df["Q1"]), len(self.df))
        self.assertTrue(all(abs(v - 2.0) < 1e-12 for v in df["Q1"]))
