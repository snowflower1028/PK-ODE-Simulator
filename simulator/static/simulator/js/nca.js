/* ============================================================ */
/* nca.js — 비구획 분석 계산기                                     */
/* ============================================================ */
/**
 * 시뮬레이터와 다른 페이지지만 같은 껍데기를 쓴다. 좌측 입력, 우측 결과,
 * 같은 카드와 접기. 도구가 바뀌었다고 조작법까지 바뀌면 안 되기 때문이다.
 *
 * 계산은 서버가 한다 (nca.py). 브라우저가 맡는 것은 넷뿐이다:
 *   - 자료를 계열로 나눠 들고 있는 일
 *   - 표에서 점을 고치고 빼고 넣게 하는 일
 *   - 말기 구간을 사람이 고르게 하는 일
 *   - 단위를 바꿔 보여 주는 일 — 이건 곱셈 하나라 왕복할 필요가 없다
 *
 * 계열이 여럿이어도 계산은 한 번에 다 해 둔다. 하나씩 골라 볼 때마다 서버에
 * 다녀오면 느리고, 내보내기는 어차피 전부 필요하다.
 *
 * 단위와 용량은 계열마다 따로 들고 있는다. 한 연구 안에서도 계열마다
 * 투여량이 다르고, 분석법이 다르면 농도 단위까지 다르다.
 */

/* ------------------------------------------------------------ */
/* 표에 실을 항목                                                  */
/* ------------------------------------------------------------ */
/* 설명은 세 부분이다 — 정의, 수식, 주의. 셋째가 가장 값어치 있다:
 * 정의와 수식은 교과서에도 있지만 "이 값이 언제 거짓말을 하는가"는
 * 여기서만 말할 수 있다. */
const NCA_ROWS = [
  { group: 'Observed' },
  {
    key: 'c_max', label: 'C<sub>max</sub>',
    definition: 'The highest measured concentration.',
    formula: 'max(C)',
    caveat: 'Read straight off the samples, never interpolated. A schedule that misses the true peak reports a lower Cmax, and nothing in this number says that it did.',
  },
  {
    key: 't_max', label: 'T<sub>max</sub>',
    definition: 'The time at which Cmax was measured. Ties go to the earlier time.',
    formula: 't where C = Cmax',
    caveat: 'It can only be one of the times you sampled. Comparing Tmax between studies with different schedules compares the schedules as much as the drugs.',
  },
  {
    key: 'c_last', label: 'C<sub>last</sub>',
    definition: 'The last concentration above the limit of quantification.',
    formula: 'last measurable C',
    caveat: 'Below-limit samples after this point do not count, whatever rule you chose for them — that choice only moves AUCall.',
  },
  {
    key: 't_last', label: 'T<sub>last</sub>',
    definition: 'The time of the last measurable concentration.',
    formula: 't at Clast',
    caveat: 'This is where measurement stops and extrapolation begins. Everything with an infinity in its name leans on the terminal slope from here on.',
  },

  { group: 'Terminal phase' },
  {
    key: 'lambda_z', label: '&lambda;<sub>z</sub>',
    definition: 'The terminal elimination rate constant — the slope of the log-linear tail.',
    formula: 'slope of ln C vs t, sign flipped',
    caveat: 'Fitted to whichever points are selected. Everything below this line, and AUC(0–∞), inherits whatever is wrong with that choice.',
  },
  {
    key: 'half_life', label: 't<sub>½</sub>',
    definition: 'Terminal half-life.',
    formula: 'ln 2 / λz',
    caveat: 'Only as good as the terminal phase you actually sampled. If the profile stops before the true terminal phase begins, λz is fitted to a distribution phase and the half-life comes out short.',
  },
  {
    key: 'lambda_z_span', label: 'Span',
    definition: 'How many half-lives the fitted stretch covers.',
    formula: '(last − first fitted time) / t½',
    caveat: 'The number to judge the fit by, ahead of R². Points crowded into a short window line up neatly and give a high R² while barely watching the drug leave. Under 2 the slope is close to guesswork.',
  },
  {
    key: 'lambda_z_adj_r_squared', label: 'R²<sub>adj</sub>', digits: 7,
    definition: 'Adjusted coefficient of determination for the terminal regression.',
    formula: '1 − (1 − R²)(n − 1)/(n − 2)',
    caveat: 'Says how straight the chosen points are, not whether they are the right points. A high R² over a short window still means a poorly determined slope — read Span too.',
  },
  {
    key: 'lambda_z_n_points', label: 'n points',
    definition: 'How many samples went into the terminal regression.',
    formula: 'count of fitted points',
    caveat: 'Three is the minimum the fit will accept, and three is rarely convincing.',
  },
  {
    key: 'c_last_pred', label: 'C<sub>last,pred</sub>',
    definition: 'What the fitted line says the concentration was at Tlast.',
    formula: 'exp(intercept − λz · Tlast)',
    caveat: 'Compare it with Clast. A large gap means the line does not pass through the data it was fitted to, which usually means the wrong points were chosen.',
  },

  { group: 'Exposure' },
  {
    key: 'auc_last', label: 'AUC<sub>0–last</sub>',
    definition: 'Area under the curve up to the last measurable concentration.',
    formula: '∫ C dt from 0 to Tlast',
    caveat: 'The endpoint is the last sample, not a fixed time. Two profiles whose sampling ends at different times are not comparable on this row.',
  },
  {
    key: 'auc_all', label: 'AUC<sub>all</sub>',
    definition: 'Area under the curve to the last sample of any kind, including below-limit ones recorded as zero.',
    formula: '∫ C dt over every sample',
    caveat: 'Differs from AUC(0–last) only when below-limit samples follow the last measurable one, and only if you chose to keep them as zero.',
  },
  {
    key: 'auc_inf_obs', label: 'AUC<sub>0–∞</sub>',
    definition: 'AUC carried to infinity from the last observed concentration.',
    formula: 'AUC(0–last) + Clast / λz',
    caveat: 'Inherits everything uncertain about λz. Check %Extrap before quoting it — a large extrapolated share means this is mostly a fitted tail, not measurement.',
  },
  {
    key: 'auc_inf_pred', label: 'AUC<sub>0–∞,pred</sub>',
    definition: 'The same, but starting the tail from the fitted Clast instead of the observed one.',
    formula: 'AUC(0–last) + Clast,pred / λz',
    caveat: 'Reported alongside the observed version so you can see how much the choice matters. A wide gap between the two is itself a warning about the terminal fit.',
  },
  {
    key: 'auc_extrap_pct', label: '%Extrap',
    definition: 'The share of AUC(0–∞) that comes from extrapolating past the last measurement.',
    formula: '(AUC∞ − AUClast) / AUC∞ × 100',
    caveat: 'Above roughly 20% the total rests more on the fitted slope than on the data, and should be reported that way rather than as a measurement.',
  },
  {
    key: 'aumc_last', label: 'AUMC<sub>0–last</sub>',
    definition: 'First moment of the curve — the area under t·C.',
    formula: '∫ t·C dt from 0 to Tlast',
    caveat: 'Not read on its own. It exists to produce MRT, and it weights the late, low, noisiest concentrations most heavily because it multiplies by time.',
  },
  {
    key: 'aumc_inf', label: 'AUMC<sub>0–∞</sub>',
    definition: 'The first moment carried to infinity.',
    formula: 'AUMClast + Tlast·Clast/λz + Clast/λz²',
    caveat: 'Extrapolates a much larger share than AUC does, because the tail is weighted by time. If %Extrap on AUC already worries you, this is worse.',
  },
  {
    key: 'aumc_extrap_pct', label: '%Extrap<sub>AUMC</sub>',
    definition: 'The extrapolated share of AUMC.',
    formula: '(AUMC∞ − AUMClast) / AUMC∞ × 100',
    caveat: 'Almost always larger than the AUC figure. It is the honest measure of how much MRT and Vss rest on the fitted tail.',
  },

  { group: 'Disposition' },
  {
    key: 'mrt', label: 'MRT',
    definition: 'Mean residence time — how long a molecule stays in the body on average.',
    formula: 'AUMC(0–∞) / AUC(0–∞)',
    caveat: 'A ratio of areas, so it needs no dose. For an infusion, half the infusion time is subtracted, because delivery itself takes time.',
  },
  {
    key: 'mrt_last', label: 'MRT<sub>last</sub>',
    definition: 'The same ratio using only the measured areas.',
    formula: 'AUMClast / AUClast',
    caveat: 'Always shorter than MRT(0–∞) — it stops the clock at the last sample. Useful as a floor when the extrapolated share is large.',
  },
  {
    key: 'cl', label: 'CL',
    definition: 'Clearance — the volume cleared of drug per unit time.',
    formula: 'Dose / AUC(0–∞)',
    caveat: 'This is CL/F for extravascular dosing, because bioavailability is unknown and cannot be separated from it. Blank when no dose was given.',
  },
  {
    key: 'vz', label: 'V<sub>z</sub>',
    definition: 'Volume of distribution during the terminal phase.',
    formula: 'Dose / (λz · AUC(0–∞))',
    caveat: 'Vz/F for extravascular dosing. It multiplies two uncertain quantities — λz and the extrapolated AUC — which makes it the least stable number here.',
  },
  {
    key: 'vss', label: 'V<sub>ss</sub>',
    definition: 'Volume of distribution at steady state.',
    formula: 'CL · MRT',
    caveat: 'Only meaningful for intravenous dosing, so it is left blank otherwise: without knowing F, neither CL nor the volume can be pinned down separately.',
  },

  { group: 'Per unit dose' },
  {
    key: 'c_max_dn', label: 'C<sub>max</sub>/D',
    definition: 'Peak concentration divided by the dose given.',
    formula: 'Cmax / Dose',
    caveat: 'Meant for comparing dose groups. If the drug is linear these line up; if they do not, that is the finding, not a mistake.',
  },
  {
    key: 'auc_inf_obs_dn', label: 'AUC<sub>0–∞</sub>/D',
    definition: 'Total exposure divided by the dose given.',
    formula: 'AUC(0–∞) / Dose',
    caveat: 'The usual test for dose proportionality. It says nothing about why a departure happened — saturable absorption and saturable clearance both bend this line.',
  },
];


