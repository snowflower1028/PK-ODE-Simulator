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


class InputValidation(unittest.TestCase):
    def test_a_malformed_nonempty_line_is_not_silently_ignored(self):
        with self.assertRaisesRegex(ValueError, "Expected"):
            parse_ode_input("dAdt = -k*A\nthis is not an equation")

    def test_remaining_non_ascii_characters_are_rejected_clearly(self):
        with self.assertRaisesRegex(ValueError, "Unsupported character"):
            parse_ode_input("dAdt = α*A")


if __name__ == "__main__":
    unittest.main()
