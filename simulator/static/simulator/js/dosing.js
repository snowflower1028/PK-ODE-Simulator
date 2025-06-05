/*───────────────────────────────*
 * dosing.js  (PK Simulator UI) *
 *───────────────────────────────*/

const doseList    = [];
let   fitTimer    = null;        // 진행 타이머

/*─────────────────────────────────────────────*
 * 1. 오프-캔버스 Observed Data 관리 초기화
 *─────────────────────────────────────────────*/
window._obs = [];                // [{name,color,data,selected}]
const COLORS = ["#d9534f","#0275d8","#5cb85c","#f0ad4e","#6f42c1"];

function pickColor() {
  return COLORS[window._obs.length % COLORS.length];
}

/* CSV → 객체 {Time:[], Col1:[], …} */
function parseCsv(file) {
  return new Promise(res => {
    const fr = new FileReader();
    fr.onload = ev => {
      const lines = ev.target.result.split(/\r?\n/).filter(Boolean);
      const head  = lines[0].split(",").map(h => h.trim());
      const tIdx  = head.findIndex(h => h.toLowerCase() === "time");
      if (tIdx === -1) {
        alert(`'Time' column missing in ${file.name}`);
        return;
      }
      const obj = {}, T = [];
      head.forEach((h, i) => { if (i !== tIdx) obj[h] = []; });
      for (let i = 1; i < lines.length; i++) {
        const vals = lines[i].split(",");
        if (vals.length <= tIdx) continue;
        T.push(+vals[tIdx]);
        head.forEach((h, j) => {
          if (j === tIdx) return;
          const v = parseFloat(vals[j]);
          obj[h].push(Number.isNaN(v) ? null : v);
        });
      }
      res({ Time: T, ...obj });
    };
    fr.readAsText(file);
  });
}

/* Observed 데이터 업로드 이벤트 */
document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("obs-file").addEventListener("change", e => {
    [...e.target.files].forEach(f => {
      parseCsv(f).then(data => {
        window._obs.push({
          name: f.name,
          color: pickColor(),
          data: data,
          selected: true
        });
        renderObsList();
      });
    });
    e.target.value = ""; // 동일 파일 재업로드 허용
  });

  /* 목록 클릭/체크박스 처리 */
  document.getElementById("obs-list").addEventListener("click", e => {
    const li = e.target.closest("li");
    if (!li) return;
    const idx = [...li.parentNode.children].indexOf(li);
    if (e.target.classList.contains("obs-check")) {
      window._obs[idx].selected = e.target.checked;
    } else if (!e.target.closest("button")) { // 삭제 버튼 클릭이 아닐 때만 미리보기
      renderPreview(idx);
    }
  });
});

/* Observed List 그리기 */
function renderObsList() {
  const ul = document.getElementById("obs-list");
  if (window._obs.length === 0) {
    ul.innerHTML = `<div class="placeholder-text">No observed data uploaded.</div>`; // Placeholder 스타일 적용
    renderPreview(); // 미리보기 초기화
    return;
  }
  ul.innerHTML = window._obs.map((o, i) => `
    <li class="list-group-item d-flex justify-content-between align-items-center">
      <div>
        <input type="checkbox" class="form-check-input me-2 obs-check" data-idx="${i}"
               ${o.selected ? "checked" : ""}>
        <span style="color:${o.color}">●</span> ${o.name}
      </div>
      <button class="btn btn-sm btn-outline-danger" onclick="removeObs(${i})">🗑️</button>
    </li>
  `).join("");
  renderPreview(); // 첫 번째 선택된 항목 또는 첫 번째 항목으로 미리보기 업데이트
}

/* Observed 삭제 */
window.removeObs = i => {
  window._obs.splice(i, 1);
  renderObsList();
};