/* ------------------------------------------------------------ */
/* 상태                                                          */
/* ------------------------------------------------------------ */
/**
 * 자료 한 덩이가 시간-농도 계열 하나다.
 *
 * 단위와 용량을 계열마다 들고 있는 것이 요점이다. 한 연구 안에서도 계열마다
 * 투여량이 다르고, 분석법이 다르면 농도 단위까지 다르다. 전역 설정으로 두면
 * 두 번째 계열을 넣는 순간 첫 번째가 조용히 틀린다.
 *
 * 행은 숫자가 아니라 문자열로 들고 있는다. "BLQ" 나 "<LLOQ" 같은 표기가
 * 숫자로 바꾸는 순간 사라지는데, 그것이야말로 정량한계 규칙이 봐야 할
 * 정보이기 때문이다.
 */
function newDataset(name) {
  NcaState._seq += 1;
  return {
    id: `ds${NcaState._seq}`,
    name: name || `Series ${NcaState._seq}`,
    rows: [],   // {time: '', conc: '', use: true}
    units: { concAmount: 'ng', concVolume: 'mL', time: 'h' },
    mw: '',
    dose: { amount: '', unit: 'mg', route: 'extravascular',
            infusion: '', bw: '', bwUnit: 'kg' },
  };
}

const NcaState = {
  _seq: 0,
  datasets: [],
  selected: null,      // 사이드바에서 고른 계열 (오른쪽 결과가 따라간다)
  editing: null,       // 모달에서 고치고 있는 계열
  results: {},         // id -> {values, terminal_line}
  lambdaTimes: {},     // id -> number[] | null  (null 이면 자동 선택)
  units: {},           // field -> {native, choices:[{label, factor}]}
  displayUnit: {},     // field -> 고른 단위 이름
};

const dataset = (id) => NcaState.datasets.find((d) => d.id === id) || null;
const currentDataset = () => dataset(NcaState.selected);
const editingDataset = () => dataset(NcaState.editing);

const $ = (id) => document.getElementById(id);


/* ------------------------------------------------------------ */
/* 서버                                                          */
/* ------------------------------------------------------------ */
function csrfToken() {
  const el = document.querySelector('input[name="csrfmiddlewaretoken"]');
  if (el) return el.value;
  const found = document.cookie.split(';')
    .map((c) => c.trim().split('='))
    .find(([name]) => name === 'csrftoken');
  return found ? decodeURIComponent(found[1]) : '';
}

async function post(url, payload) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRFToken': csrfToken() },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.status === 'error') {
    throw new Error(body.message || `Request failed (${response.status}).`);
  }
  return body;
}


/* ------------------------------------------------------------ */
/* 파일에서 가져오기                                               */
/* ------------------------------------------------------------ */
/**
 * 값을 문자열 그대로 남긴다. 여기서 숫자로 바꿔 버리면 "BLQ" 나 "<LLOQ"
 * 같은 표기가 사라지는데, 그것이야말로 정량한계 규칙이 봐야 할 정보다.
 *
 * 쉼표와 탭을 모두 받는다. 스프레드시트에서 복사하면 탭으로 나오고, 파일로
 * 내보내면 쉼표로 나온다 — 어느 쪽으로 오든 같은 자료다.
 */
function readDelimited(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (!lines.length) throw new Error('The file is empty.');

  const delimiter = lines[0].includes('\t') ? '\t' : ',';
  const split = (line) => line.split(delimiter).map((cell) => cell.trim());
  const headers = split(lines.shift());
  const rows = [];
  lines.forEach((line) => {
    const cells = split(line);
    const row = {};
    headers.forEach((name, i) => { row[name] = cells[i] !== undefined ? cells[i] : ''; });
    rows.push(row);
  });
  if (!rows.length) throw new Error('No data rows were found.');
  return { headers, rows };
}

/** 열 이름을 보고 무엇인지 짐작한다. 틀려도 사용자가 표에서 고칠 수 있다. */
function guessColumn(headers, candidates) {
  const lower = headers.map((h) => String(h).toLowerCase());
  for (const want of candidates) {
    const hit = lower.findIndex((h) => h === want);
    if (hit !== -1) return headers[hit];
  }
  for (const want of candidates) {
    const hit = lower.findIndex((h) => h.includes(want));
    if (hit !== -1) return headers[hit];
  }
  return '';
}

