const State = {
  lastFitResult: null,   // 'Apply to model' 이 참조한다
  // 1. 투여 관련 상태
  doseList: [],

  // 2. 관찰 데이터 관련 상태
  observations: [], // 기존 window._obs를 대체하며, 이름을 더 명확하게 변경
  
  // 3. 모델 파싱 결과 상태
  compartments: [],       // 기존 window._compartments 대체 (알파벳순, 계산용 기준)
  parameters: [],         // 기존 window._parameters 대체 (알파벳순, 계산용 기준)
  compartmentsOdeOrder: [], // ODE 에 적힌 순서 (표시 전용)
  parametersOdeOrder: [],   // ODE 에 적힌 순서 (표시 전용)
  symbolOrder: 'ode',       // 'ode' | 'alpha' — Value Settings 표시 순서
  processedODE: "",         // 기존 window._processedODE 대체
  derivedExpressions: {}, // 기존 window._derivedExpressions 대체

  // 4. 피팅 프로세스 관련 상태
  fitTimer: null,             // 피팅 진행 시간 측정을 위한 타이머 ID
  fittingGroupCounter: 0,   // 피팅 그룹 UI 생성을 위한 카운터
  isFitting: false,           // 현재 피팅이 진행 중인지 여부를 나타내는 플래그
  
  // 5. 시뮬레이션 프로세스 관련 상태
  isSimulating: false,        // 현재 시뮬레이션이 진행 중인지 여부를 나타내는 플래그
  latestSimulationResult: null, // 마지막 시뮬레이션 결과를 저장하는 변수
  latestPKSummary: null, // 마지막 PK 요약 결과를 저장하는 변수
};

/**
 * Value Settings 표시 순서 헬퍼.
 * 계산에 쓰이는 State.compartments / State.parameters 는 건드리지 않고,
 * 화면에 뿌릴 때만 순서를 바꾼다.
 */
const SymbolOrder = {
  STORAGE_KEY: 'pkSimulator.symbolOrder',

  load() {
    try {
      const v = localStorage.getItem(this.STORAGE_KEY);
      if (v === 'ode' || v === 'alpha') State.symbolOrder = v;
    } catch (e) { /* 프라이빗 모드 등에서 접근 불가 — 기본값 사용 */ }
    return State.symbolOrder;
  },

  save(value) {
    State.symbolOrder = value;
    try { localStorage.setItem(this.STORAGE_KEY, value); } catch (e) { /* 무시 */ }
  },

  /** base(알파벳순 기준 목록)를 현재 설정에 맞는 순서로 돌려준다. */
  apply(base, odeOrder) {
    if (State.symbolOrder !== 'ode' || !Array.isArray(odeOrder) || odeOrder.length === 0) {
      return [...base].sort((a, b) => a.localeCompare(b));
    }
    // ODE 순서에 있는 것 먼저, 빠진 것은 알파벳순으로 뒤에 붙인다.
    const inOde = odeOrder.filter(x => base.includes(x));
    const rest = base.filter(x => !inOde.includes(x)).sort((a, b) => a.localeCompare(b));
    return [...inOde, ...rest];
  },

  compartments() { return this.apply(State.compartments, State.compartmentsOdeOrder); },
  parameters()   { return this.apply(State.parameters,   State.parametersOdeOrder); },
};


/** ----- DOM 구획 ----- **/
const DOM = {
  // --- 사이드바 (Sidebar) ---
  sidebar: {
    odeInput: document.getElementById("ode-input"),
    parseBtn: document.getElementById("parse-btn"),
    editSymbolsBtn: document.getElementById("edit-symbols-btn"),
    showProcessedBtn: document.getElementById("show-processed-btn"),
    initValuesContainer: document.getElementById("init-values"),
    paramValuesContainer: document.getElementById("param-values"),
    symbolOrderRadios: document.querySelectorAll('input[name="symbolOrder"]'),
    derivedValuesContainer: document.getElementById("derived-values"),
    doseForm: document.getElementById("dose-form"),
    doseListContainer: document.getElementById("dose-list"),
    doseTypeSelect: document.getElementById("type"),
    doseDurationLabel: document.getElementById("duration-label"),
  },

  // --- 메인 콘텐츠 (Main Content) ---
  toolbar: {
    simStartTime: document.getElementById("sim-start-time"),
    simEndTime: document.getElementById("sim-end-time"),
    logScaleCheckbox: document.getElementById("log-scale"),
    openObsDataBtn: document.querySelector("button[data-bs-target='#obsPanel']"),
    fitBtn: document.getElementById("fit-btn"),
    simulateBtn: document.getElementById("simulate-btn"),
  },
  
  simulation: {
    compartmentsMenu: document.getElementById("sim-compartments-menu"),
    selectedCompBadges: document.getElementById("selected-comp-badges"),
  },

  results: {
    plotContainer: document.getElementById("plot"),
    plotPlaceholder: document.getElementById("plot-placeholder"),
    pkSummaryContainer: document.getElementById("pk-summary"),
    pkSummaryPlaceholder: document.getElementById("pk-summary-placeholder"),
    fitSummaryCard: document.getElementById("fit-summary-card"),
    fitSummaryContainer: document.getElementById("fit-summary"),
    exportProfileBtn: document.getElementById("export-profile-btn"),
    exportSummaryBtn: document.getElementById("export-summary-btn"),
    exportPlotBtn: document.getElementById("export-plot-btn"),
    importSessionInput: document.getElementById("import-session-input"),
    exportSessionBtn: document.getElementById("export-session-btn"),
  },

  // --- 모달 (Modals) & 오프캔버스 (Offcanvas) ---
  modals: {
    editSymbols: {
      element: document.getElementById("editSymbolsModal"),
      compartmentsList: document.getElementById("modal-compartments-list"),
      parametersList: document.getElementById("modal-parameters-list"),
      saveBtn: document.getElementById("save-symbol-changes-btn"),
    },
    processedOde: {
      element: document.getElementById("processedModal"),
      body: document.getElementById("modal-body"),
    },
    fittingSettings: {
      element: document.getElementById('fittingSettingsModal'),
      paramList: document.getElementById('modal-param-list'),
      // 파라미터 체크박스는 #modal-param-table-body(테이블)에 렌더링되고,
      // 테이블이 없을 때만 #modal-param-list 로 폴백된다.
      // 체크 상태를 조회할 때는 두 경우를 모두 포함하는 섹션 전체를 기준으로 해야 한다.
      paramSelectionScope: document.getElementById('fit-param-selection-section')
                        || document.getElementById('fittingSettingsModal'),
      paramBoundsList: document.getElementById('modal-param-bounds-list'),
      fetchInitialParamsBtn: document.getElementById("fetch-initial-params-btn"),
      groupsContainer: document.getElementById('fitting-groups-container'),
      addGroupBtn: document.getElementById('add-fitting-group-btn'),
      startBtn: document.getElementById('start-fitting-btn'),
      progressSection: document.getElementById('fit-progress-section'),
      progressMsg: document.getElementById("fit-msg-modal"),
      progressElapsed: document.getElementById("fit-elapsed-modal"),
      progressBar: document.querySelector("#fit-progress-bar-modal .progress-bar"),
      progressConsole: document.getElementById("fit-console-output-modal"),
      progressResult: document.getElementById("fit-result-modal"),
    },
    obsData: {
      panel: document.getElementById("obsPanel"),
      fileInput: document.getElementById("obs-file"),
      list: document.getElementById("obs-list"),
      preview: document.getElementById("obs-preview"),
    }
  }
};

/** ----- API 구획 ----- **/
function getCSRFToken() {
  const csrfTokenEl = document.querySelector('input[name="csrfmiddlewaretoken"]');
  if (csrfTokenEl) return csrfTokenEl.value;
  // 쿠키에서 CSRF 토큰을 찾는 대체 로직 (기존 코드와 동일)
  const cookies = document.cookie.split('; ');
  for (const cookie of cookies) {
    const [name, value] = cookie.split('=');
    if (name === 'csrftoken') return value;
  }
  return '';
}

const API = {
  /**
   * 모든 fetch 요청을 위한 비공개 래퍼 함수.
   * @param {string} url - 요청을 보낼 엔드포인트 URL
   * @param {object} body - POST 요청의 본문에 포함될 JavaScript 객체
   * @returns {Promise<object>} - 성공 시 서버로부터 받은 JSON 데이터
   * @throws {Error} - 네트워크 오류 또는 서버 에러 발생 시
   */
  async _fetchWrapper(url, body) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRFToken": getCSRFToken(),
        },
        body: JSON.stringify(body),
      });

      const responseData = await response.json();

      if (!response.ok) {
        // 서버가 에러 메시지를 포함하여 응답했을 경우, 해당 메시지를 에러에 담아 전달
        throw new Error(responseData.message || `Server error: ${response.status}`);
      }
      
      return responseData;

    } catch (error) {
      console.error(`API Error fetching ${url}:`, error);
      // 핸들러에서 에러를 인지할 수 있도록 다시 던져줍니다.
      throw error; 
    }
  },

  /**
   * ODE 텍스트를 서버로 보내 파싱을 요청합니다.
   * @param {string} odeText - 사용자가 입력한 ODE 텍스트
   * @returns {Promise<object>} - 파싱 결과 데이터
   */
  parseODE(odeText) {
    return this._fetchWrapper("/parse/", { text: odeText });
  },

  /**
   * 시뮬레이션에 필요한 모든 데이터를 서버로 보내 실행을 요청합니다.
   * @param {object} payload - 시뮬레이션 파라미터, 초기값, 투여 계획 등을 담은 객체
   * @returns {Promise<object>} - 시뮬레이션 결과 데이터
   */
  simulate(payload) {
    return this._fetchWrapper("/simulate/", payload);
  },
  
  /**
   * 파라미터 피팅에 필요한 모든 데이터를 서버로 보내 실행을 요청합니다.
   * @param {object} payload - 피팅 파라미터, 그룹, 경계값 등을 담은 객체
   * @returns {Promise<object>} - 피팅 결과 데이터
   */
  fit(payload) {
    return this._fetchWrapper("/fit/", payload);
  }
};

/** ----- UI 구획 ----- **/
/**
 * PK 요약 테이블의 컬럼 구성을 정의하는 설정 객체.
 * 이 배열의 순서대로 테이블이 그려집니다.
 * 새로운 파라미터를 추가하려면 이 배열에 객체 하나만 추가하면 됩니다.
 */