/* Observed 미리보기 */
function renderPreview(idx = null) {
  const box = document.getElementById("obs-preview");
  if (idx === null) idx = window._obs.findIndex(o => o.selected); // 첫 번째 선택된 항목
  if (idx === null && window._obs.length > 0) idx = 0; // 선택된 항목 없으면 첫 번째 항목

  if (idx === -1 || idx === null || !window._obs[idx]) { // 유효한 인덱스 및 데이터 확인
    box.innerHTML = `<div class="placeholder-text small">No data to preview or select an item.</div>`; // Placeholder 스타일 적용
    return;
  }

  const obj = window._obs[idx].data;
  const cols = Object.keys(obj);
  const n = Math.min(5, obj.Time.length); // 최대 5줄 미리보기
  if (obj.Time.length === 0) {
    box.innerHTML = `<div class="placeholder-text small">Selected data is empty.</div>`;
    return;
  }

  let html = "<table class='table table-sm table-bordered'><thead><tr>";
  cols.forEach(c => html += `<th>${c}</th>`);
  html += "</tr></thead><tbody>";
  for (let i = 0; i < n; i++) {
    html += "<tr>";
    cols.forEach(c => html += `<td>${obj[c][i] === null ? '-' : obj[c][i]}</td>`); // null 값 처리
    html += "</tr>";
  }
  html += "</tbody></table>";
  if (obj.Time.length > n) {
    html += `<p class="text-muted small text-center mt-1">Showing first ${n} rows...</p>`;
  }
  box.innerHTML = html;
}

/* 선택된 Observed 데이터만 반환 */
function getSelectedObs() {
  return window._obs.filter(o => o.selected).map(o => o.data);
}

/*─────────────────────────────────────────────*
 * 2. DOM 준비 (기존 요소 초기화)
 *─────────────────────────────────────────────*/
document.addEventListener("DOMContentLoaded", () => {
  /* IV infusion duration 토글 */
  document.getElementById("type").addEventListener("change", e => {
    document.getElementById("duration-label").style.display =
      e.target.value === "infusion" ? "flex" : "none"; // 'block' 대신 'flex' (row class 사용 시)
  });

  /* 시뮬 compartment badge 업데이트 */
  document.addEventListener("change", e => {
    if (e.target.classList.contains("sim-comp-checkbox")) updateSelectedBadges();
  });
  document.getElementById("selected-comp-badges").addEventListener("click", e => {
    if (e.target.classList.contains("badge")) {
      const c = e.target.textContent.trim(); // trim() 추가
      const checkbox = document.querySelector(`.sim-comp-checkbox[value="${c}"]`);
      if (checkbox) {
        checkbox.checked = false;
        updateSelectedBadges();
      }
    }
  });

  /* Dosing form submit */
  document.getElementById("dose-form").addEventListener("submit", e => {
    e.preventDefault();
    const formData = new FormData(e.target);
    const d = {
      compartment: formData.get("compartment"),
      type: formData.get("type"),
      amount: +formData.get("amount"),
      start_time: +formData.get("start_time"),
      duration: +formData.get("duration") || 0,
      repeat_every: +formData.get("repeat_every"),
      repeat_until: +formData.get("repeat_until")
    };
    // ID로 직접 접근하는 대신 FormData 사용 또는 각 ID로 값 가져오기
    // const d = {
    //   compartment: document.getElementById("compartment").value,
    //   type: document.getElementById("type").value,
    //   amount: +document.getElementById("amount").value,
    //   start_time: +document.getElementById("start_time").value,
    //   duration: +document.getElementById("duration").value || 0,
    //   repeat_every: +document.getElementById("repeat_every").value,
    //   repeat_until: +document.getElementById("repeat_until").value
    // };
    if (Number.isNaN(d.repeat_every) || d.repeat_every <= 0) d.repeat_every = null;
    if (Number.isNaN(d.repeat_until) || d.repeat_until <= 0) d.repeat_until = null;

    doseList.push(d);
    renderDoses();
    e.target.reset();
    document.getElementById("type").dispatchEvent(new Event('change')); // Infusion duration 필드 상태 업데이트
  });

  // 페이지 로드 시 초기 placeholder 상태 설정
  updateSelectedBadges();
  renderDoses();
  renderObsList(); // 관찰 데이터 목록 및 미리보기 초기화
});