/** 숫자로 읽히지 않지만 비어 있지도 않은 칸은 정량한계 표기로 본다. */
function isBelowLimitMarker(cell) {
  const text = String(cell === undefined || cell === null ? '' : cell).trim();
  if (text === '') return false;
  return !Number.isFinite(Number(text));
}

/* SheetJS 는 900KB 가까이 된다. 엑셀 파일을 실제로 고른 사람만 내려받게
   미뤄 둔다 — 대부분은 붙여넣거나 CSV 를 쓴다. */
const XLSX_URL = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
let xlsxLoading = null;

function loadXlsx() {
  if (typeof XLSX !== 'undefined') return Promise.resolve();
  if (xlsxLoading) return xlsxLoading;
  xlsxLoading = new Promise((resolve, reject) => {
    const tag = document.createElement('script');
    tag.src = XLSX_URL;
    tag.onload = () => resolve();
    tag.onerror = () => reject(new Error('The spreadsheet reader could not be loaded.'));
    document.head.appendChild(tag);
  });
  return xlsxLoading;
}

async function readWorkbook(file) {
  await loadXlsx();
  const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  // raw:false 로 읽어 셀 서식이 아니라 보이는 글자를 가져온다. BLQ 가
  // 글자로 적혀 있으면 글자로 와야 한다.
  const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
  if (!grid.length) throw new Error('The first sheet is empty.');

  const headers = grid[0].map((h, i) => String(h || `Column ${i + 1}`).trim());
  const rows = grid.slice(1).map((cells) => {
    const row = {};
    headers.forEach((name, i) => { row[name] = cells[i] !== undefined ? String(cells[i]).trim() : ''; });
    return row;
  });
  return { headers, rows };
}

/**
 * 읽어 온 표를 계열로 나눈다.
 *
 * 식별 열이 있고 값이 두 가지 이상이면 계열을 그만큼 만든다 — 한 파일에
 * 여러 개체를 담아 오는 것이 보통이기 때문이다. 없으면 지금 고치고 있는
 * 계열에 행을 채운다.
 */
function absorbTable(parsed, into) {
  const { headers, rows } = parsed;
  const timeCol = guessColumn(headers, ['time', 'tad', 'hour', 'nominal time']) || headers[0];
  const concCol = guessColumn(headers, ['conc', 'dv', 'concentration', 'value', 'result'])
    || headers[headers.length - 1];
  const idCol = guessColumn(headers, ['subject', 'id', 'profile', 'animal', 'series', 'group']);

  const grouped = new Map();
  rows.forEach((row) => {
    const time = String(row[timeCol] ?? '').trim();
    const conc = String(row[concCol] ?? '').trim();
    if (time === '' && conc === '') return;
    const key = (idCol && idCol !== timeCol && idCol !== concCol)
      ? (String(row[idCol] ?? '').trim() || '(blank)')
      : '';
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push({ time, conc, use: true });
  });

  if (!grouped.size) throw new Error('No time and concentration pairs were found.');

  const keys = [...grouped.keys()];

  // 파일에 계열이 하나면 지금 고치고 있는 것에 채운다 — "이 계열의 자료를
  // 가져온다" 는 뜻이 분명하다.
  if (keys.length === 1) {
    into.rows = grouped.get(keys[0]);
    if (keys[0]) into.name = keys[0];
    return [into];
  }

  // 여럿이면 전부 새로 만들고 지금 계열은 건드리지 않는다. 첫째를 여기에
  // 덮어쓰면 사용자가 쳐 넣던 자료가 말없이 사라진다 — 파일 하나를 잘못
  // 골랐을 뿐인데 되돌릴 방법이 없어진다.
  const made = keys.map((key) => {
    const target = newDataset(key);
    target.name = key;
    target.units = { ...into.units };
    target.mw = into.mw;
    target.dose = { ...into.dose };
    target.rows = grouped.get(key);
    NcaState.datasets.push(target);
    return target;
  });

  // 비어 있던 계열이라면 자리만 차지하므로 치운다.
  if (!datasetPoints(into).time.length) {
    const at = NcaState.datasets.indexOf(into);
    if (at !== -1) NcaState.datasets.splice(at, 1);
  }
  NcaState.editing = made[0].id;
  NcaState.selected = made[0].id;
  return made;
}

/** 계열 하나를 서버가 받을 꼴로 편다. 빠진 행은 아예 보내지 않는다. */
function datasetPoints(ds) {
  const loqRaw = $('nca-loq').value;
  const loq = loqRaw === '' ? null : Number(loqRaw);

  const time = [];
  const conc = [];
  const blq = [];
  ds.rows.forEach((row) => {
    if (!row.use) return;

    // 빈 칸을 먼저 걷어낸다. Number('') 은 0 이라, 이걸 건너뛰지 않으면
    // 표 끝에 늘 놓아 두는 빈 줄이 (0, 0) 짜리 점으로 계산에 들어간다.
    const timeText = String(row.time).trim();
    const concText = String(row.conc).trim();
    if (timeText === '' || concText === '') return;

    const t = Number(timeText);
    if (!Number.isFinite(t)) return;

    const marker = isBelowLimitMarker(concText);
    const value = marker ? 0 : Number(concText);
    if (!marker && !Number.isFinite(value)) return;

    time.push(t);
    conc.push(value);
    // 어느 점이 한계 아래인지는 여기서 정한다. 글자 표기가 먼저고, LOQ 를
    // 적었으면 그보다 작은 값도, 아니면 0 이하를 그렇게 본다.
    blq.push(marker || (loq !== null ? value < loq : value <= 0));
  });
  return { time, conc, blq };
}

/** 카드에 적을 점의 수. 포함된 것만 센다. */
function usableCount(ds) {
  return datasetPoints(ds).time.length;
}


/* ------------------------------------------------------------ */
/* 단위                                                          */
/* ------------------------------------------------------------ */
const MASS_AMOUNTS = ['ng', 'µg', 'mg', 'g', 'pg'];
const MOLE_AMOUNTS = ['pmol', 'nmol', 'µmol', 'mmol'];
const VOLUMES = ['mL', 'L', 'dL', 'µL'];
const TIMES = ['h', 'min', 'day', 's', 'week'];
/* 체중당 용량을 목록에 함께 둔다. 전임상에서는 mg/kg 이 오히려 기본이고,
   그것을 고르면 CL 과 Vz 도 체중당으로 나온다 — 단위 대수가 알아서 한다. */
const DOSES = [
  'mg', 'µg', 'ng', 'g', 'nmol', 'µmol', 'mmol', 'mol',
  'mg/kg', 'µg/kg', 'ng/kg', 'mg/g', 'µmol/kg', 'nmol/kg',
];

function fillSelect(select, values, selected) {
  select.innerHTML = values
    .map((v) => `<option value="${escapeAttr(v)}"${v === selected ? ' selected' : ''}>${escapeAttr(v)}</option>`)
    .join('');
}

/** 단위는 계열마다 다르다. 지금 보고 있는 계열의 것을 쓴다. */
function currentUnitSpec(ds) {
  ds = ds || currentDataset();
  if (!ds) return { conc: 'ng/mL', time: 'h', dose: 'mg', mw: null, bw: null };

  // 체중은 kg 으로 맞춰 보낸다. 단위 셈의 기준이 kg 이기 때문이다.
  const weight = Number(ds.dose.bw);
  const inKilos = Number.isFinite(weight) && weight > 0
    ? (ds.dose.bwUnit === 'g' ? weight / 1000 : weight)
    : null;

  return {
    conc: `${ds.units.concAmount}/${ds.units.concVolume}`,
    time: ds.units.time,
    dose: ds.dose.unit,
    mw: ds.mw === '' ? null : Number(ds.mw),
    bw: inKilos,
  };
}

