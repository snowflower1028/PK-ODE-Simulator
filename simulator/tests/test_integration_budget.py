"""적분이 끝나지 않는 요청이 워커를 붙잡지 않는가 (T3b).

유입 속도가 약 1e145 를 넘으면 LSODA 의 걸음 폭이 t=0 에서 정확히 0 이 되어
시간이 나아가지 않은 채 RHS 만 초당 13만 번 불렀다 — 끝나지 않았다.
투여가 아니라 파라미터로도 된다(`dAdt = -k*A + R`, R=1e150).  Render 의
gunicorn --timeout 180 이 워커를 죽일 때까지 요청 하나가 서비스를 붙잡았다.

    수정 전: R=1e150, 1e200, 주입 1e150/1e300  → 끝나지 않음 (8초에서 끊음)
    수정 후: 모두 약 0.8 초에 400
    R ≤ 1e143 은 예전처럼 해석해와 같은 값으로 끝난다.
    정상 최대 부하(stiff 5000회 투여, 1.63M 평가)는 비트 단위로 같은 결과.
"""
import json
import time
from unittest import mock

import numpy as np
from django.test import SimpleTestCase

import simulator.solver as solver_module
from simulator.parser import parse_ode_input
from simulator.solver import IntegrationStalled, generate_rhs_function, solve_ode_system


def _solve(ode, params, init, t_end=10.0, doses=(), n=11):
    p = parse_ode_input(ode)
    f = generate_rhs_function(p["equations"], p["compartments"], p["parameters"])
    return solve_ode_system(
        f, p["compartments"], p["parameters"], init, params,
        (0.0, t_end), np.linspace(0.0, t_end, n), list(doses),
    )


#: 멈춤 판정은 초당 13만 평가 기준으로 1초 안쪽이다.  느린 CI 를 감안한 여유.
_FAST = 10.0


class 멈추던_경우는_빨리_거절(SimpleTestCase):
    def assertRejectedQuickly(self, **kw):
        t0 = time.perf_counter()
        with self.assertRaisesRegex(IntegrationStalled, "stopped advancing"):
            _solve(**kw)
        self.assertLess(time.perf_counter() - t0, _FAST)

    def test_파라미터로_만든_큰_유입(self):
        self.assertRejectedQuickly(ode="dAdt = -k*A + R",
                                   params={"k": 0.1, "R": 1e150}, init={"A": 0.0})

    def test_주입으로_만든_큰_유입(self):
        self.assertRejectedQuickly(
            ode="dAdt = -k*A", params={"k": 0.1}, init={"A": 0.0},
            doses=[{"compartment": "A", "type": "infusion", "amount": 1e150,
                    "duration": 1.0, "start_time": 0}],
        )

    def test_거절_직후에도_솔버는_정상(self):
        """LSODA 를 콜백 안에서 끊어도 다음 적분에 흔적이 남지 않는다."""
        with self.assertRaises(IntegrationStalled):
            _solve("dAdt = -k*A + R", {"k": 0.1, "R": 1e150}, {"A": 0.0})
        df = _solve("dAdt = -k*A", {"k": 0.1}, {"A": 1.0})
        self.assertAlmostEqual(float(df["A"].iloc[-1]), np.exp(-1.0), places=7)


class 경계_아래는_예전처럼(SimpleTestCase):
    def test_큰_유입도_표현되면_해석해(self):
        for R in (1e100, 1e140, 1e143):
            with self.subTest(R=R):
                df = _solve("dAdt = -k*A + R", {"k": 0.1, "R": R}, {"A": 0.0})
                want = R / 0.1 * (1 - np.exp(-1.0))
                self.assertAlmostEqual(float(df["A"].iloc[-1]) / want, 1.0, places=6)

    def test_반복_투여_5000회는_예산의_작은_일부(self):
        """정상 부하가 상한 근처에 있으면 상한이 틀린 것이다."""
        calls = []
        real = solver_module._RhsBudget

        class Spy(real):
            __slots__ = ()

            def __init__(self):
                super().__init__()
                calls.append(self)

        with mock.patch.object(solver_module, "_RhsBudget", Spy):
            _solve("dAdt = -k*A", {"k": 0.1}, {"A": 0.0}, t_end=5000.0, n=501,
                   doses=[{"compartment": "A", "type": "bolus", "amount": 100,
                           "start_time": 0, "repeat_every": 1, "repeat_until": 4999}])
        self.assertLess(calls[0].calls, solver_module._MAX_RHS_EVALS / 20)


class 전체_상한(SimpleTestCase):
    def test_상한을_넘으면_거절(self):
        """멈춤 판정을 피해 가는 경우의 마지막 방어선. 상한을 낮춰 확인한다."""
        with mock.patch.object(solver_module, "_MAX_RHS_EVALS", 50):
            with self.assertRaisesRegex(IntegrationStalled, "more than 50 model evaluations"):
                _solve("dAdt = -k*A", {"k": 0.1}, {"A": 1.0}, t_end=48.0)


class HTTP와_피팅(SimpleTestCase):
    BODY = {
        "equations": "dAdt = -k*A + R", "initials": {"A": 0.0},
        "parameters": {"k": 0.1, "R": 1e150},
        "t_start": 0, "t_end": 10, "t_steps": 11, "doses": [],
    }

    def test_simulate_는_400(self):
        t0 = time.perf_counter()
        r = self.client.post("/simulate/", json.dumps(self.BODY),
                             content_type="application/json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("stopped advancing", r.json()["message"])
        self.assertLess(time.perf_counter() - t0, _FAST)

    def test_sweep_도_400(self):
        body = dict(self.BODY, sweep={"mode": "scan", "kind": "parameter",
                                      "target": "k", "values": [0.1]})
        r = self.client.post("/sweep/", json.dumps(body), content_type="application/json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("stopped advancing", r.json()["message"])

    def test_피팅이_멈추지_않고_오류를_돌려준다(self):
        from simulator.fitting import fit
        t0 = time.perf_counter()
        out = fit({
            "equations": "dAdt = -k*A + R", "initials": {"A": 0},
            "parameters": {"k": 0.1, "R": 1e150},
            "fit_params": ["k"], "param_scopes": {"k": "shared"},
            "bounds": {"k": [0.01, 1]},
            "fitting_groups": [{"doses": [],
                                "observed": {"Time": [1, 2, 4], "Conc": [1, 2, 3]},
                                "mappings": {"Conc": "A"}}],
        })
        self.assertEqual(out["status"], "error")
        self.assertLess(time.perf_counter() - t0, _FAST * 3)