/*─────────────────────────────────────────────*
 * 3. ODE Parsing
 *─────────────────────────────────────────────*/
function parseODE() {
  const odeInputEl = document.getElementById("ode-input");
  if (!odeInputEl.value.trim()) {
    alert("ODE input is empty.");
    return;
  }
  // 로딩 상태 표시 (필요시)
  fetch("/parse/", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRFToken": getCSRFToken() },
    body: JSON.stringify({ text: odeInputEl.value })
  })
  .then(r => {
    if (!r.ok) throw new Error(`Server error: ${r.status}`);
    return r.json();
  })
  .then(dat => {
    if (dat.status !== "ok") {
        alert("Parse failed: " + (dat.message || "Unknown error"));
        renderSymbolInputs(null, null, null); // 파싱 실패 시 placeholder 표시
        return;
    }
    const { compartments, parameters, processed_ode, derived_expressions } = dat.data;
    window._compartments = compartments;
    window._parameters   = parameters;
    window._processedODE = processed_ode;
    window._derivedExpressions = derived_expressions || {}; // derived_expressions가 없을 수 있음
    renderSymbolInputs(compartments, parameters, window._derivedExpressions);
  })
  .catch(err => {
    alert("Parse request error: " + err.message);
    renderSymbolInputs(null, null, null); // 네트워크 오류 등 발생 시 placeholder 표시
  });
}

/*─────────────────────────────────────────────*
 * 4. Value-input renderer
 *─────────────────────────────────────────────*/
function renderSymbolInputs(comps, pars, derived) {
  const initDiv  = document.getElementById("init-values");
  const paramDiv = document.getElementById("param-values");
  const cmpSel = document.getElementById("compartment"); // Dosing compartment select
  const simMenu = document.getElementById("sim-compartments-menu"); // Simulation compartment select menu

  initDiv.innerHTML = "";
  paramDiv.innerHTML = "";
  cmpSel.innerHTML = "";
  simMenu.innerHTML = "";

  // Initial Values 영역 처리
  if (comps && comps.length > 0) {
    comps.forEach(c => {
      initDiv.insertAdjacentHTML("beforeend", `
        <div class="d-flex align-items-center mb-2 parameter-entry"> <label for="init_${c}" class="form-label mb-0 me-2 text-end" style="width:70px;">${c}(0):</label> <input type="number" step="any" value="0"
                 id="init_${c}" name="init_${c}"
                 class="form-control form-control-sm flex-grow-1">
        </div>`);
    });
  } else {
    initDiv.innerHTML = `<div class="placeholder-text">No compartments defined or ODEs not parsed yet.</div>`;
  }

  // Parameter Values 영역 처리
  if (pars && pars.length > 0) {
    pars.forEach(p => {
      paramDiv.insertAdjacentHTML("beforeend", `
        <div class="d-flex align-items-center mb-2 parameter-entry"> <label for="param_${p}" class="form-label mb-0 me-2 text-end" style="width:70px;">${p}:</label> <input type="number" step="any" value="0.1" id="param_${p}" name="param_${p}"
                 class="form-control form-control-sm flex-grow-1">
          <div class="form-check ms-2" style="width:auto;">
            <input type="checkbox" class="form-check-input fit-checkbox" data-param="${p}"
                   id="fit_check_${p}" title="Include ${p} in fitting">
            <label class="form-check-label visually-hidden" for="fit_check_${p}">Fit ${p}</label>
          </div>
        </div>`);
    });
    // Derived-param display
    if (derived) { // derived가 null/undefined가 아닐 때만 실행
        Object.entries(derived)
          .filter(([k]) => !pars.includes(k)) // 이미 파라미터로 있는 것은 제외
          .forEach(([k, expr]) => {
            paramDiv.insertAdjacentHTML("beforeend", `
              <div class="derived-box"><i class="bi bi-calculator me-1"></i><strong>${k}</strong> = ${expr}</div>`);
          });
    }
  } else if (comps && comps.length > 0) {
    paramDiv.innerHTML = `<div class="placeholder-text">No parameters found in the parsed ODEs.</div>`;
  } else {
    paramDiv.innerHTML = `<div class="placeholder-text">No parameters defined or ODEs not parsed yet.</div>`;
  }

  // Dose & sim compartment selectors 처리
  if (comps && comps.length > 0) {
    cmpSel.innerHTML = comps.map(c => `<option value="${c}">${c}</option>`).join("");
    simMenu.innerHTML = comps.map(c => `
      <li><label class="dropdown-item py-1"> <input type="checkbox" class="form-check-input me-2 sim-comp-checkbox" value="${c}" checked>
          ${c}</label></li>`).join("");
  } else {
    cmpSel.innerHTML = `<option value="" disabled selected>N/A</option>`; // value="" 추가
    simMenu.innerHTML = `<li><span class="dropdown-item-text placeholder-text" style="font-size:0.9em; padding: 0.25rem 1rem; min-height:auto; border:none; background-color:transparent;">No compartments available.</span></li>`;
  }
  updateSelectedBadges();
}

