"""`analyzer.py` — 시뮬레이션 곡선을 PK 요약으로 옮기는 자리.

`nca.py` 는 잘 시험돼 있었지만 그것을 부르는 이 자리는 시험이 하나도 없었고,
조용히 틀린 숫자 둘이 여기 있었다.  둘 다 참값이 해석적으로 알려진 1구획
모델로 재현한다.
"""

import os

import numpy as np
import pandas as pd
from django.conf import settings

if not settings.configured:  # pragma: no cover - manage.py 로 돌 때는 이미 되어 있다
    import django

    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "pk_simulator.settings")
    django.setup()

from django.test import SimpleTestCase

from simulator.analyzer import analyze_simulated, infusion_duration_for


CL, V = 4.0, 32.0
K = CL / V                  # 0.125 /h  →  t½ = 5.5452 h
DOSE = 100.0


def iv_infusion_profile(duration, t_end=96.0, n=9601):
    """정맥 주입 1구획의 해석해. MRT = 1/k + Tinf/2 이지만, 보정 뒤에는 1/k 다."""
    t = np.linspace(0.0, t_end, n)
    rate = DOSE / duration
    during = (rate / CL) * (1.0 - np.exp(-K * np.minimum(t, duration)))
    conc = np.where(
        t <= duration,
        during,
        (rate / CL) * (1.0 - np.exp(-K * duration)) * np.exp(-K * (t - duration)),
    )
    return pd.DataFrame({"Time": t, "conc": conc})


class InfusionDuration(SimpleTestCase):
    """주입은 투여 자체가 시간을 쓰므로 MRT 에서 그 절반을 빼야 한다.

    `nca()` 는 `infusion_duration` 을 받을 준비가 되어 있었지만 analyzer 가
    넘겨주지 않아 기본값 0 으로 보정이 한 번도 일어나지 않았다.  2시간 주입에서
    MRT 와 Vss 가 나란히 12.5% 높게 나왔다(9.000/36.00, 참값 8.000/32.00).
    """

    def summary(self, duration):
        doses = [{"compartment": "conc", "type": "infusion",
                  "amount": DOSE, "duration": duration, "start_time": 0}]
        return analyze_simulated(
            iv_infusion_profile(duration), ["conc"], doses
        )["conc"]

    def test_mrt_and_vss_do_not_grow_with_the_infusion_length(self):
        for duration in (2.0, 6.0, 12.0):
            with self.subTest(duration=duration):
                row = self.summary(duration)
                self.assertAlmostEqual(row["mrt"], 1.0 / K, places=3)
                self.assertAlmostEqual(row["vss"], V, places=2)

    def test_clearance_is_unaffected(self):
        """CL 은 넓이의 비라 보정과 무관하다 — 회귀 확인."""
        self.assertAlmostEqual(self.summary(2.0)["cl"], CL, places=3)

    def test_the_duration_is_read_from_the_dose_that_reaches_the_variable(self):
        doses = [
            {"compartment": "gut", "type": "infusion", "amount": 50, "duration": 9},
            {"compartment": "A", "type": "infusion", "amount": DOSE, "duration": 2},
        ]
        derived = {"conc": "A/V"}
        self.assertEqual(infusion_duration_for("conc", doses, derived), 2.0)

    def test_two_infusions_of_different_lengths_are_not_guessed_between(self):
        """뺄 값이 하나로 정해지지 않으면 보정하지 않는다."""
        doses = [
            {"compartment": "A", "type": "infusion", "amount": 50, "duration": 2},
            {"compartment": "A", "type": "infusion", "amount": 50, "duration": 6},
        ]
        self.assertEqual(infusion_duration_for("A", doses, {}), 0.0)

    def test_a_bolus_is_not_corrected(self):
        self.assertEqual(
            infusion_duration_for(
                "A", [{"compartment": "A", "type": "bolus", "amount": DOSE}], {}
            ),
            0.0,
        )


def oral_multiple_dose(t_end, tau=12.0, n_doses=12, ka=1.2, n=None):
    """1구획 경구 반복 투여의 해석해(중첩)."""
    n = n or int(t_end * 50) + 1
    t = np.linspace(0.0, t_end, n)
    conc = np.zeros_like(t)
    factor = DOSE * ka / (V * (ka - K))
    for i in range(n_doses):
        t0 = i * tau
        elapsed = np.where(t >= t0, t - t0, 0.0)
        contribution = factor * (np.exp(-K * elapsed) - np.exp(-ka * elapsed))
        conc += np.where(t >= t0, contribution, 0.0)
    return pd.DataFrame({"Time": t, "conc": conc}), (n_doses - 1) * tau


class TerminalSlopeUnderRepeatDosing(SimpleTestCase):
    """종말상 기울기는 마지막 투여 뒤의 세척 구간에서만 뜻이 있다.

    세척이 없으면 탐색은 아직 흡수도 끝나지 않은 톱니의 마지막 몇 점에
    직선을 맞추고, 그 결과가 half-life 로 표에 실렸다 — 측정한 값이
    44.8시간(참값 5.545), Vz,ss 258.6(참값 32.0)이었다.
    """

    def summary(self, t_end):
        df, last_dose = oral_multiple_dose(t_end)
        doses = [{"compartment": "conc", "type": "bolus", "amount": DOSE,
                  "start_time": 0, "repeat_every": 12, "repeat_until": last_dose}]
        return analyze_simulated(df, ["conc"], doses)["conc"]

    def test_without_a_washout_nothing_is_published(self):
        row = self.summary(134.0)          # 마지막 투여 2시간 뒤 종료
        for key in ("lambda_z", "half_life", "ss_vz"):
            with self.subTest(field=key):
                self.assertIsNone(row[key])
        self.assertTrue(
            any("washout" in w for w in row["warnings"]),
            f"이유를 말해야 한다: {row['warnings']}",
        )

    def test_clearance_at_steady_state_does_not_need_the_slope(self):
        """CL,ss = 용량/AUCτ 이므로 λz 와 무관하다 — 함께 비우면 안 된다."""
        self.assertAlmostEqual(self.summary(134.0)["ss_cl"], CL, delta=0.05)

    def test_with_a_washout_the_true_half_life_comes_back(self):
        row = self.summary(180.0)          # 마지막 투여 48시간 뒤 종료
        self.assertAlmostEqual(row["half_life"], np.log(2) / K, delta=0.05)
        self.assertAlmostEqual(row["ss_vz"], V, delta=0.5)

    def test_single_dose_profiles_are_untouched(self):
        """이 규칙은 반복 투여에서만 적용된다 — 회귀 확인."""
        df = iv_infusion_profile(2.0)
        doses = [{"compartment": "conc", "type": "infusion",
                  "amount": DOSE, "duration": 2, "start_time": 0}]
        row = analyze_simulated(df, ["conc"], doses)["conc"]
        self.assertAlmostEqual(row["half_life"], np.log(2) / K, places=3)