/** 속성값 안에 넣어도 안전하도록 따옴표와 꺾쇠를 이스케이프한다. */
function escapeAttr(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/* 단회 투여일 때 보여 주는 열. */
const PK_TABLE_SINGLE = [
  {
    key: 'c_max', displayName: 'C<sub>max</sub>',
    definition: 'Highest observed concentration.',
    formula: 'max(C) — taken as observed, not interpolated',
  },
  {
    key: 't_max', displayName: 'T<sub>max</sub>',
    definition: 'Time at which Cmax occurs. Ties resolve to the earlier time.',
    formula: 't where C = Cmax',
  },
  {
    key: 'half_life', displayName: 't<sub>½</sub>',
    definition: 'Terminal half-life, from the slope of the terminal log-linear phase. The points used are chosen automatically by best adjusted R² after Tmax.',
    formula: 'ln 2 / λz',
  },
  {
    key: 'auc_last', displayName: 'AUC<sub>0–last</sub>',
    definition: 'Area under the curve up to the last measurable concentration. Simulated curves are integrated directly; observed data uses linear-up / log-down trapezoids.',
    formula: '∫ C dt from 0 to Tlast',
  },
  {
    key: 'auc_inf_obs', displayName: 'AUC<sub>0–∞</sub>',
    definition: 'AUC extrapolated to infinity using the terminal slope and the last observed concentration.',
    formula: 'AUC(0–last) + Clast / λz',
  },
  {
    key: 'auc_extrap_pct', displayName: '%Extrap',
    definition: 'Share of AUC(0–∞) that comes from extrapolation. Above 20% the estimate leans heavily on the terminal slope.',
    formula: '(AUC∞ − AUClast) / AUC∞ × 100',
  },
  {
    key: 'cl', displayName: 'CL',
    definition: 'Clearance. Reported as CL/F when the dose does not enter the observed compartment directly. Left blank for amounts, since dividing a dose by the AUC of an amount is not a clearance.',
    formula: 'Dose / AUC(0–∞)',
  },
  {
    key: 'vz', displayName: 'V<sub>z</sub>',
    definition: 'Volume of distribution during the terminal phase. Reported as Vz/F for extravascular dosing.',
    formula: 'Dose / (λz · AUC(0–∞))',
  },
];


/* 반복 투여일 때 보여 주는 열.
 *
 * 단회 지표는 여기서 뜻을 잃는다 — 톱니 곡선 전체를 적분한 값은 노출량이
 * 아니라 시뮬레이션을 얼마나 오래 돌렸는지이고, Tmax 는 마지막 투여의
 * 봉우리일 뿐이다. 그래서 열을 통째로 바꾼다. 한 투여 간격을 보고, 그
 * 간격이 되풀이된다고 읽는다. */
const PK_TABLE_STEADY = [
  {
    key: 'ss_c_max', displayName: 'C<sub>max,ss</sub>',
    definition: 'Highest concentration within the dosing interval.',
    formula: 'max(C) over one interval τ',
  },
  {
    key: 'ss_t_max', displayName: 'T<sub>max,ss</sub>',
    definition: 'Time of the peak, counted from the dose that starts the interval.',
    formula: 't at Cmax,ss − t at the dose',
  },
  {
    key: 'ss_c_min', displayName: 'C<sub>min,ss</sub>',
    definition: 'Lowest concentration within the interval. Before steady state it can fall earlier than the end of the interval, which is why it is reported separately from Ctrough.',
    formula: 'min(C) over one interval τ',
  },
  {
    key: 'ss_c_trough', displayName: 'C<sub>trough</sub>',
    definition: 'Concentration immediately before the next dose. At steady state this equals Cmin.',
    formula: 'C at the end of the interval',
  },
  {
    key: 'ss_c_avg', displayName: 'C<sub>avg</sub>',
    definition: 'Average concentration over the interval — the flat line with the same area under it.',
    formula: 'AUCτ / τ',
  },
  {
    key: 'ss_auc_tau', displayName: 'AUC<sub>τ</sub>',
    definition: 'Area under the curve across one dosing interval. At steady state this equals the whole AUC(0–∞) of a single dose, which is what makes it the exposure you compare against.',
    formula: '∫ C dt across one interval τ',
  },
  {
    key: 'ss_fluctuation_pct', displayName: '%Fluct',
    definition: 'How far the concentration swings across the interval, relative to its average. Large values mean deep troughs and high peaks between doses.',
    formula: '(Cmax,ss − Cmin,ss) / Cavg × 100',
  },
  {
    key: 'ss_accumulation_auc', displayName: 'R<sub>acc</sub>',
    definition: 'How much exposure builds up by steady state, against the first interval. For an IV bolus this is 1/(1 − e^(−λz·τ)); with absorption it comes out higher, because absorption pushes exposure out of the first interval.',
    formula: 'AUCτ at steady state / AUCτ of the first interval',
  },
  {
    key: 'ss_cl', displayName: 'CL<sub>ss</sub>',
    definition: 'Clearance at steady state. Reported as CL/F when the dose does not enter the observed compartment directly.',
    formula: 'Dose / AUCτ',
  },
  {
    key: 'ss_vz', displayName: 'V<sub>z,ss</sub>',
    definition: 'Volume of distribution during the terminal phase, from the steady-state interval.',
    formula: 'Dose / (λz · AUCτ)',
  },
  {
    key: 'half_life', displayName: 't<sub>½</sub>',
    definition: 'Terminal half-life, from the log-linear decline after the last dose.',
    formula: 'ln 2 / λz',
  },
];


const UI = {
  // --- 공용 및 일반 UI ---

  /**
   * 버튼의 로딩 상태를 설정합니다.
   * @param {HTMLElement} button - 대상 버튼 요소
   * @param {boolean} isLoading - 로딩 상태 여부
   */
  setLoading(button, isLoading) {
    if (!button) return;
    if (isLoading) {
      button.dataset.originalText = button.innerHTML;
      button.innerHTML = `<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> Running...`;
      button.disabled = true;
    } else {
      button.innerHTML = button.dataset.originalText || 'Run Simulation';
      button.disabled = false;
    }
  },

  /**
   * 선택된 시뮬레이션 구획 뱃지를 업데이트합니다.
   */
  updateSelectedBadges() {
    const container = DOM.simulation.selectedCompBadges;
    if (!container) return;
    const checkedCheckboxes = [...DOM.simulation.compartmentsMenu.querySelectorAll(".sim-comp-checkbox:checked")];
    if (State.compartments.length > 0) {
      container.innerHTML = checkedCheckboxes.length > 0
        ? checkedCheckboxes.map(cb => `<span class="badge text-bg-secondary me-1">${cb.value}</span>`).join("")
        : `<span class="placeholder-badge-area">No compartments selected.</span>`;
    } else {
      container.innerHTML = `<span class="placeholder-badge-area">Parse ODEs to select compartments.</span>`;
    }
  },

  /**
   * 파싱된 심볼(구획, 파라미터)에 대한 입력 필드와 메뉴를 렌더링합니다.
   */
  renderSymbolInputs() {
    const { derivedExpressions } = State;
    // 표시 순서만 바꾼 목록 (계산용 State 배열은 그대로 둔다)
    const compartments = SymbolOrder.compartments();
    const parameters = SymbolOrder.parameters();
    const { initValuesContainer, paramValuesContainer, derivedValuesContainer, doseForm } = DOM.sidebar;
    const { compartmentsMenu } = DOM.simulation;
    const compartmentSelect = doseForm.querySelector('#compartment');

    initValuesContainer.innerHTML = "";
    paramValuesContainer.innerHTML = "";
    derivedValuesContainer.innerHTML = "";
    compartmentSelect.innerHTML = "";
    compartmentsMenu.innerHTML = ""; // [추가] 메뉴 초기화

    if (compartments.length > 0 || Object.keys(derivedExpressions).length > 0) {
      // 초기값 필드 생성 (기본 Compartment에 대해서만)
      if (compartments.length > 0) {
        initValuesContainer.innerHTML = compartments.map(c => `
          <div class="d-flex align-items-center mb-2">
            <label for="init_${c}" class="form-label mb-0 me-2 text-end" style="width:70px;">${c}(0):</label>
            <input type="number" step="any" value="0" id="init_${c}" name="init_${c}" class="form-control form-control-sm">
          </div>`).join("");
      } else {
        initValuesContainer.innerHTML = `<div class="placeholder-text">No base compartments defined.</div>`;
      }
      
      // 투여(Dosing) 구획 드롭다운 채우기 (<optgroup> 사용)
      const baseCompOptions = compartments.map(c => `<option value="${c}">${c}</option>`).join('');
      // const derivedParamOptions = Object.keys(derivedExpressions).map(p => `<option value="${p}" style="font-style: italic;">${p}</option>`).join('');

      compartmentSelect.innerHTML = compartments.length > 0 
          ? `<optgroup label="Compartments">${baseCompOptions}</optgroup>`
          : `<option value="" disabled selected>No compartments defined</option>`;

      // 시뮬레이션 구획 선택 메뉴(체크박스) 렌더링
      const plottableVariables = [...compartments, ...Object.keys(derivedExpressions)];
      compartmentsMenu.innerHTML = plottableVariables.map(variable => `
        <li>
          <label class="dropdown-item py-1">
            <input type="checkbox" class="form-check-input me-2 sim-comp-checkbox" value="${variable}" checked>
            ${variable}
          </label>
        </li>`).join("");

    } else {
      initValuesContainer.innerHTML = `<div class="placeholder-text">Parse ODEs to set initial values.</div>`;
      compartmentsMenu.innerHTML = `<li><span class="dropdown-item-text">N/A</span></li>`;
      compartmentSelect.innerHTML = `<option value="" disabled selected>Parse ODEs first</option>`;
    }

    // 파라미터 필드 생성
    if (parameters.length > 0) {
      paramValuesContainer.innerHTML = parameters.map(p => `
        <div class="d-flex align-items-center mb-2">
          <label for="param_${p}" class="form-label mb-0 me-2 text-end" style="width:70px;">${p}:</label>
          <input type="number" step="any" value="0.1" id="param_${p}" name="param_${p}" class="form-control form-control-sm">
        </div>`).join("");
    } else {
      paramValuesContainer.innerHTML = `<div class="placeholder-text">Parse ODEs to set parameters.</div>`;
    }
   
    // 파생 변수(derived expressions) 렌더링
    const derivedEntries = Object.entries(derivedExpressions);
    
    if (derivedEntries.length > 0) {
        derivedValuesContainer.innerHTML = derivedEntries.map(([key, expr]) => `
            <div class="derived-box">
                <i class="bi bi-calculator me-1"></i>
                <strong>${key}</strong> = ${expr.replace(/</g, "&lt;").replace(/>/g, "&gt;")}
            </div>
        `).join("");
    } else {
        derivedValuesContainer.innerHTML = `<div class="placeholder-text small">No derived variables found.</div>`;
    }

    // 뱃지 UI도 함께 업데이트
    UI.updateSelectedBadges();
  },

  /**
   * 심볼 역할 편집 모달의 내용을 렌더링합니다.
   * @param {string[]} compartments - 현재 Compartment 목록
   * @param {string[]} parameters - 현재 Parameter 목록
   */
  renderSymbolEditorModal(compartments, parameters) {
    const { compartmentsList, parametersList } = DOM.modals.editSymbols;

    compartmentsList.innerHTML = compartments.map(c => `
      <div class="symbol-list-item">
        <span>${c}</span>
        <button class="btn btn-light btn-sm move-symbol-btn" data-symbol="${c}" data-direction="toParam" title="Move to Parameters">&gt;</button>
      </div>
    `).join('');

    parametersList.innerHTML = parameters.map(p => `
      <div class="symbol-list-item">
        <button class="btn btn-light btn-sm move-symbol-btn" data-symbol="${p}" data-direction="toComp" title="Move to Compartments">&lt;</button>
        <span>${p}</span>
      </div>
    `).join('');
  },

  /**
   * 파싱된 ODE 정보를 보여주는 모달을 띄웁니다.
   */
  showProcessedModal() {
    const modal = DOM.modals.processedOde;
    if (!modal || !modal.body) return;

    const compHTML = State.compartments.length > 0
      ? State.compartments.map(c => `<span class="badge text-bg-primary me-1">${c}</span>`).join("")
      : `<span class="text-muted small">No compartments defined.</span>`;

    const paramHTML = State.parameters.length > 0
      ? State.parameters.map(p => `<span class="badge text-bg-secondary me-1">${p}</span>`).join("")
      : `<span class="text-muted small">No parameters defined.</span>`;

    const odeHTML = State.processedODE
      ? `<pre class="bg-light p-2 rounded small border">${State.processedODE.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>`
      : `<span class="text-muted small">ODEs not parsed.</span>`;

    modal.body.innerHTML = `
      <h6 class="mb-1"><i class="bi bi-box-seam me-1"></i> Compartments</h6>
      <div class="mb-3 p-2 bg-light border rounded small">${compHTML}</div>
      <h6 class="mb-1"><i class="bi bi-sliders me-1"></i> Parameters</h6>
      <div class="mb-3 p-2 bg-light border rounded small">${paramHTML}</div>
      <h6 class="mb-1"><i class="bi bi-file-earmark-code me-1"></i> Processed ODEs</h6>
      ${odeHTML}`;

    // Bootstrap 모달 인스턴스를 가져오거나 생성하여 보여줍니다.
    const modalInstance = bootstrap.Modal.getOrCreateInstance(modal.element);
    modalInstance.show();
  },

  // --- 투여 (Dosing) 관련 UI ---

  /**
   * 등록된 투여 목록을 간결한 뱃지 형태로 렌더링합니다.
   */
  renderDoses() {
    const container = DOM.sidebar.doseListContainer;
    if (!container) return;
    
    if (State.doseList.length === 0) {
      container.innerHTML = `<div class="placeholder-text small">No doses registered yet.</div>`;
      return;
    }

    container.innerHTML = State.doseList.map((d, i) => {
      // 한 줄로 읽히도록 "무엇을 / 어디에 / 언제" 순서로 적는다.
      //   Bolus       250 into Ag at 0
      //   Zero-order  300 into A1 over 1, starting at 0
      //
      // 시간 단위는 적지 않는다. 시간의 단위는 사용자가 세운 ODE 의
      // 파라미터가 정하는 것이라 앱이 시간이라고 단정할 수 없다.
      //
      // 태그는 투여 경로가 아니라 입력 방식이다. 어느 구획에 넣느냐는
      // Compartment 가 정하므로, 여기서 IV 를 단정하면 안 된다.
      const isInfusion = d.type === 'infusion' && d.duration > 0;
      const typeLabel = isInfusion ? 'Zero-order' : 'Bolus';

      let summaryText = isInfusion
        ? `<strong>${d.amount}</strong> into <strong>${d.compartment}</strong> over ${d.duration}, starting at ${d.start_time}`
        : `<strong>${d.amount}</strong> into <strong>${d.compartment}</strong> at ${d.start_time}`;

      // 반복 일정은 둘째 줄로 내린다 (CSS 에서 block 처리)
      if (d.repeat_every && d.repeat_until) {
        summaryText += `<span class="dose-repeat">Repeats every ${d.repeat_every} until ${d.repeat_until}</span>`;
      }

      return `
        <div class="dose-badge">
          <span class="dose-type">${typeLabel}</span>
          <span class="dose-summary">${summaryText}</span>
          <button class="btn-close btn-sm remove-dose-btn" data-index="${i}" title="Remove dose" aria-label="Remove dose"></button>
        </div>
      `;
    }).join("");
  },
  
  // --- 관찰 데이터 (Offcanvas) 관련 UI ---

  /**
   * 업로드된 관측 데이터 목록을 렌더링합니다.
   */
  renderObsList() {
    const { list } = DOM.modals.obsData;
    if (!list) return;

    if (State.observations.length === 0) {
      list.innerHTML = `<div class="placeholder-text small">Upload observed data files (.csv).</div>`;
      document.getElementById('obs-detail-view').innerHTML = ''; // 상세 보기 영역도 비움
      return;
    }

    list.innerHTML = State.observations.map((o, i) => `
      <a href="#" class="list-group-item list-group-item-action obs-item ${o.selected ? 'active' : ''}" data-index="${i}">
        <div class="d-flex w-100 justify-content-between">
          <h6 class="mb-1 small"><span style="color:${o.color};">●</span> ${o.name}</h6>
        </div>
        <small class="text-muted">${Object.keys(o.data).length - 1} data columns.</small>
      </a>`).join("");

    // 첫 번째 아이템 또는 선택된 아이템의 상세 뷰를 렌더링
    const selectedIndex = State.observations.findIndex(o => o.selected);
    this.renderObsDetailView(selectedIndex !== -1 ? selectedIndex : 0);
  },

  /**
   * 특정 관측 데이터의 상세 보기(미리보기, 매핑) UI를 렌더링합니다.
   * @param {number} index - State.observations 배열의 인덱스
   */
  renderObsDetailView(index) {
    const detailContainer = document.getElementById('obs-detail-view');
    if (index === -1 || !State.observations[index] || !detailContainer) {
      detailContainer.innerHTML = '';
      return;
    }

    // 1. 상태 업데이트: 선택된 항목(selected) 플래그를 관리합니다.
    State.observations.forEach((obs, i) => obs.selected = (i === index));

    // UI 업데이트
    const { list } = DOM.modals.obsData;
    list.querySelectorAll('.obs-item').forEach((item, i) => {
      if (i === index) {
        item.classList.add('active');
      } else {
        item.classList.remove('active');
      }
    });

    const obsData = State.observations[index];
    const { name, data, mappings } = obsData;
    const dataColumns = Object.keys(data).filter(col => col.toLowerCase() !== 'time');
    const modelVariables = [...State.compartments, ...Object.keys(State.derivedExpressions)];

    // 2. 자동 매핑 로직: 데이터 컬럼 이름과 모델 변수 이름이 일치하면 자동으로 매핑
    dataColumns.forEach(col => {
      if (!mappings[col] && modelVariables.includes(col)) {
        mappings[col] = col;
      }
    });

    // 3. HTML 생성
    const modelOptionsHTML = modelVariables.map(v => `<option value="${v}">${v}</option>`).join('');
    const mappingHTML = dataColumns.map(col => `
      <div class="row g-2 mb-2 align-items-center">
        <div class="col-5"><input type="text" class="form-control form-control-sm" value="${col}" readonly disabled></div>
        <div class="col-2 text-center"><i class="bi bi-arrow-left-right"></i></div>
        <div class="col-5">
          <select class="form-select form-select-sm mapping-select" data-obs-index="${index}" data-column-name="${col}">
            <option value="">-- Map to --</option>
            ${modelOptionsHTML.replace(`value="${mappings[col]}"`, `value="${mappings[col]}" selected`)}
          </select>
        </div>
      </div>
    `).join('');

    const previewHTML = this._createPreviewHTML(name, data); // 미리보기 HTML 생성은 헬퍼 함수로 분리

    detailContainer.innerHTML = `
      ${previewHTML}
      <hr>
      <h6><i class="bi bi-capsule"></i> Dose</h6>
      <p class="text-muted small">The dose this profile received. Clearance and volume need it; leave it blank and those are left out of the summary.</p>
      <input type="number" step="any" class="form-control form-control-sm obs-dose-input"
             data-obs-index="${index}" value="${obsData.dose ?? ''}" placeholder="e.g. 500">
      <hr>
      <h6><i class="bi bi-link-45deg"></i> Map Data to Model</h6>
      <p class="text-muted small">Connect columns from your data file to the variables defined in your ODE model.</p>
      ${mappingHTML || '<div class="placeholder-text small">No data columns to map.</div>'}
      <button class="btn btn-sm btn-outline-danger mt-3 remove-obs-btn" data-index="${index}"><i class="bi bi-trash"></i> Remove this Dataset</button>
    `;
  },

  /**
   * 데이터 미리보기 테이블 HTML을 생성하는 '비공개' 헬퍼 함수
   */
  _createPreviewHTML(name, data) {
    const cols = Object.keys(data);
    const n = Math.min(5, data.Time?.length || 0);
    const header = `<th>${cols.join("</th><th>")}</th>`;
    const bodyRows = Array.from({ length: n }, (_, i) => `<tr>${cols.map(c => `<td>${data[c][i] ?? '-'}</td>`).join("")}</tr>`).join("");

    let html = `<p class="small text-muted mb-1">Preview: <strong>${name}</strong></p>
                <div class="table-responsive" style="max-height: 180px;">
                  <table class='table table-sm table-bordered table-striped'><thead><tr>${header}</tr></thead><tbody>${bodyRows}</tbody></table>
                </div>`;
    if ((data.Time?.length || 0) > n) {
      html += `<p class="text-muted small text-center mt-1">Showing first ${n} of ${data.Time.length} rows...</p>`;
    }
    return html;
  },

  // --- 결과 (Results) 관련 UI ---

  /**
   * 시뮬레이션 결과를 Plotly 그래프로 그립니다.
   */
  plotSimulationResult(profileData, logYaxis) {
    const { plotContainer, plotPlaceholder } = DOM.results;
    if (!plotContainer || !profileData || !profileData.Time) return;

    const selectedCompartments = [...DOM.simulation.compartmentsMenu.querySelectorAll(".sim-comp-checkbox:checked")].map(e => e.value);
    const traces = [];
    const thresholdInput = document.getElementById('dropdown-sim-threshold').value || 1e-9;

    selectedCompartments.forEach(compName => {
      if (profileData[compName]) traces.push({ x: profileData.Time, y: maskLowValues(profileData[compName], thresholdInput), mode: "lines", name: compName });
    });

    State.observations.filter(o => o.selected).forEach(obs => {
      Object.keys(obs.data).forEach(key => {
        if (key.toLowerCase() !== "time") traces.push({ x: obs.data.Time, y: obs.data[key], mode: "markers", name: `${obs.name} - ${key}`, marker: { color: obs.color } });
      });
    });

    const layout = {
      xaxis: { title: "Time", zeroline: false, gridcolor: 'rgba(0,0,0,0.05)' },
      yaxis: {
          // 한 축에 구획 내 양(A1)과 농도(C1)가 함께 올라올 수 있으므로
          // 어느 한쪽으로 단정하지 않는다. 시간 축에 단위를 적지 않는 것과
          // 같은 이유다 — 무엇을 그리는지는 사용자의 ODE 가 정한다.
          title: "Value",
          type: logYaxis ? "log" : "linear",
          zeroline: false,
          gridcolor: 'rgba(0,0,0,0.05)',
          exponentformat: 'power',
      },
      legend: { orientation: "h", yanchor: "bottom", y: 1.02, xanchor: "right", x: 1 },
      margin: { l: 60, r: 20, b: 50, t: 20, pad: 4 },
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor: "rgba(0,0,0,0)",
      autosize: true,
    };
    
    // 그리기 전에 먼저 보여 준다. Plotly 는 그리는 순간의 컨테이너 폭을
    // 재는데 display:none 이면 0 을 재고 기본 폭으로 떨어진다. 뒤늦게
    // 보여 줘도 다시 재지 않으므로, 창을 흔들거나 두세 번 다시 그려야
    // 폭이 맞는 것처럼 보였다.
    plotPlaceholder.style.display = "none";
    plotContainer.style.display = "block";
    Plotly.react(plotContainer, traces, layout, { responsive: true });
  },

  /**
   * 인쇄 직전에 리포트 머리말을 채웁니다.
   *
   * 메뉴가 아니라 Ctrl+P 로 인쇄해도 채워져야 하므로 beforeprint 에 겁니다.
   * 무엇을 계산한 것인지 모르는 PDF 는 나중에 아무 쓸모가 없습니다.
   */
  fillReportHead() {
    const meta = document.getElementById('report-meta');
    const model = document.getElementById('report-model');

    if (meta) {
      const doses = State.doseList.map(d => {
        const how = d.type === 'infusion' ? `over ${d.duration}` : 'bolus';
        const rep = d.repeat_every ? `, every ${d.repeat_every} until ${d.repeat_until}` : '';
        return `${d.amount} into ${d.compartment} at ${d.start_time} (${how}${rep})`;
      });
      const params = State.parameters
        .map(p => `${p} = ${DOM.sidebar.paramValuesContainer.querySelector(`#param_${p}`)?.value}`)
        .join(',  ');
      meta.textContent = [
        new Date().toLocaleString(),
        `time ${DOM.toolbar.simStartTime.value}–${DOM.toolbar.simEndTime.value}`,
        doses.length ? `dosing: ${doses.join('; ')}` : 'no dosing',
        params ? `parameters: ${params}` : '',
      ].filter(Boolean).join('  ·  ');
    }

    const ode = DOM.sidebar.odeInput.value.trim();
    if (model) {
      model.textContent = ode;
      model.hidden = !ode;      // 빈 상자를 종이에 남기지 않는다
    }
  },

  /**
   * PK 파라미터 요약 정보를 테이블로 표시합니다.
   */
  displayPKSummary(pkData) {
      const { pkSummaryContainer, pkSummaryPlaceholder } = DOM.results;
      if (!pkSummaryContainer || !pkData) return;

      const dataArray = Array.isArray(pkData) ? pkData : Object.entries(pkData).map(([comp, metrics]) => ({ compartment: comp, ...metrics }));

      if (dataArray.length === 0) {
        pkSummaryContainer.innerHTML = `<div class="placeholder-text">No PK summary data.</div>`;
        return;
      }

      // 반복 투여 행과 단회 투여 행은 열 자체가 다르므로 한 표에 담을 수
      // 없다. 둘 다 있으면(시뮬레이션은 정상상태인데 실측은 단회인 경우)
      // 표를 나눠서 그린다. 한 종류뿐이면 표도 하나다.
      const steady = dataArray.filter(e => e.regimen === 'steady-state');
      const single = dataArray.filter(e => e.regimen !== 'steady-state');

      pkSummaryContainer.innerHTML =
        UI._pkTable(steady, PK_TABLE_STEADY, UI._steadyStateCaption(steady)) +
        UI._pkTable(single, PK_TABLE_SINGLE,
                    steady.length && single.length
                      ? '<p class="pk-regimen">Single dose — the rows below are not on the steady-state interval.</p>'
                      : '');

      pkSummaryPlaceholder.style.display = "none";
      pkSummaryContainer.style.display = "block";
  },

  /** 한 종류의 행들을 표 하나로 그린다. 행이 없으면 아무것도 그리지 않는다. */
  _pkTable(entries, columns, caption) {
    if (!entries.length) return '';

    // 헤더마다 정의와 식을 담은 정보 표시를 붙인다. 파라미터 이름만으로는
    // 무엇을 어떻게 계산했는지 알 수 없기 때문이다.
    const headers = ['<th>Variable</th>']
      .concat(columns.map(col => {
        if (!col.definition) return `<th>${col.displayName}</th>`;
        const tip = col.formula ? col.definition + '  —  ' + col.formula : col.definition;
        return `<th>${col.displayName}<button type="button" class="pk-info" tabindex="0"
                  aria-label="About ${col.key}" data-tip="${escapeAttr(tip)}">i</button></th>`;
      }))
      .join('');

    const rows = entries.map((entry) => {
      // 같은 표에 모델 곡선과 실측이 함께 오므로, 어느 쪽인지 한눈에 보이게 한다.
      const how = entry.direct_integration
        ? '<span class="pk-source is-model" title="Simulated curve — integrated directly, no NCA interpolation or extrapolation assumptions">model</span>'
        : '<span class="pk-source is-obs" title="Observed data — noncompartmental analysis (linear-up / log-down, terminal extrapolation)">NCA</span>';
      const warn = (entry.warnings && entry.warnings.length)
        ? `<span class="pk-warn" title="${escapeAttr(entry.warnings.join('; '))}">!</span>`
        : '';
      const compartmentCell = `<td class="pk-var">${entry.compartment || 'N/A'}${how}${warn}</td>`;

      const valueCells = columns.map(col => {
        const value = entry[col.key];
        const formattedValue = typeof value === 'number' ? value.toPrecision(4) : "-";
        return `<td>${formattedValue}</td>`;
      }).join('');

      return `<tr>${compartmentCell}${valueCells}</tr>`;
    }).join("");

    return `${caption || ''}
      <div class="table-responsive">
        <table class="table table-sm table-hover">
          <thead class="table-light">
            <tr>${headers}</tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  },

  /** 적합 결과가 있을 때만 'Apply to model' 을 누를 수 있게 한다.
   *  모달 안과 카드 위 두 곳에 같은 버튼이 있고, 하는 일도 같다. */
  syncApplyFitButton() {
    const ready = !!(State.lastFitResult && Array.isArray(State.lastFitResult.params));
    const btn = document.getElementById('fit-apply-modal-btn');
    if (btn) btn.disabled = !ready;
  },

  /** 어느 구간을 보고 있는지, 그리고 그 값을 믿어도 되는지 표 위에 밝힌다.
   *
   *  정상상태에 이르지 못했으면 그 사실이 숫자보다 중요하다. 경고 아이콘
   *  뒤에 숨기지 않고 표 위에 내놓는다. */
  _steadyStateCaption(entries) {
    if (!entries.length) return '';
    const e = entries[0];
    const fmt = v => (typeof v === 'number' ? +v.toPrecision(4) : '?');
    const n = e.ss_n_intervals;
    const where = `τ = ${fmt(e.ss_tau)}, measured over ${fmt(e.ss_interval_start)}–${fmt(e.ss_interval_end)}`
                + (n ? ` (${n === 1 ? 'the only' : 'the last of ' + n} complete interval${n === 1 ? '' : 's'})` : '');

    if (e.ss_at_steady_state === false) {
      const drift = typeof e.ss_interval_change_pct === 'number'
        ? e.ss_interval_change_pct.toFixed(1) : '?';
      return `<p class="pk-regimen is-warn">Repeated dosing, ${where} — <strong>not at steady state</strong>.
              AUC<sub>τ</sub> is still changing ${drift}% from one interval to the next, so these are
              a snapshot of a rising curve, not steady-state values.</p>`;
    }
    if (e.ss_at_steady_state === true) {
      return `<p class="pk-regimen">Steady state, ${where}. Every interval is the same, so these
              describe all of them.</p>`;
    }
    return `<p class="pk-regimen is-warn">Repeated dosing, ${where} — only one interval is available,
            so whether steady state was reached could not be checked. Simulate for longer.</p>`;
  },
  
  // --- 피팅 모달 (Fitting Modal) 관련 UI ---

  // Bootstrap 모달 인스턴스를 관리하기 위한 내부 변수
  _fittingModalInstance: null,

  /**
   * 피팅 설정 모달을 열고 내부 UI(파라미터 Scope, Error Model 등)를 초기화합니다.
   */
  openFittingSettingsModal() {
    // 1. 모달 인스턴스 준비
    if (!this._fittingModalInstance) {
      this._fittingModalInstance = new bootstrap.Modal(DOM.modals.fittingSettings.element);
    }

    // 2. 필수 데이터 확인 (ODEs 파싱 여부, 관측 데이터 유무)
    if (State.compartments.length === 0 || State.parameters.length === 0) {
      return alert("Please parse ODEs first to define parameters for fitting.");
    }
    if (State.observations.length === 0) {
      return alert("⚠️ Please upload at least one observed data file before starting a fit.");
    }

    // 3. 파라미터 테이블 렌더링 (체크박스 + Scope 라디오 버튼)
    // HTML 구조가 <table> 형태의 #modal-param-table-body를 가지고 있다고 가정합니다.
    const paramTableBody = document.getElementById('modal-param-table-body');
    
    if (paramTableBody) {
      paramTableBody.innerHTML = State.parameters.map(p_name => {
        // 메인 화면의 현재 파라미터 값 가져오기 (참고용)
        const mainInput = DOM.sidebar.paramValuesContainer.querySelector(`#param_${p_name}`);
        const currentValue = mainInput ? mainInput.value : 'N/A';

        return `
          <tr>
            <td class="align-middle text-center" style="width: 40px;">
              <input class="form-check-input modal-fit-param-cb" type="checkbox" value="${p_name}" id="cb_${p_name}">
            </td>
            <td class="align-middle">
              <label class="form-check-label mb-0 fw-bold" for="cb_${p_name}" style="cursor: pointer;">
                ${p_name}
              </label>
            </td>
            <td class="align-middle" style="width: 130px;">
              <input type="number" step="any" class="form-control form-control-sm modal-param-guess"
                     data-param-name="${p_name}" value="${currentValue}"
                     title="Starting point for the optimiser. Changing it here does not touch the model in the sidebar.">
            </td>
            <td class="align-middle">
              <div class="btn-group btn-group-sm" role="group" aria-label="Parameter Scope">
                <input type="radio" class="btn-check param-scope-radio" name="scope_${p_name}" id="scope_${p_name}_g" value="shared" checked disabled>
                <label class="btn btn-outline-secondary" for="scope_${p_name}_g" title="One value that every group shares">Shared</label>

                <input type="radio" class="btn-check param-scope-radio" name="scope_${p_name}" id="scope_${p_name}_l" value="per_group" disabled>
                <label class="btn btn-outline-secondary" for="scope_${p_name}_l" title="A separate value estimated for each group">Per group</label>
              </div>
            </td>
          </tr>
        `;
      }).join('');

      // 이벤트 위임: 체크박스 변경 시 Scope 라디오 버튼 활성화/비활성화 처리
      paramTableBody.onchange = (e) => {
        if (e.target.classList.contains('modal-fit-param-cb')) {
          const pName = e.target.value;
          const isChecked = e.target.checked;
          
          // 해당 파라미터의 Scope 라디오 버튼들 활성화/비활성화
          const scopeRadios = document.querySelectorAll(`input[name="scope_${pName}"]`);
          scopeRadios.forEach(r => r.disabled = !isChecked);

          // Bounds UI 업데이트 (선택된 파라미터가 변경되었으므로)
          this.renderFitParamBoundsUI();
        }
      };

    } else {
      // (Fallback) 만약 HTML이 업데이트되지 않아 테이블 바디를 찾을 수 없는 경우
      console.warn("Element #modal-param-table-body not found. Falling back to simple list.");
      DOM.modals.fittingSettings.paramList.innerHTML = State.parameters.map(p => 
        `<div class="form-check">
           <input class="form-check-input modal-fit-param-cb" type="checkbox" value="${p}" id="modal_fit_${p}">
           <label class="form-check-label" for="modal_fit_${p}">${p}</label>
         </div>`
      ).join('');
    }

    // 4. 피팅 그룹 초기화
    DOM.modals.fittingSettings.groupsContainer.innerHTML = '';
    State.fittingGroupCounter = 0; 
    this.addFittingGroup();

    // 5. Bounds UI 초기화 (아무것도 선택되지 않은 상태로 시작)
    this.renderFitParamBoundsUI();

    // 6. Objective 초기화 (기본값: 최대가능도 + Additive)
    const defaultObjective = document.getElementById('objMle');
    if (defaultObjective) defaultObjective.checked = true;
    const defaultErrModel = document.getElementById('errConst');
    if (defaultErrModel) defaultErrModel.checked = true;
    const defaultWeighting = document.getElementById('weightNone');
    if (defaultWeighting) defaultWeighting.checked = true;
    this.applyFitObjective();

    // 7. 진행 상태 섹션 숨기기 및 버튼 초기화
    const { progressSection, startBtn } = DOM.modals.fittingSettings;
    if (progressSection) progressSection.style.display = 'none';
    if (startBtn) {
      startBtn.disabled = false;
      startBtn.innerHTML = '<i class="bi bi-play-circle"></i> Start Fitting';
    }

    // 8. 이전 결과가 남아 있으면 Apply 를 켠 채로 연다.
    this.syncApplyFitButton();

    // 9. 모달 표시
    this._fittingModalInstance.show();
  },

  /**
   * 고른 목적함수의 설정만 보여 줍니다.
   * 두 방식이 모두 잔차 가중을 정하므로, 안 쓰는 쪽을 남겨 두면
   * 고르지 않은 설정이 적용된 것처럼 읽힙니다.
   */
  applyFitObjective() {
    const checked = document.querySelector('input[name="fitObjective"]:checked');
    const objective = checked ? checked.value : 'mle';
    document.querySelectorAll('#fit-objective-section [data-fit-objective]').forEach(el => {
      el.hidden = el.dataset.fitObjective !== objective;
    });
  },

  /**
   * 피팅 실험 그룹을 UI에 추가합니다.
   */
  addFittingGroup() {
    const container = DOM.modals.fittingSettings.groupsContainer;
    if (!container) return;
    // 헬퍼 함수를 호출하여 그룹 카드 HTML을 생성하고 추가
    const newGroupHTML = this._createFittingGroupHTML(State.fittingGroupCounter);
    container.insertAdjacentHTML('beforeend', newGroupHTML);
    State.fittingGroupCounter++; // State의 카운터 증가
  },

  /**
   * 피팅 그룹 카드 하나의 HTML 문자열을 생성하는 '비공개' 헬퍼 함수.
   * @param {number} groupId - 생성할 그룹의 ID
   * @returns {string} - 그룹 카드 HTML 문자열
   */
  _createFittingGroupHTML(groupId) {
    // State에서 관찰 데이터와 구획 목록을 가져와 드롭다운 옵션 생성
    const observedDataOptions = State.observations.map((obs, index) => 
      `<option value="${index}">${obs.name}</option>`
    ).join('');

    const compartmentOptions = State.compartments.map(c => `<option value="${c}">${c}</option>`).join('');

    // 템플릿 리터럴(백틱)을 사용하여 가독성 좋게 HTML 작성
    return `
      <div class="card mb-3 fitting-group-card" id="fitting-group-${groupId}" data-group-id="${groupId}">
        <div class="card-body">
          <div class="d-flex justify-content-between align-items-center mb-2">
            <h6 class="card-title mb-0">Group ${groupId + 1}</h6>
            <button type="button" class="btn-close remove-fitting-group-btn" title="Remove Group"></button>
          </div>
          
          <div class="row g-3">
            <div class="col-md-12">
              <label class="form-label small">Observed Data</label>
              <select class="form-select form-select-sm group-obs-select" required>
                ${observedDataOptions 
                  ? `<option value="" selected disabled>Select observed data...</option>${observedDataOptions}` 
                  : `<option value="" selected disabled>No observed data uploaded</option>`
                }
              </select>
            </div>
            
            <div class="col-md-6">
              <label class="form-label small">Dose Compartment</label>
              <select class="form-select form-select-sm group-dose-comp">
                ${compartmentOptions || `<option value="" selected disabled>Parse ODEs first</option>`}
              </select>
            </div>
            <div class="col-md-6">
              <label class="form-label small">Input</label>
              <select class="form-select form-select-sm group-dose-type"
                      title="How the amount enters the selected compartment. This is not a route of administration.">
                <option value="bolus">Bolus</option>
                <option value="infusion">Zero-order (Infusion)</option>
              </select>
            </div>
            <div class="col-md-4">
              <label class="form-label small">Amount</label>
              <input type="number" step="any" class="form-control form-control-sm group-dose-amount" placeholder="e.g., 100" required>
              <div class="group-dose-hint" hidden></div>
            </div>
            <div class="col-md-4">
              <label class="form-label small">Start Time</label>
              <input type="number" step="any" class="form-control form-control-sm group-dose-time" value="0" required>
            </div>
            <div class="col-md-4 group-duration-field" style="display:none;">
              <label class="form-label small">Duration</label>
              <input type="number" step="any" class="form-control form-control-sm group-dose-duration" placeholder="e.g., 1">
            </div>
          </div>

          <div class="form-check form-switch mt-3 mb-0">
            <input class="form-check-input group-repeat-toggle" type="checkbox" id="group-repeat-${groupId}">
            <label class="form-check-label small" for="group-repeat-${groupId}">Set up repeat dosing</label>
          </div>
          <div class="row g-3 mt-0 group-repeat-fields" style="display:none;">
            <div class="col-md-6">
              <label class="form-label small">Repeat every</label>
              <input type="number" step="any" class="form-control form-control-sm group-dose-repeat-every">
            </div>
            <div class="col-md-6">
              <label class="form-label small">Repeat until</label>
              <input type="number" step="any" class="form-control form-control-sm group-dose-repeat-until">
            </div>
          </div>

          <div class="mt-3 mapping-container" style="display: none;">
            <h6 class="subsection-title small mt-0 pt-0 border-0">Map Data Columns to Model Variables:</h6>
            <div class="mapping-rows">
              {/* This area will be populated by renderMappingUI */}
            </div>
          </div>
          
        </div>
      </div>
    `;
  },

  /**
   * 선택된 피팅 파라미터에 대한 경계값(Bounds) 입력 UI를 렌더링합니다.
   */
  renderFitParamBoundsUI() {
    const { paramBoundsList, paramSelectionScope, fetchInitialParamsBtn } = DOM.modals.fittingSettings;
    const checkedParams = paramSelectionScope.querySelectorAll('.modal-fit-param-cb:checked');

    // 1. 선택된 파라미터가 없으면 버튼을 숨기고 placeholder를 표시합니다.
    if (checkedParams.length === 0) {
      fetchInitialParamsBtn.style.display = 'none'; // 버튼 숨기기
      paramBoundsList.innerHTML = '<div class="placeholder-text small" style="border:none;background:none;min-height:40px;">Select parameters to set bounds.</div>';
      return;
    }

    // 2. 선택된 파라미터가 있으면 버튼을 보여줍니다.
    fetchInitialParamsBtn.style.display = 'block';

    // 3. 각 선택된 파라미터에 대한 입력 필드 HTML을 생성합니다.
    const boundsInputsHTML = Array.from(checkedParams).map(cb => {
      const paramName = cb.value;
      return `
        <div class="row g-2 mb-2 align-items-center">
          <div class="col-md-3">
            <label class="form-label mb-0 small" for="lower_bound_${paramName}">${paramName}:</label>
          </div>
          <div class="col-md-4">
            <input type="number" step="any" class="form-control form-control-sm modal-param-lower" data-param-name="${paramName}" placeholder="Lower Bound" id="lower_bound_${paramName}">
          </div>
          <div class="col-md-1 text-center text-muted">-</div>
          <div class="col-md-4">
            <input type="number" step="any" class="form-control form-control-sm modal-param-upper" data-param-name="${paramName}" placeholder="Upper Bound">
          </div>
        </div>`;
    }).join('');
    
    // 4. 입력 필드 영역만 업데이트합니다.
    paramBoundsList.innerHTML = boundsInputsHTML;
  },

  /**
   * 메인 페이지의 파라미터 입력 필드 값을 업데이트합니다.
   * @param {list} params - { 파라미터이름: 값 } 형태의 객체
   */
  /**
   * 적합값을 사이드바 모델로 옮깁니다.
   *
   * 예전에는 피팅이 끝나면 이 일이 저절로 일어났습니다. 이제는 카드의
   * 'Apply to model' 을 눌러야 합니다 — 피팅은 모델을 바꾸지 않고,
   * 바꾸는 것은 사용자의 선택입니다.
   */
  applyFittedParams(params) {
    params.forEach(p => {
      // 백엔드는 "ka (Shared)" / "V (Group 2)" 형태의 표시용 이름을 보낸다.
      // 사이드바 입력칸(#param_ka)에 반영할 수 있는 것은 공유 파라미터뿐이므로
      // base_name 을 쓰고, 그룹별 값이나 sigma 는 건너뛴다.
      if (p.scope && p.scope !== 'shared') return;
      const key = p.base_name || String(p.name).replace(/\s*\(.*\)\s*$/, '');
      if (!key) return;
      const inputEl = DOM.sidebar.paramValuesContainer.querySelector(`#param_${key}`);
      if (inputEl) {
        inputEl.value = Number(p.value).toPrecision(6);
      }
    });
  },

  /**
   * 메인 페이지에 피팅 결과 요약 카드를 렌더링합니다.
   * @param {object} params - 피팅된 파라미터 객체
   * @param {number} cost - 최종 SSR(잔차 제곱합) 값
   */
  /**
   * 피팅 결과를 자기 카드에 그립니다 — 설명, 관측점 위에 겹친 적합 곡선, 표.
   *
   * 사이드바를 건드리지 않으므로 메인 Profile 플롯은 계속 사이드바의 모델을
   * 그립니다. 어느 곡선이 무엇인지 헷갈릴 일이 없습니다.
   */
  renderFitResult(data, options) {
    State.lastFitResult = data;
    this.syncApplyFitButton();

    // 플롯을 그리기 전에 카드를 보여 준다. 숨은 카드 안에서 그리면 Plotly 가
    // 폭 0 을 재고 기본 폭으로 그려 놓고, 나중에 보여 줘도 다시 재지 않는다.
    DOM.results.fitSummaryCard.style.display = "block";

    this.renderFitCaption(data);
    this.renderFitPlot(data.curves || []);
    this.renderFitSummary(data.params, data.ssr_total);

    // 결과 카드는 화면 두 개쯤 아래에 있고 모달은 열린 채로 남는다. 데려다
    // 주지 않으면 적합이 끝난 뒤 닫고 내려가 찾아야 한다. 되살리는 중일
    // 때는 하지 않는다 — 방금 무슨 일이 일어난 게 아니라 원래 있던 것이다.
    //
    // behavior:"smooth" 는 이 중첩 스크롤 컨테이너에서 무시된다 — 넣어 두면
    // 스크롤이 아예 일어나지 않는다. 애니메이션이 맞는 자리도 아니다.
    if (!options || options.scroll !== false) {
      DOM.results.fitSummaryCard.scrollIntoView({ block: "nearest" });
    }
  },

  /** 무엇으로 어떻게 적합했고 그 결과를 믿을 만한지 표 위에 밝힙니다. */
  renderFitCaption(data) {
    const caption = document.getElementById('fit-caption');
    const note = document.getElementById('fit-note');
    const num = (v, d) => (typeof v === 'number' && Number.isFinite(v)) ? v.toPrecision(d || 4) : null;

    const how = data.objective === 'wls'
      ? `weighted least squares · ${data.weighting === 'none' ? 'no weighting' : data.weighting}`
      : `maximum likelihood · ${data.error_model} error`;

    const bits = [how, `${data.n_obs} points`, `${data.dof} dof`];
    const rmse = num(data.rmse);
    if (rmse) bits.push(`RMSE ${rmse}`);
    // 가중최소제곱에는 가능도가 없어 AIC/BIC 가 비어 온다. 없는 것을 지어내지 않는다.
    const aic = num(data.aic, 5);
    const bic = num(data.bic, 5);
    if (aic) bits.push(`AIC ${aic}`);
    if (bic) bits.push(`BIC ${bic}`);
    if (caption) caption.textContent = bits.join(' · ');

    if (note) {
      if (data.converged === false) {
        note.textContent = 'The optimiser stopped without converging' +
          (data.message ? ` — ${data.message}.` : '.') +
          ' Treat these values as a starting point, not an answer: widen the bounds, ' +
          'or start from a guess closer to the data.';
        note.hidden = false;
      } else {
        note.hidden = true;
      }
    }
  },

  /** 관측점과 적합 곡선을 겹쳐 그립니다. 그룹마다 한 색. */
  renderFitPlot(curves) {
    const el = document.getElementById('fit-plot');
    if (!el) return;
    if (!curves.length) {
      Plotly.purge(el);
      el.style.display = 'none';
      return;
    }
    el.style.display = '';

    const palette = ['#007AFF', '#FF9500', '#34C759', '#AF52DE', '#FF3B30', '#5AC8FA'];
    const traces = [];
    curves.forEach((c, i) => {
      const color = palette[i % palette.length];
      const label = curves.length > 1 ? `Group ${c.group} · ${c.variable}` : c.variable;
      traces.push({
        x: c.observed_time, y: c.observed, mode: 'markers', type: 'scatter',
        name: `${label} observed`,
        marker: { color: color, size: 7, symbol: 'circle-open', line: { width: 2 } },
      });
      traces.push({
        x: c.time, y: c.fitted, mode: 'lines', type: 'scatter',
        name: `${label} fitted`,
        line: { color: color, width: 2 },
      });
    });

    Plotly.react(el, traces, {
      xaxis: { title: 'Time', zeroline: false, gridcolor: 'rgba(0,0,0,0.05)' },
      yaxis: {
        title: curves.length === 1 ? curves[0].variable : 'Value',
        type: document.getElementById('log-scale').checked ? 'log' : 'linear',
        zeroline: false, gridcolor: 'rgba(0,0,0,0.05)', exponentformat: 'power',
      },
      legend: { orientation: 'h', yanchor: 'bottom', y: 1.02, xanchor: 'right', x: 1 },
      margin: { t: 30, r: 20, b: 50, l: 60 },
      paper_bgcolor: 'rgba(0,0,0,0)',
      plot_bgcolor: 'rgba(0,0,0,0)',
    }, { responsive: true });
  },

  renderFitSummary(params, cost) {
    const { fitSummaryCard, fitSummaryContainer } = DOM.results;
    if (!fitSummaryCard || !fitSummaryContainer) return;

    const rows = params.map(p => {
      // CV% 계산: (표준오차 / 추정치) * 100
      // 추정치가 0이거나 표준오차 계산이 불가능한 경우 'N/A' 처리
      // 표준오차/신뢰구간은 Hessian 계산이 실패하면 null 로 올 수 있고,
      // 예전 백엔드 응답에는 아예 없을 수도 있다(undefined). 둘 다 방어한다.
      const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

      const cvText = isNum(p.cv_pct)
        ? `${p.cv_pct.toFixed(2)}%`
        : (isNum(p.stderr) && isNum(p.value) && p.value !== 0
            ? `${Math.abs((p.stderr / p.value) * 100).toFixed(2)}%`
            : 'N/A');

      const ciText = (isNum(p.ci_lower) && isNum(p.ci_upper))
        ? `[${p.ci_lower.toPrecision(4)}, ${p.ci_upper.toPrecision(4)}]`
        : 'N/A';

      const valText = isNum(p.value) ? p.value.toPrecision(6) : String(p.value);

      return `
        <tr>
          <td>${p.name}</td>
          <td>${valText}</td>
          <td>${cvText}</td>
          <td>${ciText}</td>
        </tr>`;
    }).join("");

    fitSummaryContainer.innerHTML = `
      <div class="table-responsive">
        <table class="table table-sm table-hover mb-2">
          <thead class="table-light">
            <tr>
              <th>Parameter</th>
              <th>Value</th>
              <th>CV%</th>
              <th>95% CI</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <p class="small text-muted mb-0 text-end">SSR: ${(typeof cost === 'number' && Number.isFinite(cost)) ? cost.toPrecision(6) : 'N/A'}</p>`;
      
    fitSummaryCard.style.display = "block";
  },

  /**
   * 피팅 모달의 진행률 표시 영역을 초기 상태로 리셋합니다.
   */
  resetFitProgress() {
      const { progressMsg, progressElapsed, progressBar, progressConsole, progressResult } = DOM.modals.fittingSettings;
      
      progressMsg.textContent = "Waiting for fitting to start...";
      progressMsg.className = ""; // 혹시 에러 클래스가 있었다면 제거
      progressElapsed.textContent = "(0s)";
      progressConsole.innerHTML = "";
      progressResult.innerHTML = "";

      if (progressBar) {
          progressBar.style.width = "0%";
          progressBar.classList.remove('bg-danger', 'bg-success');
          progressBar.classList.add('progress-bar-animated');
      }
  },

  /**
   * 피팅 모달에 성공 결과를 표시합니다.
   * @param {object} resultData - 서버로부터 받은 피팅 결과 데이터 객체
   */
  displayFitSuccess(resultData) {
      const { progressMsg, progressBar, progressConsole, progressResult } = DOM.modals.fittingSettings;

      progressMsg.textContent = "Fitting successfully completed! 🎉";
      
      if (progressBar) {
        progressBar.style.width = "100%";
        progressBar.classList.add('bg-success');
        progressBar.classList.remove('progress-bar-animated');
      }

      let consoleOutput = `Termination: ${resultData.message || 'N/A'}\n`;
      consoleOutput += `Function Evaluations: ${resultData.nfev || 'N/A'}\n`;
      consoleOutput += `Final Unweighted SSR: ${typeof resultData.ssr_total === 'number' ? resultData.ssr_total.toPrecision(6) : 'N/A'}`;
      progressConsole.textContent = consoleOutput;

      const rows = resultData.params.map(p => {
        const cvText = (p.stderr !== null && p.value !== 0) 
          ? `${((p.stderr / p.value) * 100).toFixed(2)}%` 
          : 'N/A';
        return `<tr><td>${p.name}</td><td>${p.value.toPrecision(6)}</td><td>${cvText}</td></tr>`;
      }).join("");

      progressResult.innerHTML = `
        <table class="table table-sm table-bordered mb-0">
          <thead class="table-light">
            <tr><th>Fitted Parameter</th><th>Value</th><th>CV%</th></tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>`;
  },

  /**
   * 피팅 모달에 에러 메시지를 표시합니다.
   * @param {string} errorMessage - 표시할 에러 메시지
   */
  displayFitError(errorMessage) {
      const { progressMsg, progressBar, progressConsole } = DOM.modals.fittingSettings;

      progressMsg.innerHTML = `<span class="text-danger"><strong>Error:</strong> ${errorMessage}</span>`;
      progressConsole.textContent = `Fitting failed: ${errorMessage}`;

      if (progressBar) {
        progressBar.style.width = "100%";
        progressBar.classList.add('bg-danger');
        progressBar.classList.remove('progress-bar-animated');
      }
  }
};

