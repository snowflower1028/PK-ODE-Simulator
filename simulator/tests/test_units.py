"""units.py 검증.

nca.py 의 시험과 같은 규칙으로, 눈으로 본 값을 적어 두는 대신 손으로 셀 수
있는 문제로 확인한다. 단위 환산은 답이 늘 손셈으로 나오므로 이 방식이 특히
잘 맞는다.
"""

import unittest

from simulator.units import (
    Composed,
    FIELD_UNITS,
    UnitError,
    convert,
    display_options,
    field_unit,
    parse_unit,
    scale_factor,
)


P = parse_unit


class Parsing(unittest.TestCase):
    def test_simple_units(self):
        self.assertEqual(P("mg").label, "mg")
        self.assertEqual(P("h").label, "h")
        self.assertEqual(P("hr").label, "h")   # 같은 것을 다르게 적어도
        self.assertEqual(P("L").label, "L")

    def test_micro_sign_spellings_agree(self):
        # MICRO SIGN, 그리스 뮤, 그냥 u — 셋 다 같은 단위여야 한다.
        for spelling in ("µg/mL", "μg/mL", "ug/mL", "UG/ML"):
            self.assertEqual(P(spelling).factor, P("ug/mL").factor, msg=spelling)

    def test_compound_units_are_not_only_concentrations(self):
        # L/h 는 농도가 아니지만 같은 자리에 들어온다.
        self.assertEqual(P("L/h").label, "L/h")
        self.assertEqual(P("mL/min").dim, P("L/h").dim)

    def test_molar_shorthand(self):
        self.assertEqual(P("nM").factor, P("nmol/L").factor)
        self.assertEqual(P("uM").dim, P("umol/L").dim)

    def test_unknown_units_are_refused_by_name(self):
        with self.assertRaises(UnitError) as caught:
            P("furlong")
        self.assertIn("furlong", str(caught.exception))

        with self.assertRaises(UnitError) as caught:
            P("ng/furlong")
        self.assertIn("furlong", str(caught.exception))


class Conversion(unittest.TestCase):
    def test_the_same_size_under_a_different_name(self):
        # mg/L 와 µg/mL 는 같은 크기라 수치가 바뀌면 안 된다.
        self.assertAlmostEqual(convert(1.0, P("mg/L"), P("ug/mL")), 1.0, places=12)
        self.assertAlmostEqual(convert(1.0, P("ng/mL"), P("ug/L")), 1.0, places=12)

    def test_hand_computed_clearance(self):
        # 100 mg 를 주고 AUC 가 25 ng/mL·h 이면 CL 은 4 mg/((ng/mL)·h) 이고,
        # AUC 를 0.025 mg/L·h 로 고쳐 적으면 CL = 100/0.025 = 4000 L/h 다.
        native = field_unit("cl", P("ng/mL"), P("h"), P("mg"))
        self.assertAlmostEqual(convert(4.0, native, P("L/h")), 4000.0, places=6)

    def test_hand_computed_volume(self):
        native = field_unit("vz", P("ng/mL"), P("h"), P("mg"))
        self.assertAlmostEqual(convert(32.0, native, P("L")), 32000.0, places=6)

    def test_round_trip_is_exact_enough(self):
        pairs = [("ng/mL", "ug/L"), ("h", "min"), ("mg", "ug"), ("L/h", "mL/min")]
        for a, b in pairs:
            there = convert(7.0, P(a), P(b))
            back = convert(there, P(b), P(a))
            self.assertAlmostEqual(back, 7.0, places=9, msg=f"{a} -> {b}")

    def test_none_stays_none(self):
        self.assertIsNone(convert(None, P("mg"), P("ug")))

    def test_different_kinds_are_refused(self):
        with self.assertRaises(UnitError):
            convert(1.0, P("h"), P("mg"))
        with self.assertRaises(UnitError):
            convert(1.0, P("ng/mL"), P("L/h"))


class MassAndMoles(unittest.TestCase):
    """분자량 없이는 오갈 수 없다. 못 하겠다고 말해야지 지어내면 안 된다."""

    def test_refused_without_a_molecular_weight(self):
        with self.assertRaises(UnitError) as caught:
            convert(1.0, P("ng/mL"), P("nmol/L"))
        self.assertIn("molecular weight", str(caught.exception))

    def test_hand_computed_with_a_molecular_weight(self):
        # 1 ng 은 1e-9 g. MW 500 g/mol 이면 2e-12 mol = 2 pmol.
        # mL 당 2 pmol 은 L 당 2 nmol 이다.
        self.assertAlmostEqual(
            convert(1.0, P("ng/mL"), P("nmol/L"), mw=500.0), 2.0, places=9)

    def test_round_trip_through_a_molecular_weight(self):
        there = convert(3.7, P("ug/mL"), P("umol/L"), mw=325.0)
        back = convert(there, P("umol/L"), P("ug/mL"), mw=325.0)
        self.assertAlmostEqual(back, 3.7, places=9)

    def test_a_zero_or_missing_weight_is_not_taken_as_a_number(self):
        for bad in (None, 0.0, -1.0):
            with self.assertRaises(UnitError):
                convert(1.0, P("ng/mL"), P("nmol/L"), mw=bad)


