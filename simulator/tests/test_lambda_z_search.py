"""종말상 기울기 탐색이 O(n) 이 되어도 같은 창·같은 값을 고르는가 (T5b).

예전 탐색은 창을 넓힐 때마다 처음부터 다시 맞춰 O(n²) 이었다. 20,000점에서
탐색 하나가 1.87 초라 t_steps 상한을 20,000 으로 묶어야 했다. 이제 Welford
방식 누적 갱신으로 창을 고르고(0.051 초), 고른 창을 예전과 같은 두 단계
최소제곱으로 다시 맞춰 보고한다.

측정: 무작위 30,300개 프로파일(희소 임상형·BLQ 꼬리·Tmax 제외, 무잡음 단일/
이중지수, t≈1e6 좁은 간격, 평평한 꼬리, 시뮬레이션 격자)에서 예전과 모든
필드가 같았다.
"""
import time
import unittest
from unittest import mock

import numpy as np

import simulator.nca as N


def _reference(t, c, min_points=3, exclude_tmax=False):
    """예전 탐색 — 모듈에 _best_fit_quadratic 으로 남겨 둔 것."""
    t, c = N._clean(t, c)
    if t.size < min_points:
        return N.LambdaZ()
    i_tmax = int(np.argmax(c))
    start = i_tmax + 1 if exclude_tmax else i_tmax
    idx = np.array([i for i in range(start, t.size) if c[i] > 0], dtype=int)
    if idx.size < min_points:
        return N.LambdaZ()
    return N._best_fit_quadratic(t, c, idx, min_points)


class 예전과_같은_답(unittest.TestCase):
    def assertSame(self, t, c, **kw):
        self.assertEqual(N.best_fit_lambda_z(t, c, **kw), _reference(t, c, **kw))

    def test_무작위_희소_자료(self):
        rng = np.random.default_rng(20260922)
        grid = np.r_[0.25, 0.5, 1, 1.5, 2, 3, 4, 6, 8, 10, 12, 16, 24, 36, 48, 72]
        for _ in range(2000):
            n = int(rng.integers(4, 17))
            t = np.sort(rng.choice(grid, n, replace=False))
            c = 100 * (np.exp(-rng.uniform(0.02, 0.5) * t) - np.exp(-rng.uniform(0.5, 3) * t))
            c = c * rng.lognormal(0, rng.choice([0, 0.05, 0.2]), n)
            if rng.random() < 0.3:
                c[-int(rng.integers(1, 3)):] = 0.0
            self.assertSame(t, c, min_points=int(rng.choice([3, 4])),
                            exclude_tmax=bool(rng.random() < 0.3))

    def test_모든_창이_동점인_무잡음_단일지수(self):
        """조정 결정계수가 거의 같아 동점 규칙이 가장 예민한 경우."""
        rng = np.random.default_rng(1)
        for _ in range(300):
            t = np.linspace(0, rng.uniform(5, 500), int(rng.integers(5, 200)))
            self.assertSame(t, 50 * np.exp(-rng.uniform(0.001, 2) * t))

    def test_시각이_크고_간격이_좁다(self):
        """원시 합(Σt, Σt²)이었다면 자릿수 상쇄로 망가지는 경우."""
        rng = np.random.default_rng(2)
        for _ in range(300):
            t = 1e6 + np.sort(rng.uniform(0, 10, int(rng.integers(10, 80))))
            self.assertSame(t, np.exp(-0.3 * (t - 1e6)) * rng.lognormal(0, 0.02, t.size))

    def test_시뮬레이션_격자(self):
        t = np.linspace(0, 48, 2001)
        self.assertSame(t, 100 * (np.exp(-0.1 * t) - np.exp(-1.5 * t)))


class 대체_경로(unittest.TestCase):
    def test_다시_맞춘_창이_조건을_못_맞추면_예전_탐색(self):
        t = np.array([0.5, 1, 2, 4, 6, 8, 12, 24.0])
        c = np.array([3, 8, 10, 7, 5, 3.6, 1.9, 0.3])
        real = N._window_candidate
        calls = []

        def first_fails(*args, **kwargs):
            calls.append(1)
            return None if len(calls) == 1 else real(*args, **kwargs)

        with mock.patch.object(N, "_window_candidate", first_fails):
            got = N.best_fit_lambda_z(t, c)
        self.assertGreater(len(calls), 1)
        self.assertEqual(got, _reference(t, c))


class 속도(unittest.TestCase):
    def test_20000점이_1초_안(self):
        """예전 1.87 초, 지금 0.05 초. 느린 CI 를 감안해 1초로 잡는다."""
        t = np.linspace(0, 48, 20000)
        c = 100 * (np.exp(-0.1 * t) - np.exp(-1.5 * t))
        t0 = time.perf_counter()
        N.best_fit_lambda_z(t, c)
        self.assertLess(time.perf_counter() - t0, 1.0)


if __name__ == "__main__":
    unittest.main()
