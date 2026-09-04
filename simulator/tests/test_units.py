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
    preferred_unit,
    scale_factor,
    unit_group,
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

    def test_a_lone_unit_carries_no_parentheses(self):
        # 괄호는 다른 조각과 붙을 때만 필요하다. 혼자인데 씌우면 Cmax 의
        # 단위가 (ng/mL) 로 나온다.
        self.assertEqual(field_unit("c_max", self.C, self.T, self.D).label, "ng/mL")
        self.assertEqual(field_unit("half_life", self.C, self.T, self.D).label, "h")
        self.assertEqual(field_unit("dose", self.C, self.T, self.D).label, "mg")

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


class BodyWeight(unittest.TestCase):
    """체중은 약물의 질량과 다른 양이다.

    한 차원으로 묶으면 mg/kg 이 무차원이 되고, CL 이 L/h/kg 으로 나와야 할
    자리에 L/h 가 나온다. 전임상에서 실제로 보고하는 형태가 체중당이므로
    이게 어긋나면 값이 조용히 1000배쯤 틀린다.
    """

    def setUp(self):
        self.C, self.T = P("ng/mL"), P("h")

    def test_a_dose_per_kilogram_is_not_dimensionless(self):
        self.assertFalse(P("mg/kg").dim.is_dimensionless)
        # 분자의 kg 은 여전히 약물의 질량이다 — 1 kg 을 투여할 수도 있다.
        self.assertEqual(P("kg").dim, P("mg").dim)
        # 그리고 mg/kg 은 mg 과 같은 차원이 아니다.
        self.assertNotEqual(P("mg/kg").dim, P("mg").dim)

    def test_denominators_read_kg_as_body_weight(self):
        # mg/kg 는 질량/체중이라 남는 차원이 있다.
        self.assertEqual(P("mg/kg").dim.mass, 1)
        self.assertEqual(P("mg/kg").dim.bw, -1)

    def test_clearance_comes_out_per_kilogram(self):
        cl = field_unit("cl", self.C, self.T, P("mg/kg"))
        self.assertEqual(cl.dim.volume, 1)
        self.assertEqual(cl.dim.time, -1)
        self.assertEqual(cl.dim.bw, -1)

    def test_hand_computed_per_kilogram_clearance(self):
        # 100 mg/kg 에 AUC 25 ng/mL·h 이면 CL 은 4 (mg/kg)/((ng/mL)·h).
        # AUC 를 0.025 mg/L·h 로 고쳐 적으면 CL = 100/0.025 = 4000 L/h/kg.
        native = field_unit("cl", self.C, self.T, P("mg/kg"))
        self.assertAlmostEqual(convert(4.0, native, P("L/h/kg")), 4000.0, places=6)
        # 4000 L/h/kg = 4e6 mL/h/kg = 66666.7 mL/min/kg
        self.assertAlmostEqual(convert(4.0, native, P("mL/min/kg")),
                               4000.0 * 1000.0 / 60.0, places=3)

    def test_volume_comes_out_per_kilogram(self):
        native = field_unit("vz", self.C, self.T, P("mg/kg"))
        self.assertAlmostEqual(convert(32.0, native, P("L/kg")), 32000.0, places=6)

    def test_absolute_and_per_weight_do_not_mix(self):
        absolute = field_unit("cl", self.C, self.T, P("mg"))
        per_kilo = field_unit("cl", self.C, self.T, P("mg/kg"))
        with self.assertRaises(UnitError):
            scale_factor(absolute, per_kilo)
        with self.assertRaises(UnitError):
            convert(1.0, per_kilo, P("L/h"))

    def test_only_the_reachable_family_is_offered(self):
        # 고를 수 없는 것을 내놓고 고르는 순간 막으면 고장으로 보인다.
        absolute = display_options("cl", field_unit("cl", self.C, self.T, P("mg")))
        per_kilo = display_options("cl", field_unit("cl", self.C, self.T, P("mg/kg")))
        self.assertIn("L/h", absolute)
        self.assertNotIn("L/h/kg", absolute)
        self.assertIn("L/h/kg", per_kilo)
        self.assertNotIn("L/h", per_kilo)

    def test_a_body_weight_bridges_the_two_families(self):
        per_kilo = field_unit("cl", self.C, self.T, P("mg/kg"))
        # 4 (mg/kg)/((ng/mL)·h) = 4000 L/h/kg. 25 kg 짜리면 100000 L/h.
        self.assertAlmostEqual(convert(4.0, per_kilo, P("L/h/kg")), 4000.0, places=6)
        self.assertAlmostEqual(convert(4.0, per_kilo, P("L/h"), bw=25.0),
                               100000.0, places=3)
        # 반대 방향도 같은 다리를 쓴다.
        absolute = field_unit("cl", self.C, self.T, P("mg"))
        self.assertAlmostEqual(convert(4.0, absolute, P("L/h/kg"), bw=25.0),
                               4000.0 / 25.0, places=6)

    def test_the_bridge_opens_the_other_family_in_the_menu(self):
        per_kilo = field_unit("cl", self.C, self.T, P("mg/kg"))
        without = display_options("cl", per_kilo)
        with_bw = display_options("cl", per_kilo, bw=25.0)
        self.assertNotIn("L/h", without)
        self.assertIn("L/h", with_bw)
        self.assertIn("L/h/kg", with_bw)

    def test_a_zero_or_missing_weight_is_not_taken_as_a_number(self):
        per_kilo = field_unit("cl", self.C, self.T, P("mg/kg"))
        for bad in (None, 0.0, -3.0):
            with self.assertRaises(UnitError):
                convert(1.0, per_kilo, P("L/h"), bw=bad)

    def test_concentration_and_time_are_untouched(self):
        # 체중 차원을 더했다고 기존 단위가 달라지면 안 된다.
        self.assertAlmostEqual(convert(1.0, P("mg/L"), P("ug/mL")), 1.0, places=12)
        self.assertAlmostEqual(convert(1.0, P("h"), P("min")), 60.0, places=12)
        self.assertAlmostEqual(convert(1.0, P("mL/min"), P("L/h")), 0.06, places=12)


