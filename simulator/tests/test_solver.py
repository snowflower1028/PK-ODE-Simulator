import unittest
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np

from simulator.solver import solve_ode_system


def zero_rhs(t, y, parameters):
    return [0.0]


class DoseEvents(unittest.TestCase):
    def solve(self, doses, *, span=(0.0, 2.0), times=(0.0, 1.0, 2.0)):
        return solve_ode_system(
            equations_callable=zero_rhs,
            compartments=["A"],
            parameters=[],
            init_values={"A": 0},
            param_values={},
            t_span=span,
            t_eval=times,
            doses=doses,
        )

    def test_fractional_bolus_is_not_truncated_by_integer_initials(self):
        df = self.solve([
            {"compartment": "A", "type": "bolus", "amount": 1.5, "start_time": 0}
        ])

        np.testing.assert_allclose(df["A"], [1.5, 1.5, 1.5])

    def test_nearby_distinct_events_are_each_consumed_once(self):
        df = self.solve(
            [
                {"compartment": "A", "type": "bolus", "amount": 10, "start_time": 1.0},
                {"compartment": "A", "type": "bolus", "amount": 20, "start_time": 1.000005},
            ],
            times=(0.0, 1.0, 1.000005, 2.0),
        )

        np.testing.assert_allclose(df["A"], [0.0, 10.0, 30.0, 30.0])

    def test_event_boundaries_are_right_continuous(self):
        df = self.solve(
            [{"compartment": "A", "type": "bolus", "amount": 7, "start_time": 1}],
            times=(0.999, 1.0, 1.001),
        )

        np.testing.assert_allclose(df["A"], [0.0, 7.0, 7.0])

    def test_bolus_at_the_end_of_the_range_is_applied(self):
        df = self.solve(
            [{"compartment": "A", "type": "bolus", "amount": 3, "start_time": 2}],
            times=(0.0, 2.0),
        )

        np.testing.assert_allclose(df["A"], [0.0, 3.0])

    def test_an_infusion_already_running_at_t_start_remains_active(self):
        df = self.solve(
            [{
                "compartment": "A", "type": "infusion", "amount": 10,
                "start_time": 0, "duration": 10,
            }],
            span=(5.0, 6.0),
            times=(5.0, 6.0),
        )

        np.testing.assert_allclose(df["A"], [0.0, 1.0], rtol=1e-9, atol=1e-9)


class SolverValidation(unittest.TestCase):
    def test_zero_or_reversed_time_range_is_rejected(self):
        for span in ((1, 1), (2, 1)):
            with self.subTest(span=span), self.assertRaisesRegex(ValueError, "t_span"):
                solve_ode_system(zero_rhs, ["A"], [], {"A": 1}, {}, span, [span[0]])

    def test_missing_model_values_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "Missing parameter"):
            solve_ode_system(zero_rhs, ["A"], ["k"], {"A": 0}, {}, [0, 1], [0, 1])

    def test_invalid_dose_is_rejected_instead_of_ignored(self):
        with self.assertRaisesRegex(ValueError, "dose type"):
            solve_ode_system(
                zero_rhs, ["A"], [], {"A": 0}, {}, [0, 1], [0, 1],
                [{"compartment": "A", "type": "mystery", "amount": 1, "start_time": 0}],
            )

    @patch("simulator.solver.solve_ivp")
    def test_an_integration_failure_is_raised(self, mocked_solve):
        mocked_solve.return_value = SimpleNamespace(
            success=False,
            message="deliberate failure",
            t=np.array([0.0]),
            y=np.array([[1.0]]),
            sol=None,
        )

        with self.assertRaisesRegex(RuntimeError, "deliberate failure"):
            solve_ode_system(zero_rhs, ["A"], [], {"A": 1}, {}, [0, 1], [0, 1])


if __name__ == "__main__":
    unittest.main()
