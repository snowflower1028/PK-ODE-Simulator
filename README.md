# PK-ODE-Simulator

**[Open the app →](https://pk-ode-simulator.onrender.com/)**

Two pharmacokinetic tools that share one workspace: a simulator that solves
whatever ODE system you type, and a noncompartmental analysis calculator that
works from observed concentrations. Switch between them with the menu at the top
left. Django on the server, plain JavaScript and Plotly in the browser.

Built for researchers, students and pharmacometricians who want to see what a
model does — and, just as often, to see where a number stops being a measurement
and starts being an extrapolation.

---

## The two tools

### ODE Simulator

Type a system of differential equations; the app finds the compartments and
parameters for you and builds the inputs.

- **Dosing** — bolus, zero-order infusion, and repeat schedules, into any compartment
- **Simulation** — time range, resolution, log axis, derived variables (`C1 = A1/V`)
- **PK summary** — Cmax, Tmax, t½, AUC(0–last), AUC(0–∞), %Extrap, CL, Vz per
  compartment. Under repeat dosing the table switches to steady-state columns
  (Cmax,ss, Ctrough, Cavg, AUCτ, %Fluctuation, Racc, CLss). Rows are marked
  `model` or `NCA`: the model rows integrate the solved curve directly, while an
  uploaded dataset gets the same noncompartmental treatment the calculator gives
  it, so you can read the two next to each other and see what the assumptions
  cost
- **Parameter fitting** — least squares or maximum likelihood with additive,
  proportional and combined error models; weighting schemes; per-group or shared
  parameters; bounds; standard errors from the Hessian
- **Sensitivity analysis** — sweep one value and watch the curve move, or nudge
  every parameter and rank them in a tornado plot
- **Observed vs Predicted** — AFE, AAFE, within-2-fold, worst point, RMSE

### NCA Calculator

Register time–concentration series and analyse them one at a time.

- **Built-in spreadsheet** — type values in, paste two columns straight from Excel,
  or import CSV/XLSX. A file with a subject column becomes one series per subject
- **Per series** — its own name, concentration and time units, molecular weight,
  dose, route and body weight. A study can mix them without one series quietly
  taking on another's units
- **Terminal phase by hand** — best-fit λz to start, then click points off the
  plot or pick the range from the sample times. `n`, `R²adj` and **Span** update
  as you go, so you can see what the choice costs
- **Below the limit** — the three regions (before the first measurable sample,
  between measurable ones, after the last) are set separately, because the same
  "not detected" means different things in each
- **Units** — clearance and volume are shown the way people write them
  (`mL/min/kg`, `L/h`), not as the raw composition of what you entered. A dose in
  mg/kg carries through to CL in mL/min/kg without needing a body weight

Both tools keep your work across a refresh and can save a session to a file.

---

## Screenshots

### ODE Simulator

![A two-compartment IV model: the parsed system and its parameters in the sidebar, an observed dataset overlaid on the profile, and a PK summary that puts the model-derived and NCA-derived parameters on adjacent rows](https://github.com/user-attachments/assets/5d7c74a7-3f20-4949-accb-bfbf49b6e271)

### NCA Calculator

![Two registered series, the selected one shown on a semi-log plot with the terminal points picked out and the fitted slope drawn through them, and the parameter table below with its units](https://github.com/user-attachments/assets/d3f957bd-bbda-40cf-8804-3bae41a21d1f)

---

## Running locally

Python and Django. A virtual environment and one environment file.

### 1. Clone

```bash
git clone https://github.com/snowflower1028/PK-ODE-Simulator.git
cd PK-ODE-Simulator
```

### 2. Create a virtual environment

```bash
python -m venv .venv

# Windows
.venv\Scripts\activate
# macOS / Linux
source .venv/bin/activate
```

### 3. Install dependencies

```bash
pip install -r requirements.txt
```

### 4. Write a `.env`

Secrets come from environment variables. Create `.env` in the project root:

```
DJANGO_DEBUG=True
DJANGO_SECRET_KEY='your-own-secret-key'
```

Generate a key with the virtual environment active:

```bash
python -c "from django.core.management.utils import get_random_secret_key; print(get_random_secret_key())"
```

### 5. Migrate and run

```bash
python manage.py migrate
python manage.py runserver
```

The simulator is at <http://127.0.0.1:8000/> and the NCA calculator at
<http://127.0.0.1:8000/nca/>.

---

## Data formats

### Simulator — observed data

Wide format, one column per measured series. Upload from **Data → Observed
Datasets**; several files at once become several datasets, and you map each
column to a model variable after upload.

```
Time,Plasma,Metabolite
0,0,0
0.5,72.4,1.1
1,88.1,3.6
2,77.3,7.9
4,51.2,11.4
```

A row whose field count does not match the header is skipped, as is a row with a
non-numeric time. Any other non-numeric or empty cell is a **missing point, not a
zero**.

### NCA — observed data

Long format, one row per sample. The subject column is optional; without it the
whole file is one series.

```
Subject,Time,Conc
S-01,0,BLQ
S-01,0.5,124.3
S-01,1,180.7
S-02,0,BLQ
S-02,0.5,98.1
```

Text that is not a number (`BLQ`, `<LLOQ`) is kept as written and treated as
below the limit of quantification — it is not silently read as zero.

---

## How the numbers are checked

PK software is easy to write and hard to trust, so the arithmetic is pinned by
149 tests that compare against answers known in closed form — or against Phoenix
WinNonlin — rather than against values someone once eyeballed.

```bash
python manage.py test simulator
```

- **Closed-form agreement.** One-compartment IV bolus and first-order absorption
  have analytic solutions, so AUC(0–∞), t½, CL, Vz, MRT, Vss and the accumulation
  ratio are all checked against them. For an IV bolus AUCτ at steady state equals
  Dose/CL exactly, and Racc equals 1/(1 − e^(−kτ)) exactly.
- **Unit algebra.** Every conversion round-trips, and the composed ones are
  checked by hand: 100 mg with an AUC of 25 ng/mL·h gives 4000 L/h; the same dose
  as 100 mg/kg gives 4000 L/h/kg, which is 66 667 mL/min/kg.
- **Agreement with WinNonlin.** Two real runs are pinned as tests: a 1 mg IV
  bolus and an 80 mg oral dose, checked on AUC(0–∞), AUMC(0–∞), Cmax, MRT, CL,
  Vss/Vz and λz. Reproducing them turned up three places where this app differed
  — a bolus recorded as zero at time 0 needs its C0 back-extrapolated, an
  extravascular profile that starts late needs a zero placed at time 0, and
  neither of those constructed values may become Cmax. All three are fixed, and
  the two profiles now agree to the last digit WinNonlin reports.
- **Regression tests for bugs that were actually found.** Two examples, both of
  which had been sitting in working code:

  | on a 1-compartment bolus | reported | correct |
  |---|---|---|
  | AUC(0–∞), with a below-limit sample after Tlast | 26.867 (+7.5 %) | 25.000 |
  | CL, same profile | 3.722 | 4.000 |

  The first came from counting the tail twice — once as a trapezoid down to zero,
  again as `Clast/λz`. A separate test fixes what the below-limit rules are worth:
  calling a single mid-profile sample zero instead of leaving it out moved
  AUC(0–last) by **−23.3 %** and CL from 4.00 to 5.14.

The point of the second group is that these are not hypothetical. They are the
reason the calculator reports Span next to R², keeps `AUClast` and `AUCall`
apart, and makes you choose the below-limit rules rather than burying them in a
default.

---

## Project layout

```
simulator/
├── parser.py            ODE text → compartments, parameters, equations
├── solver.py            numerical integration (LSODA), dose events
├── analyzer.py          PK summary tables, observed-vs-predicted
├── fitting.py           least squares / MLE, error models, weighting
├── nca.py               noncompartmental analysis — no Django, numpy only
├── units.py             unit algebra — no Django, no numpy
├── metrics.py           AFE, AAFE, within-2-fold, RMSE
├── views.py             HTTP endpoints for both tools
├── urls.py
├── templates/simulator/
│   ├── index.html           ODE Simulator
│   ├── nca.html             NCA Calculator
│   └── _app_switcher.html   the menu shared by both
├── static/simulator/
│   ├── css/style.css
│   └── js/
│       ├── script.js        simulator
│       ├── sensitivity.js   parameter sweeps
│       ├── menubar.js       menu behaviour
│       ├── nca.js           NCA calculator
│       ├── tooltip.js       shared — the ⓘ explanations
│       └── resize.js        shared — sidebar and plot sizing
└── tests/
    ├── test_nca.py          68
    ├── test_units.py        45
    ├── test_fitting.py      19
    └── test_metrics.py      17
```

`nca.py` and `units.py` deliberately import nothing from Django or from the rest
of the project, so they can be used as plain libraries.

---

## Deployment

Deployed on [Render](https://render.com) from `render.yaml`; pushing to `main`
builds and releases. Set `DJANGO_SECRET_KEY` in the dashboard and leave
`DJANGO_DEBUG` unset.

Measured on the deployed instance (Singapore, network round trip subtracted):

| what | server time |
|---|---|
| simulate, 1-compartment, 200 points | 36 ms |
| 7-point sweep | 205 ms |
| 40-point sweep (the cap) | 1.45 s |
| peak throughput | 12.7 req/s at concurrency 4 |
| 385 requests | 0 errors |

Two gunicorn workers on the 512 MB plan. Each worker is about 171 MB — most of it
numpy, scipy, sympy and pandas — so three would not fit. Two means a long sweep
does not block everyone else.

---

## Built with

Django 5.2 · NumPy · SciPy · SymPy · pandas · Bootstrap 5.3 · Plotly.js (basic
build, MIT) · SheetJS, loaded only when someone opens an `.xlsx`

---

## Roadmap

- Units in the ODE Simulator (the NCA calculator has them)
- Warn when a fit returns a physically impossible value, such as a negative rate
  constant
- Sparse-sampling NCA (one profile from several animals)
- A summary across series in the calculator — the table shows one at a time, and
  comparing them means exporting

---

## Author

**Minsoo Lee**
College of Pharmacy, Seoul National University
[minsoo.lee@snu.ac.kr](mailto:minsoo.lee@snu.ac.kr)

## License

MIT.