/*─────────────────────────────────────────────*
 * 5. Simulation
 *─────────────────────────────────────────────*/
let simRunning = false;
document.getElementById("simulate-btn").addEventListener("click", () => { // 직접 onclick 대신 addEventListener 사용
  if (simRunning) return;
  if (!window._compartments || !window._parameters) {
    alert("Please parse ODEs first.");
    return;
  }

  simRunning = true;
  const simulateBtn = document.getElementById("simulate-btn");
  const originalBtnHTML = simulateBtn.innerHTML;
  simulateBtn.disabled = true;
  simulateBtn.innerHTML = `
    <span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>
    Running...
  `;

  const odeText  = document.getElementById("ode-input").value.trim();
  const t0       = +document.getElementById("sim-start-time").value;
  const t1       = +document.getElementById("sim-end-time").value;
  const nSteps   = +document.getElementById("sim-steps").value;
  const logScale = document.getElementById("log-scale").checked;
  const selComps = [...document.querySelectorAll(".sim-comp-checkbox:checked")]
                      .map(e => e.value);

  if (selComps.length === 0) {
    alert("Please select at least one compartment to simulate.");
    simRunning = false;
    simulateBtn.disabled = false;
    simulateBtn.innerHTML = originalBtnHTML;
    return;
  }

  const initials = {}, params = {};
  try {
    window._compartments.forEach(c => {
      const el = document.querySelector(`input[name="init_${c}"]`);
      if (!el) throw new Error(`Initial value input for ${c} not found.`);
      initials[c] = +el.value;
      if (Number.isNaN(initials[c])) throw new Error(`Initial value for ${c} is not a valid number.`);
    });
    window._parameters.forEach(p => {
      const el = document.querySelector(`input[name="param_${p}"]`);
      if (!el) throw new Error(`Parameter value input for ${p} not found.`);
      params[p] = +el.value;
      if (Number.isNaN(params[p])) throw new Error(`Parameter value for ${p} is not a valid number.`);
    });
  } catch (err) {
    alert(`Input error: ${err.message}`);
    simRunning = false;
    simulateBtn.disabled = false;
    simulateBtn.innerHTML = originalBtnHTML;
    return;
  }


  fetch("/simulate/", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRFToken": getCSRFToken() },
    body: JSON.stringify({
      equations: odeText, // `window._processedODE` 대신 원본 텍스트 전송 (서버에서 파싱 가정)
      compartments: selComps, // 시뮬레이션 대상 구획만 전송
      parameters: params,
      initials: initials,
      doses: doseList,
      t_start: t0,
      t_end: t1,
      t_steps: nSteps,
      // log_scale: logScale // logScale은 클라이언트 측에서만 사용
    })
  })
  .then(r => {
    if (!r.ok) return r.json().then(err => { throw new Error(err.message || `Server error: ${r.status}`) });
    return r.json();
  })
  .then(d => {
    if (d.status !== "ok") throw new Error(d.message || "Simulation failed with unknown server error.");
    plotSimulationResult(d.data.profile, logScale, selComps); // logScale 전달
    displayPKSummary(d.data.pk);
    document.getElementById("plot-placeholder").style.display = "none";
    document.getElementById("plot").style.display = "block";
    document.getElementById("pk-summary-placeholder").style.display = "none";
    document.getElementById("pk-summary").style.display = "block";

  })
  .catch(err => alert("Simulation error: " + err.message))
  .finally(() => {
    simRunning = false;
    simulateBtn.disabled = false;
    simulateBtn.innerHTML = originalBtnHTML;
  });
});

