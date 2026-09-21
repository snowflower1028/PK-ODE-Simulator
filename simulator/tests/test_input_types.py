"""요청의 수치 입력이 조용히 다른 값이 되지 않는가 (T3).

수정 전 /simulate/ 에서 잰 것 (dAdt = -k*A, k=0.1, 볼루스 1, 0~10 h):

    정상                       200  A(10)=0.3679
    k=true                     200  A(10)=4.54e-05   ← k=1 로 계산
    t_start=true               200  창 시작이 1 h 로 바뀜
    initial A=true             200  A(0)=1 로 계산
    t_steps=11.7               200  말없이 11 로 잘림
    주입 1e308 / 1e-300        200  A=0.0        ← 속도 inf, 투여가 사라짐
    주입 1 / 5e-324            200  A=0.0
    주입 start=1e17, dur=1     200  A=0.0        ← 1e17+1 == 1e17, 유입 0
    initial A='abc' / null     400  numpy·scipy 내부 메시지

그리고 /sweep/ 에는 ValueError 분기가 없어 요청 잘못이 전부 500 이었다.
"""
import json

import numpy as np
from django.test import SimpleTestCase

from simulator.parser import parse_ode_input
from simulator.solver import finite_number, generate_rhs_function, solve_ode_system


BASE = {
    "equations": "dAdt = -k*A",
    "initials": {"A": 0.0},
    "parameters": {"k": 0.1},
    "t_start": 0, "t_end": 10, "t_steps": 11,
    "doses": [{"compartment": "A", "type": "bolus", "amount": 1, "start_time": 0}],
}


def _dose(**kw):
    d = {"compartment": "A", "type": "bolus", "amount": 1, "start_time": 0}
    d.update(kw)
    return [d]


class _Http(SimpleTestCase):
    def post(self, url="/simulate/", **over):
        body = json.loads(json.dumps(BASE))
        body.update(over)
        return self.client.post(url, json.dumps(body), content_type="application/json")

    def assert400(self, pattern, **over):
        r = self.post(**over)
        self.assertEqual(r.status_code, 400, r.content[:200])
        self.assertRegex(r.json()["message"], pattern)


class 참거짓은_숫자가_아니다(_Http):
    def test_파라미터(self):
        self.assert400(r"Parameter 'k' must be a number, not true", parameters={"k": True})
        self.assert400(r"not false", parameters={"k": False})

    def test_초기값(self):
        self.assert400(r"initial value of 'A' must be a number", initials={"A": True})

    def test_투여_필드(self):
        self.assert400(r"amount of dose #1 must be a number", doses=_dose(amount=True))
        self.assert400(r"start_time of true", doses=_dose(start_time=True))
        self.assert400(r"repeat_every of true", doses=_dose(repeat_every=True, repeat_until=5))

    def test_시간_창과_격자(self):
        self.assert400(r"start time must be a number", t_start=True)
        self.assert400(r"end time must be a number", t_end=True)
        self.assert400(r"t_steps must be a number", t_steps=True)

    def test_t_steps_소수는_잘리지_않고_거절(self):
        self.assert400(r"whole number", t_steps=11.7)

    def test_정수로_떨어지는_값과_숫자_문자열은_예전처럼_받는다(self):
        """폼 입력이 문자열이나 11.0 으로 올 수 있다."""
        for over in ({"t_steps": 11.0}, {"t_steps": "11"},
                     {"parameters": {"k": "0.1"}}, {"initials": {"A": "0"}}):
            with self.subTest(over):
                r = self.post(**over)
                self.assertEqual(r.status_code, 200, r.content[:200])
                self.assertAlmostEqual(r.json()["data"]["profile"]["A"][-1],
                                       np.exp(-1.0), places=7)


class 초기값_메시지(_Http):
    def test_내부_메시지_대신_이유(self):
        self.assert400(r"initial value of 'A' is not a number: 'abc'", initials={"A": "abc"})
        self.assert400(r"initial value of 'A' is missing", initials={"A": None})

    def test_빠진_구획은_0_에서_시작(self):
        r = self.post(initials={})
        self.assertEqual(r.status_code, 200)
        self.assertAlmostEqual(r.json()["data"]["profile"]["A"][-1], np.exp(-1.0), places=7)


class 사라지는_주입(_Http):
    def test_속도가_무한대(self):
        self.assert400(r"rate .* too large",
                       doses=_dose(type="infusion", amount=1e308, duration=1e-300))
        self.assert400(r"rate .* too large",
                       doses=_dose(type="infusion", amount=1, duration=5e-324))

    def test_끝과_시작을_구별할_수_없음(self):
        self.assert400(r"too short to separate",
                       t_end=2e17, doses=_dose(type="infusion", amount=1,
                                              duration=1, start_time=1e17))

    def test_반복_주입의_뒤쪽_회차도_본다(self):
        """첫 회는 구별되지만 뒤 회차에서 구별이 안 되는 경우."""
        with self.assertRaisesRegex(ValueError, "too short to separate"):
            p = parse_ode_input("dAdt = -k*A")
            f = generate_rhs_function(p["equations"], p["compartments"], p["parameters"])
            # 2**53 근처에서 간격 1 은 표현되지만 0.25 는 안 된다
            solve_ode_system(
                f, p["compartments"], p["parameters"], {"A": 0.0}, {"k": 0.0},
                (0.0, 2.0**53 + 10), np.array([0.0, 2.0**53 + 10]),
                [{"compartment": "A", "type": "infusion", "amount": 1,
                  "duration": 0.25, "start_time": 1.0,
                  "repeat_every": 2.0**52, "repeat_until": 2.0**53}],
            )

    def test_정상_주입은_그대로(self):
        k, dur = 0.1, 2.0
        r = self.post(doses=_dose(type="infusion", amount=1, duration=dur))
        self.assertEqual(r.status_code, 200)
        want = (1 / dur) / k * (1 - np.exp(-k * dur)) * np.exp(-k * (10 - dur))
        self.assertAlmostEqual(r.json()["data"]["profile"]["A"][-1], want, places=7)


class 스윕도_400(_Http):
    def sweep(self, spec, **over):
        return self.post("/sweep/", sweep=spec, **over)

    def test_요청_잘못이_500_이_아니라_400(self):
        r = self.sweep({"mode": "scan", "kind": "parameter", "target": "k",
                        "values": [0.1]}, t_steps=1)
        self.assertEqual(r.status_code, 400)
        self.assertIn("t_steps", r.json()["message"])

    def test_스윕_값의_참거짓(self):
        r = self.sweep({"mode": "scan", "kind": "parameter", "target": "k",
                        "values": [True]})
        self.assertEqual(r.status_code, 400)
        self.assertIn("sweep value", r.json()["message"])

    def test_정상_스윕(self):
        r = self.sweep({"mode": "scan", "kind": "parameter", "target": "k",
                        "values": [0.1, 0.2]})
        self.assertEqual(r.status_code, 200, r.content[:200])


class finite_number_단위(SimpleTestCase):
    def test_받는_값(self):
        for raw, want in ((1, 1.0), (0, 0.0), (-2.5, -2.5), ("3", 3.0),
                          (np.float64(1.5), 1.5), (np.int64(4), 4.0)):
            with self.subTest(raw=raw):
                self.assertEqual(finite_number(raw, "x"), want)

    def test_거절하는_값(self):
        for raw in (True, False, np.bool_(True), None, "", "abc",
                    float("inf"), float("nan"), [1], {}):
            with self.subTest(raw=raw):
                with self.assertRaises(ValueError):
                    finite_number(raw, "x")
