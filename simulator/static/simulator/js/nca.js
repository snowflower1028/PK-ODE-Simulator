/* ============================================================ */
/* nca.js — 비구획 분석 계산기                                     */
/* ============================================================ */
/**
 * 시뮬레이터와 다른 페이지지만 같은 껍데기를 쓴다. 좌측 입력, 우측 결과,
 * 같은 카드와 접기. 도구가 바뀌었다고 조작법까지 바뀌면 안 되기 때문이다.
 *
 * 계산은 서버가 한다 (nca.py). 브라우저가 맡는 것은 셋뿐이다:
 *   - CSV 를 읽어 프로파일로 나누는 일
 *   - 말기 구간을 사람이 고르게 하는 일
 *   - 단위를 바꿔 보여 주는 일 — 이건 곱셈 하나라 왕복할 필요가 없다
 *
 * 프로파일이 여럿이어도 계산은 한 번에 다 해 둔다. 하나씩 골라 볼 때마다
 * 서버에 다녀오면 느리고, 내보내기는 어차피 전부 필요하다.
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
const NcaState = {
  headers: [],
  rows: [],            // CSV 의 raw 문자열 행
  profiles: [],        // [{id, time[], conc[], blq[]}]
  results: {},         // id -> {values, terminal_line}
  lambdaTimes: {},     // id -> number[] | null  (null 이면 자동 선택)
  units: {},           // field -> {native, choices:[{label, factor}]}
  displayUnit: {},     // field -> 고른 단위 이름
  current: null,       // 지금 보고 있는 프로파일 id
};

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
/* CSV                                                           */
/* ------------------------------------------------------------ */
/**
 * 값을 문자열 그대로 남긴다. 여기서 숫자로 바꿔 버리면 "BLQ" 나 "<LLOQ"
 * 같은 표기가 사라지는데, 그것이야말로 정량한계 규칙이 봐야 할 정보다.
 */
function readCsv(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (!lines.length) throw new Error('The file is empty.');

  const split = (line) => line.split(',').map((cell) => cell.trim());
  const headers = split(lines.shift());
  const rows = [];
  lines.forEach((line) => {
    const cells = split(line);
    if (cells.length < headers.length) return;
    const row = {};
    headers.forEach((name, i) => { row[name] = cells[i]; });
    rows.push(row);
  });
  if (!rows.length) throw new Error('No data rows were found.');
  return { headers, rows };
}

/** 열 이름을 보고 무엇인지 짐작한다. 틀려도 사용자가 고칠 수 있다. */
function guessColumn(headers, candidates) {
  const lower = headers.map((h) => h.toLowerCase());
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
  if (cell === undefined || cell === null) return false;
  const text = String(cell).trim();
  if (text === '') return false;
  return !Number.isFinite(Number(text));
}


/* ------------------------------------------------------------ */
/* 프로파일 만들기                                                 */
/* ------------------------------------------------------------ */
function buildProfiles() {
  const idCol = $('nca-col-id').value;
  const timeCol = $('nca-col-time').value;
  const concCol = $('nca-col-conc').value;
  if (!timeCol || !concCol) return [];

  const loqRaw = $('nca-loq').value;
  const loq = loqRaw === '' ? null : Number(loqRaw);

  const grouped = new Map();
  NcaState.rows.forEach((row) => {
    const time = Number(row[timeCol]);
    if (!Number.isFinite(time)) return;

    const cell = row[concCol];
    const marker = isBelowLimitMarker(cell);
    const value = marker ? 0 : Number(cell);
    if (!marker && !Number.isFinite(value)) return;

    const id = idCol ? String(row[idCol] ?? '') || '(blank)' : 'All data';
    if (!grouped.has(id)) grouped.set(id, { id, time: [], conc: [], blq: [] });

    const profile = grouped.get(id);
    profile.time.push(time);
    profile.conc.push(value);
    // 어느 점이 한계 아래인지를 여기서 정한다. 글자 표기가 우선이고,
    // LOQ 를 적었으면 그보다 작은 값도, 아니면 0 이하를 그렇게 본다.
    profile.blq.push(marker || (loq !== null ? value < loq : value <= 0));
  });

  return [...grouped.values()];
}


/* ------------------------------------------------------------ */
/* 단위                                                          */
/* ------------------------------------------------------------ */
const MASS_AMOUNTS = ['ng', 'µg', 'mg', 'g', 'pg'];
const MOLE_AMOUNTS = ['pmol', 'nmol', 'µmol', 'mmol'];
const VOLUMES = ['mL', 'L', 'dL', 'µL'];
const TIMES = ['h', 'min', 'day', 's', 'week'];
const DOSES = ['mg', 'µg', 'ng', 'g', 'nmol', 'µmol', 'mmol', 'mol'];

function fillSelect(select, values, selected) {
  select.innerHTML = values
    .map((v) => `<option value="${escapeAttr(v)}"${v === selected ? ' selected' : ''}>${escapeAttr(v)}</option>`)
    .join('');
}