/*─────────────────────────────────────────────*
 * 6. Non-linear Fitting
 *─────────────────────────────────────────────*/
document.getElementById("fit-btn").addEventListener("click", () => { // 직접 onclick 대신 addEventListener 사용
  if (!window._compartments || !window._parameters) {
    alert("Please parse ODEs first.");
    return;
  }
  const selObs = getSelectedObs();
  if (!selObs.length) return alert("⚠️ Upload and select observed data first.");

  const fitBtn = document.getElementById("fit-btn");
  const originalFitBtnHTML = fitBtn.innerHTML;


  const initials = {}, paramsToFit = {}; // params는 Fitting 대상이 아닌 값도 포함 가능, paramsToFit은 초기 추정치
  try {
    window._compartments.forEach(c => {
      const el = document.querySelector(`input[name="init_${c}"]`);
      if (!el) throw new Error(`Initial value input for ${c} not found.`);
      initials[c] = +el.value;
      if (Number.isNaN(initials[c])) throw new Error(`Initial value for ${c} is not a valid number.`);
    });
    window._parameters.forEach(p => {
      const el = document.querySelector(`input[name="param_${p}"]`);
      if (!el) throw new Error(`Parameter value input for ${p} not found.`);
      paramsToFit[p] = +el.value; // 모든 파라미터의 현재 값을 초기 추정치로 사용
      if (Number.isNaN(paramsToFit[p])) throw new Error(`Parameter value for ${p} is not a valid number.`);
    });
  } catch (err) {
    alert(`Input error: ${err.message}`);
    return;
  }

  const fitCheckedParams = [...document.querySelectorAll(".fit-checkbox:checked")]
                      .map(cb => cb.dataset.param);
  if (!fitCheckedParams.length) return alert("Select parameters to fit by checking the boxes.");


  fitBtn.disabled = true;
  fitBtn.innerHTML = `
    <span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>
    Fitting...
  `;

  const body = {
    equations: document.getElementById("ode-input").value.trim(),
    // compartments: window._compartments, // 서버에서 observed data의 compartment를 기준으로 추론하거나, 모든 compartment 전달
    initials: initials,
    parameters: paramsToFit, // 현재 UI의 파라미터 값을 초기 추정치로 전달
    observed: selObs,
    fit_params: fitCheckedParams, // 어떤 파라미터를 fitting할지 명시
    doses: doseList, // 도징 정보도 전달
    // t_start, t_end, t_steps는 observed data의 time range를 기반으로 서버에서 설정하거나, UI에서 가져올 수 있음
    t_start: +document.getElementById("sim-start-time").value,
    t_end: +document.getElementById("sim-end-time").value,
    t_steps: +document.getElementById("sim-steps").value,

  };

  const modalEl = document.getElementById("fitModal");
  const modal   = bootstrap.Modal.getOrCreateInstance(modalEl); // getOrCreateInstance 사용
  const msg     = modalEl.querySelector("#fit-msg");
  const elapsed = modalEl.querySelector("#fit-elapsed");
  const bar     = modalEl.querySelector("#fit-progress");
  const resBox  = modalEl.querySelector("#fit-result");

  msg.textContent = "Running nonlinear fitting…"; elapsed.textContent = "(0s)"; resBox.innerHTML = ""; bar.style.display = "block";
  modal.show();

  if (fitTimer) clearInterval(fitTimer);
  const t0 = Date.now();
  fitTimer = setInterval(() => {
    elapsed.textContent = ` (${Math.floor((Date.now() - t0) / 1000)}s)`;
  }, 1000);

  fetch("/fit/", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRFToken": getCSRFToken() },
    body: JSON.stringify(body)
  })
  .then(r => {
    if (!r.ok) return r.json().then(err => { throw new Error(err.message || `Server error: ${r.status}`) });
    return r.json();
  })
  .then(res => {
    if (res.status !== "ok") throw new Error(res.message || "Fitting failed with unknown server error.");

    updateInputFields(res.data.params); // Fit된 파라미터 값으로 UI 업데이트
    renderFitSummary(res.data.params, res.data.cost); // Fit 결과 요약 카드 표시
    autoSimulate(); // Fit된 파라미터로 자동 시뮬레이션 실행

    const rows = Object.entries(res.data.params)
      .map(([k, v]) => `<tr><td>${k}</td><td>${typeof v === 'number' ? v.toPrecision(6) : v}</td></tr>`)
      .join("");
    resBox.innerHTML = `
      <p class="mb-1"><strong>Fitted Parameters:</strong></p>
      <table class="table table-sm table-bordered mb-2">
        <thead class="table-light"><tr><th>Parameter</th><th>Value</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="small text-muted mb-0">Final Cost (SSR): ${typeof res.data.cost === 'number' ? res.data.cost.toFixed(4) : res.data.cost}</p>`;
    msg.textContent = "Fitting Done 🎉";
  })
  .catch(err => {
    msg.innerHTML = `<span class="text-danger"><strong>Error:</strong> ${err.message}</span>`;
  })
  .finally(() => {
    clearInterval(fitTimer); fitTimer = null; bar.style.display = "none";
    fitBtn.disabled = false;
    fitBtn.innerHTML = originalFitBtnHTML;
  });
});

