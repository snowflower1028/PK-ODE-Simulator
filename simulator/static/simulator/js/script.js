const State = {
  // 1. 투여 관련 상태
  doseList: [],

  // 2. 관찰 데이터 관련 상태
  observations: [], // 기존 window._obs를 대체하며, 이름을 더 명확하게 변경
  
  // 3. 모델 파싱 결과 상태
  compartments: [],       // 기존 window._compartments 대체
  parameters: [],         // 기존 window._parameters 대체
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
const PK_TABLE_CONFIG = [
  {
    key: 'Cmax',                  // State 데이터의 키 이름
    displayName: 'C<sub>max</sub>', // 화면에 표시될 이름 (HTML 태그 사용 가능)
  },
  {
    key: 'Tmax',
    displayName: 'T<sub>max</sub> (h)',
  },
  {
    key: 'AUC',
    displayName: 'AUC',
  },
  {
    key: 'Clearance',
    displayName: 'Clearance',
  },
  {
    key: 'HL_half_life',
    displayName: 'Half-life (h)',
  },
  // 예시: 나중에 Vd를 추가하고 싶다면 아래 한 줄만 추가하면 끝입니다.
  // { key: 'Vd', displayName: 'Vd' }
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
    const { compartments, parameters, derivedExpressions } = State;
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
      // 투여 정보를 요약하는 텍스트 생성
      let summaryText = `Amount of "${d.amount}" of ${d.type} to <strong>${d.compartment}</strong> at ${d.start_time}h`;
      if (d.type === 'infusion' && d.duration > 0) {
          summaryText += ` over ${d.duration}h`;
      }
      if (d.repeat_every && d.repeat_until) {
          summaryText += ` (repeats every ${d.repeat_every}h until ${d.repeat_until}h)`;
      }

      return `
        <div class="dose-badge">
          <span>${summaryText}</span>
          <button class="btn-close btn-close-white btn-sm remove-dose-btn" data-index="${i}" title="Remove dose"></button>
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
      xaxis: { title: "Time (h)", zeroline: false, gridcolor: 'rgba(0,0,0,0.05)' },
      yaxis: {
          title: "Concentration",
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
    
    Plotly.react(plotContainer, traces, layout, { responsive: true });
    plotPlaceholder.style.display = "none";
    plotContainer.style.display = "block";
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

      // --- [핵심 변경 로직 시작] ---

      // 1. 설정을 기반으로 동적으로 테이블 헤더 생성
      const headers = ['<th>Compartment</th>'] // 첫 번째 컬럼은 고정
        .concat(PK_TABLE_CONFIG.map(col => `<th>${col.displayName}</th>`))
        .join('');

      // 2. 각 데이터 행에 대해, 설정을 기반으로 동적으로 데이터 셀(<td>) 생성
      const rows = dataArray.map((entry) => {
        const compartmentCell = `<td>${entry.compartment || 'N/A'}</td>`;
        
        const valueCells = PK_TABLE_CONFIG.map(col => {
          const value = entry[col.key]; // 설정의 key를 사용해 데이터 값 조회
          const formattedValue = typeof value === 'number' ? value.toPrecision(4) : "-";
          return `<td>${formattedValue}</td>`;
        }).join('');
        
        return `<tr>${compartmentCell}${valueCells}</tr>`;
      }).join("");

      // --- [핵심 변경 로직 끝] ---

      // 3. 최종 HTML 조합
      pkSummaryContainer.innerHTML = `
        <div class="table-responsive">
          <table class="table table-sm table-hover"> 
            <thead class="table-light">
              <tr>${headers}</tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`;

      pkSummaryPlaceholder.style.display = "none";
      pkSummaryContainer.style.display = "block";
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
              <div class="text-muted small" style="font-size: 0.75rem;">Current: ${currentValue}</div>
            </td>
            <td class="align-middle">
              <div class="btn-group btn-group-sm" role="group" aria-label="Parameter Scope">
                <input type="radio" class="btn-check param-scope-radio" name="scope_${p_name}" id="scope_${p_name}_g" value="global" checked disabled>
                <label class="btn btn-outline-secondary" for="scope_${p_name}_g" title="One value shared across all groups">Global</label>

                <input type="radio" class="btn-check param-scope-radio" name="scope_${p_name}" id="scope_${p_name}_l" value="local" disabled>
                <label class="btn btn-outline-secondary" for="scope_${p_name}_l" title="Individual value for each group">Local</label>
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

    // 6. Error Model 초기화 (기본값: Additive/Constant)
    const defaultErrModel = document.getElementById('errConst');
    if (defaultErrModel) defaultErrModel.checked = true;

    // 7. 진행 상태 섹션 숨기기 및 버튼 초기화
    const { progressSection, startBtn } = DOM.modals.fittingSettings;
    if (progressSection) progressSection.style.display = 'none';
    if (startBtn) {
      startBtn.disabled = false;
      startBtn.innerHTML = '<i class="bi bi-play-circle"></i> Start Fitting';
    }

    // 8. 모달 표시
    this._fittingModalInstance.show();
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
            
            <div class="col-md-4">
              <label class="form-label small">Dose Compartment</label>
              <select class="form-select form-select-sm group-dose-comp">
                ${compartmentOptions || `<option value="" selected disabled>Parse ODEs first</option>`}
              </select>
            </div>
            <div class="col-md-4">
              <label class="form-label small">Amount</label>
              <input type="number" step="any" class="form-control form-control-sm group-dose-amount" placeholder="e.g., 100" required>
            </div>
            <div class="col-md-4">
              <label class="form-label small">Time</label>
              <input type="number" step="any" class="form-control form-control-sm group-dose-time" value="0" required>
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
  updateInputFields(params) {
    params.forEach(p => {
      // 백엔드는 "ka (Global)" / "V (Group 2)" 형태의 표시용 이름을 보낸다.
      // 사이드바 입력칸(#param_ka)에 반영할 수 있는 것은 Global 파라미터뿐이므로
      // base_name 을 사용하고, scope 가 local 이거나 error 인 항목은 건너뛴다.
      if (p.scope && p.scope !== 'global') return;
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
    DOM.sidebar.doseTypeSelect.dispatchEvent(new Event('change')); // Infusion 필드 숨김 처리
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
    const summaryArray = summaryData.map(item => ({
        compartment: item.compartment,
        Cmax: item.Cmax,
        Tmax: item.Tmax,
        AUC: item.AUC,
        Clearance: item.Clearance,
        'Half-life': item['HL_half_life']
    }));
    exportSummaryToCsv(summaryArray, "pk_summary.csv");
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
    // 1. 현재 상태를 하나의 객체로 수집
    const sessionData = {
      ode: DOM.sidebar.odeInput.value,
      initials: {},
      parameters: {},
      doses: State.doseList,
      simulationSettings: {
        start: +DOM.toolbar.simStartTime.value,
        end: +DOM.toolbar.simEndTime.value,
        steps: +document.getElementById('dropdown-sim-steps').value,
        logScale: DOM.toolbar.logScaleCheckbox.checked,
        selectedCompartments: [...DOM.simulation.compartmentsMenu.querySelectorAll(".sim-comp-checkbox:checked")].map(e => e.value)
      }
    };

    State.compartments.forEach(c => {
      sessionData.initials[c] = +DOM.sidebar.initValuesContainer.querySelector(`#init_${c}`).value;
    });
    State.parameters.forEach(p => {
      sessionData.parameters[p] = +DOM.sidebar.paramValuesContainer.querySelector(`#param_${p}`).value;
    });

    // 2. JSON 문자열로 변환하여 파일로 다운로드
    const jsonString = JSON.stringify(sessionData, null, 2); // 2는 가독성을 위한 들여쓰기
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
        const sessionData = JSON.parse(e.target.result);

        // 1. ODE 입력창 채우고 파싱 실행
        DOM.sidebar.odeInput.value = sessionData.ode || "";
        await Handlers.handleParseClick();

        // 2. 파싱 후 UI가 업데이트될 시간을 잠시 대기
        setTimeout(() => {
          // 3. 파라미터 및 초기값 복원
          if(sessionData.parameters) {
            Object.entries(sessionData.parameters).forEach(([key, value]) => {
              const el = DOM.sidebar.paramValuesContainer.querySelector(`#param_${key}`);
              if (el) el.value = value;
            });
          }
          if(sessionData.initials) {
            Object.entries(sessionData.initials).forEach(([key, value]) => {
              const el = DOM.sidebar.initValuesContainer.querySelector(`#init_${key}`);
              if (el) el.value = value;
            });
          }

          // 4. 투여 계획(Dose) 복원
          State.doseList = sessionData.doses || [];
          UI.renderDoses();

          // 5. 시뮬레이션 설정 복원
          const settings = sessionData.simulationSettings || {};
          DOM.toolbar.simStartTime.value = settings.start || 0;
          DOM.toolbar.simEndTime.value = settings.end || 48;
          document.getElementById('dropdown-sim-steps').value = settings.steps || 200;
          DOM.toolbar.logScaleCheckbox.checked = settings.logScale || false;

          // 6. 선택된 Compartment 복원
          const selected = settings.selectedCompartments || State.compartments;
          DOM.simulation.compartmentsMenu.querySelectorAll('.sim-comp-checkbox').forEach(cb => {
            cb.checked = selected.includes(cb.value);
          });
          UI.updateSelectedBadges();

          alert('Session loaded successfully!');
        }, 500); // 0.5초 대기

      } catch (error) {
        alert('Failed to load or parse the session file. Please check if the file is a valid JSON.');
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
      return alert("⚠️ Upload and select observed data first for fitting.");
    }
    
    // 모든 조건 통과 시, UI 모듈에 모달을 열도록 요청합니다.
    UI.openFittingSettingsModal();
  },

  /**
   * 'Fetch Guesses & Set Bounds' 버튼 클릭을 처리합니다.
   * 메인 화면의 파라미터 값을 읽어와 선택된 피팅 파라미터의
   * 초기값으로 사용하고, 1/10배와 10배를 경계값으로 자동 설정합니다.
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
      
      // 1. 메인 화면에서 현재 파라미터 값을 가져옵니다.
      const mainInput = DOM.sidebar.paramValuesContainer.querySelector(`#param_${paramName}`);
      if (!mainInput) return;
      
      const initialValue = parseFloat(mainInput.value);
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
 * - 모달에서 설정된 파라미터 Scope(Global/Local), Bounds, Error Model, Fitting Groups 정보를 수집합니다.
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

      // 1-1. Scope 수집 (Global vs Local)
      // 모달에 해당 파라미터에 대한 라디오 버튼(name="scope_{pName}")이 있다고 가정
      const scopeRadio = document.querySelector(`input[name="scope_${pName}"]:checked`);
      const scope = scopeRadio ? scopeRadio.value : 'global'; // 기본값 global
      paramScopes[pName] = scope;

      // 1-2. Bounds 수집
      // Scope가 Local이더라도, 초기 Bounds는 사용자가 입력한 하나의 범위를 공통으로 적용한다고 가정
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

    // --- 2. 데이터 수집: Error Model (MLE) ---
    // 모달에 Error Model 라디오 버튼(name="errorModel")이 있다고 가정
    const errorModelRadio = document.querySelector('input[name="errorModel"]:checked');
    const errorModel = errorModelRadio ? errorModelRadio.value : 'constant'; // 기본값 constant (additive)

    // --- 3. 데이터 수집: 초기값 및 현재 파라미터 값 ---
    const initials = {};
    const currentParams = {};
    State.compartments.forEach(c => {
      const val = parseFloat(DOM.sidebar.initValuesContainer.querySelector(`#init_${c}`).value);
      initials[c] = isNaN(val) ? 0 : val;
    });
    State.parameters.forEach(p => {
      const val = parseFloat(DOM.sidebar.paramValuesContainer.querySelector(`#param_${p}`).value);
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

      const selectedObs = State.observations[parseInt(obsIndexStr, 10)];

      fittingGroups.push({
        doses: [{ compartment: comp, type: 'bolus', amount: amount, start_time: time }],
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
      
      // [신규 기능] 파라미터 범위 및 에러 모델 정보 추가
      param_scopes: paramScopes,
      error_model: errorModel,
      
      // 기존 weighting 필드는 error_model로 대체되므로 필요하다면 하위 호환성을 위해 남겨두거나 제거
      weighting: 'none' 
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
      
      // 결과 요약 테이블 렌더링 (Global/Local 파라미터 모두 포함됨)
      // response.data.params는 [{name: "V (Group 1)", value: ...}, ...] 형태일 수 있음
      UI.renderFitSummary(response.data.params, response.data.ssr_total);

      // 메인 입력창 업데이트 (Global 파라미터 이름이 정확히 일치하는 경우에만 업데이트)
      // Local 파라미터는 메인 입력창에 1:1로 매핑되지 않으므로 건너뜀
      if (response.data.params && Array.isArray(response.data.params)) {
          // 배열 형태의 params를 {name: value} 객체로 변환 (Global param 업데이트용)
          const simpleParams = {};
          response.data.params.forEach(p => {
              // 이름에 "(Group ...)" 등이 없는 순수 파라미터명인 경우만 추출 시도
              // 하지만 백엔드에서 이름을 변경해서 보낸다면 이 로직은 수정 필요
              // 여기서는 단순성을 위해 그대로 둠.
              simpleParams[p.name] = p.value;
          });
          UI.updateInputFields(response.data.params); 
      }

      // 피팅된 값으로 자동 시뮬레이션 실행 (결과 시각화)
      this.handleSimulateClick(); 
      
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
  handleFittingGroupEvents(event) {
    if (event.target.classList.contains('remove-fitting-group-btn')) {
      event.target.closest('.fitting-group-card')?.remove();
    }
  },
};

const App = {
  /**
   * 애플리케이션을 초기화하는 메인 함수.
   */
  init() {
    console.log("Application initializing...");

    this._bindEvents();
    this._initialRender();
  },

  /**
   * 모든 DOM 요소에 이벤트 리스너를 연결하는 '비공개' 헬퍼 함수.
   */
  _bindEvents() {
    // --- 사이드바 이벤트 바인딩 ---
    DOM.sidebar.parseBtn.addEventListener('click', Handlers.handleParseClick);
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
    DOM.modals.fittingSettings.startBtn.addEventListener('click', () => Handlers.handleStartFittingClick());
    DOM.modals.fittingSettings.fetchInitialParamsBtn.addEventListener('click', Handlers.handleFetchInitialParamsClick);

    // --- Export 버튼 이벤트 바인딩 ---
    if(DOM.results.exportProfileBtn) DOM.results.exportProfileBtn.addEventListener('click', Handlers.handleExportProfileClick);
    if(DOM.results.exportSummaryBtn) DOM.results.exportSummaryBtn.addEventListener('click', Handlers.handleExportSummaryClick);
    if(DOM.results.exportPlotBtn) DOM.results.exportPlotBtn.addEventListener('click', Handlers.handleExportPlotClick);
    if(DOM.results.exportSessionBtn) DOM.results.exportSessionBtn.addEventListener('click', Handlers.handleExportSessionClick);
    if(DOM.results.importSessionInput) DOM.results.importSessionInput.addEventListener('change', Handlers.handleImportSessionChange);
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