function currentUnitSpec() {
  const mwRaw = $('nca-mw').value;
  return {
    conc: `${$('nca-conc-amount').value}/${$('nca-conc-volume').value}`,
    time: $('nca-time-unit').value,
    dose: $('nca-dose-unit').value,
    mw: mwRaw === '' ? null : Number(mwRaw),
  };
}

/** 각 항목을 어떤 단위로 보여 줄 수 있는지 서버에 묻는다.
 *  환산은 곱셈이라 브라우저가 하지만, 어떤 선택지가 실제로 닿을 수 있는지는
 *  분자량까지 걸린 문제라 단위 셈을 아는 쪽이 답한다. */
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
  const profile = NcaState.profiles.find((p) => p.id === NcaState.current);
  if (!profile) return;

  const result = NcaState.results[profile.id];
  const values = result ? result.values : null;
  const fitted = new Set((values && values.lambda_z_n_points)
    ? selectedTimes(profile, values)
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
    margin: { l: 62, r: 18, t: 12, b: 48 },
    height: 380,
    xaxis: { title: `Time (${spec.time})`, zeroline: false },
    yaxis: {
      title: `Concentration (${spec.conc})`,
      type: logScale ? 'log' : 'linear',
      zeroline: false,
    },
    legend: { orientation: 'h', y: -0.22 },
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
function selectedTimes(profile, values) {
  const manual = NcaState.lambdaTimes[profile.id];
  if (manual) return manual;
  const from = values.lambda_z_t_first;
  const to = values.lambda_z_t_last;
  if (from === null || to === null) return [];
  return profile.time.filter((t, i) => t >= from && t <= to && profile.conc[i] > 0);
}

function toggleTerminalPoint(time) {
  const profile = NcaState.profiles.find((p) => p.id === NcaState.current);
  const result = NcaState.results[profile && profile.id];
  if (!profile || !result) return;

  const current = selectedTimes(profile, result.values).slice();
  const at = current.findIndex((t) => Math.abs(t - time) < 1e-9);
  if (at === -1) current.push(time);
  else current.splice(at, 1);
  current.sort((a, b) => a - b);

  if (current.length < 3) {
    showMessage('The terminal phase needs at least three points.');
    return;
  }
  NcaState.lambdaTimes[profile.id] = current;
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
  return `<select class="form-select form-select-sm nca-unit-select" data-field="${escapeAttr(field)}">${options}</select>`;
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
  const result = NcaState.results[NcaState.current];
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

  $('nca-results-caption').textContent =
    `${NcaState.current} · ${values.method} · ${values.administration.replace(/_/g, ' ')}`;
  card.style.display = '';
}

function renderTerminalBar() {
  const result = NcaState.results[NcaState.current];
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

function showMessage(text) {
  const box = $('nca-warnings');
  box.innerHTML = `<div class="alert alert-warning py-2 px-3 mb-2">${escapeAttr(text)}</div>`;
}


/* ------------------------------------------------------------ */
/* 계산                                                          */
/* ------------------------------------------------------------ */
function analysisPayload() {
  const partial = $('nca-partial').value
    .split(',')
    .map((piece) => Number(piece.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);

  return {
    profiles: NcaState.profiles,
    dose: $('nca-dose').value,
    route: $('nca-route').value,
    infusion_duration: $('nca-infusion').value || 0,
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
  NcaState.profiles = buildProfiles();
  if (!NcaState.profiles.length) {
    showMessage('No usable rows — check the time and concentration columns.');
    return;
  }
  if (!NcaState.current || !NcaState.profiles.some((p) => p.id === NcaState.current)) {
    NcaState.current = NcaState.profiles[0].id;
  }

  const button = $('nca-run-btn');
  button.disabled = true;
  try {
    await refreshUnits();
    const body = await post('/nca/run/', analysisPayload());
    NcaState.results = {};
    body.profiles.forEach((entry) => { NcaState.results[entry.id] = entry; });

    fillProfilePicker();
    plotProfile();
    renderTerminalBar();
    renderResults();
  } catch (err) {
    showMessage(err.message);
  } finally {
    button.disabled = false;
  }
}

function fillProfilePicker() {
  const picker = $('nca-profile-picker');
  const select = $('nca-profile-select');
  const ids = NcaState.profiles.map((p) => p.id);
  picker.hidden = ids.length < 2;
  fillSelect(select, ids, NcaState.current);

  const badge = $('nca-profile-count');
  badge.hidden = ids.length < 2;
  badge.textContent = `${ids.length} profiles`;
}


/* ------------------------------------------------------------ */
/* 내보내기                                                       */
/* ------------------------------------------------------------ */
/** 화면은 하나를 보여 주지만 파일은 전부 낸다. 열둘을 계산해 놓고 한 줄만
 *  가져가는 것은 말이 안 된다. */
function exportCsv() {
  const ids = Object.keys(NcaState.results);
  if (!ids.length) { showMessage('Nothing to export yet.'); return; }

  const keys = NCA_ROWS.filter((r) => !r.group).map((r) => r.key);
  const header = ['Profile', ...keys.map((k) => {
    const entry = NcaState.units[k];
    const unit = entry ? (NcaState.displayUnit[k] || entry.native) : '';
    return unit ? `${k} (${unit})` : k;
  })];

  const lines = [header.join(',')];
  ids.forEach((id) => {
    const values = NcaState.results[id].values;
    const cells = keys.map((k) => {
      const shown = displayed(k, values[k]);
      return shown === null || shown === undefined ? '' : shown;
    });
    lines.push([id, ...cells].join(','));
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
function bindColumnSelects() {
  const options = (headers, blank) =>
    (blank ? ['<option value="">(none)</option>'] : [])
      .concat(headers.map((h) => `<option value="${escapeAttr(h)}">${escapeAttr(h)}</option>`))
      .join('');

  $('nca-col-id').innerHTML = options(NcaState.headers, true);
  $('nca-col-time').innerHTML = options(NcaState.headers, false);
  $('nca-col-conc').innerHTML = options(NcaState.headers, false);

  $('nca-col-id').value = guessColumn(NcaState.headers, ['subject', 'id', 'profile', 'animal']);
  $('nca-col-time').value = guessColumn(NcaState.headers, ['time', 'tad', 'hour']) || NcaState.headers[0];
  $('nca-col-conc').value = guessColumn(NcaState.headers, ['conc', 'dv', 'concentration', 'value'])
    || NcaState.headers[NcaState.headers.length - 1];

  $('nca-mapping').hidden = false;
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

  fillSelect($('nca-conc-amount'), [...MASS_AMOUNTS, ...MOLE_AMOUNTS], 'ng');
  fillSelect($('nca-conc-volume'), VOLUMES, 'mL');
  fillSelect($('nca-time-unit'), TIMES, 'h');
  fillSelect($('nca-dose-unit'), DOSES, 'mg');

  $('nca-file-input').addEventListener('change', async (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = readCsv(text);
      NcaState.headers = parsed.headers;
      NcaState.rows = parsed.rows;
      NcaState.lambdaTimes = {};
      NcaState.results = {};
      NcaState.current = null;
      bindColumnSelects();
      $('nca-file-hint').textContent =
        `${parsed.rows.length} rows, ${parsed.headers.length} columns.`;
      $('nca-run-btn').disabled = false;
      run();
    } catch (err) {
      showMessage(err.message);
    }
  });

  ['nca-col-id', 'nca-col-time', 'nca-col-conc'].forEach((id) => {
    $(id).addEventListener('change', () => {
      // 프로파일이 다시 나뉘면 손으로 고른 구간은 뜻을 잃는다.
      NcaState.lambdaTimes = {};
      NcaState.current = null;
      run();
    });
  });

  $('nca-run-btn').addEventListener('click', run);

  $('nca-route').addEventListener('change', (event) => {
    $('nca-infusion-field').hidden = event.target.value !== 'iv_infusion';
    run();
  });

  ['nca-dose', 'nca-infusion', 'nca-method', 'nca-min-points', 'nca-partial',
   'nca-loq', 'nca-blq-before', 'nca-blq-between', 'nca-blq-after']
    .forEach((id) => $(id).addEventListener('change', run));

  ['nca-conc-amount', 'nca-conc-volume', 'nca-time-unit', 'nca-dose-unit', 'nca-mw']
    .forEach((id) => $(id).addEventListener('change', async () => {
      // 단위를 바꿔도 계산은 그대로다 — 곱셈만 다시 한다.
      await refreshUnits();
      renderResults();
      renderTerminalBar();
      plotProfile();
    }));

  $('nca-profile-select').addEventListener('change', (event) => {
    NcaState.current = event.target.value;
    plotProfile();
    renderTerminalBar();
    renderResults();
  });

  $('nca-log-toggle').addEventListener('change', plotProfile);

  // 말기 구간을 범위로 고르기
  const applyRange = () => {
    const profile = NcaState.profiles.find((p) => p.id === NcaState.current);
    if (!profile) return;
    const from = Number($('nca-lz-from').value);
    const to = Number($('nca-lz-to').value);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return;
    const picked = profile.time.filter((t, i) => t >= from && t <= to && profile.conc[i] > 0);
    if (picked.length < 3) { showMessage('That range holds fewer than three points.'); return; }
    NcaState.lambdaTimes[profile.id] = picked;
    run();
  };
  $('nca-lz-from').addEventListener('change', applyRange);
  $('nca-lz-to').addEventListener('change', applyRange);

  $('nca-lz-auto').addEventListener('click', () => {
    delete NcaState.lambdaTimes[NcaState.current];
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
    if (!NcaState.current) return;
    Plotly.downloadImage($(PLOT_ID), {
      format: 'png', width: 1200, height: 700,
      filename: `nca_${NcaState.current}`,
    });
  });
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
