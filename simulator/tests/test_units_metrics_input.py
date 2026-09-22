"""NCA 단위와 예측 오차 지표의 입력 강화 (T4).

stash(codex, 2026-09-08)의 시험 16개를 현재 코드에 하나씩 재 보고, 실제로
틀린 것만 옮겼다. 옮기지 않은 것:
  - validate_nca_input_units 의 "MW 가 필요한가" 판정 — nmol/L + mg 은 지금도
    원래 단위로 보여 주고 닿을 수 없는 선택지를 내놓지 않는다. 결함이 아니다.
  - 1e±300 에서 log(p/o) 대신 log(p)-log(o) — 입력 검사가 아니라 계산 순서
    변경이라 별도 승인 대상.

/nca/units/ 에서 잰 수정 전:
    mw=1e-308          200, 응답 JSON 에 Infinity — 브라우저가 못 읽음
    bw=1e-320          500 (OverflowError)
    mw='nan'           200, 응답 JSON 에 NaN
    mw='inf'           200, Cmax 를 nmol/L 로 보는 배율이 0
    mw=true            200, 분자량 1 로 계산
    conc='mg'          200, CL 이 mg/(mg·h) — 실제로는 1/h
"""
import json
import math
import unittest

import numpy as np
from django.test import SimpleTestCase

from simulator.metrics import prediction_error
from simulator.units import (
    UnitError,
    check_nca_input_units,
    display_options,
    field_unit,
    parse_unit as P,
    scale_factor,
)


class 배율이_표현되지_않으면_거절(unittest.TestCase):
    def test_극단적인_분자량(self):
        for frm, to in ((P("mg"), P("umol")), (P("umol"), P("mg"))):
            with self.subTest(frm=frm.label, to=to.label):
                with self.assertRaisesRegex(UnitError, "unrepresentable scale factor"):
                    scale_factor(frm, to, mw=1e-308)

    def test_극단적인_체중(self):
        cl = field_unit("cl", P("ng/mL"), P("h"), P("mg"))
        for bw in (1e-308, 1e-320):
            with self.subTest(bw=bw):
                with self.assertRaisesRegex(UnitError, "unrepresentable scale factor"):
                    scale_factor(cl, P("L/h/kg"), bw=bw)

    def test_선택지에는_표현되는_배율만(self):
        for field, native, bridge in (
            ("c_max", field_unit("c_max", P("ng/mL"), P("h"), P("mg")), {"mw": 1e-308}),
            ("cl", field_unit("cl", P("ng/mL"), P("h"), P("mg")), {"bw": 1e-320}),
        ):
            with self.subTest(field=field, bridge=bridge):
                choices = display_options(field, native, **bridge)
                self.assertTrue(choices)
                for choice in choices:
                    factor = scale_factor(native, P(choice), **bridge)
                    self.assertTrue(math.isfinite(factor) and factor > 0, msg=choice)


class 분자량과_체중은_양의_유한한_수(unittest.TestCase):
    def test_거절(self):
        cl = field_unit("cl", P("ng/mL"), P("h"), P("mg"))
        for bad in (float("nan"), float("inf"), True, 0, -5, "abc"):
            with self.subTest(mw=bad):
                with self.assertRaises(UnitError):
                    scale_factor(P("mg"), P("umol"), mw=bad)
            with self.subTest(bw=bad):
                with self.assertRaises(UnitError):
                    scale_factor(cl, P("L/h/kg"), bw=bad)

    def test_없으면_예전처럼_다리가_필요하다고(self):
        with self.assertRaisesRegex(UnitError, "needs a molecular weight"):
            scale_factor(P("mg"), P("umol"))

    def test_정상_값은_그대로(self):
        self.assertAlmostEqual(scale_factor(P("mg"), P("umol"), mw=500.0), 2.0, places=12)
        self.assertAlmostEqual(scale_factor(P("mg"), P("umol"), mw="500"), 2.0, places=12)


class 입력_단위의_자리(unittest.TestCase):
    def test_맞는_조합(self):
        for conc, time, dose in (("ng/mL", "h", "mg"), ("nmol/L", "min", "umol"),
                                 ("nmol/L", "h", "mg"), ("ng/mL", "day", "mg/kg"),
                                 ("umol/L", "h", "nmol/kg")):
            with self.subTest((conc, time, dose)):
                check_nca_input_units(P(conc), P(time), P(dose))

    def test_틀린_자리(self):
        for conc, time, dose, what in (("mg", "h", "mg", "concentration"),
                                       ("ng/mL", "mg", "mg", "time"),
                                       ("ng/mL", "h", "L", "dose"),
                                       ("ng/mL", "h", "mg/kg/h", "dose")):
            with self.subTest((conc, time, dose)):
                with self.assertRaisesRegex(UnitError, what):
                    check_nca_input_units(P(conc), P(time), P(dose))