/** 각 항목을 어떤 단위로 보여 줄 수 있는지 서버에 묻는다.
 *  환산은 곱셈이라 브라우저가 하지만, 어떤 선택지가 실제로 닿을 수 있는지는
 *  분자량과 체중까지 걸린 문제라 단위 셈을 아는 쪽이 답한다. */
async function refreshUnits() {
  try {
    const body = await post('/nca/units/', currentUnitSpec());
    NcaState.units = body.units || {};
    // 없어진 선택지를 붙들고 있지 않도록 정리한다.
    Object.keys(NcaState.displayUnit).forEach((field) => {
      const entry = NcaState.units[field];
      const still = entry && entry.choices.some((c) => c.label === NcaState.displayUnit[field]);
      if (!still) delete NcaState.displayUnit[field];
    });
  } catch (err) {
    NcaState.units = {};
    console.warn('Units could not be resolved:', err.message);
  }
}


/* ------------------------------------------------------------ */
/* 플롯                                                          */
/* ------------------------------------------------------------ */
const PLOT_ID = 'nca-plot';

function plotProfile() {
  const ds = currentDataset();
  const profile = ds && ds._points;
  if (!profile || !profile.time.length) return;

  const result = NcaState.results[ds.id];
  const values = result ? result.values : null;
  const fitted = new Set((values && values.lambda_z_n_points)
    ? selectedTimes(ds, values)
    : []);

  const inFit = { t: [], c: [] };
  const outFit = { t: [], c: [] };
  profile.time.forEach((t, i) => {
    const c = profile.conc[i];
    const bucket = fitted.has(t) ? inFit : outFit;
    bucket.t.push(t);
    bucket.c.push(c);
  });

  const logScale = $('nca-log-toggle').checked;
  const spec = currentUnitSpec();

  const traces = [
    {
      x: outFit.t, y: outFit.c, type: 'scatter', mode: 'markers',
      name: 'Observed',
      marker: { size: 9, color: '#8e8e93', line: { width: 1, color: '#fff' } },
      hovertemplate: '%{x}, %{y}<extra></extra>',
    },
    {
      x: inFit.t, y: inFit.c, type: 'scatter', mode: 'markers',
      name: 'In terminal fit',
      marker: { size: 11, color: '#0a84ff', line: { width: 1.5, color: '#fff' } },
      hovertemplate: '%{x}, %{y}<extra>in fit</extra>',
    },
  ];

  if (result && result.terminal_line) {
    traces.push({
      x: result.terminal_line.t, y: result.terminal_line.c,
      type: 'scatter', mode: 'lines', name: 'Terminal slope',
      line: { color: '#ff9500', width: 2, dash: 'dash' },
      hoverinfo: 'skip',
    });
  }

  const layout = {
    // 아래 여백은 축 제목과 범례가 함께 들어갈 만큼 둔다 — 좁게 잡으면
    // "Time (h)" 위에 범례가 겹쳐 앉는다.
    margin: { l: 62, r: 18, t: 12, b: 78 },
    height: 380,
    xaxis: { title: `Time (${spec.time})`, zeroline: false },
    yaxis: {
      title: `Concentration (${spec.conc})`,
      type: logScale ? 'log' : 'linear',
      zeroline: false,
    },
    legend: { orientation: 'h', y: -0.28, yanchor: 'top' },
    hovermode: 'closest',
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: 'rgba(0,0,0,0)',
  };

  const container = $(PLOT_ID);
  // 숨은 채로 그리면 Plotly 가 폭 0 을 재고 그대로 굳는다. 먼저 보이게 한다.
  container.style.display = 'block';
  $('nca-plot-placeholder').style.display = 'none';

  Plotly.react(container, traces, layout, { responsive: true, displaylogo: false });

  if (!container.dataset.clickBound) {
    container.on('plotly_click', (event) => {
      const point = event.points && event.points[0];
      if (!point) return;
      toggleTerminalPoint(Number(point.x));
    });
    container.dataset.clickBound = '1';
  }
}

/** 지금 말기 회귀에 들어간 시각들. 손으로 고른 것이 있으면 그것이고,
 *  없으면 서버가 고른 구간 안의 양수 농도 점들이다. */
function selectedTimes(ds, values) {
  const manual = NcaState.lambdaTimes[ds.id];
  if (manual) return manual;
  const from = values.lambda_z_t_first;
  const to = values.lambda_z_t_last;
  if (from === null || to === null) return [];
  const points = ds._points || { time: [], conc: [] };
  return points.time.filter((t, i) => t >= from && t <= to && points.conc[i] > 0);
}

function toggleTerminalPoint(time) {
  const ds = currentDataset();
  const result = ds && NcaState.results[ds.id];
  if (!ds || !result) return;

  const current = selectedTimes(ds, result.values).slice();
  const at = current.findIndex((t) => Math.abs(t - time) < 1e-9);
  if (at === -1) current.push(time);
  else current.splice(at, 1);
  current.sort((a, b) => a - b);

  if (current.length < 3) {
    showMessage('The terminal phase needs at least three points.');
    return;
  }
  NcaState.lambdaTimes[ds.id] = current;
  run();
}


/* ------------------------------------------------------------ */
/* 결과                                                          */
/* ------------------------------------------------------------ */
/**
 * 뒤에 붙는 0 을 자르지 않는다. 자르면 정밀도가 사라진다 — 조정 R² 0.999998
 * 이 5자리로 1.0000 이 되고, 거기서 0 을 떼면 "1" 이 되어 완벽한 적합처럼
 * 읽힌다. 유효자릿수를 그대로 보이는 것이 PK 표의 관례이기도 하고, 자릿수를
 * 맞춰 두면 열이 눈으로 줄이 선다.
 */
function formatValue(value, digits = 5) {
  if (value === null || value === undefined) return '&mdash;';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value !== 'number') return escapeAttr(String(value));
  if (!Number.isFinite(value)) return '&mdash;';
  if (value === 0) return '0';
  if (Number.isInteger(value) && Math.abs(value) < 1e6) return String(value);
  const size = Math.abs(value);
  if (size >= 1e6 || size < 1e-3) return value.toExponential(3);
  return value.toPrecision(digits);
}

function unitCell(row, field) {
  const entry = NcaState.units[field];
  if (!entry) return '';
  const chosen = NcaState.displayUnit[field] || entry.native;
  if (!entry.choices.length) return `<span class="nca-unit-static">${escapeAttr(entry.native)}</span>`;

  const options = [entry.native, ...entry.choices.map((c) => c.label)]
    .filter((label, i, all) => all.indexOf(label) === i)
    .map((label) => `<option value="${escapeAttr(label)}"${label === chosen ? ' selected' : ''}>${escapeAttr(label)}</option>`)
    .join('');
  // 고른 이름을 글자로도 함께 낸다. select 는 종이에 빈 상자로 찍히는데,
  // 단위가 없는 PK 표는 아무 뜻이 없다.
  return `<select class="form-select form-select-sm nca-unit-select" data-field="${escapeAttr(field)}">${options}</select>`
    + `<span class="nca-unit-static print-only">${escapeAttr(chosen)}</span>`;
}

