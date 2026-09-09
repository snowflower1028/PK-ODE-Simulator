"""요청 하나가 서비스를 멈추지 못하게 하는 상한들.

여기 있는 입력은 전부 실제로 재 본 것이다. 상한이 없을 때:

  repeat_every=0.002        2분이 지나도 응답이 오지 않았다
  t_steps=2,000,000         np.linspace 만으로 1.6 GB
  x1=2**1000; x2=x1**10000  파싱 도중 메모리가 바닥났다

화면에는 max="1000" 같은 제한이 이미 있지만 그건 브라우저에게 하는 부탁이라,
직접 POST 하면 그냥 지나간다. 그래서 서버에서 다시 본다.
"""

import json
import os

from django.conf import settings

if not settings.configured:  # pragma: no cover - manage.py 로 돌 때는 이미 되어 있다
    import django

    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "pk_simulator.settings")
    django.setup()

from django.test import SimpleTestCase

from simulator.parser import parse_ode_input


BASE = {
    "equations": "dAdt = -k*A",
    "parameters": {"k": 0.1},
    "initials": {"A": 1},
    "t_start": 0,
    "t_end": 48,
    "t_steps": 200,
    "doses": [],
}


class RequestLimits(SimpleTestCase):
    def simulate(self, **overrides):
        payload = json.loads(json.dumps(BASE))
        payload.update(overrides)
        response = self.client.post(
            "/simulate/", data=json.dumps(payload), content_type="application/json"
        )
        return response.status_code, response.json().get("message", "")

    def test_a_reasonable_request_still_works(self):
        status, _ = self.simulate()
        self.assertEqual(status, 200)

    def test_a_dose_cannot_repeat_without_limit(self):
        """이벤트 하나가 적분 구간 하나다. 간격이 짧으면 구간 수가 폭발한다."""
        status, message = self.simulate(doses=[{
            "compartment": "A", "type": "bolus", "amount": 1,
            "start_time": 0, "repeat_every": 0.002, "repeat_until": 1e9,
        }])
        self.assertEqual(status, 400)
        self.assertIn("repeat", message)

    def test_ordinary_repeat_dosing_is_untouched(self):
        status, _ = self.simulate(doses=[{
            "compartment": "A", "type": "bolus", "amount": 1,
            "start_time": 0, "repeat_every": 12, "repeat_until": 48,
        }])
        self.assertEqual(status, 200)

    def test_numeric_dose_fields_sent_as_text_are_accepted_not_crashed(self):
        """예전에는 "12" 가 비교까지 흘러가 TypeError 로 500 이 났다."""
        status, _ = self.simulate(doses=[{
            "compartment": "A", "type": "bolus", "amount": "1",
            "start_time": "0", "repeat_every": "12", "repeat_until": "48",
        }])
        self.assertEqual(status, 200)

    def test_a_dose_field_that_is_not_a_number_is_refused(self):
        status, message = self.simulate(doses=[{
            "compartment": "A", "type": "bolus", "amount": 1, "start_time": "soon",
        }])
        self.assertEqual(status, 400)
        self.assertIn("start_time", message)

    def test_the_time_grid_has_a_ceiling(self):
        status, message = self.simulate(t_steps=2_000_000)
        self.assertEqual(status, 400)
        self.assertIn("t_steps", message)

    def test_the_time_grid_needs_at_least_two_points(self):
        status, message = self.simulate(t_steps=1)
        self.assertEqual(status, 400)
        self.assertIn("t_steps", message)

    def test_uploaded_observations_have_a_ceiling(self):
        """관찰 시각은 적분 격자에 끼어들므로, 점 수가 곧 계산량이다."""
        big = list(range(15_000))
        status, message = self.simulate(observed=[{
            "name": "big.csv",
            "data": {"Time": big, "P": big},
            "mappings": {"P": "A"},
        }])
        self.assertEqual(status, 400)
        self.assertIn("observed data", message)


class ParserLimits(SimpleTestCase):
    def test_a_single_huge_power_is_refused(self):
        with self.assertRaisesRegex(ValueError, "too large"):
            parse_ode_input("dAdt = ((2**10000)**200)**2 * A")

    def test_a_power_chained_through_a_named_value_is_refused(self):
        """밑이 심볼일 때는 파싱 시점에 크기를 알 수 없으므로 치환 뒤 다시 잰다."""
        with self.assertRaisesRegex(ValueError, "too large"):
            parse_ode_input("x1 = 2**1000\nx2 = x1**10000\ndAdt = -A*x2")

    def test_repeated_squaring_by_multiplication_is_refused(self):
        """거듭제곱만 막으면 곱셈으로 같은 일을 할 수 있다."""
        lines = ["x0 = 2**1000"]
        lines += [f"x{i} = x{i-1}*x{i-1}" for i in range(1, 40)]
        lines.append("dAdt = -A*x39")
        with self.assertRaisesRegex(ValueError, "too large"):
            parse_ode_input("\n".join(lines))

    def test_the_powers_pk_models_actually_use_are_fine(self):
        for text in (
            "dAdt = -k*A**2",                          # 2차 소실
            "dAdt = -CL*(BW/70)**0.75*A",              # 알로메트리
            "Km = 2**10\ndAdt = -Vmax*A/(Km+A)",       # Michaelis-Menten
        ):
            with self.subTest(model=text.splitlines()[-1]):
                parse_ode_input(text)

    def test_a_syntax_error_is_a_bad_request_not_a_server_error(self):
        response = self.client.post(
            "/parse/", data=json.dumps({"text": "dAdt = -k*"}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 400)
