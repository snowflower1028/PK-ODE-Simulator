# 예제 데이터셋 — 웹 앱 기능 점검용

`generate_examples.py` 로 생성했습니다 (seed `20260902`, 비례 오차 CV `10%`).
앱이 쓰는 것과 같은 파서·솔버로 만들었으므로 **참 파라미터를 알고 있는**
데이터입니다. 시뮬레이션 곡선이 점들 위를 지나가야 하고, 피팅은 그 참값을
되찾아와야 합니다.

```bash
python manage.py runserver
```

---

## 기능별 점검 순서

### 1. 세션 불러오기 · 시뮬레이션 · PK 요약

`File → Open Session` 에서 `sessions/01-iv-bolus-1c.json` 을 엽니다.
ODE·초기값·파라미터·투여·시간 범위가 한 번에 채워집니다.

- 사이드바 ① Model 에 식 두 줄, ② Values 에 `CL 3.5` / `V 28`,
  ③ Dosing 에 `A1 에 볼루스 500 @ 0h` 가 들어와 있어야 합니다.
- `Run Simulation` → 곡선이 그려지고 **PK Profile Summary** 에
  `C1` 의 Cmax 가 아래 표의 값과 맞아야 합니다.

### 2. 플롯 컨트롤

`sessions/03-iv-2c.json` 을 엽니다. 2구획이라 로그 축에서 두 상(분포·소실)이
꺾인 직선 두 개로 보입니다.

- 플롯 카드 헤더의 **Compartments** 드롭다운으로 표시할 변수를 켜고 끕니다.
- 같은 헤더의 **Log Y** 를 켜면 y축이 로그로 바뀝니다.
  `Simulation → Log Y-axis` 메뉴에도 체크 표시가 같이 따라와야 합니다.

### 3. 관찰 데이터 올리기 · 열 매핑

`Data → Observed Datasets` 에서 `data/03-iv-2c.csv` 를 올립니다.

- 목록에 파일이 뜨고, 미리보기에 `Time` / `Plasma` 두 열이 보입니다.
- **Map Data to Model** 에서 `Plasma` 를 `C1` 로 매핑합니다.
- 다시 `Run Simulation` 하면 곡선 위에 점이 겹쳐 찍힙니다.

### 4. 투여 UI (주입 · 반복)

`sessions/04-infusion-multidose.json` 을 엽니다. 12시간마다 1시간 주입을
60시간까지 반복하는 설정입니다.

- ③ Dosing 의 **Registered Doses** 에 이렇게 한 줄이 들어옵니다:
  `Amount of "300" of infusion to A1 at 0h over 1h (repeats every 12h until 60h)`
- `Run Simulation` → 톱니 모양으로 축적되다가 정상상태에 이르고,
  60시간 이후 소실되는 곡선이 보입니다. `C1` 의 Cmax 는 61시간에 나옵니다
  (마지막 주입이 끝나는 시점).

세션은 **등록된 투여 목록**만 복원하고 위쪽 입력 폼은 건드리지 않습니다.
폼 자체를 점검하려면 직접 입력해 보세요 — Type 을 `IV Infusion` 으로 바꾸면
Duration 칸이 나타나고, **Set up repeat dosing** 을 켜면 반복 칸이 열립니다.
위 세션과 같은 값(300 / 0h / 1h / 12h / 60h)을 넣으면 같은 곡선이 나와야 합니다.

### 5. 파라미터 피팅

`sessions/02-oral-1c.json` + `data/02-oral-1c.csv` 조합이 가장 잘 맞습니다.

1. 세션을 열고, CSV 를 올린 뒤 `Plasma` → `C1` 로 매핑합니다.
2. **② Values 의 파라미터를 참값에서 흔들어 놓습니다.** 세션에는 참값이
   그대로 들어 있어서, 그냥 두면 이미 정답에서 시작하는 셈입니다.
   예: `ka 0.8`, `CL 6`, `V 20`
3. `Data → Fit Parameters` → 세 파라미터를 모두 체크(Global).
4. **Error Model** 은 `Proportional` — 데이터를 비례 오차로 만들었습니다.
5. **Add Experimental Group** 으로 그룹 하나를 만들고,
   Observed Data = 올린 CSV, Dose Compartment = `Ag`, Amount = `250`, Time = `0`.
6. `Start Fitting`.

제대로 돌면 이렇게 나옵니다 (실측):

```
CL (Global)             4.05958    CV  3.43%     참값 4.0   (+1.5%)
V  (Global)            32.7107     CV  5.07%     참값 32.0  (+2.2%)
ka (Global)             1.13426    CV 10.90%     참값 1.2   (-5.5%)
Sigma (Proportional)    0.106589   CV 19.83%
```

`Sigma (Proportional)` 가 **0.10 근처**로 나오는지 보세요. 데이터에 넣은
오차 수준을 되찾았다는 뜻입니다.