const COLORS = ["#d9534f","#0275d8","#5cb85c","#f0ad4e","#6f42c1"];
function pickColor() {
  return COLORS[State.observations.length % COLORS.length];
}

function parseCsv(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = ev => {
      try {
        const lines = ev.target.result.split(/\r?\n/).filter(Boolean);
        const head = lines.shift().split(",").map(h => h.trim());
        const tIdx = head.findIndex(h => h.toLowerCase() === "time");
        if (tIdx === -1) return reject(new Error(`'Time' column missing in ${file.name}`));
        
        const data = { Time: [], ...Object.fromEntries(head.filter((_, i) => i !== tIdx).map(h => [h, []])) };
        
        lines.forEach(line => {
          const vals = line.split(",");
          if (vals.length !== head.length) return;
          
          const timeVal = parseFloat(vals[tIdx]);
          if (isNaN(timeVal)) return;
          
          data.Time.push(timeVal);
          head.forEach((h, j) => {
            if (j === tIdx) return;
            const v = parseFloat(vals[j]);
            data[h].push(isNaN(v) ? null : v);
          });
        });
        resolve(data);
      } catch (error) { reject(error); }
    };
    fr.onerror = (err) => reject(new Error(`Error reading file ${file.name}: ${err}`));
    fr.readAsText(file);
  });
}