/*─────────────────────────────────────────────*
 * 7. Helper functions (global)
 *─────────────────────────────────────────────*/
function updateInputFields(dict) {
  for (const [k, v] of Object.entries(dict)) {
    const el = document.getElementById(`param_${k}`);
    if (el) el.value = v;
  }
}
window.updateInputFields = updateInputFields; // 전역 스코프에 할당 (필요한 경우)

function renderFitSummary(dict, cost) {
  const card = document.getElementById("fit-summary-card");
  const box  = document.getElementById("fit-summary");
  if (!card || !box) return; // 요소가 없으면 종료

  const rows = Object.entries(dict)
    .map(([k, v]) => `<tr><td>${k}</td><td>${typeof v === 'number' ? v.toPrecision(6) : v}</td></tr>`)
    .join("");
  box.innerHTML = `
    <table class="table table-sm table-bordered mb-2">
      <thead class="table-light"><tr><th>Parameter</th><th>Value</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="small text-muted mb-0">Cost (SSR): ${typeof cost === 'number' ? cost.toFixed(4) : cost}</p>`;
  card.style.display = "block"; // Bootstrap d-none/d-block 클래스 사용 권장
}
window.renderFitSummary = renderFitSummary;

function autoSimulate() {
  // simulate-btn에 대한 참조를 가져와서 click 이벤트 트리거
  const simulateButton = document.getElementById("simulate-btn");
  if (simulateButton) {
    simulateButton.click();
  }
}
window.autoSimulate = autoSimulate;

function updateSelectedBadges() {
  const con = document.getElementById("selected-comp-badges");
  if (!con) return; // 요소가 없으면 종료
  const checkedCheckboxes = [...document.querySelectorAll(".sim-comp-checkbox:checked")];

  if (window._compartments && window._compartments.length > 0) {
    if (checkedCheckboxes.length === 0) {
      con.innerHTML = `<span class="placeholder-badge-area">No compartments selected. Click dropdown to select.</span>`;
    } else {
      con.innerHTML = checkedCheckboxes
        .map(cb => `<span class="badge text-bg-secondary me-1">${cb.value}</span>`) // text-bg-secondary 사용 (Bootstrap 5.3+)
        .join("");
    }
  } else {
    con.innerHTML = `<span class="placeholder-badge-area">Parse ODEs to select compartments.</span>`;
  }
}