/** 표시 단위로 옮긴 값. 고른 단위가 없으면 계산된 그대로다. */
function displayed(field, value) {
  if (typeof value !== 'number') return value;
  const entry = NcaState.units[field];
  const chosen = NcaState.displayUnit[field];
  if (!entry || !chosen || chosen === entry.native) return value;
  const choice = entry.choices.find((c) => c.label === chosen);
  return choice ? value * choice.factor : value;
}

function renderResults() {
  const result = NcaState.results[NcaState.selected];
  const card = $('nca-results-card');
  if (!result) { card.style.display = 'none'; return; }

  const values = result.values;
  let html = '<div class="table-responsive"><table class="table table-sm nca-table"><tbody>';

  NCA_ROWS.forEach((row) => {
    if (row.group) {
      html += `<tr class="nca-group"><th colspan="3">${escapeAttr(row.group)}</th></tr>`;
      return;
    }
    const raw = values[row.key];
    if (raw === undefined) return;
    html += `<tr>
      <th scope="row">${row.label} ${infoButton({ key: row.key, definition: row.definition, formula: row.formula, caveat: row.caveat })}</th>
      <td class="nca-value">${formatValue(displayed(row.key, raw), row.digits)}</td>
      <td class="nca-unit">${unitCell(row, row.key)}</td>
    </tr>`;
  });

  const partial = values.partial_auc || {};
  const windows = Object.keys(partial);
  if (windows.length) {
    html += '<tr class="nca-group"><th colspan="3">Partial areas</th></tr>';
    windows.forEach((label) => {
      html += `<tr>
        <th scope="row">AUC<sub>${escapeAttr(label)}</sub></th>
        <td class="nca-value">${formatValue(displayed('auc_last', partial[label]))}</td>
        <td class="nca-unit">${unitCell(null, 'auc_last')}</td>
      </tr>`;
    });
  }

  html += '</tbody></table></div>';
  $('nca-results').innerHTML = html;

  const warnings = values.warnings || [];
  $('nca-warnings').innerHTML = warnings.length
    ? `<ul class="nca-warnings">${warnings.map((w) => `<li>${escapeAttr(w)}</li>`).join('')}</ul>`
    : '';

  const ds = currentDataset();
  $('nca-results-caption').textContent =
    `${ds ? ds.name : ''} · ${values.method} · ${values.administration.replace(/_/g, ' ')}`;
  card.style.display = '';
}

function renderTerminalBar() {
  const result = NcaState.results[NcaState.selected];
  const bar = $('nca-lambda-bar');
  if (!result) { bar.hidden = true; return; }

  const values = result.values;
  bar.hidden = false;
  $('nca-lambda-hint').hidden = false;

  $('nca-lz-from').value = values.lambda_z_t_first ?? '';
  $('nca-lz-to').value = values.lambda_z_t_last ?? '';

  const span = values.lambda_z_span;
  const weak = span !== null && span !== undefined && span < 2;
  $('nca-lambda-stats').innerHTML = [
    `<span class="nca-stat">n <b>${values.lambda_z_n_points || 0}</b></span>`,
    `<span class="nca-stat">R²<sub>adj</sub> <b>${formatValue(values.lambda_z_adj_r_squared, 7)}</b></span>`,
    `<span class="nca-stat${weak ? ' is-weak' : ''}">Span <b>${formatValue(span)}</b></span>`,
    `<span class="nca-stat">t½ <b>${formatValue(displayed('half_life', values.half_life))}</b></span>`,
    values.lambda_z_manual ? '<span class="nca-stat">chosen by hand</span>' : '',
  ].join('');
}

/**
 * 인쇄 직전에 리포트 머리말을 채운다.
 *
 * 메뉴가 아니라 Ctrl+P 로 인쇄해도 채워져야 하므로 beforeprint 에 건다.
 * 무엇을 어떤 규칙으로 계산한 것인지 모르는 PDF 는 나중에 쓸모가 없다 —
 * 특히 BLQ 규칙과 말기 구간은 값을 크게 바꾸므로 종이에 남아야 한다.
 */
function fillReportHead() {
  const meta = $('nca-report-meta');
  if (!meta) return;

  const ds = currentDataset();
  const result = NcaState.results[NcaState.selected];
  const values = result ? result.values : null;
  const spec = currentUnitSpec();
  const dose = ds ? ds.dose.amount : '';

  const parts = [
    new Date().toLocaleString(),
    `series: ${ds ? ds.name : '—'}`,
    `units: ${spec.conc}, ${spec.time}`,
    dose ? `dose: ${dose} ${spec.dose}` : 'no dose given',
    ds && ds.dose.bw ? `body weight: ${ds.dose.bw} ${ds.dose.bwUnit}` : null,
    `route: ${$('nca-route').selectedOptions[0].textContent.trim()}`,
    `trapezoid: ${$('nca-method').selectedOptions[0].textContent.trim()}`,
    `BLQ: before ${$('nca-blq-before').value}, between ${$('nca-blq-between').value}, after ${$('nca-blq-after').value}`,
  ];
  if (values && values.lambda_z_n_points) {
    parts.push(
      `terminal phase: ${values.lambda_z_t_first}–${values.lambda_z_t_last} `
      + `(${values.lambda_z_n_points} points, ${values.lambda_z_manual ? 'chosen by hand' : 'best fit'})`
    );
  }
  meta.textContent = parts.filter(Boolean).join('  ·  ');
}

function showMessage(text) {
  const box = $('nca-warnings');
  box.innerHTML = `<div class="alert alert-warning py-2 px-3 mb-2">${escapeAttr(text)}</div>`;
}