/**
 * PK 요약 데이터를 CSV 형식으로 변환하여 다운로드합니다.
 * @param {Array<object>} data - PK 요약 객체들의 배열
 * @param {string} filename - 다운로드될 파일의 이름
 */
function exportSummaryToCsv(data, filename) {
  if (!data || data.length === 0) return;

  const headers = Object.keys(data[0]);
  let csvContent = headers.join(",") + "\r\n";

  data.forEach(row => {
    const values = headers.map(header => {
        const value = row[header];
        return value === null ? '' : value; // null 값을 빈 문자열로 처리
    });
    csvContent += values.join(",") + "\r\n";
  });

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement("a");
  if (link.download !== undefined) {
    const url = URL.createObjectURL(blob);
    link.setAttribute("href", url);
    link.setAttribute("download", filename);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }
}

function maskLowValues(arr, threshold = 0.000000001) {
  return arr.map(v => (v < threshold ? null : v));
} 

/**
 * 데이터를 CSV 형식으로 변환하여 다운로드합니다.
 * @param {object} data - { Time: [...], C: [...] } 형태의 데이터 객체
 * @param {string} filename - 다운로드될 파일의 이름
 */
function exportDataToCsv(data, filename) {
  const headers = Object.keys(data);
  const numRows = data[headers[0]].length;
  
  // 1. CSV 헤더 생성 (e.g., "Time", "C", "P")
  let csvContent = headers.join(",") + "\r\n";

  // 2. 데이터 행 생성
  for (let i = 0; i < numRows; i++) {
    const row = headers.map(header => data[header][i]);
    csvContent += row.join(",") + "\r\n";
  }

  // 3. 파일 다운로드 실행
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement("a");
  if (link.download !== undefined) {
    const url = URL.createObjectURL(blob);
    link.setAttribute("href", url);
    link.setAttribute("download", filename);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }
}