class NCA_단위_엔드포인트(SimpleTestCase):
    def post(self, **body):
        spec = {"conc": "ng/mL", "time": "h", "dose": "mg"}
        spec.update(body)
        return self.client.post("/nca/units/", json.dumps(spec), content_type="application/json")

    def assertBrowserReadable(self, response):
        """JSON.parse 는 NaN·Infinity 를 받지 않는다."""
        self.assertEqual(response.status_code, 200, response.content[:200])
        def refuse(token):
            raise AssertionError(f"response contains {token}")
        json.loads(response.content, parse_constant=refuse)

    def test_극단적인_분자량_체중에도_읽을_수_있는_응답(self):
        self.assertBrowserReadable(self.post(mw=1e-308))
        self.assertBrowserReadable(self.post(bw=1e-320))

    def test_쓸_수_없는_분자량은_400(self):
        for bad in ("nan", "inf", True, -1, 0):
            with self.subTest(mw=bad):
                r = self.post(mw=bad)
                self.assertEqual(r.status_code, 400)
                self.assertIn("molecular weight", r.json()["message"])

    def test_틀린_자리의_단위는_400(self):
        r = self.post(conc="mg")
        self.assertEqual(r.status_code, 400)
        self.assertIn("not a concentration unit", r.json()["message"])

    def test_정상_요청은_예전과_같다(self):
        r = self.post(mw=500, bw=70)
        self.assertBrowserReadable(r)
        cl = r.json()["units"]["cl"]
        self.assertEqual(cl["native"], "mg/((ng/mL)·h)")
        self.assertIn("L/h", [c["label"] for c in cl["choices"]])


class 예측_오차의_짝짓기(unittest.TestCase):
    def test_시각이_모자라도_값_쌍을_버리지_않는다(self):
        """예전: 값 3쌍 중 2쌍을 경고 없이 버리고 n=1."""
        r = prediction_error([10.0, 10.0, 10.0], [10.0, 10.0, 50.0], times=[1.0])
        self.assertEqual(r.n, 3)
        self.assertAlmostEqual(r.max_fold_error, 5.0, places=12)
        self.assertIsNone(r.max_fold_error_time)
        self.assertTrue(any("time values" in w for w in r.warnings))

    def test_빈_시각_배열(self):
        """예전: n=0 "No paired points"."""
        r = prediction_error([1.0, 2.0], [2.0, 4.0], times=[])
        self.assertEqual(r.n, 2)
        self.assertAlmostEqual(r.afe, 2.0, places=12)

    def test_남는_시각은_버리고_알린다(self):
        r = prediction_error([10.0], [20.0], times=[7.0, 8.0])
        self.assertAlmostEqual(r.max_fold_error_time, 7.0)
        self.assertTrue(any("extra time" in w for w in r.warnings))

    def test_값_길이가_다르면_알린다(self):
        r = prediction_error([1.0, 2.0, 4.0], [1.0, 2.0])
        self.assertEqual(r.n, 2)
        self.assertTrue(any("lengths differ" in w for w in r.warnings))

    def test_스칼라는_한_쌍(self):
        """예전: TypeError."""
        r = prediction_error(2.0, 4.0, times=7.0)
        self.assertEqual(r.n, 1)
        self.assertAlmostEqual(r.afe, 2.0, places=12)
        self.assertAlmostEqual(r.max_fold_error_time, 7.0)

    def test_2차원은_거절(self):
        """예전: IndexError."""
        with self.assertRaisesRegex(ValueError, "one-dimensional"):
            prediction_error([[1.0, 2.0]], [[1.0, 2.0]])

    def test_같은_길이면_경고를_보태지_않는다(self):
        """앱 경로(analyzer)는 항상 같은 길이로 부른다 — 결과가 바뀌면 안 된다."""
        r = prediction_error([1.0, 2.0, 4.0], [1.0, 2.0, 8.0], times=[1, 2, 3])
        self.assertEqual(r.warnings, [])


class 배수_기준(unittest.TestCase):
    def test_1_은_정확히_일치(self):
        self.assertAlmostEqual(prediction_error([1.0, 1.0], [1.0, 2.0], fold=1).within_2fold_pct, 50.0)

    def test_쓸_수_없는_기준은_거절(self):
        """예전: 0·-1·nan → 0 %, inf·True → 100 %, 'x'·None → TypeError."""
        for fold in (0, -1, 0.5, float("nan"), float("inf"), "not-a-number", None, True):
            with self.subTest(fold=fold):
                with self.assertRaisesRegex(ValueError, "fold"):
                    prediction_error([1.0], [1.0], fold=fold)


if __name__ == "__main__":
    unittest.main()