/* ------------------------------------------------------------ */
/* 계산                                                          */
/* ------------------------------------------------------------ */function analysisPayload() {
  const partial = $('nca-partial').value
    .split(',')
    .map((piece) => Number(piece.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);

  // 용량과 경로는 계열마다 실어 보낸다. 전역으로 두면 두 번째 계열을 넣는
  // 순간 첫 번째가 조용히 틀린다.
  const profiles = NcaState.datasets.map((ds) => {
    const points = ds._points;
    return {
      id: ds.id,
      time: points.time,
      conc: points.conc,
      blq: points.blq,
      dose: ds.dose.amount,
      route: ds.dose.route,
      infusion_duration: ds.dose.infusion || 0,
    };
  });

  return {
    profiles,
    method: $('nca-method').value,
    min_lambda_z_points: $('nca-min-points').value,
    partial_times: partial,
    blq: {
      before: $('nca-blq-before').value,
      between: $('nca-blq-between').value,
      after: $('nca-blq-after').value,
    },
    lambda_z_times: NcaState.lambdaTimes,
  };
}

async function run() {
  // 계산에 쓸 점을 계열마다 한 번 펴 둔다. 플롯과 λz 편집이 같은 배열을
  // 봐야 클릭한 점과 회귀에 들어간 점이 어긋나지 않는다.
  NcaState.datasets.forEach((ds) => { ds._points = datasetPoints(ds); });

  const usable = NcaState.datasets.filter((ds) => ds._points.time.length >= 2);
  if (!usable.length) {
    clearResults();
    if (NcaState.datasets.length) {
      showMessage('No series has two usable points yet. Add times and concentrations.');
    }
    return;
  }
  if (!currentDataset()) NcaState.selected = NcaState.datasets[0].id;

  const button = $('nca-run-btn');
  button.disabled = true;
  try {
    await refreshUnits();
    const body = await post('/nca/run/', analysisPayload());
    NcaState.results = {};
    body.profiles.forEach((entry) => { NcaState.results[entry.id] = entry; });

    plotProfile();
    renderTerminalBar();
    renderResults();
    renderDataCards();
  } catch (err) {
    showMessage(err.message);
  } finally {
    button.disabled = false;
  }
}

function clearResults() {
  NcaState.results = {};
  $('nca-results-card').style.display = 'none';
  $('nca-lambda-bar').hidden = true;
  $('nca-lambda-hint').hidden = true;
  $('nca-plot').style.display = 'none';
  $('nca-plot-placeholder').style.display = '';
}


/* ------------------------------------------------------------ */
/* 사이드바의 카드                                                 */
/* ------------------------------------------------------------ */
/**
 * 카드 하나가 계열 하나다. 고른 것은 색으로 채우고 나머지는 회색으로 둔다 —
 * 오른쪽 결과가 어느 자료의 것인지 목록만 보고 알 수 있어야 한다.
 *
 * 카드 안에 버튼을 겹쳐 넣지 않는다. 고르는 버튼과 고치는 버튼, 지우는
 * 버튼을 형제로 두면 키보드 이동과 화면 낭독기가 그냥 맞는다.
 */
function renderDataCards() {
  const list = $('nca-data-list');
  const badge = $('nca-profile-count');

  if (!NcaState.datasets.length) {
    list.innerHTML = '<div class="nca-data-placeholder">'
      + 'Nothing registered yet.<br>A series is one time&ndash;concentration pair.'
      + '</div>';
    badge.hidden = true;
  } else {
    list.innerHTML = NcaState.datasets.map((ds) => {
      const points = ds._points || datasetPoints(ds);
      const selected = ds.id === NcaState.selected;
      const dose = ds.dose.amount !== '' && ds.dose.amount !== null
        ? `${ds.dose.amount} ${ds.dose.unit}` : 'no dose';
      return `<div class="nca-data-card${selected ? ' is-selected' : ''}">
        <button type="button" class="nca-card-select" data-id="${escapeAttr(ds.id)}"
                aria-pressed="${selected}">
          <span class="nca-card-name">${escapeAttr(ds.name)}</span>
          <span class="nca-card-meta">${points.time.length} pts &middot; ${escapeAttr(dose)}</span>
        </button>
        <button type="button" class="nca-card-btn nca-card-edit" data-id="${escapeAttr(ds.id)}"
                title="Edit this series" aria-label="Edit ${escapeAttr(ds.name)}">
          <i class="bi bi-pencil"></i>
        </button>
        <button type="button" class="nca-card-btn nca-card-remove" data-id="${escapeAttr(ds.id)}"
                title="Remove this series" aria-label="Remove ${escapeAttr(ds.name)}">
          <i class="bi bi-x-lg"></i>
        </button>
      </div>`;
    }).join('');
    badge.hidden = NcaState.datasets.length < 2;
    badge.textContent = `${NcaState.datasets.length} series`;
  }
  renderDoseSection();
}


/* ------------------------------------------------------------ */
/* 용량 — 고른 계열의 것                                           */
/* ------------------------------------------------------------ */
/**
 * 용량은 계열에 딸린다. 사이드바에 있으면 전역 설정으로 읽히기 쉬우므로,
 * 어느 계열의 것인지 맨 위에 적어 둔다.
 */
function renderDoseSection() {
  const ds = currentDataset();
  const owner = $('nca-dose-owner').querySelector('span');
  const fields = ['nca-dose', 'nca-dose-unit', 'nca-route', 'nca-infusion',
                  'nca-bw', 'nca-bw-unit'];

  if (!ds) {
    owner.innerHTML = 'Select a data series first.';
    fields.forEach((id) => { $(id).disabled = true; });
    $('nca-infusion-field').hidden = true;
    return;
  }

  owner.innerHTML = `Belongs to <b>${escapeAttr(ds.name)}</b>. Every series carries its own dose.`;
  fields.forEach((id) => { $(id).disabled = false; });

  $('nca-dose').value = ds.dose.amount;
  fillSelect($('nca-dose-unit'), DOSES, ds.dose.unit);
  $('nca-route').value = ds.dose.route;
  $('nca-infusion').value = ds.dose.infusion;
  $('nca-infusion-field').hidden = ds.dose.route !== 'iv_infusion';
  $('nca-bw').value = ds.dose.bw;
  $('nca-bw-unit').value = ds.dose.bwUnit;
}

function readDoseSection() {
  const ds = currentDataset();
  if (!ds) return;
  ds.dose.amount = $('nca-dose').value;
  ds.dose.unit = $('nca-dose-unit').value;
  ds.dose.route = $('nca-route').value;
  ds.dose.infusion = $('nca-infusion').value;
  ds.dose.bw = $('nca-bw').value;
  ds.dose.bwUnit = $('nca-bw-unit').value;
  $('nca-infusion-field').hidden = ds.dose.route !== 'iv_infusion';
}


/* ------------------------------------------------------------ */
/* 등록·관리 모달                                                  */
/* ------------------------------------------------------------ */
function openManager(id) {
  if (!NcaState.datasets.length) addDataset();
  NcaState.editing = id || NcaState.selected || NcaState.datasets[0].id;
  renderManager();
  bootstrap.Modal.getOrCreateInstance($('ncaDataModal')).show();
}

function addDataset() {
  const ds = newDataset();
  // 새 계열은 앞의 것에서 단위와 용량을 물려받는다. 같은 연구의 두 번째
  // 개체라면 대개 같고, 다르면 고치면 된다 — 매번 처음부터 세우는 것보다 낫다.
  const previous = NcaState.datasets[NcaState.datasets.length - 1];
  if (previous) {
    ds.units = { ...previous.units };
    ds.mw = previous.mw;
    ds.dose = { ...previous.dose };
  }
  NcaState.datasets.push(ds);
  NcaState.selected = ds.id;
  NcaState.editing = ds.id;
  return ds;
}

function removeDataset(id) {
  const at = NcaState.datasets.findIndex((d) => d.id === id);
  if (at === -1) return;
  NcaState.datasets.splice(at, 1);
  delete NcaState.results[id];
  delete NcaState.lambdaTimes[id];
  if (NcaState.selected === id) {
    NcaState.selected = NcaState.datasets.length
      ? NcaState.datasets[Math.min(at, NcaState.datasets.length - 1)].id : null;
  }
  if (NcaState.editing === id) NcaState.editing = NcaState.selected;
  if (!NcaState.datasets.length) clearResults();
  renderDataCards();
  renderManager();
  run();
}

function renderManager() {
  const rail = $('nca-rail-list');
  rail.innerHTML = NcaState.datasets.map((ds) => {
    const points = ds._points || datasetPoints(ds);
    return `<button type="button" class="nca-rail-item${ds.id === NcaState.editing ? ' is-selected' : ''}"
              data-id="${escapeAttr(ds.id)}">
      <i class="bi bi-list-columns-reverse" aria-hidden="true"></i>
      <span class="nca-card-name">${escapeAttr(ds.name)}</span>
      <span class="nca-card-meta">${points.time.length}</span>
    </button>`;
  }).join('');

  const ds = editingDataset();
  $('nca-manager-empty').hidden = !!ds;
  $('nca-manager-editor').hidden = !ds;
  if (!ds) return;

  $('nca-edit-name').value = ds.name;
  fillSelect($('nca-edit-conc-amount'), [...MASS_AMOUNTS, ...MOLE_AMOUNTS], ds.units.concAmount);
  fillSelect($('nca-edit-conc-volume'), VOLUMES, ds.units.concVolume);
  fillSelect($('nca-edit-time-unit'), TIMES, ds.units.time);
  $('nca-edit-mw').value = ds.mw;
  renderSheet();
}


/* ------------------------------------------------------------ */
/* 스프레드시트                                                    */
/* ------------------------------------------------------------ */
/**
 * 셀마다 input 을 둔다. contenteditable 보다 붙잡기 쉽고, 탭 이동과 화면
 * 낭독기 지원이 그냥 따라온다.
 *
 * 마지막에 늘 빈 줄 하나를 둔다 — 점을 더하려고 버튼을 찾아 헤매지 않아도
 * 되도록. 그 줄에 뭔가 적으면 새 빈 줄이 뒤에 붙는다.
 */
function renderSheet(focus) {
  const ds = editingDataset();
  if (!ds) return;
  ensureBlankRow(ds);

  $('nca-sheet-body').innerHTML = ds.rows.map((row, i) => {
    const dropped = !row.use;
    return `<tr class="${dropped ? 'is-excluded' : ''}" data-row="${i}">
      <td class="nca-cell-use">
        <input type="checkbox" class="form-check-input nca-row-use" data-row="${i}"
               ${row.use ? 'checked' : ''} aria-label="Include row ${i + 1}">
      </td>
      <td><input type="text" class="nca-cell" data-row="${i}" data-col="time"
                 value="${escapeAttr(row.time)}" aria-label="Time, row ${i + 1}"></td>
      <td><input type="text" class="nca-cell" data-row="${i}" data-col="conc"
                 value="${escapeAttr(row.conc)}" aria-label="Concentration, row ${i + 1}"></td>
      <td><button type="button" class="nca-row-del" data-row="${i}"
                  title="Delete row" aria-label="Delete row ${i + 1}">
            <i class="bi bi-trash3"></i></button></td>
    </tr>`;
  }).join('');

  const points = datasetPoints(ds);
  const dropped = ds.rows.filter((r) => !r.use && (r.time !== '' || r.conc !== '')).length;
  $('nca-sheet-count').textContent = dropped
    ? `${points.time.length} in use, ${dropped} left out`
    : `${points.time.length} points`;

  if (focus) {
    const cell = $('nca-sheet-body')
      .querySelector(`.nca-cell[data-row="${focus.row}"][data-col="${focus.col}"]`);
    if (cell) { cell.focus(); cell.setSelectionRange(cell.value.length, cell.value.length); }
  }
}

function ensureBlankRow(ds) {
  const last = ds.rows[ds.rows.length - 1];
  if (!last || last.time !== '' || last.conc !== '') {
    ds.rows.push({ time: '', conc: '', use: true });
  }
}

/** 스프레드시트에서 붙여넣은 격자를 그 자리부터 채워 넣는다. */
function pasteGrid(text, startRow, startCol) {
  const ds = editingDataset();
  if (!ds) return false;

  const lines = text.replace(/\r/g, '').split('\n').filter((l) => l.trim() !== '');
  const grid = lines.map((line) => line.split(line.includes('\t') ? '\t' : ',').map((c) => c.trim()));
  if (!grid.length) return false;
  // 한 칸짜리는 그냥 타이핑이다. 브라우저에 맡긴다.
  if (grid.length === 1 && grid[0].length === 1) return false;

  // 머리글이 딸려 왔으면 버린다 — 숫자가 아닌 첫 줄은 값일 리가 없다.
  if (grid.length > 1 && grid[0].every((cell) => !Number.isFinite(Number(cell)) && cell !== '')) {
    grid.shift();
  }

  const columns = ['time', 'conc'];
  grid.forEach((cells, r) => {
    const target = startRow + r;
    while (ds.rows.length <= target) ds.rows.push({ time: '', conc: '', use: true });
    cells.forEach((cell, c) => {
      const col = columns[columns.indexOf(startCol) + c];
      if (col) ds.rows[target][col] = cell;
    });
  });
  return true;
}


/* ------------------------------------------------------------ */
/* 내보내기                                                       */
/* ------------------------------------------------------------ */
/** 화면은 하나를 보여 주지만 파일은 전부 낸다. 열둘을 계산해 놓고 한 줄만
 *  가져가는 것은 말이 안 된다.
 *
 *  단위를 열 이름에 적는다. 계열마다 단위가 다를 수 있으므로, 이걸 빼면
 *  숫자만 남은 표가 되어 나중에 읽을 수 없다. */
function exportCsv() {
  const ids = Object.keys(NcaState.results);
  if (!ids.length) { showMessage('Nothing to export yet.'); return; }

  const keys = NCA_ROWS.filter((r) => !r.group).map((r) => r.key);
  const header = ['Series', 'Conc. unit', 'Time unit', 'Dose unit', ...keys];

  const lines = [header.join(',')];
  ids.forEach((id) => {
    const ds = dataset(id);
    const values = NcaState.results[id].values;
    const cells = keys.map((k) => {
      const shown = displayed(k, values[k]);
      return shown === null || shown === undefined ? '' : shown;
    });
    lines.push([
      ds ? ds.name : id,
      ds ? `${ds.units.concAmount}/${ds.units.concVolume}` : '',
      ds ? ds.units.time : '',
      ds ? ds.dose.unit : '',
      ...cells,
    ].join(','));
  });

  const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'nca_results.csv';
  link.click();
  URL.revokeObjectURL(link.href);
}


/* ------------------------------------------------------------ */
/* 시작                                                          */
/* ------------------------------------------------------------ */
function bindManager() {
  $('nca-add-data-btn').addEventListener('click', () => openManager(null));
  $('nca-rail-add').addEventListener('click', () => {
    addDataset();
    renderDataCards();
    renderManager();
  });

  $('nca-rail-list').addEventListener('click', (event) => {
    const item = event.target.closest('.nca-rail-item');
    if (!item) return;
    NcaState.editing = item.dataset.id;
    renderManager();
  });

  // 이름과 단위
  $('nca-edit-name').addEventListener('input', (event) => {
    const ds = editingDataset();
    if (!ds) return;
    ds.name = event.target.value;
    renderDataCards();
    renderManager();
    // 이름은 계산에 들어가지 않는다. 다시 돌릴 이유가 없다.
  });
  ['nca-edit-conc-amount', 'nca-edit-conc-volume', 'nca-edit-time-unit', 'nca-edit-mw']
    .forEach((id) => $(id).addEventListener('change', () => {
      const ds = editingDataset();
      if (!ds) return;
      ds.units.concAmount = $('nca-edit-conc-amount').value;
      ds.units.concVolume = $('nca-edit-conc-volume').value;
      ds.units.time = $('nca-edit-time-unit').value;
      ds.mw = $('nca-edit-mw').value;
      // 단위는 계산을 바꾸지 않는다 — 표시만 다시 세운다.
      refreshUnits().then(() => { renderResults(); renderTerminalBar(); plotProfile(); });
    }));

  // 표
  const body = $('nca-sheet-body');
  body.addEventListener('input', (event) => {
    const cell = event.target.closest('.nca-cell');
    if (!cell) return;
    const ds = editingDataset();
    const row = ds.rows[Number(cell.dataset.row)];
    if (!row) return;
    row[cell.dataset.col] = cell.value;

    // 마지막 줄에 적었으면 뒤에 빈 줄을 하나 더 붙인다.
    if (Number(cell.dataset.row) === ds.rows.length - 1) {
      renderSheet({ row: Number(cell.dataset.row), col: cell.dataset.col });
    } else {
      $('nca-sheet-count').textContent = `${datasetPoints(ds).time.length} points`;
    }
  });

  body.addEventListener('change', (event) => {
    const box = event.target.closest('.nca-row-use');
    if (!box) return;
    const ds = editingDataset();
    const row = ds.rows[Number(box.dataset.row)];
    if (!row) return;
    row.use = box.checked;
    renderSheet();
    scheduleRun();
  });

  body.addEventListener('click', (event) => {
    const button = event.target.closest('.nca-row-del');
    if (!button) return;
    const ds = editingDataset();
    ds.rows.splice(Number(button.dataset.row), 1);
    renderSheet();
    scheduleRun();
  });

  body.addEventListener('paste', (event) => {
    const cell = event.target.closest('.nca-cell');
    if (!cell) return;
    const text = (event.clipboardData || window.clipboardData).getData('text');
    if (!text) return;
    if (pasteGrid(text, Number(cell.dataset.row), cell.dataset.col)) {
      event.preventDefault();
      renderSheet();
      scheduleRun();
    }
  });

  // 표를 벗어날 때 한 번만 다시 계산한다 — 한 글자마다 왕복할 이유가 없다.
  body.addEventListener('focusout', () => scheduleRun());

  $('nca-sheet-clear').addEventListener('click', () => {
    const ds = editingDataset();
    if (!ds) return;
    ds.rows = [];
    renderSheet();
    scheduleRun();
  });

  $('nca-sheet-import').addEventListener('change', async (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    const ds = editingDataset() || addDataset();
    try {
      const excel = /\.xlsx?$/i.test(file.name);
      const parsed = excel ? await readWorkbook(file) : readDelimited(await file.text());
      const made = absorbTable(parsed, ds);
      if (made.length > 1) {
        $('nca-sheet-note').textContent =
          `${made.length} series were found in that file and registered separately.`;
      }
      renderDataCards();
      renderManager();
      run();
    } catch (err) {
      $('nca-sheet-note').textContent = err.message;
    } finally {
      event.target.value = '';
    }
  });

  // 모달을 닫으면 카드 목록과 결과를 맞춰 둔다.
  $('ncaDataModal').addEventListener('hidden.bs.modal', () => {
    renderDataCards();
    run();
  });
}

/* 표를 만지는 동안 요청이 줄줄이 나가지 않도록 한 번으로 모은다. */
let runTimer = null;
function scheduleRun() {
  window.clearTimeout(runTimer);
  runTimer = window.setTimeout(run, 350);
}

function bindCards() {
  $('nca-data-list').addEventListener('click', (event) => {
    const select = event.target.closest('.nca-card-select');
    if (select) {
      NcaState.selected = select.dataset.id;
      renderDataCards();
      plotProfile();
      refreshUnits().then(() => { renderTerminalBar(); renderResults(); });
      return;
    }
    const edit = event.target.closest('.nca-card-edit');
    if (edit) { openManager(edit.dataset.id); return; }

    const remove = event.target.closest('.nca-card-remove');
    if (remove) removeDataset(remove.dataset.id);
  });
}

function init() {
  Tooltip.init();

  // 껍데기는 시뮬레이터와 같은 코드가 맡는다. 지켜볼 플롯만 갈아 끼우고,
  // 저장 키도 함께 바꾼다 — 같은 키를 쓰면 이 페이지를 여는 것만으로
  // 시뮬레이터가 기억해 둔 플롯 높이가 지워진다.
  if (typeof Resize !== 'undefined') {
    Resize.PLOTS = [PLOT_ID];
    Resize.PLOT_KEY = 'pkNca.plotHeights';
    Resize.init();
  }

  fillSelect($('nca-dose-unit'), DOSES, 'mg');
  renderDataCards();
  bindCards();
  bindManager();

  $('nca-run-btn').addEventListener('click', run);
  $('nca-run-btn').disabled = false;

  // 용량은 고른 계열의 것을 고친다.
  ['nca-dose', 'nca-dose-unit', 'nca-route', 'nca-infusion', 'nca-bw', 'nca-bw-unit']
    .forEach((id) => $(id).addEventListener('change', () => {
      readDoseSection();
      renderDataCards();
      run();
    }));

  // 계산 규칙은 모든 계열에 함께 걸린다.
  ['nca-method', 'nca-min-points', 'nca-partial', 'nca-loq',
   'nca-blq-before', 'nca-blq-between', 'nca-blq-after']
    .forEach((id) => $(id).addEventListener('change', run));

  $('nca-log-toggle').addEventListener('change', plotProfile);

  // 말기 구간을 범위로 고르기
  const applyRange = () => {
    const ds = currentDataset();
    if (!ds || !ds._points) return;
    const from = Number($('nca-lz-from').value);
    const to = Number($('nca-lz-to').value);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return;
    const picked = ds._points.time.filter(
      (t, i) => t >= from && t <= to && ds._points.conc[i] > 0);
    if (picked.length < 3) { showMessage('That range holds fewer than three points.'); return; }
    NcaState.lambdaTimes[ds.id] = picked;
    run();
  };
  $('nca-lz-from').addEventListener('change', applyRange);
  $('nca-lz-to').addEventListener('change', applyRange);

  $('nca-lz-auto').addEventListener('click', () => {
    delete NcaState.lambdaTimes[NcaState.selected];
    run();
  });

  // 항목별 표시 단위
  $('nca-results').addEventListener('change', (event) => {
    const select = event.target.closest('.nca-unit-select');
    if (!select) return;
    NcaState.displayUnit[select.dataset.field] = select.value;
    renderResults();
    renderTerminalBar();
  });

  $('nca-export-csv-btn').addEventListener('click', exportCsv);
  $('nca-export-plot-btn').addEventListener('click', () => {
    const ds = currentDataset();
    if (!ds) return;
    Plotly.downloadImage($(PLOT_ID), {
      format: 'png', width: 1200, height: 700,
      filename: `nca_${ds.name}`,
    });
  });

  $('nca-export-report-btn').addEventListener('click', () => {
    if (!currentDataset()) { showMessage('Nothing to report yet.'); return; }
    window.print();
  });
  window.addEventListener('beforeprint', fillReportHead);

  $('nca-clear-btn').addEventListener('click', () => window.location.reload());

  // 도움말 메뉴에서 고른 절로 스크롤한다.
  document.querySelectorAll('[data-help-tab]').forEach((item) => {
    item.addEventListener('click', () => {
      const target = document.querySelector(item.dataset.helpTab);
      if (target) setTimeout(() => target.scrollIntoView({ block: 'start' }), 300);
    });
  });
}

document.addEventListener('DOMContentLoaded', init);