const Handlers = {
  // --- 사이드바 및 공용 핸들러 ---

  /**
   * Value Settings 의 표시 순서 토글(ODE order / A-Z)을 처리합니다.
   * 계산에는 영향이 없고 입력 필드의 나열 순서만 바뀝니다.
   * 이미 입력한 값이 지워지지 않도록, 다시 그리기 전에 현재 값을 읽어 두었다가 되돌려 놓습니다.
   */
  handleSymbolOrderChange(event) {
    const value = event.target.value;
    if (value !== 'ode' && value !== 'alpha') return;

    // 현재 입력값 보존
    const keep = { init: {}, param: {} };
    State.compartments.forEach(c => {
      const el = DOM.sidebar.initValuesContainer.querySelector(`#init_${c}`);
      if (el) keep.init[c] = el.value;
    });
    State.parameters.forEach(pn => {
      const el = DOM.sidebar.paramValuesContainer.querySelector(`#param_${pn}`);
      if (el) keep.param[pn] = el.value;
    });

    SymbolOrder.save(value);
    UI.renderSymbolInputs();

    // 값 복원
    Object.entries(keep.init).forEach(([c, v]) => {
      const el = DOM.sidebar.initValuesContainer.querySelector(`#init_${c}`);
      if (el) el.value = v;
    });
    Object.entries(keep.param).forEach(([pn, v]) => {
      const el = DOM.sidebar.paramValuesContainer.querySelector(`#param_${pn}`);
      if (el) el.value = v;
    });

    UI.updateSelectedBadges();
  },

  /**
   * 'Parse' 버튼 클릭을 처리합니다.
   * ODE 텍스트를 API로 보내고, 결과를 받아 State를 업데이트한 후 UI를 다시 렌더링합니다.
   */
  async handleParseClick() {
    const odeText = DOM.sidebar.odeInput.value.trim();
    if (!odeText) return alert("Please enter ODEs.");

    try {
      const response = await API.parseODE(odeText);
      if (response.status === "ok") {
        // State 업데이트
        State.compartments = response.data.compartments || [];
        State.parameters = response.data.parameters || [];
        State.compartmentsOdeOrder = response.data.compartments_ode_order || [];
        State.parametersOdeOrder = response.data.parameters_ode_order || [];
        State.processedODE = response.data.processed_ode;
        State.derivedExpressions = response.data.derived_expressions || {};

        // UI 업데이트 요청
        UI.renderSymbolInputs();
        UI.updateSelectedBadges();

        DOM.sidebar.editSymbolsBtn.disabled = false; // 심볼 편집 버튼 활성화
      } else {
        alert("Parse failed: " + (response.message || "Unknown error"));
      }
    } catch (error) {
      // API.js에서 던진 에러를 여기서 처리 (이미 alert는 API.js에서 처리됨)
      console.error("Parse failed:", error);
    }
  },


  /**
   * 심볼 편집 모달 내부의 클릭 이벤트를 처리합니다 (이벤트 위임).
   */
  handleSymbolEditorClick(event) {
    const moveBtn = event.target.closest('.move-symbol-btn');
    if (!moveBtn) return;
    
    const symbol = moveBtn.dataset.symbol;
    const direction = moveBtn.dataset.direction;
    const sourceList = direction === 'toParam' ? 
      DOM.modals.editSymbols.compartmentsList : 
      DOM.modals.editSymbols.parametersList;
    const destList = direction === 'toParam' ? 
      DOM.modals.editSymbols.parametersList : 
      DOM.modals.editSymbols.compartmentsList;

    const itemToMove = moveBtn.parentElement;
    
    // 버튼 방향에 따라 새 버튼 생성
    const newButtonHTML = direction === 'toParam' ? 
      `<button class="btn btn-light btn-sm move-symbol-btn" data-symbol="${symbol}" data-direction="toComp" title="Move to Compartments">&lt;</button>` :
      `<button class="btn btn-light btn-sm move-symbol-btn" data-symbol="${symbol}" data-direction="toParam" title="Move to Parameters">&gt;</button>`;
      
    // 아이템 구조 변경 및 이동
    itemToMove.remove();
    const newItem = document.createElement('div');
    newItem.className = 'symbol-list-item';
    
    if (direction === 'toParam') {
        newItem.innerHTML = `${newButtonHTML} <span>${symbol}</span>`;
        destList.appendChild(newItem);
    } else {
        newItem.innerHTML = `<span>${symbol}</span> ${newButtonHTML}`;
        destList.prepend(newItem); // 파라미터 -> 구획 이동 시 위로 추가
    }
  },

  /**
   * 심볼 편집 모달의 'Save Changes' 버튼 클릭을 처리합니다.
   */
  handleSaveChangesClick() {
    const { compartmentsList, parametersList } = DOM.modals.editSymbols;

    // 모달 UI에서 최신 심볼 목록을 다시 읽어옵니다.
    const newCompartments = [...compartmentsList.querySelectorAll('.symbol-list-item span')].map(s => s.textContent);
    const newParameters = [...parametersList.querySelectorAll('.symbol-list-item span')].map(s => s.textContent);
    
    // State를 새로운 목록으로 업데이트합니다.
    State.compartments = newCompartments;
    State.parameters = newParameters;
    
    // 변경된 State를 기반으로 메인 UI를 다시 렌더링합니다.
    UI.renderSymbolInputs();
    
    // 모달을 닫습니다.
    const modalInstance = bootstrap.Modal.getInstance(DOM.modals.editSymbols.element);
    modalInstance.hide();
  },

  /**
   * Dosing 폼 제출을 처리합니다.
   * @param {Event} event - 폼 제출 이벤트 객체
   */
  handleDoseFormSubmit(event) {
    event.preventDefault();
    const formData = new FormData(event.target);
    const d = {
      compartment: formData.get("compartment"),
      type: formData.get("type"),
      amount: +formData.get("amount"),
      start_time: +formData.get("start_time"),
      duration: formData.get("type") === "infusion" ? (+formData.get("duration") || 0) : 0,
      repeat_every: +formData.get("repeat_every") || null,
      repeat_until: +formData.get("repeat_until") || null
    };

    // 유효성 검사
    if (!d.amount || d.amount <= 0) return alert("Please enter a valid amount.");
    if (d.repeat_every && (!d.repeat_until || d.repeat_until <= d.start_time)) {
      return alert("If 'Repeat every' is set, 'Repeat until' must also be set and be greater than Start Time.");
    }
    
    // State 업데이트
    State.doseList.push(d);
    // UI 업데이트
    UI.renderDoses();
    
    event.target.reset();
    // reset() 은 값만 되돌릴 뿐 change 를 쏘지 않으므로, 값에 따라 보였다 숨었다
    // 하는 칸들은 직접 알려 줘야 한다. 안 그러면 스위치는 꺼졌는데 반복 입력칸만
    // 남는 것처럼 폼과 화면이 어긋난다.
    DOM.sidebar.doseTypeSelect.dispatchEvent(new Event('change')); // Infusion 필드 숨김 처리
    const repeatToggle = document.getElementById('repeat-dose-toggle');
    if (repeatToggle) repeatToggle.dispatchEvent(new Event('change')); // 반복 필드 숨김 처리
  },

  /**
   * 동적으로 생성된 투여 목록의 클릭 이벤트를 처리합니다 (이벤트 위임).
   * @param {Event} event - 클릭 이벤트 객체
   */
  handleDoseListClick(event) {
    const removeButton = event.target.closest('.remove-dose-btn');
    if (removeButton) {
      const index = parseInt(removeButton.dataset.index, 10);
      if (confirm(`Are you sure you want to remove dose #${index + 1}?`)) {
        // State 업데이트
        State.doseList.splice(index, 1);
        // UI 업데이트
        UI.renderDoses();
      }
    }
  },

  // --- 메인 툴바 및 시뮬레이션 핸들러 ---
  /**
   * 선택된 구획 배지 클릭을 처리하여 해당 구획을 선택 해제합니다.
   * @param {Event} event - 클릭 이벤트 객체
   */
  handleBadgeClick(event) {
    // 1. 클릭된 요소가 '뱃지'가 맞는지 확인합니다.
    const clickedBadge = event.target.closest('.badge');
    if (!clickedBadge) {
      return; // 뱃지가 아니면 아무 작업도 하지 않음
    }

    // 2. 클릭된 배지에서 구획(compartment) 이름을 가져옵니다.
    const compName = clickedBadge.textContent.trim();
    if (!compName) return;

    // 3. 뱃지 이름과 일치하는 시뮬레이션 구획 선택 메뉴의 체크박스를 찾습니다.
    const checkboxToUncheck = DOM.simulation.compartmentsMenu.querySelector(`.sim-comp-checkbox[value="${compName}"]`);

    // 4. 체크박스를 찾았다면, 선택을 해제합니다.
    if (checkboxToUncheck) {
      checkboxToUncheck.checked = false;
      
      // 5. 체크박스 상태가 변경되었으므로, 뱃지 UI를 다시 렌더링하여 화면에 반영합니다.
      UI.updateSelectedBadges();
    }
  },

  /**
   * 'Run Simulation' 버튼 클릭을 처리합니다.
   */
  async handleSimulateClick() {
    if (State.isSimulating) return;
    if (State.compartments.length === 0 || State.parameters.length === 0) {
      return alert("Please parse ODEs first.");
    }

    State.isSimulating = true;
    UI.setLoading(DOM.toolbar.simulateBtn, true);

    const stepsInput = document.getElementById('dropdown-sim-steps');

    try {
      const payload = {
        equations: DOM.sidebar.odeInput.value.trim(),
        compartments: [...DOM.simulation.compartmentsMenu.querySelectorAll(".sim-comp-checkbox:checked")].map(e => e.value),
        initials: {},
        parameters: {},
        doses: State.doseList,
        t_start: +DOM.toolbar.simStartTime.value,
        t_end: +DOM.toolbar.simEndTime.value,
        t_steps: stepsInput ? +stepsInput.value : 200, // 기본값 200
        // 선택된 관찰 데이터도 함께 보내 같은 표에서 NCA 결과를 나란히 본다.
        // 매핑된 열만 의미가 있으므로 매핑과 용량을 함께 싣는다.
        observed: State.observations
          .filter(o => o.selected)
          .map(o => ({
            name: o.name,
            data: o.data,
            mappings: o.mappings || {},
            dose: (o.dose === undefined || o.dose === null || o.dose === '') ? null : +o.dose,
          })),
      };

      // 파라미터 및 초기값 수집
      State.compartments.forEach(c => payload.initials[c] = +DOM.sidebar.initValuesContainer.querySelector(`#init_${c}`).value);
      State.parameters.forEach(p => payload.parameters[p] = +DOM.sidebar.paramValuesContainer.querySelector(`#param_${p}`).value);
      
      const response = await API.simulate(payload);

      if (response.status === "ok") {
        State.latestSimulationResult = response.data.profile;
        State.latestPKSummary = response.data.pk;
        UI.plotSimulationResult(response.data.profile, DOM.toolbar.logScaleCheckbox.checked);
        UI.displayPKSummary(response.data.pk);
        window.dispatchEvent(new Event('pk:result'));
      }
    } catch (error) {
       // API 모듈에서 이미 alert를 띄웠으므로, 콘솔에만 에러 기록
       console.error("Simulation failed:", error);
    } finally {
      State.isSimulating = false;
      UI.setLoading(DOM.toolbar.simulateBtn, false);
    }
  },

  /**
   * Export handlers
   */
  handleExportProfileClick() {
    if (!State.latestSimulationResult) {
      alert("Please run a simulation first to export results.");
      return;
    }
    // 내보내기 헬퍼 함수 호출
    exportDataToCsv(State.latestSimulationResult, "simulation_results.csv");
  },

  handleExportSummaryClick() {
    if (!State.latestPKSummary) {
        alert("Please run a simulation first to export the summary.");
        return;
    }
    // 1. 데이터가 배열이든 객체든 항상 배열 형태로 변환합니다.
    const summaryData = Array.isArray(State.latestPKSummary) 
      ? State.latestPKSummary 
      : Object.entries(State.latestPKSummary).map(([comp, metrics]) => ({ compartment: comp, ...metrics }));

    // 2. 변환된 배열을 바탕으로 CSV용 데이터를 재구성합니다.
    // analyzer.py 가 돌려주는 키를 그대로 쓴다. 표에 없는 항목까지 함께 내보내
    // 스프레드시트에서 더 파고들 수 있게 한다.
    const summaryArray = summaryData.map(item => ({
        variable: item.compartment,
        Cmax: item.c_max,
        Tmax: item.t_max,
        Clast: item.c_last,
        Tlast: item.t_last,
        lambda_z: item.lambda_z,
        'Half-life': item.half_life,
        'lambda_z_points': item.lambda_z_n_points,
        'lambda_z_adj_R2': item.lambda_z_adj_r_squared,
        'AUC_0-last': item.auc_last,
        'AUC_0-inf': item.auc_inf_obs,
        'AUC_extrap_pct': item.auc_extrap_pct,
        'AUMC_0-last': item.aumc_last,
        'AUMC_0-inf': item.aumc_inf,
        CL: item.cl,
        Vz: item.vz,
        MRT: item.mrt,
        Vss: item.vss,
        // 반복 투여 항목. 단회 투여 행에서는 빈 칸으로 나간다. 화면 표에
        // 싣지 않은 Ctrough·Swing·AUMCτ 도 여기에는 넣는다 — 스프레드시트로
        // 가져가는 이유가 대개 더 파고들기 위해서다.
        Regimen: item.regimen,
        tau: item.ss_tau,
        SS_interval_start: item.ss_interval_start,
        SS_interval_end: item.ss_interval_end,
        SS_n_intervals: item.ss_n_intervals,
        'Cmax_ss': item.ss_c_max,
        'Tmax_ss': item.ss_t_max,
        'Cmin_ss': item.ss_c_min,
        'Tmin_ss': item.ss_t_min,
        Ctrough: item.ss_c_trough,
        Cavg: item.ss_c_avg,
        AUC_tau: item.ss_auc_tau,
        AUMC_tau: item.ss_aumc_tau,
        Fluctuation_pct: item.ss_fluctuation_pct,
        Swing: item.ss_swing,
        Racc_AUC: item.ss_accumulation_auc,
        Racc_Cmax: item.ss_accumulation_c_max,
        CL_ss: item.ss_cl,
        Vz_ss: item.ss_vz,
        At_steady_state: item.ss_at_steady_state,
        Interval_change_pct: item.ss_interval_change_pct,
        Method: item.method,
        Administration: item.administration,
    }));
    exportSummaryToCsv(summaryArray, "pk_summary.csv");
  },

  /**
   * 결과 영역을 PDF 리포트로 뽑습니다.
   *
   * 브라우저의 인쇄 대화상자를 씁니다. html2canvas + jsPDF 를 얹으면 1MB 가까이
   * 늘고 결과는 화면을 찍은 래스터라 표 글자가 뭉갭니다. 인쇄 경로는 글자가
   * 글자로, Plotly 의 SVG 가 벡터로 들어가고 페이지 나눔도 브라우저가 맡습니다.
   *
   * 무엇을 계산한 것인지 모르는 PDF 는 나중에 쓸모가 없으므로, 인쇄 직전에
   * 모델과 조건을 머리말에 채워 넣습니다.
   */
  handleExportReportClick() {
    if (!State.latestSimulationResult) {
      return alert("Run a simulation first — there are no results to report yet.");
    }
    window.print();
  },


  handleExportPlotClick() {
    if (!State.latestSimulationResult) {
      alert("Please run a simulation first to export the plot.");
      return;
    }
    // Plotly 내장 기능 사용
    Plotly.downloadImage(DOM.results.plotContainer, {
      format: 'png',
      width: 1200,
      height: 800,
      filename: 'simulation_plot'
    });    
  },

    /**
   * 'Save Session' 버튼 클릭을 처리합니다.
   * 현재 앱의 모든 상태를 하나의 JSON 파일로 만들어 다운로드합니다.
   */
  handleExportSessionClick() {
    // 자동저장과 같은 것을 담는다. 결과와 관측값까지 한 파일에 들어가므로
    // 파일 하나로 세션이 그대로 되살아난다.
    const jsonString = JSON.stringify(Session.snapshot(), null, 2);
    const blob = new Blob([jsonString], { type: "application/json" });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `pk-simulator-session-${new Date().toISOString().slice(0,10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },

  /**
   * 'Load Session' 파일 선택을 처리합니다.
   * 사용자가 선택한 JSON 파일을 읽어 앱의 상태를 복원합니다.
   */
  handleImportSessionChange(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const ok = await Session.restore(JSON.parse(e.target.result));
        if (!ok) throw new Error("The file does not contain a model.");
        Session.save();
        alert('Session loaded successfully!');
      } catch (error) {
        alert('Failed to load the session file: ' + error.message);
        console.error("Session load error:", error);
      } finally {
        // 동일한 파일을 다시 선택할 수 있도록 입력값 초기화
        event.target.value = "";
      }
    };
    reader.readAsText(file);
  },


  // --- 피팅 관련 핸들러 ---

  handleFitBtnClick() {
    // 모달을 열기 전, 필수 조건들을 확인합니다.
    if (State.compartments.length === 0 || State.parameters.length === 0) {
      return alert("Please parse ODEs first to define parameters for fitting.");
    }
    if (State.observations.filter(o => o.selected).length === 0) {
      alert("Fitting needs observed data to fit against. Upload a CSV and select it, then try again.");
      // 알려 주고 끝내면 사용자가 그 창을 직접 찾아야 한다. 데려다 준다.
      const panel = document.getElementById('obsPanel');
      if (panel) bootstrap.Offcanvas.getOrCreateInstance(panel).show();
      return;
    }
    
    // 모든 조건 통과 시, UI 모듈에 모달을 열도록 요청합니다.
    UI.openFittingSettingsModal();
  },

  /**
   * 'Suggest Bounds from Initial Guesses' 버튼 클릭을 처리합니다.
   * 모달의 Initial guess 값을 읽어 1/10배와 10배를 경계값으로 채웁니다.
   */
  handleFetchInitialParamsClick() {
    const { paramSelectionScope, paramBoundsList } = DOM.modals.fittingSettings;
    const checkedParams = paramSelectionScope.querySelectorAll('.modal-fit-param-cb:checked');

    if (checkedParams.length === 0) {
      alert("Please select at least one parameter to fetch initial values.");
      return;
    }

    checkedParams.forEach(checkbox => {
      const paramName = checkbox.value;

      // 1. 경계는 이 모달의 Initial guess 를 기준으로 잡는다. 사이드바가
      //    아니라 실제로 최적화가 출발할 값 주위여야 뜻이 있다.
      const guessInput = document.querySelector(`.modal-param-guess[data-param-name="${paramName}"]`);
      if (!guessInput) return;

      const initialValue = parseFloat(guessInput.value);
      if (isNaN(initialValue)) return;

      // 2. 모달의 경계값(Bounds) 입력 필드를 찾습니다.
      const lowerBoundInput = paramBoundsList.querySelector(`.modal-param-lower[data-param-name="${paramName}"]`);
      const upperBoundInput = paramBoundsList.querySelector(`.modal-param-upper[data-param-name="${paramName}"]`);

      if (lowerBoundInput && upperBoundInput) {
        // 3. 1/10배와 10배 값을 계산하여 입력 필드에 설정합니다.
        //    만약 초기값이 0이면, 경계값은 설정하지 않습니다.
        if (initialValue !== 0) {
          lowerBoundInput.value = initialValue / 10;
          upperBoundInput.value = initialValue * 10;
        } else {
          lowerBoundInput.value = '';
          upperBoundInput.value = '';
        }
      }
    });

    alert(`${checkedParams.length} parameter(s) had their bounds automatically set.`);
  },

/**
 * 'Start Fitting' 버튼 클릭을 처리합니다.
 * - 모달에서 설정된 파라미터 Scope(Shared/Per group), Bounds, Objective, Fitting Groups 정보를 수집합니다.
 * - 유효성을 검사하고 API 서버에 MLE Fitting을 요청합니다.
 * - 결과를 받아 UI에 표시하고 시뮬레이션을 자동 실행합니다.
 */
async handleStartFittingClick() {
  // 0. 중복 실행 방지 및 UI 초기화
  if (State.isFitting) return;

  const startBtn = DOM.modals.fittingSettings.startBtn;
  const progressSection = DOM.modals.fittingSettings.progressSection;

  try {
    State.isFitting = true;
    progressSection.style.display = 'block'; // 진행률 섹션 표시
    UI.resetFitProgress(); // 진행바, 로그 초기화
    UI.setLoading(startBtn, true);

    // --- 1. 데이터 수집: 파라미터, Scope, Bounds ---
    const selectedFitParams = [];
    const paramScopes = {};
    const bounds = {};

    // 체크된 파라미터들을 순회하며 정보 수집
    const checkedParamBoxes = DOM.modals.fittingSettings.paramSelectionScope.querySelectorAll('.modal-fit-param-cb:checked');
    
    if (checkedParamBoxes.length === 0) {
      throw new Error("Please select at least one parameter to fit.");
    }

    checkedParamBoxes.forEach(cb => {
      const pName = cb.value;
      selectedFitParams.push(pName);

      // 1-1. Scope 수집 (모든 그룹이 공유하는가, 그룹마다 따로 두는가)
      // 모달에 해당 파라미터에 대한 라디오 버튼(name="scope_{pName}")이 있다고 가정
      const scopeRadio = document.querySelector(`input[name="scope_${pName}"]:checked`);
      const scope = scopeRadio ? scopeRadio.value : 'shared'; // 기본값 shared
      paramScopes[pName] = scope;

      // 1-2. Bounds 수집
      // 그룹마다 따로 추정하더라도, 경계는 사용자가 입력한 하나의 범위를 공통으로 적용한다
      const lowerEl = DOM.modals.fittingSettings.paramBoundsList.querySelector(`.modal-param-lower[data-param-name="${pName}"]`);
      const upperEl = DOM.modals.fittingSettings.paramBoundsList.querySelector(`.modal-param-upper[data-param-name="${pName}"]`);
      
      const lbVal = lowerEl?.value.trim() === '' ? null : parseFloat(lowerEl.value);
      const ubVal = upperEl?.value.trim() === '' ? null : parseFloat(upperEl.value);

      // 유효성 검사
      if ((lbVal !== null && isNaN(lbVal)) || (ubVal !== null && isNaN(ubVal))) {
        throw new Error(`Invalid bounds for parameter '${pName}'. Please enter numeric values.`);
      }
      if (lbVal !== null && ubVal !== null && lbVal > ubVal) {
        throw new Error(`Lower bound cannot be greater than upper bound for '${pName}'.`);
      }

      bounds[pName] = [lbVal, ubVal];
    });

    // --- 2. 데이터 수집: Objective ---
    // 최대가능도와 가중최소제곱은 둘 다 잔차 가중을 정하므로 배타적이다.
    // 고른 쪽의 설정만 보낸다.
    const objectiveRadio = document.querySelector('input[name="fitObjective"]:checked');
    const objective = objectiveRadio ? objectiveRadio.value : 'mle';
    const errorModelRadio = document.querySelector('input[name="errorModel"]:checked');
    const errorModel = errorModelRadio ? errorModelRadio.value : 'constant';
    const weightingRadio = document.querySelector('input[name="fitWeighting"]:checked');
    const weighting = weightingRadio ? weightingRadio.value : 'none';

    // --- 3. 데이터 수집: 초기값 및 시작 파라미터 값 ---
    // 적합할 파라미터의 출발점은 모달의 Initial guess 칸에서 읽는다. 그 값은
    // 모달 안에만 살고 사이드바를 건드리지 않는다 — 피팅은 모델을 바꾸지
    // 않는다는 원칙. 적합하지 않는 파라미터와 구획 초기값은 모델 그대로다.
    const initials = {};
    const currentParams = {};
    State.compartments.forEach(c => {
      const val = parseFloat(DOM.sidebar.initValuesContainer.querySelector(`#init_${c}`).value);
      initials[c] = isNaN(val) ? 0 : val;
    });
    State.parameters.forEach(p => {
      const guessInput = document.querySelector(`.modal-param-guess[data-param-name="${p}"]`);
      const sidebarInput = DOM.sidebar.paramValuesContainer.querySelector(`#param_${p}`);
      const raw = guessInput && guessInput.value !== '' ? guessInput.value : (sidebarInput ? sidebarInput.value : '');
      const val = parseFloat(raw);
      currentParams[p] = isNaN(val) ? 0.1 : val;
    });

    // --- 4. 데이터 수집: Fitting Groups (실험 그룹) ---
    const fittingGroups = [];
    const groupCards = DOM.modals.fittingSettings.groupsContainer.querySelectorAll('.fitting-group-card');

    if (groupCards.length === 0) {
      throw new Error("Please add at least one experimental group.");
    }

    for (const card of groupCards) {
      const groupId = parseInt(card.dataset.groupId, 10) + 1;
      const obsIndexStr = card.querySelector('.group-obs-select').value;
      const comp = card.querySelector('.group-dose-comp').value;
      const amountStr = card.querySelector('.group-dose-amount').value;
      const timeStr = card.querySelector('.group-dose-time').value;

      // 그룹 데이터 유효성 검사
      if (obsIndexStr === "" || !State.observations[parseInt(obsIndexStr, 10)]) {
        throw new Error(`Group ${groupId}: Please select observed data.`);
      }
      if (!comp) {
        throw new Error(`Group ${groupId}: Please select a dosing compartment.`);
      }
      const amount = parseFloat(amountStr);
      const time = parseFloat(timeStr);
      if (isNaN(amount) || amount <= 0) {
        throw new Error(`Group ${groupId}: Please enter a valid dose amount.`);
      }
      if (isNaN(time)) {
        throw new Error(`Group ${groupId}: Please enter a valid dose time.`);
      }

      // 투여 방식은 사이드바 dose 폼과 같은 규칙으로 읽는다. zero-order 는
      // duration 이 있어야 속도가 정해지고, 반복은 간격과 종료 시각이
      // 둘 다 있어야 일정이 성립한다.
      const type = card.querySelector('.group-dose-type').value;
      const dose = { compartment: comp, type: type, amount: amount, start_time: time };

      if (type === 'infusion') {
        const duration = parseFloat(card.querySelector('.group-dose-duration').value);
        if (isNaN(duration) || duration <= 0) {
          throw new Error(`Group ${groupId}: A zero-order input needs a duration greater than zero.`);
        }
        dose.duration = duration;
      }

      if (card.querySelector('.group-repeat-toggle').checked) {
        const every = parseFloat(card.querySelector('.group-dose-repeat-every').value);
        const until = parseFloat(card.querySelector('.group-dose-repeat-until').value);
        if (isNaN(every) || every <= 0) {
          throw new Error(`Group ${groupId}: Repeat dosing needs an interval greater than zero.`);
        }
        if (isNaN(until) || until <= time) {
          throw new Error(`Group ${groupId}: Repeat dosing must end after the first dose at ${time}.`);
        }
        dose.repeat_every = every;
        dose.repeat_until = until;
      }

      const selectedObs = State.observations[parseInt(obsIndexStr, 10)];

      fittingGroups.push({
        doses: [dose],
        observed: selectedObs.data,
        mappings: selectedObs.mappings // 컬럼 매핑 정보 포함
      });
    }

    // --- 5. API 요청 페이로드 생성 ---
    const payload = {
      equations: DOM.sidebar.odeInput.value.trim(),
      initials: initials,
      parameters: currentParams,
      fit_params: selectedFitParams,
      bounds: bounds,
      fitting_groups: fittingGroups,
      
      param_scopes: paramScopes,
      // 서버는 objective 를 보고 둘 중 하나만 읽는다.
      objective: objective,
      error_model: errorModel,
      weighting: weighting
    };

    // --- 6. API 호출 ---
    // progress bar 애니메이션을 위해 가짜 타이머 시작 (선택 사항)
    let fakeProgress = 0;
    const progressInterval = setInterval(() => {
        fakeProgress = Math.min(fakeProgress + 5, 90);
        const bar = DOM.modals.fittingSettings.progressBar;
        if(bar) bar.style.width = `${fakeProgress}%`;
    }, 500);

    const response = await API.fit(payload);
    
    clearInterval(progressInterval); // API 응답 오면 타이머 중지

    // --- 7. 결과 처리 ---
    if (response.status === "ok") {
      UI.displayFitSuccess(response.data);
      
      // 결과는 자기 카드에 그린다. 사이드바를 덮어쓰고 다시 시뮬레이션을
      // 돌려 적합 곡선을 보여 주던 예전 방식은 없앴다 — 피팅이 모델을
      // 말없이 바꾸는 셈이었기 때문이다. 적합값을 모델로 옮기고 싶으면
      // 카드의 'Apply to model' 을 누른다.
      UI.renderFitResult(response.data);
      window.dispatchEvent(new Event('pk:result'));

    } else {
      throw new Error(response.message || "Fitting failed on the server.");
    }

  } catch (err) {
    UI.displayFitError(err.message);
  } finally {
    State.isFitting = false;
    UI.setLoading(startBtn, false);
  }
},

  /**
   * 'Show Processed ODEs' 버튼 클릭을 처리합니다.
   */
  handleShowProcessedClick() {
    // UI.showProcessedModal() 함수를 UI 모듈에 추가해야 합니다.
    // 이 함수는 State의 _processedODE, _compartments 등을 읽어 모달 내용을 채우고 보여줍니다.
    UI.showProcessedModal(); 
  },

  /**
   * Dosing 폼의 'Type' select 변경을 처리합니다.
   */
  handleDoseTypeChange(event) {
    DOM.sidebar.doseDurationLabel.style.display = event.target.value === "infusion" ? "flex" : "none";
  },

  /**
   * 시뮬레이션 구획 선택 메뉴의 변경을 처리합니다.
   */
  handleSimCompMenuChange() {
    UI.updateSelectedBadges();
  },

  /**
   * 관찰 데이터 파일 입력을 처리합니다.
   * @param {Event} event - 파일 input의 change 이벤트
   */
  async handleObsFileChange(event) {
    const files = [...event.target.files];
    for (const file of files) {
      try {
        const data = await parseCsv(file);
        State.observations.push({
          name: file.name,
          color: pickColor(),
          data: data,
          selected: true,
          dose: null,  // 사용자가 패널에서 입력한다. 없으면 CL/Vz 는 계산하지 않는다.
          mappings: {} // { dataColumn: modelVariable, ... }
        });
      } catch (error) {
        alert(`Error processing file ${file.name}: ${error.message}`);
      }
    }
    UI.renderObsList();
    event.target.value = ""; // 동일한 파일을 다시 선택할 수 있도록 초기화
  },

  /**
   * 관찰 데이터 패널(Offcanvas) 내부의 'click' 이벤트를 처리합니다.
   */
  handleObsPanelClick(event) {
    const target = event.target;
    const item = target.closest('.obs-item');       // 목록 아이템
    const removeBtn = target.closest('.remove-obs-btn'); // 삭제 버튼

    // 1. 삭제 버튼 클릭 시
    if (removeBtn) {
      const index = parseInt(removeBtn.dataset.index, 10);
      const obsData = State.observations[index];
      if (obsData && confirm(`Are you sure you want to remove "${obsData.name}"?`)) {
        State.observations.splice(index, 1);
        UI.renderObsList(); // 목록과 상세 보기를 다시 렌더링
      }
      return;
    }

    // 2. 목록 아이템 클릭 시
    if (item) {
      event.preventDefault();
      const index = parseInt(item.dataset.index, 10);
      UI.renderObsDetailView(index);
    }
  },

  /**
   * 관찰 데이터 패널(Offcanvas) 내부의 'change' 이벤트를 처리합니다.
   */
  handleObsPanelChange(event) {
    const target = event.target;

    // 데이터셋별 투여량 — NCA 의 CL, Vz 에 쓰인다
    if (target.classList.contains('obs-dose-input')) {
      const index = parseInt(target.dataset.obsIndex, 10);
      if (State.observations[index]) {
        const raw = target.value.trim();
        State.observations[index].dose = raw === '' ? null : +raw;
      }
      return;
    }

    // 매핑 드롭다운 메뉴 변경 시
    if (target.classList.contains('mapping-select')) {
        const obsIndex = parseInt(target.dataset.obsIndex, 10);
        const colName = target.dataset.columnName;
        if (State.observations[obsIndex]) {
          State.observations[obsIndex].mappings[colName] = target.value;
        }
    }
  },

  /**
   * 피팅 모달의 파라미터 체크박스 변경을 처리합니다.
   */
  handleFitParamCheckboxChange() {
    UI.renderFitParamBoundsUI();
  },
  
  /**
   * 'Add Experimental Group' 버튼 클릭을 처리합니다.
   */
  handleAddFittingGroupClick() {
    UI.addFittingGroup();
  },

  /**
   * 피팅 그룹 카드 내의 클릭 이벤트를 처리합니다 (이벤트 위임).
   */
  /**
   * 'Apply to model' 버튼. 적합값을 사이드바로 옮기고 그 값으로 다시
   * 시뮬레이션을 돌려 메인 Profile 이 새 모델을 그리게 합니다.
   */
  handleApplyFitClick() {
    const data = State.lastFitResult;
    if (!data || !Array.isArray(data.params)) return;

    const shared = data.params.filter(p => p.scope === 'shared');
    if (!shared.length) {
      return alert("Only shared parameters can be applied — a per-group value belongs to one group, and the sidebar holds one model.");
    }
    UI.applyFittedParams(shared);
    Handlers.handleSimulateClick();
  },

  handleFittingGroupEvents(event) {
    if (event.target.classList.contains('remove-fitting-group-btn')) {
      event.target.closest('.fitting-group-card')?.remove();
    }
  },

  /**
   * 그룹 카드의 입력 변화를 처리합니다 (이벤트 위임).
   * 사이드바 dose 폼과 같은 규칙 — Duration 은 zero-order 일 때만, 반복
   * 설정은 토글을 켰을 때만 보인다.
   */
  handleFittingGroupChange(event) {
    const card = event.target.closest('.fitting-group-card');
    if (!card) return;

    // 관측 데이터에 용량이 적혀 있으면 그대로 가져온다. 같은 숫자를 두 번
    // 입력하게 두면 두 곳이 어긋나고, 어느 쪽이 맞는지 알 수 없게 된다.
    // 사용자가 직접 고친 값은 덮어쓰지 않는다.
    if (event.target.classList.contains('group-obs-select')) {
      const obs = State.observations[parseInt(event.target.value, 10)];
      const amount = card.querySelector('.group-dose-amount');
      const hint = card.querySelector('.group-dose-hint');
      const untouched = amount.value === '' || amount.dataset.autofilled === '1';

      if (obs && obs.dose != null && obs.dose !== '' && untouched) {
        amount.value = obs.dose;
        amount.dataset.autofilled = '1';
        hint.textContent = `from ${obs.name}`;
        hint.hidden = false;
      } else if (amount.dataset.autofilled === '1' && (!obs || obs.dose == null)) {
        // 용량이 적히지 않은 데이터로 바꾸면, 앞 데이터에서 끌어온 값도 치운다.
        amount.value = '';
        delete amount.dataset.autofilled;
        hint.hidden = true;
      } else if (amount.dataset.autofilled !== '1') {
        hint.hidden = true;
      }
    }

    if (event.target.classList.contains('group-dose-type')) {
      const isInfusion = event.target.value === 'infusion';
      const field = card.querySelector('.group-duration-field');
      if (field) field.style.display = isInfusion ? '' : 'none';
      if (!isInfusion) card.querySelector('.group-dose-duration').value = '';
    }

    if (event.target.classList.contains('group-repeat-toggle')) {
      const on = event.target.checked;
      const fields = card.querySelector('.group-repeat-fields');
      if (fields) fields.style.display = on ? '' : 'none';
      if (!on) {
        card.querySelector('.group-dose-repeat-every').value = '';
        card.querySelector('.group-dose-repeat-until').value = '';
      }
    }
  },
};

