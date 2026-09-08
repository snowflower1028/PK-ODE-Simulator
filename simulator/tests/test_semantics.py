import json

import numpy as np
import pandas as pd
from django.test import Client, SimpleTestCase

from simulator.analyzer import analyze_observed, analyze_simulated
from simulator.parser import parse_ode_input
from simulator.semantics import resolve_variable_semantics, structural_classes


MPBPK = """\
dA1dt = -(CL/V1)*A1 - (Q1/V1)*A1 + (Q2/V2)*A2
dA2dt = (Q1/V1)*A1 - (Q2/V2)*A2
Q1 = fd1 * QCO
Q2 = fd2 * QCO
fd2 = 1-fd1
C1 = A1/V1
C2 = A2/V2
"""


class StructuralClassificationTests(SimpleTestCase):
    def test_mpbpk_secondary_parameters_are_not_inferred_as_concentrations(self):
        parsed = parse_ode_input(MPBPK)

        self.assertEqual(
            structural_classes(parsed),
            {
                "A1": "compartment",
                "A2": "compartment",
                "fd2": "secondary_parameter",
                "Q1": "secondary_parameter",
                "Q2": "secondary_parameter",
                "C1": "derived_output",
                "C2": "derived_output",
            },
        )
        semantics = resolve_variable_semantics(parsed)
        self.assertTrue(all(v["quantity_kind"] == "unknown" for v in semantics.values()))
        self.assertTrue(all(v["pk_scope"] == "none" for v in semantics.values()))

    def test_pk_scope_requires_an_explicit_concentration(self):
        parsed = parse_ode_input("dAdt = -k*A\nC = A/V")

        with self.assertRaisesRegex(ValueError, "only when it is a concentration"):
            resolve_variable_semantics(
                parsed, {"C": {"quantity_kind": "flow", "pk_scope": "systemic"}}
            )

    def test_parse_api_returns_only_safe_structural_defaults(self):
        response = Client().post(
            "/parse/",
            data=json.dumps({"text": MPBPK}),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200)
        semantics = response.json()["data"]["variable_semantics"]
        self.assertEqual(semantics["Q1"]["structural_class"], "secondary_parameter")
        self.assertEqual(semantics["C1"]["structural_class"], "derived_output")
        self.assertEqual(semantics["C1"]["quantity_kind"], "unknown")


class PkEligibilityTests(SimpleTestCase):
    def setUp(self):
        time = np.linspace(0.0, 8.0, 17)
        self.df = pd.DataFrame(
            {
                "Time": time,
                "C1": np.exp(-0.2 * time),
                "C2": 0.5 * np.exp(-0.1 * time),
                "Q1": np.full_like(time, 5.0),
            }
        )
        self.semantics = {
            "C1": {"quantity_kind": "concentration", "pk_scope": "systemic"},
            "C2": {"quantity_kind": "concentration", "pk_scope": "exposure"},
            "Q1": {"quantity_kind": "flow", "pk_scope": "none"},
        }

    def test_only_pk_concentrations_are_analyzed_and_only_systemic_uses_dose(self):
        result = analyze_simulated(
            self.df,
            ["C1", "C2", "Q1"],
            [{"compartment": "C1", "type": "bolus", "amount": 100.0}],
            variable_semantics=self.semantics,
        )

        self.assertEqual(set(result), {"C1", "C2"})
        self.assertEqual(result["C1"]["dose"], 100.0)
        self.assertIsNotNone(result["C1"]["cl"])
        self.assertIsNone(result["C2"]["dose"])
        self.assertIsNone(result["C2"]["cl"])

    def test_observed_nca_respects_the_same_semantics(self):
        dataset = {
            "name": "study.csv",
            "data": {"Time": [0, 1, 2], "plasma": [2, 1, 0.5], "flow": [5, 5, 5]},
            "mappings": {"plasma": "C1", "flow": "Q1"},
            "dose": 100,
        }

        result = analyze_observed(
            [dataset], [], variable_semantics=self.semantics
        )

        self.assertEqual(set(result), {"C1 · study.csv"})
        self.assertEqual(result["C1 · study.csv"]["dose"], 100.0)