class ComposedFields(unittest.TestCase):
    """각 항목이 C·T·D 를 몇 제곱씩 쓰는지."""

    def setUp(self):
        self.C, self.T, self.D = P("ng/mL"), P("h"), P("mg")

    def test_every_registered_field_composes(self):
        for name in FIELD_UNITS:
            unit = field_unit(name, self.C, self.T, self.D)
            self.assertIsNotNone(unit, msg=name)
            self.assertTrue(unit.label, msg=name)

    def test_labels_read_the_way_they_are_written(self):
        self.assertEqual(field_unit("auc_last", self.C, self.T, self.D).label,
                         "(ng/mL)·h")
        self.assertEqual(field_unit("aumc_last", self.C, self.T, self.D).label,
                         "(ng/mL)·h^2")
        self.assertEqual(field_unit("lambda_z", self.C, self.T, self.D).label,
                         "1/h")
        self.assertEqual(field_unit("cl", self.C, self.T, self.D).label,
                         "mg/((ng/mL)·h)")

    def test_an_unregistered_field_is_dimensionless(self):
        # 백분율과 개수는 단위가 없다.
        for name in ("auc_extrap_pct", "lambda_z_n_points", "lambda_z_span"):
            self.assertIsNone(field_unit(name, self.C, self.T, self.D), msg=name)
            self.assertEqual(display_options(name), ())

    def test_changing_only_the_time_unit_scales_by_the_time_ratio(self):
        # AUC 는 C·T 라 시간 단위만 바꾸면 시간 비율만큼만 움직여야 한다.
        in_hours = field_unit("auc_last", self.C, P("h"), self.D)
        in_minutes = field_unit("auc_last", self.C, P("min"), self.D)
        self.assertAlmostEqual(scale_factor(in_hours, in_minutes), 60.0, places=9)

        # AUMC 는 C·T² 라 제곱만큼 움직인다.
        m_hours = field_unit("aumc_last", self.C, P("h"), self.D)
        m_minutes = field_unit("aumc_last", self.C, P("min"), self.D)
        self.assertAlmostEqual(scale_factor(m_hours, m_minutes), 3600.0, places=6)

    def test_conversion_composes(self):
        # A -> C 가 A -> B -> C 와 같아야 한다. 곱셈이므로 당연하지만,
        # 이것이 무너지면 사용자가 단위를 두 번 바꿨을 때 값이 흘러내린다.
        a = field_unit("cl", P("ng/mL"), P("h"), P("mg"))
        b = field_unit("cl", P("ug/L"), P("min"), P("ug"))
        c = field_unit("cl", P("mg/L"), P("day"), P("g"))
        direct = scale_factor(a, c)
        stepped = scale_factor(a, b) * scale_factor(b, c)
        self.assertAlmostEqual(direct, stepped, delta=abs(direct) * 1e-9)


class DisplayChoices(unittest.TestCase):
    def test_clearance_and_volume_get_readable_names(self):
        # 조합한 이름이 mg/((ng/mL)·h) 라서, 고를 때는 익숙한 쪽을 내놓는다.
        self.assertIn("L/h", display_options("cl"))
        self.assertIn("L", display_options("vz"))

    def test_every_offered_choice_actually_parses_and_fits(self):
        for name in FIELD_UNITS:
            native = field_unit(name, P("ng/mL"), P("h"), P("mg"))
            for choice in display_options(name, native):
                # 고를 수 있다고 내놓은 단위는 실제로 환산이 되어야 한다.
                scale_factor(native, P(choice))

    def test_molar_choices_are_hidden_until_a_weight_is_given(self):
        native = field_unit("c_max", P("ng/mL"), P("h"), P("mg"))
        without = display_options("c_max", native)
        self.assertIn("ug/L", [c.replace("µ", "u") for c in without])
        self.assertNotIn("nmol/L", without)

        # 분자량을 주면 그때 나타난다. 고를 수 없는 것을 내놓지 않는 것이
        # 골랐을 때 거절하는 것보다 낫다.
        with_mw = display_options("c_max", native, mw=500.0)
        self.assertIn("nmol/L", with_mw)
        self.assertGreater(len(with_mw), len(without))


if __name__ == "__main__":
    unittest.main()