/* ============================================================ */
/* Session — 한 벌의 상태를 만들고 되돌린다                        */
/* ============================================================ */
/**
 * 새로고침으로 날아가지 않게 브라우저에 담아 두는 일과, 파일로 내보내고
 * 불러오는 일은 결국 같은 것을 직렬화한다. 두 벌로 두면 반드시 한쪽만
 * 갱신되어 어긋나므로 snapshot/restore 한 쌍만 두고 둘 다 그것을 쓴다.
 */
const Session = {
  KEY: 'pkSimulator.session',
  //: 담는 모양이 바뀌면 올린다. 예전 모양은 복원하지 않고 버린다 —
  //  반쯤 이해한 상태로 되살리면 화면이 조용히 어긋난다.
  VERSION: 2,
  _timer: null,
  _restoring: false,

  /** 지금 화면에 있는 것 전부를 평범한 객체로. */
  snapshot() {
    const stepsInput = document.getElementById('dropdown-sim-steps');
    const data = {
      version: this.VERSION,
      savedAt: new Date().toISOString(),
      ode: DOM.sidebar.odeInput.value,
      initials: {},
      parameters: {},
      doses: State.doseList,
      observations: State.observations,
      simulationSettings: {
        start: +DOM.toolbar.simStartTime.value,
        end: +DOM.toolbar.simEndTime.value,
        steps: stepsInput ? +stepsInput.value : 200,
        logScale: DOM.toolbar.logScaleCheckbox.checked,
        symbolOrder: State.symbolOrder,
        selectedCompartments: [...DOM.simulation.compartmentsMenu.querySelectorAll('.sim-comp-checkbox:checked')].map(e => e.value),
      },
      results: {
        simulation: State.latestSimulationResult,
        pk: State.latestPKSummary,
        fit: State.lastFitResult,
        sensitivity: (window.pkSensitivity && window.pkSensitivity.snapshot()) || null,
      },
    };

    State.compartments.forEach(c => {
      const el = DOM.sidebar.initValuesContainer.querySelector(`#init_${c}`);
      if (el) data.initials[c] = +el.value;
    });
    State.parameters.forEach(p => {
      const el = DOM.sidebar.paramValuesContainer.querySelector(`#param_${p}`);
      if (el) data.parameters[p] = +el.value;
    });
    return data;
  },

  /**
   * 객체를 화면으로 되돌린다.
   *
   * 파싱이 끝나야 파라미터 입력칸이 생기므로 반드시 기다린다. 예전 코드는
   * setTimeout(500) 으로 어림잡았는데, 서버가 느리면 그대로 실패하고
   * 아무 말도 하지 않았다.
   */
  async restore(data) {
    if (!data || !data.ode) return false;

    // 되돌리는 동안의 input/change 는 저장을 부르지 않는다. 아직 절반만
    // 채워진 상태를 덮어써 버리면 원본이 사라진다.
    this._restoring = true;
    try {
      DOM.sidebar.odeInput.value = data.ode;
      await Handlers.handleParseClick();

      Object.entries(data.parameters || {}).forEach(([key, value]) => {
        const el = DOM.sidebar.paramValuesContainer.querySelector(`#param_${key}`);
        if (el) el.value = value;
      });
      Object.entries(data.initials || {}).forEach(([key, value]) => {
        const el = DOM.sidebar.initValuesContainer.querySelector(`#init_${key}`);
        if (el) el.value = value;
      });

      State.doseList = data.doses || [];
      UI.renderDoses();

      State.observations = data.observations || [];
      UI.renderObsList();

      const settings = data.simulationSettings || {};
      DOM.toolbar.simStartTime.value = settings.start ?? 0;
      DOM.toolbar.simEndTime.value = settings.end ?? 48;
      if (document.getElementById('dropdown-sim-steps')) {
        document.getElementById('dropdown-sim-steps').value = settings.steps ?? 200;
      }
      DOM.toolbar.logScaleCheckbox.checked = !!settings.logScale;

      const selected = settings.selectedCompartments || State.compartments;
      DOM.simulation.compartmentsMenu.querySelectorAll('.sim-comp-checkbox').forEach(cb => {
        cb.checked = selected.includes(cb.value);
      });
      UI.updateSelectedBadges();

      // 결과는 다시 계산하지 않고 저장된 것을 그대로 그린다. 새로고침
      // 한 번에 서버를 다시 부르면 느릴 뿐 아니라 결과가 달라질 수도 있다
      // (그 사이 사이드바 값을 건드렸다면).
      const results = data.results || {};
      if (results.simulation) {
        State.latestSimulationResult = results.simulation;
        UI.plotSimulationResult(results.simulation, !!settings.logScale);
      }
      if (results.pk) {
        State.latestPKSummary = results.pk;
        UI.displayPKSummary(results.pk);
      }
      if (results.fit) {
        UI.renderFitResult(results.fit, { scroll: false });
      }
      if (results.sensitivity && window.pkSensitivity) {
        window.pkSensitivity.restore(results.sensitivity);
      }
      return true;
    } finally {
      this._restoring = false;
    }
  },

  save() {
    if (this._restoring) return;
    const data = this.snapshot();
    try {
      window.localStorage.setItem(this.KEY, JSON.stringify(data));
    } catch (error) {
      // 자리에서 가장 큰 것은 결과다. 모자라면 입력만이라도 남긴다 —
      // 다시 돌리면 되는 것보다 다시 입력해야 하는 것이 아깝다.
      try {
        data.results = null;
        data.resultsDropped = true;
        window.localStorage.setItem(this.KEY, JSON.stringify(data));
      } catch (again) {
        this.clear();
      }
    }
  },

  /** 값을 칠 때마다 저장하지 않도록 잠깐 모았다 쓴다. */
  saveSoon() {
    window.clearTimeout(this._timer);
    this._timer = window.setTimeout(() => this.save(), 400);
  },

  load() {
    try {
      const raw = window.localStorage.getItem(this.KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      return (data && data.version === this.VERSION) ? data : null;
    } catch (error) {
      return null;
    }
  },

  clear() {
    try { window.localStorage.removeItem(this.KEY); } catch (error) { /* 사생활 보호 모드 등 */ }
  },
};


/* ============================================================ */
/* Resize — 사이드바 너비와 플롯 높이를 사용자가 정한다            */
/* ============================================================ */
/**
 * 어느 쪽이 넓어야 하는지는 지금 무엇을 하는지에 달려 있다. ODE 를 고칠 때는
 * 왼쪽이, 결과를 읽을 때는 오른쪽이 넓어야 한다. 정답을 하나 고르는 대신
 * 손잡이를 준다.
 *
 * 크기는 세션이 아니라 localStorage 에 둔다 — 창을 어떻게 나눠 쓰는지는
 * 모델의 일부가 아니라 이 브라우저의 습관이다. (사이드바 접힘 상태와 같은 자리)
 */
const Resize = {
  SIDEBAR_KEY: 'pkSimulator.sidebarWidth',
  PLOT_KEY: 'pkSimulator.plotHeights',
  PLOTS: ['plot', 'fit-plot', 'sensitivity-plot'],

  init() {
    this._restoreSidebar();
    this._bindSidebar();
    this._restorePlotHeights();
    this._watchPlots();
    this.bindPrint();
  },

  /* ---------------- 사이드바 ---------------- */
  /** 지금 창에서의 폭 한계. CSS 가 갖고 있는 값을 읽어 쓴다 — 두 곳에 적어
   *  두면 반드시 어긋난다. max-width 는 50vw 라 창을 줄이면 같이 줄어든다. */
  _limits() {
    const sidebar = document.querySelector('.sidebar');
    if (!sidebar) return { min: 308, max: 460 };
    const cs = getComputedStyle(sidebar);
    // 좁은 화면에서는 사이드바가 본문 위로 쌓이고 max-width 가 none 이 된다.
    // 거기서는 폭이 아무 뜻도 없으므로 자르지 않는다 — 자르면 창을 다시
    // 넓혔을 때 사용자가 정해 둔 폭이 임의의 값으로 바뀌어 있다.
    const max = parseFloat(cs.maxWidth);
    return {
      min: parseFloat(cs.minWidth) || 308,
      max: Number.isFinite(max) ? max : Infinity,
    };
  },

  _restoreSidebar() {
    let saved = null;
    try { saved = localStorage.getItem(this.SIDEBAR_KEY); } catch (e) { /* 무시 */ }
    if (!saved) return;

    // 넓은 모니터에서 정한 폭을 좁은 화면에서 그대로 되살리면 본문이 사라진다.
    const { min, max } = this._limits();
    const px = Math.min(Math.max(parseFloat(saved) || min, min), max);
    document.documentElement.style.setProperty('--apple-sidebar-width', px + 'px');
  },

  _bindSidebar() {
    const handle = document.getElementById('sidebar-resizer');
    const sidebar = document.querySelector('.sidebar');
    if (!handle || !sidebar) return;

    // min/max 는 CSS 가 이미 갖고 있다. 두 곳에 적어 두면 반드시 어긋나므로
    // 여기서 읽어 쓴다.
    const apply = (px) => {
      // 한계는 매번 다시 읽는다. max-width 가 50vw 라 창 크기를 따라 움직이므로,
      // 한 번 읽어 두면 창을 줄인 뒤로는 낡은 값을 쓰게 된다.
      const { min, max } = this._limits();
      const clamped = Math.min(Math.max(px, min), max);
      document.documentElement.style.setProperty('--apple-sidebar-width', clamped + 'px');
      return clamped;
    };

    let dragging = false;
    const onMove = (event) => {
      if (!dragging) return;
      // 사이드바는 왼쪽에 붙어 있으므로 포인터의 x 가 곧 너비다.
      apply(event.clientX - sidebar.getBoundingClientRect().left);
    };
    const stop = () => {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove('is-dragging');
      document.body.classList.remove('is-resizing');
      try {
        localStorage.setItem(this.SIDEBAR_KEY,
          getComputedStyle(document.documentElement).getPropertyValue('--apple-sidebar-width').trim());
      } catch (e) { /* 무시 */ }
      // 폭이 바뀌었으니 플롯도 다시 그려야 한다.
      this._resizePlots();
    };

    handle.addEventListener('pointerdown', (event) => {
      dragging = true;
      handle.classList.add('is-dragging');
      document.body.classList.add('is-resizing');
      handle.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);

    // 키보드로도 옮길 수 있어야 한다 — 손잡이가 tabindex 를 갖고 있다.
    handle.addEventListener('keydown', (event) => {
      const step = event.shiftKey ? 40 : 10;
      if (event.key === 'ArrowLeft') apply(sidebar.offsetWidth - step);
      else if (event.key === 'ArrowRight') apply(sidebar.offsetWidth + step);
      else return;
      event.preventDefault();
      stop.call(this);
      dragging = false;
    });
  },

  /* ---------------- 플롯 높이 ---------------- */
  /* CSS 의 resize:vertical 이 손잡이를 그려 주므로 드래그는 브라우저가 맡는다.
     우리가 할 일은 두 가지 — 바뀐 높이를 기억하고, Plotly 에게 알려 주는 것.
     Plotly 는 창 크기만 듣고 요소 크기는 듣지 않는다. */
  _restorePlotHeights() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(this.PLOT_KEY) || '{}'); } catch (e) { saved = {}; }
    this.PLOTS.forEach((id) => {
      const el = document.getElementById(id);
      if (el && saved[id]) el.style.height = saved[id];
    });
  },

  _savePlotHeights() {
    if (this._printing) return;
    const out = {};
    this.PLOTS.forEach((id) => {
      const el = document.getElementById(id);
      if (el && el.style.height) out[id] = el.style.height;
    });
    try { localStorage.setItem(this.PLOT_KEY, JSON.stringify(out)); } catch (e) { /* 무시 */ }
  },

  _resizePlots() {
    this.PLOTS.forEach((id) => {
      const el = document.getElementById(id);
      // 그려진 적 없는 컨테이너에 resize 를 걸면 Plotly 가 던진다.
      if (el && el.offsetParent !== null && el.querySelector('.main-svg')) {
        try { Plotly.Plots.resize(el); } catch (e) { /* 무시 */ }
      }
    });
  },

  /* 인쇄할 때는 플롯을 종이 크기로 줄였다가 되돌린다.
     CSS 로 컨테이너만 줄이면 Plotly 의 SVG 는 그대로 남아 그림이 잘린다.
     Plotly 에게 직접 말해 줘야 다시 그린다. */
  PRINT_HEIGHT: 300,
  _printing: false,

  bindPrint() {
    let saved = null;
    window.addEventListener('beforeprint', () => {
      // 인쇄용으로 줄이는 것은 사용자가 정한 크기가 아니다. 관찰자가 그걸
      // 취향으로 오해해 저장하면, 인쇄 한 번에 화면 설정이 바뀐다.
      this._printing = true;
      saved = {};
      this.PLOTS.forEach((id) => {
        const el = document.getElementById(id);
        if (!el || !el.querySelector('.main-svg')) return;
        saved[id] = el.style.height;
        el.style.height = this.PRINT_HEIGHT + 'px';
        try { Plotly.Plots.resize(el); } catch (e) { /* 무시 */ }
      });
    });
    window.addEventListener('afterprint', () => {
      if (!saved) return;
      Object.entries(saved).forEach(([id, height]) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.style.height = height;
        try { Plotly.Plots.resize(el); } catch (e) { /* 무시 */ }
      });
      saved = null;
      this._printing = false;
    });
  },

  _watchPlots() {
    if (typeof ResizeObserver === 'undefined') return;
    let timer = null;
    const observer = new ResizeObserver(() => {
      this._resizePlots();
      window.clearTimeout(timer);
      timer = window.setTimeout(() => this._savePlotHeights(), 400);
    });
    this.PLOTS.forEach((id) => {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    });
  },
};


