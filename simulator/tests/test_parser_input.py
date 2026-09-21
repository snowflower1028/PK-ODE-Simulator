"""파서가 받아야 할 것과 거절해야 할 것 (T2).

1. 한국어 주석이 거절됐다.  비 ASCII 검사가 주석을 자르기 *전에* 돌아서
   `# 1구획 모델` 이 "Unsupported character U+AD6C" 가 됐다.  식별자에서
   비 ASCII 를 막는 규칙은 그대로 둔다.

2. 어떤 파라미터 값을 넣어도 이미 망가진 식이 파싱을 통과했다.

       dAdt = -k*A/0         -> zoo*A*k   (복소 무한대)
       dAdt = -k*A*sqrt(-1)  -> -I*A*k    (허수)
       dAdt = -1e400*A       -> -oo*A     (리터럴이 float 범위를 넘음)
       V = 0 ; C = A/V       -> zoo*A     (파생 연쇄로 0 분모)

   이것들이 lambdify 까지 내려가 적분이 nan/inf/복소수를 만났다.
   `sqrt(k)`, `CL/V` 처럼 값에 따라 달라지는 식은 여기서 판단하지 않는다.
"""
import unittest

from simulator.parser import parse_ode_input


class 한국어_주석(unittest.TestCase):
    def test_주석_줄(self):
        p = parse_ode_input("# 1구획 모델\ndAdt = -k*A")
        self.assertEqual(p["compartments"], ["A"])
        self.assertEqual(p["parameters"], ["k"])

    def test_행_끝_주석(self):
        p = parse_ode_input("dAdt = -k*A  # 소실")
        self.assertEqual(p["processed_ode"], "dAdt = -A*k")

    def test_주석이_있어도_유니코드_minus_는_정규화된다(self):
        p = parse_ode_input("dAdt = −k*A  # 소실 − 과정")
        self.assertEqual(p["processed_ode"], "dAdt = -A*k")

    def test_파생식_주석(self):
        p = parse_ode_input("C = A/V  # 혈장 농도\ndAdt = -CL*C")
        self.assertIn("C", p["derived_expressions"])
        self.assertEqual(p["parameters"], ["CL", "V"])

    def test_식별자의_한국어는_여전히_거절(self):
        with self.assertRaisesRegex(ValueError, "Unsupported character U\\+C18D"):
            parse_ode_input("dAdt = -속도*A")

    def test_주석_앞에_있는_한국어는_여전히_거절(self):
        with self.assertRaisesRegex(ValueError, "Unsupported character"):
            parse_ode_input("dAdt = -k*A 소실 # 설명")


class 망가진_상수식_거절(unittest.TestCase):
    BAD = {
        "0 으로 나누기": ("dAdt = -k*A/0", "zoo"),
        "log(0)": ("dAdt = -k*A*log(0)", "zoo"),
        "0**-1": ("dAdt = -k*A*0**-1", "zoo"),
        "분모가 A-A": ("dAdt = -k/(A-A)", "zoo"),
        "sqrt(-1)": ("dAdt = -k*A*sqrt(-1)", "imaginary"),
        "(-1)**0.5": ("dAdt = -k*A*(-1)**0.5", "imaginary"),
        "1e400 리터럴": ("dAdt = -1e400*A", "infinite"),
    }

    def test_ODE_식(self):
        for label, (text, reason) in self.BAD.items():
            with self.subTest(label):
                with self.assertRaisesRegex(ValueError, f"'dAdt' contains .*{reason}"):
                    parse_ode_input(text)

    def test_쓰이지_않는_파생식도_거절(self):
        """ODE 에 안 쓰여도 표시·플롯 대상이 되므로 걸러야 한다."""
        with self.assertRaisesRegex(ValueError, "'x' contains .*zoo"):
            parse_ode_input("x = 1/0\ndAdt = -k*A")

    def test_파생_연쇄로_생긴_0_분모는_그_이름으로_보고(self):
        with self.assertRaisesRegex(ValueError, "'C' contains .*zoo"):
            parse_ode_input("V = 0\nC = A/V\ndAdt = -k*C")


class 값에_따라_달라지는_식은_통과(unittest.TestCase):
    """파라미터 값을 모르는 파싱 시점에 거절하면 안 되는 식."""

    def test_정상_식(self):
        for text in (
            "dAdt = -sqrt(k)*A",
            "dAdt = -log(k)*A",
            "dAdt = -CL/V*A",
            "dAdt = -k*A**-1",
            "dAdt = -k*A*exp(-k*t)",
            "dAdt = -k*A/(Km + A)",
        ):
            with self.subTest(text):
                parse_ode_input(text)

    def test_I_라는_파라미터는_허수가_아니다(self):
        p = parse_ode_input("dAdt = -I*A")
        self.assertEqual(p["parameters"], ["I"])


if __name__ == "__main__":
    unittest.main()
