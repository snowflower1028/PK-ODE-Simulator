#!/usr/bin/env python
"""
generate_examples.py  --  PK ODE Simulator 예제 데이터셋 생성기
================================================================

앱이 실제로 쓰는 코드 경로(simulator.parser -> sympy.lambdify ->
simulator.solver)를 그대로 호출해 "참값"을 시뮬레이션한 뒤, 여기에 잔차
오차를 얹어 관찰 데이터 CSV 를 만든다. 참 파라미터를 알고 있으므로
피팅이 그 값을 되찾아오는지로 앱을 검증할 수 있다.

만들어지는 것
-------------
  examples/data/<name>.csv          File -> ... 아니라 Data -> Observed Datasets 로 올린다
  examples/sessions/<name>.json     File -> Open Session 으로 바로 불러온다
  examples/README.md                각 예제의 참값과 사용법

사용법
------
  .venv/Scripts/python.exe examples/generate_examples.py
  .venv/Scripts/python.exe examples/generate_examples.py --seed 7 --noise 0.15

옵션
----
  --seed   난수 시드 (기본 20260902). 같은 시드면 같은 CSV 가 나온다.
  --noise  비례 오차의 표준편차. 0.10 이면 CV 10%.
  --outdir 출력 디렉터리 (기본: 이 스크립트 옆)
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Dict, List

import numpy as np
import pandas as pd
from sympy import lambdify, symbols

# Windows 콘솔 기본 코드페이지(cp949)에서 일부 문자가 깨지거나 예외가 나므로
# 출력 인코딩을 UTF-8 로 고정한다.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, ValueError):
    pass

# 프로젝트 루트를 import 경로에 넣어 앱 모듈을 그대로 쓴다.
PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from simulator.parser import parse_ode_input          # noqa: E402
from simulator.solver import solve_ode_system         # noqa: E402


# ---------------------------------------------------------------------------
# 예제 정의
# ---------------------------------------------------------------------------
# 각 예제는 앱의 Model -> Load Example 항목과 같은 ODE 를 쓴다.
# observe: CSV 로 내보낼 변수 -> 컬럼 이름. 관찰 가능한 것만 내보낸다
#          (혈장 농도는 재지만 흡수 구획의 양은 재지 못하는 게 보통이다).
EXAMPLES = [
    {
        "name": "01-iv-bolus-1c",
        "title": "1-compartment IV bolus",
        "ode": "dA1dt = -(CL/V)*A1\nC1 = A1/V",
        "true_params": {"CL": 3.5, "V": 28.0},
        "initials": {"A1": 0.0},
        "doses": [
            {"compartment": "A1", "type": "bolus", "amount": 500.0,
             "start_time": 0.0, "duration": 0, "repeat_every": None, "repeat_until": None}
        ],
        "t_end": 24.0,
        "steps": 241,
        "sample_times": [0.25, 0.5, 1, 2, 3, 4, 6, 8, 12, 16, 24],
        "observe": {"C1": "Plasma"},
        "plot": ["A1", "C1"],
        "note": "가장 단순한 검증용. CL 과 V 가 그대로 되찾아져야 한다.",
    },
    {
        "name": "02-oral-1c",
        "title": "1-compartment oral absorption",
        "ode": "dAgdt = -ka*Ag\ndA1dt = ka*Ag - (CL/V)*A1\nC1 = A1/V",
        "true_params": {"ka": 1.2, "CL": 4.0, "V": 32.0},
        "initials": {"Ag": 0.0, "A1": 0.0},
        "doses": [
            {"compartment": "Ag", "type": "bolus", "amount": 250.0,
             "start_time": 0.0, "duration": 0, "repeat_every": None, "repeat_until": None}
        ],
        "t_end": 36.0,
        "steps": 361,
        "sample_times": [0.25, 0.5, 1, 1.5, 2, 3, 4, 6, 8, 12, 18, 24, 36],
        "observe": {"C1": "Plasma"},
        "plot": ["Ag", "A1", "C1"],
        "note": "흡수상을 잡으려면 초기 구간 샘플이 촘촘해야 한다. Ag 는 관찰 불가로 두었다.",
    },
    {
        "name": "03-iv-2c",
        "title": "2-compartment IV bolus",
        "ode": ("dA1dt = -(CL/V1)*A1 - (Q/V1)*A1 + (Q/V2)*A2\n"
                "dA2dt = (Q/V1)*A1 - (Q/V2)*A2\n"
                "C1 = A1/V1\n"
                "C2 = A2/V2"),
        "true_params": {"CL": 3.0, "V1": 15.0, "Q": 8.0, "V2": 45.0},
        "initials": {"A1": 0.0, "A2": 0.0},
        "doses": [
            {"compartment": "A1", "type": "bolus", "amount": 400.0,
             "start_time": 0.0, "duration": 0, "repeat_every": None, "repeat_until": None}
        ],
        "t_end": 48.0,
        "steps": 481,
        "sample_times": [0.083, 0.25, 0.5, 1, 2, 4, 6, 8, 12, 18, 24, 36, 48],
        "observe": {"C1": "Plasma"},
        "plot": ["C1", "C2"],
        "note": "분포상과 소실상을 모두 담으려면 아주 이른 시점(5분)이 필요하다. "
                "말초 구획 C2 는 관찰 불가.",
    },
    {
        "name": "04-infusion-multidose",
        "title": "1-compartment IV infusion, repeated",
        "ode": "dA1dt = -(CL/V)*A1\nC1 = A1/V",
        "true_params": {"CL": 5.0, "V": 40.0},
        "initials": {"A1": 0.0},
        "doses": [
            {"compartment": "A1", "type": "infusion", "amount": 300.0,
             "start_time": 0.0, "duration": 1.0,
             "repeat_every": 12.0, "repeat_until": 60.0}
        ],
        "t_end": 96.0,
        "steps": 961,
        "sample_times": [0.5, 1, 2, 4, 8, 12, 12.5, 13, 24, 36, 48, 60, 61, 62, 72, 84, 96],
        "observe": {"C1": "Plasma"},
        "plot": ["C1"],
        "note": "12시간마다 1시간 주입, 60시간까지 반복. 축적과 정상상태를 확인한다. "
                "피팅 UI 는 그룹당 단회 볼루스만 받으므로 이 예제는 시뮬레이션 확인용이다.",
    },
    {
        "name": "05-michaelis-menten",
        "title": "Michaelis-Menten elimination",
        "ode": "dA1dt = -Vmax*C/(Km + C)\nC = A1/V",
        "true_params": {"Vmax": 12.0, "Km": 4.0, "V": 20.0},
        "initials": {"A1": 0.0},
        "doses": [
            {"compartment": "A1", "type": "bolus", "amount": 600.0,
             "start_time": 0.0, "duration": 0, "repeat_every": None, "repeat_until": None}
        ],
        "t_end": 48.0,
        "steps": 481,
        "sample_times": [0.5, 1, 2, 4, 6, 8, 12, 16, 20, 24, 30, 36, 42, 48],
        "observe": {"C": "Plasma"},
        "plot": ["C"],
        "note": "비선형 소실. 초기에는 0차에 가깝다가 후기에 1차로 넘어간다 "
                "— 반감기가 일정하지 않은 것이 정상이다.",
    },
]


# ---------------------------------------------------------------------------
# 시뮬레이션 (앱과 같은 경로)
# ---------------------------------------------------------------------------
def simulate(ode_text: str,
             initials: Dict[str, float],
             params: Dict[str, float],
             doses: List[Dict],
             t_end: float,
             steps: int,
             extra_times: List[float] | None = None) -> pd.DataFrame:
    """simulator.views.simulate 와 같은 순서로 풀어 DataFrame 을 돌려준다.

    extra_times 를 주면 그 시점들을 t_eval 에 합쳐 솔버가 직접 평가하게 한다.
    격자에 스냅하거나 보간하지 않으므로 채혈 시점의 값이 정확하다.
    """
    parsed = parse_ode_input(ode_text)
    compartments = parsed["compartments"]
    parameters = parsed["parameters"]
    equations = parsed["equations"]

    comp_syms = symbols(compartments)
    param_syms = symbols(parameters)
    t_sym = symbols("t")

    y_args = tuple(comp_syms) if isinstance(comp_syms, (list, tuple)) else (comp_syms,)
    p_args = tuple(param_syms) if isinstance(param_syms, (list, tuple)) else (param_syms,)

    rhs = lambdify((t_sym, y_args, p_args), [equations[c] for c in compartments], modules="numpy")

    t_eval = np.linspace(0.0, t_end, steps)
    if extra_times:
        t_eval = np.unique(np.concatenate([t_eval, np.asarray(extra_times, dtype=float)]))
    df = solve_ode_system(
        equations_callable=lambda t, y, p: rhs(t, y, p),
        compartments=compartments,
        parameters=parameters,
        init_values=initials,
        param_values=params,
        t_span=[0.0, t_end],
        t_eval=t_eval,
        doses=doses,
    )

    # 파생 변수도 앱과 같은 방식으로 붙인다.
    available = {**df.to_dict(orient="series"), **params}
    for name, expr in parsed["derived_expressions"].items():
        df[name] = pd.eval(expr, local_dict=available, engine="python")
        available[name] = df[name]

    return df


def sample_with_noise(df: pd.DataFrame,
                      sample_times: List[float],
                      observe: Dict[str, str],
                      cv: float,
                      rng: np.random.Generator) -> pd.DataFrame:
    """조밀한 프로파일에서 채혈 시점을 뽑고 비례 오차를 얹는다.

    비례(정률) 오차를 쓰는 이유: PK 농도의 측정 오차는 대개 농도에
    비례하고, 음수 농도가 나오지 않는다. 앱의 Weighting Scheme 에서
    1/Y 또는 1/Y^2 을 고르면 이 구조와 맞는다.
    """
    out = {"Time": []}
    for col_name in observe.values():
        out[col_name] = []

    times = np.asarray(df["Time"], dtype=float)
    for t in sample_times:
        idx = int(np.argmin(np.abs(times - t)))
        # 채혈 시점은 t_eval 에 넣어 두었으므로 정확히 일치해야 한다.
        # 어긋나면 조용히 다른 시점의 값을 쓰게 되므로 여기서 끊는다.
        if abs(times[idx] - t) > 1e-9:
            raise RuntimeError(
                f"sample time {t} not found in solver output (nearest {times[idx]})"
            )
        out["Time"].append(round(float(t), 4))
        for var, col_name in observe.items():
            true_val = float(df[var].iloc[idx])
            noisy = true_val * (1.0 + rng.normal(0.0, cv))
            out[col_name].append(round(max(noisy, 0.0), 5))

    return pd.DataFrame(out)


def build_session(ex: Dict) -> Dict:
    """File -> Open Session 이 그대로 읽는 형식으로 세션을 만든다."""
    return {
        "ode": ex["ode"],
        "initials": ex["initials"],
        "parameters": ex["true_params"],
        "doses": ex["doses"],
        "simulationSettings": {
            "start": 0,
            "end": ex["t_end"],
            "steps": ex["steps"],
            "logScale": False,
            "selectedCompartments": ex["plot"],
        },
    }


# ---------------------------------------------------------------------------
# README
# ---------------------------------------------------------------------------
def write_readme(path: Path, results: List[Dict], seed: int, cv: float) -> None:
    """웹 앱 기능을 하나씩 눌러보는 순서로 README 를 쓴다."""
    lines = [
        "# 예제 데이터셋 — 웹 앱 기능 점검용",
        "",
        f"`generate_examples.py` 로 생성했습니다 (seed `{seed}`, 비례 오차 CV `{cv:.0%}`).",
        "앱이 쓰는 것과 같은 파서·솔버로 만들었으므로 **참 파라미터를 알고 있는**",
        "데이터입니다. 시뮬레이션 곡선이 점들 위를 지나가야 하고, 피팅은 그 참값을",
        "되찾아와야 합니다.",
        "",
        "```bash",
        "python manage.py runserver",
        "```",
        "",
        "---",
        "",
        "## 기능별 점검 순서",
        "",
        "### 1. 세션 불러오기 · 시뮬레이션 · PK 요약",
        "",
        "`File → Open Session` 에서 `sessions/01-iv-bolus-1c.json` 을 엽니다.",
        "ODE·초기값·파라미터·투여·시간 범위가 한 번에 채워집니다.",
        "",
        "- 사이드바 ① Model 에 식 두 줄, ② Values 에 `CL 3.5` / `V 28`,",
        "  ③ Dosing 에 `A1 에 볼루스 500 @ 0h` 가 들어와 있어야 합니다.",
        "- `Run Simulation` → 곡선이 그려지고 **PK Profile Summary** 에",
        f"  `C1` 의 Cmax 가 아래 표의 값과 맞아야 합니다.",
        "",
        "### 2. 플롯 컨트롤",
        "",
        "`sessions/03-iv-2c.json` 을 엽니다. 2구획이라 로그 축에서 두 상(분포·소실)이",
        "꺾인 직선 두 개로 보입니다.",
        "",
        "- 플롯 카드 헤더의 **Compartments** 드롭다운으로 표시할 변수를 켜고 끕니다.",
        "- 같은 헤더의 **Log Y** 를 켜면 y축이 로그로 바뀝니다.",
        "  `Simulation → Log Y-axis` 메뉴에도 체크 표시가 같이 따라와야 합니다.",
        "",
        "### 3. 관찰 데이터 올리기 · 열 매핑",
        "",
        "`Data → Observed Datasets` 에서 `data/03-iv-2c.csv` 를 올립니다.",
        "",
        "- 목록에 파일이 뜨고, 미리보기에 `Time` / `Plasma` 두 열이 보입니다.",
        "- **Map Data to Model** 에서 `Plasma` 를 `C1` 로 매핑합니다.",
        "- 다시 `Run Simulation` 하면 곡선 위에 점이 겹쳐 찍힙니다.",
        "",
        "### 4. 투여 UI (주입 · 반복)",
        "",
        "`sessions/04-infusion-multidose.json` 을 엽니다. 12시간마다 1시간 주입을",
        "60시간까지 반복하는 설정입니다.",
        "",
        "- ③ Dosing 의 **Registered Doses** 에 이렇게 한 줄이 들어옵니다:",
        '  `Amount of "300" of infusion to A1 at 0h over 1h (repeats every 12h until 60h)`',
        "- `Run Simulation` → 톱니 모양으로 축적되다가 정상상태에 이르고,",
        "  60시간 이후 소실되는 곡선이 보입니다. `C1` 의 Cmax 는 61시간에 나옵니다",
        "  (마지막 주입이 끝나는 시점).",
        "",
        "세션은 **등록된 투여 목록**만 복원하고 위쪽 입력 폼은 건드리지 않습니다.",
        "폼 자체를 점검하려면 직접 입력해 보세요 — Type 을 `IV Infusion` 으로 바꾸면",
        "Duration 칸이 나타나고, **Set up repeat dosing** 을 켜면 반복 칸이 열립니다.",
        "위 세션과 같은 값(300 / 0h / 1h / 12h / 60h)을 넣으면 같은 곡선이 나와야 합니다.",
        "",
        "### 5. 파라미터 피팅",
        "",
        "`sessions/02-oral-1c.json` + `data/02-oral-1c.csv` 조합이 가장 잘 맞습니다.",
        "",
        "1. 세션을 열고, CSV 를 올린 뒤 `Plasma` → `C1` 로 매핑합니다.",
        "2. **② Values 의 파라미터를 참값에서 흔들어 놓습니다.** 세션에는 참값이",
        "   그대로 들어 있어서, 그냥 두면 이미 정답에서 시작하는 셈입니다.",
        "   예: `ka 0.8`, `CL 6`, `V 20`",
        "3. `Data → Fit Parameters` → 세 파라미터를 모두 체크(Global).",
        "4. **Error Model** 은 `Proportional` — 데이터를 비례 오차로 만들었습니다.",
        "5. **Add Experimental Group** 으로 그룹 하나를 만들고,",
        "   Observed Data = 올린 CSV, Dose Compartment = `Ag`, Amount = `250`, Time = `0`.",
        "6. `Start Fitting`.",
        "",
        "제대로 돌면 이렇게 나옵니다 (실측):",
        "",
        "```",
        "CL (Global)             4.05958    CV  3.43%     참값 4.0   (+1.5%)",
        "V  (Global)            32.7107     CV  5.07%     참값 32.0  (+2.2%)",
        "ka (Global)             1.13426    CV 10.90%     참값 1.2   (-5.5%)",
        "Sigma (Proportional)    0.106589   CV 19.83%",
        "```",
        "",
        f"`Sigma (Proportional)` 가 **{cv:.2f} 근처**로 나오는지 보세요. 데이터에 넣은",
        "오차 수준을 되찾았다는 뜻입니다.",
        "",
        "> **잘못된 국소최소를 알아보는 법**",
        ">",
        "> `Sigma` 가 `1.0` 근처로 크게 나오면 적합이 실패한 것입니다. 오차 모델이",
        "> 안 맞는 예측을 억지로 감싸느라 오차를 100% 로 키운 상태입니다.",
        "> 이 경우 파라미터 값은 믿을 수 없습니다.",
        ">",
        "> 흡수가 있는 경구 모델은 `ka` 와 소실속도가 서로 바뀌어도 비슷한 곡선을",
        "> 만드는 flip-flop 문제가 있어 시작값에 민감합니다. 참값의 **2배 안쪽**에서",
        "> 출발하세요. 3배 이상 벗어난 값에서 `Proportional`/`Combined` 로 시작하면",
        "> 최적화가 한 발도 못 움직이고 시작값을 그대로 돌려주기도 합니다",
        "> (이때도 `CV 0.00%` 로 표시되니 같이 확인하세요).",
        "",
        "### 6. 내보내기 · 세션 저장",
        "",
        "- `File → Export → Simulated Profile / PK Summary Table / Plot Image`",
        "- `File → Save Session` 으로 저장한 뒤 `New Session` → `Open Session` 으로",
        "  되돌려, 파라미터·투여·시간 범위가 그대로 복원되는지 확인합니다.",
        "",
        "---",
        "",
        "## 데이터셋 목록",
        "",
    ]

    for r in results:
        ex = r["example"]
        params = "  ".join(f"`{k} = {v:g}`" for k, v in ex["true_params"].items())
        obs_var = ", ".join(ex["observe"].keys())
        obs_col = ", ".join(ex["observe"].values())
        dose = ex["doses"][0]
        if dose["type"] == "infusion":
            dose_desc = (f"{dose['amount']:g} 를 {dose['compartment']} 에 "
                         f"{dose['duration']:g}h 주입")
            if dose.get("repeat_every"):
                dose_desc += f", {dose['repeat_every']:g}h 마다 {dose['repeat_until']:g}h 까지 반복"
        else:
            dose_desc = f"{dose['amount']:g} 를 {dose['compartment']} 에 볼루스 (t={dose['start_time']:g}h)"

        lines += [
            f"### {ex['name']} — {ex['title']}",
            "",
            "```",
            ex["ode"],
            "```",
            "",
            f"- **참 파라미터**: {params}",
            f"- **투여**: {dose_desc}",
            f"- **관찰 변수**: `{obs_var}` → CSV 열 `{obs_col}`",
            f"- **샘플**: {len(ex['sample_times'])} 점, 0 – {ex['t_end']:g} h",
            f"- **Cmax (참값, 무오차)**: {r['cmax']:.4g} at t = {r['tmax']:g} h",
            "",
            f"{ex['note']}",
            "",
        ]

    lines += [
        "---",
        "",
        "## 다시 만들기",
        "",
        "```bash",
        "python examples/generate_examples.py --seed 7 --noise 0.15",
        "```",
        "",
        "같은 시드면 같은 CSV 가 나옵니다. `--noise 0` 이면 오차가 없는 데이터가 되어,",
        "피팅이 참값을 소수점까지 되찾아야 정상입니다 — 솔버나 피팅을 의심할 때",
        "먼저 이걸로 확인하세요.",
        "",
    ]

    path.write_text("\n".join(lines), encoding="utf-8")


# ---------------------------------------------------------------------------
def main() -> int:
    ap = argparse.ArgumentParser(description="PK ODE Simulator 예제 데이터셋 생성")
    ap.add_argument("--seed", type=int, default=20260902)
    ap.add_argument("--noise", type=float, default=0.10,
                    help="비례 오차의 표준편차 (0.10 = CV 10%%)")
    ap.add_argument("--outdir", type=Path, default=Path(__file__).resolve().parent)
    args = ap.parse_args()

    data_dir = args.outdir / "data"
    sess_dir = args.outdir / "sessions"
    data_dir.mkdir(parents=True, exist_ok=True)
    sess_dir.mkdir(parents=True, exist_ok=True)

    rng = np.random.default_rng(args.seed)
    results = []

    for ex in EXAMPLES:
        df = simulate(ex["ode"], ex["initials"], ex["true_params"],
                      ex["doses"], ex["t_end"], ex["steps"],
                      extra_times=ex["sample_times"])

        obs = sample_with_noise(df, ex["sample_times"], ex["observe"], args.noise, rng)
        csv_path = data_dir / f"{ex['name']}.csv"
        obs.to_csv(csv_path, index=False)

        sess_path = sess_dir / f"{ex['name']}.json"
        sess_path.write_text(json.dumps(build_session(ex), indent=2), encoding="utf-8")

        main_var = next(iter(ex["observe"]))
        series = df[main_var]
        i_max = int(np.argmax(series))
        results.append({
            "example": ex,
            "cmax": float(series.iloc[i_max]),
            "tmax": float(df["Time"].iloc[i_max]),
        })

        print(f"  {ex['name']:26s}  {len(obs):3d} points  "
              f"Cmax {series.iloc[i_max]:9.4g} @ {df['Time'].iloc[i_max]:6.2f} h")

    write_readme(args.outdir / "README.md", results, args.seed, args.noise)

    print(f"\n{len(EXAMPLES)} examples written to {args.outdir}")
    print(f"  data/     {len(EXAMPLES)} CSV")
    print(f"  sessions/ {len(EXAMPLES)} JSON")
    print("  README.md")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
