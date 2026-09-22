import unittest

from sympy import symbols

from simulator.parser import parse_ode_input


class ParserSyntax(unittest.TestCase):
    def test_time_is_the_independent_variable_not_a_parameter(self):
        parsed = parse_ode_input("dAdt = t")

        self.assertEqual(parsed["parameters"], [])
        self.assertEqual(parsed["equations"]["A"], symbols("t"))

    def test_scientific_notation_does_not_create_an_e_parameter(self):
        parsed = parse_ode_input("dAdt = -1e-3*A")

        self.assertEqual(parsed["parameters"], [])
        self.assertEqual(str(parsed["equations"]["A"]), "-0.001*A")

    def test_unicode_minus_is_normalised_instead_of_deleted(self):
        parsed = parse_ode_input("dAdt = −k*A")

        self.assertEqual(str(parsed["equations"]["A"]), "-A*k")

    def test_unsupported_syntax_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "not allowed"):
            parse_ode_input("dAdt = sqrt.__globals__")


class DerivedDefinitions(unittest.TestCase):
    def test_dependencies_are_returned_before_their_consumers(self):
        parsed = parse_ode_input(
            "dAdt = -k*A\n"
            "D = 2*C\n"
            "C = A/V"
        )

        self.assertEqual(list(parsed["derived_expressions"]), ["C", "D"])
        self.assertEqual(str(parsed["equations"]["A"]), "-A*k")

    def test_a_cycle_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "Cyclic derived definition"):
            parse_ode_input("dAdt = X\nX = Y\nY = X")

    def test_a_derived_name_cannot_replace_a_compartment(self):
        with self.assertRaisesRegex(ValueError, "both a compartment and a derived"):
            parse_ode_input("dAdt = -k*A\nA = B")

    def test_time_column_name_is_reserved(self):
        with self.assertRaisesRegex(ValueError, "reserved"):
            parse_ode_input("dAdt = -k*A\nTime = 3")

    def test_duplicate_ode_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "Duplicate ODE"):
            parse_ode_input("dAdt = -k*A\ndAdt = -q*A")


class DerivedOutputEligibility(unittest.TestCase):
    """Output(Plot 선택 메뉴) 기본값 = compartment + compartment 를 (직접 또는
    다른 derived 를 거추 간접적으로) 포함하는 derived 변수만.

    순수 파라미터로만 이루어진 derived(시간에 따라 변하지 않는 상수)는 정의는
    되지만(derived_expressions 에는 남는다) Output 후보(derived_output_eligible)
    에서는 빠진다.
    """

    def test_direct_reference_to_a_compartment_is_eligible(self):
        parsed = parse_ode_input("dAdt = -k*A\nC = A/V")

        self.assertEqual(parsed["derived_output_eligible"], ["C"])

    def test_pure_parameter_expression_is_not_eligible(self):
        # QCO 와 f 는 둘 다 파라미터고, 어느 것도 compartment 를 참조하지 않는다 —
        # Q 는 시간에 따라 변하지 않는 상수이므로 Output 후보가 아니다.
        parsed = parse_ode_input("dAdt = -k*A\nQ = QCO*f")

        self.assertEqual(list(parsed["derived_expressions"]), ["Q"])  # 정의는 남는다
        self.assertEqual(parsed["derived_output_eligible"], [])       # Output 후보는 아니다

    def test_chained_reference_through_another_derived_is_eligible(self):
        # fd2 는 순수 파라미터라 그 자체로는 제외 대상이지만, B 는 fd2 가 아니라
        # compartment 유래인 C 를 참조하므로 포함돼야 한다.
        parsed = parse_ode_input(
            "dAdt = -k*A\n"
            "fd2 = 1-fd1\n"
            "C = A/V\n"
            "B = fd2 + C"
        )

        self.assertNotIn("fd2", parsed["derived_output_eligible"])
        self.assertIn("C", parsed["derived_output_eligible"])
        self.assertIn("B", parsed["derived_output_eligible"])

    def test_mpbpk_reference_model_matches_the_intended_split(self):
        # 사용자의 mPBPK 참조 모델(test_derived.py 의 MPBPK 와 동일) — Q1/Q2/fd2 는
        # 이차 파라미터(제외), C1/C2 는 농도(포함)여야 한다.
        parsed = parse_ode_input(
            "dA1dt = -(CL/V1)*A1 - (Q1/V1)*A1 + (Q2/V2)*A2\n"
            "dA2dt = (Q1/V1)*A1 - (Q2/V2)*A2\n"
            "Q1 = fd1 * QCO\n"
            "Q2 = fd2 * QCO\n"
            "fd2 = 1-fd1\n"
            "C1 = A1/V1\n"
            "C2 = A2/V2"
        )

        self.assertEqual(set(parsed["derived_output_eligible"]), {"C1", "C2"})

    def test_no_cyclic_false_positive_on_a_two_step_chain(self):
        # 순환이 없는 다단 체인에서 위상 순서를 신뢰해 한 번의 순회로 끝까지
        # 판단하는지 확인 — D 는 C 를 거쳐 B, 결국 compartment A 까지 이어진다.
        parsed = parse_ode_input(
            "dAdt = -k*A\n"
            "B = A/V\n"
            "C = B*2\n"
            "D = C+1"
        )

        self.assertEqual(parsed["derived_output_eligible"], ["B", "C", "D"])


class InputValidation(unittest.TestCase):
    def test_a_malformed_nonempty_line_is_not_silently_ignored(self):
        with self.assertRaisesRegex(ValueError, "Expected"):
            parse_ode_input("dAdt = -k*A\nthis is not an equation")

    def test_remaining_non_ascii_characters_are_rejected_clearly(self):
        with self.assertRaisesRegex(ValueError, "Unsupported character"):
            parse_ode_input("dAdt = α*A")


if __name__ == "__main__":
    unittest.main()