function renderDoses() {
  const con = document.getElementById("dose-list");
  if (!con) return; // 요소가 없으면 종료

  if (!doseList.length) {
    con.innerHTML = `<div class="placeholder-text">No doses registered yet. Add doses using the form above.</div>`;
    return;
  }
  con.innerHTML = `
    <table class="table table-sm table-bordered table-striped">
      <thead class="table-light">
        <tr>
          <th>#</th><th>Compartment</th><th>Type</th><th>Amount</th><th>Start (h)</th>
          <th>Duration (h)</th><th>Repeat Every (h)</th><th>Repeat Until (h)</th><th>Action</th>
        </tr>
      </thead>
      <tbody>${
        doseList.map((d, i) => `
          <tr>
            <td>${i+1}</td>
            <td>${d.compartment}</td>
            <td>${d.type}</td>
            <td>${d.amount}</td>
            <td>${d.start_time}</td>
            <td>${d.type === "infusion" && d.duration > 0 ? d.duration : "-"}</td>
            <td>${d.repeat_every || "-"}</td>
            <td>${d.repeat_until || "-"}</td>
            <td>
              <button class="btn btn-sm btn-outline-danger py-0 px-1" onclick="removeDose(${i})" title="Remove dose">🗑️</button>
            </td>
          </tr>`).join("")
      }</tbody>
    </table>`;
}
window.removeDose = i => {
  if (confirm(`Are you sure you want to remove dose #${i + 1}?`)) {
    doseList.splice(i, 1);
    renderDoses();
  }
};

function plotSimulationResult(data, logYaxis, selectedCompartments) {
  const plotDiv = document.getElementById("plot");
  if (!plotDiv || !data || !data.Time) {
    console.error("Plotting error: Target div or data is missing.");
    return;
  }

  const time = data.Time;
  const traces = [];

  // Simulated traces
  selectedCompartments.forEach(compName => {
    if (data.hasOwnProperty(compName)) { // data 객체에 해당 compartment 키가 있는지 확인
      traces.push({
        x: time,
        y: data[compName],
        mode: "lines",
        name: compName,
        line: { width: 2 } // 선 두께 조정
      });
    }
  });

  // Observed traces (다중)
  window._obs
    .filter(o => o.selected)
    .forEach(obsDataset => {
      Object.keys(obsDataset.data).forEach(key => {
        if (key.toLowerCase() === "time") return; // 'time' 컬럼은 x축으로 사용되므로 제외
        // 시뮬레이션된 compartment와 이름이 같은 observed data만 표시 (선택적)
        // if (!selectedCompartments.includes(key)) return;

        traces.push({
          x: obsDataset.data.Time,
          y: obsDataset.data[key],
          mode: "markers",
          name: `${obsDataset.name} - ${key}`,
          marker: { size: 7, color: obsDataset.color, symbol: 'circle' } // 마커 크기 및 심볼 조정
        });
      });
    });

  const layout = {
    // title: "Concentration-Time Profile", // 제목은 카드 헤더에 있으므로 생략 가능
    xaxis: { title: "Time (h)", zeroline: false, gridcolor: 'rgba(0,0,0,0.05)' },
    yaxis: {
        title: "Concentration",
        type: logYaxis ? "log" : "linear",
        zeroline: false,
        gridcolor: 'rgba(0,0,0,0.05)',
        exponentformat: 'power', // 로그 스케일 시 지수 표기법
    },
    legend: {
        orientation: "h",
        yanchor: "bottom",
        y: 1.02,
        xanchor: "right",
        x: 1
    },
    margin: { l: 60, r: 20, b: 50, t: 20, pad: 4 }, // 여백 조정
    paper_bgcolor: "rgba(0,0,0,0)", // 투명 배경
    plot_bgcolor: "rgba(0,0,0,0)",  // 투명 배경
    autosize: true, // 자동 크기 조절
    // width 와 height는 부모 div에 의해 결정되도록 하거나, 필요시 설정
  };

  Plotly.react("plot", traces, layout, {responsive: true}); // newPlot 대신 react 사용 (업데이트 효율)
}