const App = {
  /**
   * 애플리케이션을 초기화하는 메인 함수.
   */
  init() {
    console.log("Application initializing...");

    // 저장된 표시 순서 설정을 복원해 라디오 버튼에 반영
    const order = SymbolOrder.load();
    DOM.sidebar.symbolOrderRadios.forEach(r => { r.checked = (r.value === order); });

    this._bindEvents();
    this._initialRender();
    Resize.init();
    this._restoreSession();
  },

  /**
   * 새로고침해도 하던 일이 남아 있게 한다.
   *
   * 되살리다 실패하면 저장본을 버린다. 깨진 저장본을 그대로 두면 새로고침할
   * 때마다 같은 자리에서 넘어져 앱을 열 수 없게 된다 — 한 번은 잃더라도
   * 다음 새로고침은 되게 하는 편이 낫다.
   */
  async _restoreSession() {
    const saved = Session.load();
    if (!saved) return;
    try {
      await Session.restore(saved);
    } catch (error) {
      console.error("Could not restore the previous session:", error);
      Session.clear();
    }
  },

  /**
   * 모든 DOM 요소에 이벤트 리스너를 연결하는 '비공개' 헬퍼 함수.
   */
  _bindEvents() {
    // --- 사이드바 이벤트 바인딩 ---
    DOM.sidebar.parseBtn.addEventListener('click', Handlers.handleParseClick);
    DOM.sidebar.symbolOrderRadios.forEach(r =>
      r.addEventListener('change', Handlers.handleSymbolOrderChange));
    DOM.sidebar.showProcessedBtn.addEventListener('click', Handlers.handleShowProcessedClick);
    DOM.sidebar.doseForm.addEventListener('submit', Handlers.handleDoseFormSubmit);
    DOM.sidebar.doseTypeSelect.addEventListener('change', Handlers.handleDoseTypeChange);
    DOM.sidebar.doseListContainer.addEventListener('click', Handlers.handleDoseListClick);
    
    // Dosing 폼의 'Repeat' 토글 스위치 이벤트
    const repeatToggle = document.getElementById('repeat-dose-toggle');
    const repeatFields = document.getElementById('repeat-dose-fields');
    if(repeatToggle && repeatFields) {
        repeatToggle.addEventListener('change', (event) => {
            repeatFields.style.display = event.target.checked ? 'block' : 'none';
        });
    }

    // --- 메인 툴바 이벤트 바인딩 ---
    DOM.toolbar.logScaleCheckbox.addEventListener('change', () => { // 로그 스케일 변경 시 즉시 플롯을 다시 그림
      if(State.latestSimulationResult) {
        UI.plotSimulationResult(State.latestSimulationResult, DOM.toolbar.logScaleCheckbox.checked);
      }
    });
    DOM.toolbar.simulateBtn.addEventListener('click', Handlers.handleSimulateClick);
    DOM.toolbar.fitBtn.addEventListener('click', Handlers.handleFitBtnClick);

    // --- 시뮬레이션 구획 선택 이벤트 바인딩 ---
    DOM.simulation.compartmentsMenu.addEventListener('change', Handlers.handleSimCompMenuChange);
    DOM.simulation.selectedCompBadges.addEventListener('click', Handlers.handleBadgeClick);

    // --- 관찰 데이터(Offcanvas) 이벤트 바인딩 ---
    DOM.modals.obsData.fileInput.addEventListener('change', Handlers.handleObsFileChange);
    DOM.modals.obsData.panel.addEventListener('click', Handlers.handleObsPanelClick);
    DOM.modals.obsData.panel.addEventListener('change', Handlers.handleObsPanelChange);

    // --- 심볼 편집 모달 이벤트 바인딩 ---
    DOM.sidebar.editSymbolsBtn.addEventListener('click', () => { // 심볼 편집 모달 열기
      UI.renderSymbolEditorModal(State.compartments, State.parameters);
    });
    DOM.modals.editSymbols.element.addEventListener('click', Handlers.handleSymbolEditorClick); // 모달 내부 클릭
    DOM.modals.editSymbols.saveBtn.addEventListener('click', Handlers.handleSaveChangesClick); // 모달 내부 'Save Changes' 버튼 클릭

    // --- 피팅 모달 이벤트 바인딩 ---
    DOM.modals.fittingSettings.paramList.addEventListener('change', Handlers.handleFitParamCheckboxChange);
    DOM.modals.fittingSettings.addGroupBtn.addEventListener('click', Handlers.handleAddFittingGroupClick);
    DOM.modals.fittingSettings.groupsContainer.addEventListener('click', Handlers.handleFittingGroupEvents);
    DOM.modals.fittingSettings.groupsContainer.addEventListener('change', Handlers.handleFittingGroupChange);
    // 사용자가 용량을 직접 고치면 "데이터에서 가져왔다"는 표시를 뗀다.
    DOM.modals.fittingSettings.groupsContainer.addEventListener('input', (e) => {
      if (!e.target.classList.contains('group-dose-amount')) return;
      delete e.target.dataset.autofilled;
      const hint = e.target.closest('.fitting-group-card')?.querySelector('.group-dose-hint');
      if (hint) hint.hidden = true;
    });
    document.querySelectorAll('input[name="fitObjective"]').forEach(el =>
      el.addEventListener('change', () => UI.applyFitObjective()));
    document.getElementById('fit-apply-btn')?.addEventListener('click', Handlers.handleApplyFitClick);
    document.getElementById('fit-apply-modal-btn')?.addEventListener('click', Handlers.handleApplyFitClick);
    DOM.modals.fittingSettings.startBtn.addEventListener('click', () => Handlers.handleStartFittingClick());
    DOM.modals.fittingSettings.fetchInitialParamsBtn.addEventListener('click', Handlers.handleFetchInitialParamsClick);

    // --- Export 버튼 이벤트 바인딩 ---
    if(DOM.results.exportProfileBtn) DOM.results.exportProfileBtn.addEventListener('click', Handlers.handleExportProfileClick);
    if(DOM.results.exportSummaryBtn) DOM.results.exportSummaryBtn.addEventListener('click', Handlers.handleExportSummaryClick);
    if(DOM.results.exportPlotBtn) DOM.results.exportPlotBtn.addEventListener('click', Handlers.handleExportPlotClick);
    document.getElementById('export-report-btn')?.addEventListener('click', Handlers.handleExportReportClick);
    window.addEventListener('beforeprint', () => UI.fillReportHead());
    if(DOM.results.exportSessionBtn) DOM.results.exportSessionBtn.addEventListener('click', Handlers.handleExportSessionClick);
    if(DOM.results.importSessionInput) DOM.results.importSessionInput.addEventListener('change', Handlers.handleImportSessionChange);

    // --- 자동저장 ---
    // 값이 바뀌는 자리를 하나씩 찾아다니는 대신 문서 단위로 듣는다. 입력칸이
    // 파싱 뒤에 만들어지고 그룹 카드가 동적으로 늘어나는 앱이라, 개별 바인딩은
    // 반드시 새로 생긴 것을 빠뜨린다.
    document.addEventListener('input', () => Session.saveSoon());
    document.addEventListener('change', () => Session.saveSoon());
    // 결과는 위 두 이벤트로 잡히지 않으므로 만들어진 자리에서 직접 부른다.
    window.addEventListener('pk:result', () => Session.saveSoon());
  },

  /**
   * 페이지 로드 시 필요한 초기 UI를 렌더링합니다.
   */
  _initialRender() {
    UI.renderDoses();
    UI.renderObsList();
    UI.updateSelectedBadges();
  }
};


// =======================================================
// =============== 애플리케이션 실행 (점화!) ===============
// =======================================================

document.addEventListener('DOMContentLoaded', () => App.init());