> **잘못된 국소최소를 알아보는 법**
>
> `Sigma` 가 `1.0` 근처로 크게 나오면 적합이 실패한 것입니다. 오차 모델이
> 안 맞는 예측을 억지로 감싸느라 오차를 100% 로 키운 상태입니다.
> 이 경우 파라미터 값은 믿을 수 없습니다.
>
> 흡수가 있는 경구 모델은 `ka` 와 소실속도가 서로 바뀌어도 비슷한 곡선을
> 만드는 flip-flop 문제가 있어 시작값에 민감합니다. 참값의 **2배 안쪽**에서
> 출발하세요. 3배 이상 벗어난 값에서 `Proportional`/`Combined` 로 시작하면
> 최적화가 한 발도 못 움직이고 시작값을 그대로 돌려주기도 합니다
> (이때도 `CV 0.00%` 로 표시되니 같이 확인하세요).

### 6. 내보내기 · 세션 저장

- `File → Export → Simulated Profile / PK Summary Table / Plot Image`
- `File → Save Session` 으로 저장한 뒤 `New Session` → `Open Session` 으로
  되돌려, 파라미터·투여·시간 범위가 그대로 복원되는지 확인합니다.

---

## 데이터셋 목록

### 01-iv-bolus-1c — 1-compartment IV bolus

```
dA1dt = -(CL/V)*A1
C1 = A1/V
```

- **참 파라미터**: `CL = 3.5`  `V = 28`
- **투여**: 500 를 A1 에 볼루스 (t=0h)
- **관찰 변수**: `C1` → CSV 열 `Plasma`
- **샘플**: 11 점, 0 – 24 h
- **Cmax (참값, 무오차)**: 17.86 at t = 0 h

가장 단순한 검증용. CL 과 V 가 그대로 되찾아져야 한다.

### 02-oral-1c — 1-compartment oral absorption

```
dAgdt = -ka*Ag
dA1dt = ka*Ag - (CL/V)*A1
C1 = A1/V
```

- **참 파라미터**: `ka = 1.2`  `CL = 4`  `V = 32`
- **투여**: 250 를 Ag 에 볼루스 (t=0h)
- **관찰 변수**: `C1` → CSV 열 `Plasma`
- **샘플**: 13 점, 0 – 36 h
- **Cmax (참값, 무오차)**: 6.006 at t = 2.1 h

흡수상을 잡으려면 초기 구간 샘플이 촘촘해야 한다. Ag 는 관찰 불가로 두었다.

### 03-iv-2c — 2-compartment IV bolus

```
dA1dt = -(CL/V1)*A1 - (Q/V1)*A1 + (Q/V2)*A2
dA2dt = (Q/V1)*A1 - (Q/V2)*A2
C1 = A1/V1
C2 = A2/V2
```

- **참 파라미터**: `CL = 3`  `V1 = 15`  `Q = 8`  `V2 = 45`
- **투여**: 400 를 A1 에 볼루스 (t=0h)
- **관찰 변수**: `C1` → CSV 열 `Plasma`
- **샘플**: 13 점, 0 – 48 h
- **Cmax (참값, 무오차)**: 26.67 at t = 0 h

분포상과 소실상을 모두 담으려면 아주 이른 시점(5분)이 필요하다. 말초 구획 C2 는 관찰 불가.

### 04-infusion-multidose — 1-compartment IV infusion, repeated

```
dA1dt = -(CL/V)*A1
C1 = A1/V
```

- **참 파라미터**: `CL = 5`  `V = 40`
- **투여**: 300 를 A1 에 1h 주입, 12h 마다 60h 까지 반복
- **관찰 변수**: `C1` → CSV 열 `Plasma`
- **샘플**: 17 점, 0 – 96 h
- **Cmax (참값, 무오차)**: 9.079 at t = 61 h

12시간마다 1시간 주입, 60시간까지 반복. 축적과 정상상태를 확인한다. 피팅 UI 는 그룹당 단회 볼루스만 받으므로 이 예제는 시뮬레이션 확인용이다.

### 05-michaelis-menten — Michaelis-Menten elimination

```
dA1dt = -Vmax*C/(Km + C)
C = A1/V
```

- **참 파라미터**: `Vmax = 12`  `Km = 4`  `V = 20`
- **투여**: 600 를 A1 에 볼루스 (t=0h)
- **관찰 변수**: `C` → CSV 열 `Plasma`
- **샘플**: 14 점, 0 – 48 h
- **Cmax (참값, 무오차)**: 30 at t = 0 h

비선형 소실. 초기에는 0차에 가깝다가 후기에 1차로 넘어간다 — 반감기가 일정하지 않은 것이 정상이다.

---

## 다시 만들기

```bash
python examples/generate_examples.py --seed 7 --noise 0.15
```

같은 시드면 같은 CSV 가 나옵니다. `--noise 0` 이면 오차가 없는 데이터가 되어,
피팅이 참값을 소수점까지 되찾아야 정상입니다 — 솔버나 피팅을 의심할 때
먼저 이걸로 확인하세요.