class Groups(unittest.TestCase):
    """같은 종류끼리 묶어 한 번에 고르게 한다.

    항목마다 따로 고르게 두면 Cmax 는 ng/mL 인데 Clast 는 µg/mL 인 표가
    나올 수 있다. 묶는 기준은 단위 조합 그 자체다 — 조합이 같으면 고를 수
    있는 것도 같기 때문이다.
    """

    def setUp(self):
        self.C, self.T, self.D = P("ng/mL"), P("h"), P("mg")

    def test_fields_of_a_kind_land_in_one_group(self):
        for field in ("c_max", "c_last", "c_last_pred", "c0_back_extrapolated"):
            self.assertEqual(unit_group(field), "concentration", msg=field)
        for field in ("t_max", "t_last", "half_life", "mrt", "mrt_last"):
            self.assertEqual(unit_group(field), "time", msg=field)
        self.assertEqual(unit_group("cl"), "clearance")
        self.assertEqual(unit_group("vz"), unit_group("vss"))

    def test_a_group_shares_one_native_unit_and_one_menu(self):
        # 이것이 무너지면 종류별로 고르게 하는 것이 성립하지 않는다.
        for group in ("concentration", "time", "clearance", "volume"):
            fields = [f for f in FIELD_UNITS if unit_group(f) == group]
            natives = {field_unit(f, self.C, self.T, self.D).label for f in fields}
            menus = {display_options(f, field_unit(f, self.C, self.T, self.D))
                     for f in fields}
            self.assertEqual(len(natives), 1, msg=f"{group}: {natives}")
            self.assertEqual(len(menus), 1, msg=f"{group}: {menus}")

    def test_dimensionless_fields_have_no_group(self):
        for field in ("auc_extrap_pct", "lambda_z_span", "lambda_z_n_points"):
            self.assertIsNone(unit_group(field), msg=field)


class Rates(unittest.TestCase):
    """λz 는 1/시간이다. 반감기를 분으로 보면서 λz 만 1/h 로 두면 어긋난다."""

    def test_one_over_a_unit_parses(self):
        self.assertEqual(P("1/h").dim, P("h").dim ** -1)
        self.assertAlmostEqual(P("1/min").factor, 60.0, places=9)

    def test_hand_computed_rate_conversion(self):
        native = field_unit("lambda_z", P("ng/mL"), P("h"), P("mg"))
        # 0.1233 1/h 는 분당 0.1233/60 이다.
        self.assertAlmostEqual(convert(0.1233, native, P("1/min")),
                               0.1233 / 60.0, places=12)
        self.assertAlmostEqual(convert(0.1233, native, P("1/day")),
                               0.1233 * 24.0, places=12)

    def test_a_rate_is_not_a_time(self):
        with self.assertRaises(UnitError):
            convert(1.0, P("1/h"), P("h"))


class PreferredUnits(unittest.TestCase):
    """조립한 이름이 읽히지 않는 항목은 처음부터 관용 단위에 담는다.

    용량 mg 을 ng/mL·h 로 나누면 mg/((ng/mL)·h) 가 나온다. 틀린 이름은
    아니지만 아무도 그렇게 적지 않는다. 단위가 서로 맞물려 있지 않아도 환산은
    곱셈 하나라, 처음부터 읽히는 쪽에 담는 것이 맞다.
    """

    def setUp(self):
        self.C, self.T = P("ng/mL"), P("h")

    def _pref(self, field, dose):
        native = field_unit(field, self.C, self.T, P(dose))
        return preferred_unit(field, native), native

    def test_an_absolute_dose_gives_the_clinical_units(self):
        label, native = self._pref("cl", "mg")
        self.assertEqual(label, "L/h")
        # mg/((ng/mL)·h) 는 L/h 의 1000 배다.
        self.assertAlmostEqual(scale_factor(native, P(label)), 1000.0, places=6)

        label, _ = self._pref("vz", "mg")
        self.assertEqual(label, "L")

    def test_a_dose_per_kilogram_gives_the_preclinical_units(self):
        label, native = self._pref("cl", "mg/kg")
        self.assertEqual(label, "mL/min/kg")
        # 4000 L/h/kg 은 분당 66666.7 mL/kg 이다.
        self.assertAlmostEqual(scale_factor(native, P(label)),
                               1000.0 * 1000.0 / 60.0, places=3)

        for field in ("vz", "vss"):
            label, _ = self._pref(field, "mg/kg")
            self.assertEqual(label, "L/kg", msg=field)

    def test_units_that_already_line_up_are_left_alone_in_size(self):
        # µg 를 ng/mL 로 나누면 정확히 L 이 된다 — 이름만 바뀌고 값은 그대로다.
        label, native = self._pref("cl", "ug")
        self.assertEqual(label, "L/h")
        self.assertAlmostEqual(scale_factor(native, P(label)), 1.0, places=12)

    def test_what_the_user_entered_is_not_second_guessed(self):
        # 농도·시간·용량은 넣은 그대로 둔다. 넣은 ng/mL 을 말없이 mg/L 로
        # 바꿔 보여 줄 이유가 없다.
        for field in ("c_max", "half_life", "t_max", "dose", "auc_last",
                      "aumc_last", "lambda_z"):
            native = field_unit(field, self.C, self.T, P("mg"))
            self.assertIsNone(preferred_unit(field, native), msg=field)


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