function displayPKSummary(pkData) {
  const summaryDiv = document.getElementById("pk-summary");
  if (!summaryDiv || !pkData) return;

  // pkData가 배열인지 객체인지 확인 (단일 compartment 결과 또는 다중 compartment 결과)
  const pkArray = Array.isArray(pkData) ? pkData : Object.entries(pkData).map(([comp, metrics]) => ({ compartment: comp, ...metrics }));


  if (pkArray.length === 0) {
    summaryDiv.innerHTML = `<div class="placeholder-text">No PK summary data available.</div>`;
    return;
  }

  const rows = pkArray.map((entry, i) => {
    const compartmentName = entry.compartment || `Comp ${i+1}`; // compartment 이름이 없을 경우 대비
    return `
    <tr>
      <td>${compartmentName}</td>
      <td>${entry.Cmax?.toPrecision(4) ?? "-"}</td>
      <td>${entry.Tmax?.toPrecision(4) ?? "-"}</td>
      <td>${entry.AUC_last?.toPrecision(4) ?? entry.AUC?.toPrecision(4) ?? "-"}</td>
      <td>${entry.HL_half_life?.toPrecision(4) ?? "-"}</td>
    </tr>`;
  }).join("");

  summaryDiv.innerHTML = `
    <div class="table-responsive">
      <table class="table table-sm table-hover"> <thead class="table-light">
          <tr>
            <th>Compartment</th>
            <th>C<sub>max</sub></th>
            <th>T<sub>max</sub> (h)</th>
            <th>AUC<sub>last</sub></th>
            <th>Half-life (h)</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function getCSRFToken() {
  const csrfTokenEl = document.querySelector('input[name="csrfmiddlewaretoken"]');
  if (csrfTokenEl) {
    return csrfTokenEl.value;
  }
  // 쿠키에서 가져오는 방식 (Fallback)
  const cookies = document.cookie.split('; ');
  for (const cookie of cookies) {
    const [name, value] = cookie.split('=');
    if (name === 'csrftoken') {
      return value;
    }
  }
  return ''; // CSRF 토큰을 찾지 못한 경우
}

function showProcessedModal() {
  const modalBody = document.getElementById("modal-body");
  if (!modalBody) return;

  const compHTML = window._compartments && window._compartments.length > 0
    ? window._compartments.map(c => `<span class="badge text-bg-primary me-1">${c}</span>`).join("")
    : `<span class="text-muted small">No compartments defined.</span>`;

  const paramHTML = window._parameters && window._parameters.length > 0
    ? window._parameters.map(p => `<span class="badge text-bg-secondary me-1">${p}</span>`).join("")
    : `<span class="text-muted small">No parameters defined.</span>`;

  const odeHTML = window._processedODE
    ? `<pre class="bg-light p-2 rounded small border">${window._processedODE.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>` // XSS 방지
    : `<span class="text-muted small">ODEs not parsed or no processed ODEs available.</span>`;

  modalBody.innerHTML = `
    <h6 class="mb-1"><i class="bi bi-box-seam me-1"></i> Compartments</h6>
    <div class="mb-3 p-2 bg-light border rounded small">${compHTML}</div>
    <h6 class="mb-1"><i class="bi bi-sliders me-1"></i> Parameters</h6>
    <div class="mb-3 p-2 bg-light border rounded small">${paramHTML}</div>
    <h6 class="mb-1"><i class="bi bi-file-earmark-code me-1"></i> Processed ODEs</h6>
    ${odeHTML}`;

  const modalEl = document.getElementById("processedModal");
  if (modalEl) {
    const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
    modal.show();
  }
}