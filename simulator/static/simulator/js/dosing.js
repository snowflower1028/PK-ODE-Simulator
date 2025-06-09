/*───────────────────────────────*
 * dosing.js  (PK Simulator UI) *
 *───────────────────────────────*/

const doseList    = [];
let   fitTimer    = null;        // 진행 타이머
// Bootstrap Modal 인스턴스를 저장할 변수
let fittingSettingsModalInstance = null;


/*─────────────────────────────────────────────*
 * 1. 오프-캔버스 Observed Data 관리 초기화
 *─────────────────────────────────────────────*/
window._obs = [];                // [{name,color,data,selected}]
const COLORS = ["#d9534f","#0275d8","#5cb85c","#f0ad4e","#6f42c1"];

function pickColor() {
  return COLORS[window._obs.length % COLORS.length];
}

function parseCsv(file) {
  return new Promise((resolve, reject) => { // reject 추가
    const fr = new FileReader();
    fr.onload = ev => {
      try {
        const lines = ev.target.result.split(/\r?\n/).filter(Boolean);
        if (lines.length < 1) throw new Error("CSV file is empty or has no header.");
        const head  = lines[0].split(",").map(h => h.trim());
        const tIdx  = head.findIndex(h => h.toLowerCase() === "time");
        
        if (tIdx === -1) {
          // alert 대신 reject 사용 또는 커스텀 알림 함수 사용
          return reject(new Error(`'Time' column missing in ${file.name}`));
        }
        
        const obj = {}, T = [];
        head.forEach((h, i) => { if (i !== tIdx) obj[h] = []; });
        
        for (let i = 1; i < lines.length; i++) {
          const vals = lines[i].split(",");
          if (vals.length !== head.length) { // 각 행의 컬럼 수가 헤더와 일치하는지 확인
             console.warn(`Skipping line ${i+1} in ${file.name} due to incorrect column count.`);
             continue;
          }
          if (vals.length <= tIdx) continue; // 사실상 위에서 걸러짐
          
          const timeVal = parseFloat(vals[tIdx]);
          if (isNaN(timeVal)) {
            console.warn(`Skipping line ${i+1} in ${file.name} due to invalid time value: ${vals[tIdx]}`);
            continue;
          }
          T.push(timeVal);

          head.forEach((h, j) => {
            if (j === tIdx) return;
            const v = parseFloat(vals[j]);
            obj[h].push(Number.isNaN(v) ? null : v);
          });
        }
        resolve({ Time: T, ...obj });
      } catch (error) {
        reject(error);
      }
    };
    fr.onerror = (err) => {
        reject(new Error(`Error reading file ${file.name}: ${err}`));
    };
    fr.readAsText(file);
  });
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("obs-file").addEventListener("change", e => {
    [...e.target.files].forEach(f => {
      parseCsv(f)
        .then(data => {
          window._obs.push({
            name: f.name,
            color: pickColor(),
            data: data,
            selected: true
          });
          renderObsList();
        })
        .catch(error => {
          alert(`Error processing file ${f.name}: ${error.message}`); // 사용자에게 에러 알림
        });
    });
    e.target.value = "";
  });

  document.getElementById("obs-list").addEventListener("click", e => {
    const li = e.target.closest("li");
    if (!li) return;
    const idx = parseInt(li.dataset.idx, 10); // data-idx 속성 사용 고려
    if (isNaN(idx)) return;

    if (e.target.classList.contains("obs-check")) {
      if (window._obs[idx]) window._obs[idx].selected = e.target.checked;
    } else if (!e.target.closest("button")) {
      renderPreview(idx);
    }
  });

  // 피팅 설정 모달 관련 이벤트 리스너
  const fittingModalElement = document.getElementById('fittingSettingsModal');
  if (fittingModalElement) {
    fittingSettingsModalInstance = new bootstrap.Modal(fittingModalElement);

    // 모달 내 파라미터 목록에서 체크박스 변경 시 Bounds UI 업데이트
    document.getElementById('modal-param-list')?.addEventListener('change', (event) => {
      if (event.target.classList.contains('modal-fit-param-cb')) {
        renderFitParamBoundsUI();
      }
    });

    // "Start Fitting" 버튼 클릭 리스너
    document.getElementById('start-fitting-btn')?.addEventListener('click', handleStartFitting);
  }
});

function renderObsList() {
  const ul = document.getElementById("obs-list");
  if (!ul) return;
  if (window._obs.length === 0) {
    ul.innerHTML = `<div class="placeholder-text">No observed data uploaded.</div>`;
    renderPreview();
    return;
  }
  ul.innerHTML = window._obs.map((o, i) => `
    <li class="list-group-item d-flex justify-content-between align-items-center" data-idx="${i}">
      <div>
        <input type="checkbox" class="form-check-input me-2 obs-check" 
               ${o.selected ? "checked" : ""}>
        <span style="color:${o.color}; cursor:default;">●</span>
        <span style="cursor:pointer;" class="obs-name-clickable">${o.name}</span>
      </div>
      <button class="btn btn-sm btn-outline-danger py-0 px-1" onclick="removeObs(${i})" title="Remove ${o.name}">🗑️</button>
    </li>
  `).join("");
  // 이름 클릭 시 미리보기 (선택 사항)
  ul.querySelectorAll('.obs-name-clickable').forEach((span, i) => {
    span.addEventListener('click', () => renderPreview(i));
  });
  renderPreview();
}

window.removeObs = i => {
  if (confirm(`Are you sure you want to remove observed data "${window._obs[i]?.name}"?`)) {
    window._obs.splice(i, 1);
    renderObsList();
  }
};

function renderPreview(idx = null) {
  const box = document.getElementById("obs-preview");
  if (!box) return;
  if (idx === null) idx = window._obs.findIndex(o => o.selected);
  if (idx === null && window._obs.length > 0) idx = 0;

  if (idx === -1 || idx === null || !window._obs[idx] || !window._obs[idx].data) {
    box.innerHTML = `<div class="placeholder-text small">No data to preview or select an item.</div>`;
    return;
  }

  const { name: fileName, data: obj } = window._obs[idx];
  const cols = Object.keys(obj);
  const n = Math.min(5, obj.Time ? obj.Time.length : 0);

  if (!obj.Time || obj.Time.length === 0) {
    box.innerHTML = `<div class="placeholder-text small">Selected data "${fileName}" is empty or has no 'Time' column.</div>`;
    return;
  }

  let html = `<p class="small text-muted mb-1">Preview: <strong>${fileName}</strong></p>
              <table class='table table-sm table-bordered table-striped'><thead><tr>`;
  cols.forEach(c => html += `<th>${c}</th>`);
  html += "</tr></thead><tbody>";
  for (let i = 0; i < n; i++) {
    html += "<tr>";
    cols.forEach(c => html += `<td>${obj[c][i] === null ? '-' : obj[c][i]}</td>`);
    html += "</tr>";
  }
  html += "</tbody></table>";
  if (obj.Time.length > n) {
    html += `<p class="text-muted small text-center mt-1">Showing first ${n} of ${obj.Time.length} rows...</p>`;
  }
  box.innerHTML = html;
}

function getSelectedObs() {
  return window._obs.filter(o => o.selected).map(o => o.data);
}

document.addEventListener("DOMContentLoaded", () => {
  const typeSelect = document.getElementById("type");
  if (typeSelect) {
    typeSelect.addEventListener("change", e => {
        const durationLabel = document.getElementById("duration-label");
        if (durationLabel) {
            durationLabel.style.display = e.target.value === "infusion" ? "flex" : "none";
        }
    });
  }
  
  document.addEventListener("change", e => {
    if (e.target.classList.contains("sim-comp-checkbox")) updateSelectedBadges();
  });

  const selectedBadgesDiv = document.getElementById("selected-comp-badges");
  if (selectedBadgesDiv) {
    selectedBadgesDiv.addEventListener("click", e => {
      if (e.target.classList.contains("badge")) {
        const c = e.target.textContent.trim();
        const checkbox = document.querySelector(`.sim-comp-checkbox[value="${c}"]`);
        if (checkbox) {
          checkbox.checked = false;
          updateSelectedBadges();
        }
      }
    });
  }
  
  const doseForm = document.getElementById("dose-form");
  if (doseForm) {
    doseForm.addEventListener("submit", e => {
      e.preventDefault();
      const formData = new FormData(e.target);
      const d = {
        compartment: formData.get("compartment"),
        type: formData.get("type"),
        amount: +formData.get("amount"),
        start_time: +formData.get("start_time"),
        duration: formData.get("type") === "infusion" ? (+formData.get("duration") || 0) : 0,
        repeat_every: +formData.get("repeat_every"),
        repeat_until: +formData.get("repeat_until")
      };
      if (Number.isNaN(d.amount) || d.amount <=0) return alert("Please enter a valid amount.");
      if (Number.isNaN(d.start_time)) return alert("Please enter a valid start time.");


      if (Number.isNaN(d.repeat_every) || d.repeat_every <= 0) d.repeat_every = null;
      if (Number.isNaN(d.repeat_until) || d.repeat_until <= 0) d.repeat_until = null;
      if (d.repeat_every && (!d.repeat_until || d.repeat_until <= d.start_time)) {
          return alert("If 'Repeat every' is set, 'Repeat until' must also be set and be greater than Start Time.");
      }


      doseList.push(d);
      renderDoses();
      e.target.reset();
      document.getElementById("type")?.dispatchEvent(new Event('change'));
    });
  }

  updateSelectedBadges();
  renderDoses();
  renderObsList();
});

function parseODE() {
  const odeInputEl = document.getElementById("ode-input");
  if (!odeInputEl || !odeInputEl.value.trim()) {
    alert("ODE input is empty.");
    return;
  }
  fetch("/parse/", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRFToken": getCSRFToken() },
    body: JSON.stringify({ text: odeInputEl.value })
  })
  .then(r => {
    if (!r.ok) return r.json().then(err => { throw new Error(err.message || `Server error: ${r.status}`) });
    return r.json();
  })
  .then(dat => {
    if (dat.status !== "ok") {
        alert("Parse failed: " + (dat.message || "Unknown error"));
        renderSymbolInputs(null, null, null);
        return;
    }
    const { compartments, parameters, processed_ode, derived_expressions } = dat.data;
    window._compartments = compartments || [];
    window._parameters   = parameters || [];
    window._processedODE = processed_ode;
    window._derivedExpressions = derived_expressions || {};
    renderSymbolInputs(window._compartments, window._parameters, window._derivedExpressions);
  })
  .catch(err => {
    alert("Parse request error: " + err.message);
    renderSymbolInputs(null, null, null);
  });
}

function renderSymbolInputs(comps, pars, derived) {
  const initDiv  = document.getElementById("init-values");
  const paramDiv = document.getElementById("param-values");
  const cmpSel = document.getElementById("compartment");
  const simMenu = document.getElementById("sim-compartments-menu");

  if (initDiv) initDiv.innerHTML = "";
  if (paramDiv) paramDiv.innerHTML = "";
  if (cmpSel) cmpSel.innerHTML = "";
  if (simMenu) simMenu.innerHTML = "";

  if (comps && comps.length > 0) {
    if (initDiv) {
      comps.forEach(c => {
        initDiv.insertAdjacentHTML("beforeend", `
          <div class="d-flex align-items-center mb-2 parameter-entry">
            <label for="init_${c}" class="form-label mb-0 me-2 text-end" style="width:70px;">${c}(0):</label>
            <input type="number" step="any" value="0" id="init_${c}" name="init_${c}" class="form-control form-control-sm flex-grow-1">
          </div>`);
      });
    }
    if (cmpSel) cmpSel.innerHTML = comps.map(c => `<option value="${c}">${c}</option>`).join("");
    if (simMenu) {
      simMenu.innerHTML = comps.map(c => `
        <li><label class="dropdown-item py-1">
            <input type="checkbox" class="form-check-input me-2 sim-comp-checkbox" value="${c}" checked>
            ${c}</label></li>`).join("");
    }
  } else {
    if (initDiv) initDiv.innerHTML = `<div class="placeholder-text">Parse ODEs to set initial values.</div>`;
    if (cmpSel) cmpSel.innerHTML = `<option value="" disabled selected>N/A</option>`;
    if (simMenu) simMenu.innerHTML = `<li><span class="dropdown-item-text placeholder-text small-placeholder">No compartments available.</span></li>`;
  }

  if (pars && pars.length > 0) {
    if (paramDiv) {
      pars.forEach(p => {
        paramDiv.insertAdjacentHTML("beforeend", `
          <div class="d-flex align-items-center mb-2 parameter-entry">
            <label for="param_${p}" class="form-label mb-0 me-2 text-end" style="width:70px;">${p}:</label>
            <input type="number" step="any" value="0.1" id="param_${p}" name="param_${p}" class="form-control form-control-sm flex-grow-1">
            <!-- Fit checkbox removed from here, moved to modal -->
          </div>`);
      });
      if (derived) {
        Object.entries(derived)
          .filter(([k]) => !pars.includes(k))
          .forEach(([k, expr]) => {
            paramDiv.insertAdjacentHTML("beforeend", `
              <div class="derived-box"><i class="bi bi-calculator me-1"></i><strong>${k}</strong> = ${expr}</div>`);
          });
      }
    }
  } else {
    if (paramDiv) paramDiv.innerHTML = `<div class="placeholder-text">Parse ODEs to set parameters.</div>`;
  }
  updateSelectedBadges();
}

let simRunning = false;
const simulateBtnEl = document.getElementById("simulate-btn");
if (simulateBtnEl) {
    simulateBtnEl.addEventListener("click", () => {
    if (simRunning) return;
    if (!window._compartments || window._compartments.length === 0 || !window._parameters || window._parameters.length === 0) {
        alert("Please parse ODEs and ensure compartments/parameters are defined.");
        return;
    }

    simRunning = true;
    const originalBtnHTML = simulateBtnEl.innerHTML;
    simulateBtnEl.disabled = true;
    simulateBtnEl.innerHTML = `<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> Running...`;

    const odeText  = document.getElementById("ode-input").value.trim();
    const t0       = +document.getElementById("sim-start-time").value;
    const t1       = +document.getElementById("sim-end-time").value;
    const nSteps   = +document.getElementById("sim-steps").value;
    const logScale = document.getElementById("log-scale").checked;
    const selComps = [...document.querySelectorAll(".sim-comp-checkbox:checked")].map(e => e.value);

    if (selComps.length === 0) {
        alert("Please select at least one compartment to simulate.");
        simRunning = false;
        simulateBtnEl.disabled = false;
        simulateBtnEl.innerHTML = originalBtnHTML;
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
        simulateBtnEl.disabled = false;
        simulateBtnEl.innerHTML = originalBtnHTML;
        return;
    }

    fetch("/simulate/", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRFToken": getCSRFToken() },
        body: JSON.stringify({
        equations: odeText,
        compartments: selComps,
        parameters: params,
        initials: initials,
        doses: doseList,
        t_start: t0,
        t_end: t1,
        t_steps: nSteps,
        })
    })
    .then(r => {
        if (!r.ok) return r.json().then(err => { throw new Error(err.message || `Server error: ${r.status}`) });
        return r.json();
    })
    .then(d => {
        if (d.status !== "ok") throw new Error(d.message || "Simulation failed.");
        plotSimulationResult(d.data.profile, logScale, selComps);
        displayPKSummary(d.data.pk);
        document.getElementById("plot-placeholder").style.display = "none";
        document.getElementById("plot").style.display = "block";
        const pkSummaryPlaceholder = document.getElementById("pk-summary-placeholder");
        const pkSummaryDiv = document.getElementById("pk-summary");
        if (pkSummaryPlaceholder) pkSummaryPlaceholder.style.display = "none";
        if (pkSummaryDiv) pkSummaryDiv.style.display = "block";
    })
    .catch(err => alert("Simulation error: " + err.message))
    .finally(() => {
        simRunning = false;
        simulateBtnEl.disabled = false;
        simulateBtnEl.innerHTML = originalBtnHTML;
    });
    });
}


// --- Fitting Modal Logic ---
const fitBtnMain = document.getElementById("fit-btn");
if (fitBtnMain) {
    fitBtnMain.addEventListener("click", () => {
        if (!window._compartments || window._compartments.length === 0 || !window._parameters || window._parameters.length === 0) {
            alert("Please parse ODEs first to define parameters for fitting.");
            return;
        }
        if (getSelectedObs().length === 0) {
            alert("⚠️ Upload and select observed data first for fitting.");
            return;
        }
        openFittingSettingsModal();
    });
}

function openFittingSettingsModal() {
    const paramListDiv = document.getElementById('modal-param-list');
    const paramBoundsListDiv = document.getElementById('modal-param-bounds-list');
    const fitProgressSection = document.getElementById('fit-progress-section');

    if (!paramListDiv || !paramBoundsListDiv || !fittingSettingsModalInstance) return;

    paramListDiv.innerHTML = ''; // Clear previous list
    paramBoundsListDiv.innerHTML = ''; // Clear previous bounds

    if (window._parameters && window._parameters.length > 0) {
        window._parameters.forEach(p_name => {
            // 현재 UI에서 해당 파라미터의 값을 가져옴 (초기 추정치)
            const paramValueEl = document.getElementById(`param_${p_name}`);
            const currentValue = paramValueEl ? paramValueEl.value : 'N/A';

            const div = document.createElement('div');
            div.className = 'form-check mb-1';
            div.innerHTML = `
                <input class="form-check-input modal-fit-param-cb" type="checkbox" value="${p_name}" id="modal_fit_${p_name}">
                <label class="form-check-label" for="modal_fit_${p_name}">
                    ${p_name} <small class="text-muted">(current: ${currentValue})</small>
                </label>
            `;
            paramListDiv.appendChild(div);
        });
    } else {
        paramListDiv.innerHTML = `<p class="text-muted small">No parameters available for fitting. Parse ODEs first.</p>`;
    }
    
    if(fitProgressSection) fitProgressSection.style.display = 'none'; // 진행률 섹션 숨기기
    document.getElementById('start-fitting-btn').disabled = false; // 시작 버튼 활성화

    fittingSettingsModalInstance.show();
}

function renderFitParamBoundsUI() {
    const paramBoundsListDiv = document.getElementById('modal-param-bounds-list');
    if (!paramBoundsListDiv) return;
    paramBoundsListDiv.innerHTML = ''; // Clear previous bounds

    const checkedParams = document.querySelectorAll('#modal-param-list .modal-fit-param-cb:checked');
    if (checkedParams.length === 0) {
        paramBoundsListDiv.innerHTML = `<p class="text-muted small">Select parameters above to set their bounds.</p>`;
        return;
    }

    checkedParams.forEach(cb => {
        const paramName = cb.value;
        const row = document.createElement('div');
        row.className = 'row g-2 mb-2 align-items-center';
        row.innerHTML = `
            <div class="col-md-3"><label class="form-label mb-0 small" for="lower_bound_${paramName}">${paramName}:</label></div>
            <div class="col-md-4">
                <input type="number" step="any" class="form-control form-control-sm modal-param-lower" 
                       data-param-name="${paramName}" placeholder="Lower Bound" id="lower_bound_${paramName}">
            </div>
            <div class="col-md-1 text-center">-</div>
            <div class="col-md-4">
                <input type="number" step="any" class="form-control form-control-sm modal-param-upper" 
                       data-param-name="${paramName}" placeholder="Upper Bound">
            </div>
        `;
        paramBoundsListDiv.appendChild(row);
    });
}

function handleStartFitting() {
    if (!window._compartments || !window._parameters) {
        alert("Critical error: Compartments or parameters not defined. Please parse ODEs again.");
        return;
    }
    const selObs = getSelectedObs();
    if (!selObs.length) {
        alert("⚠️ No observed data selected for fitting.");
        return;
    }

    const fitProgressSection = document.getElementById('fit-progress-section');
    const startFittingBtn = document.getElementById('start-fitting-btn');
    
    const selectedFitParams = [];
    document.querySelectorAll('#modal-param-list .modal-fit-param-cb:checked').forEach(cb => {
        selectedFitParams.push(cb.value);
    });

    if (selectedFitParams.length === 0) {
        alert("Please select at least one parameter to fit from the list.");
        return;
    }

    const initials = {};
    const currentParams = {}; // 모든 파라미터의 현재 값 (초기 추정치)
    const bounds = {};      // 선택된 파라미터의 바운드

    try {
        window._compartments.forEach(c => {
            const el = document.querySelector(`input[name="init_${c}"]`);
            initials[c] = +el.value;
            if (Number.isNaN(initials[c])) throw new Error(`Initial value for ${c} is invalid.`);
        });
        window._parameters.forEach(p => {
            const el = document.querySelector(`input[name="param_${p}"]`);
            currentParams[p] = +el.value;
            if (Number.isNaN(currentParams[p])) throw new Error(`Current value for parameter ${p} is invalid.`);
        });

        selectedFitParams.forEach(pName => {
            const lowerEl = document.querySelector(`.modal-param-lower[data-param-name="${pName}"]`);
            const upperEl = document.querySelector(`.modal-param-upper[data-param-name="${pName}"]`);
            const lowerVal = lowerEl && lowerEl.value.trim() !== '' ? parseFloat(lowerEl.value) : -Infinity;
            const upperVal = upperEl && upperEl.value.trim() !== '' ? parseFloat(upperEl.value) : Infinity;

            if (Number.isNaN(lowerVal) || Number.isNaN(upperVal)) {
                throw new Error(`Invalid bound for parameter ${pName}. Please enter numeric values or leave blank.`);
            }
            if (lowerVal > upperVal) {
                throw new Error(`Lower bound cannot be greater than upper bound for parameter ${pName}.`);
            }
            bounds[pName] = [lowerVal, upperVal];
        });

    } catch (err) {
        alert(`Input Error: ${err.message}`);
        return;
    }
    
    if(fitProgressSection) fitProgressSection.style.display = 'block';
    if(startFittingBtn) startFittingBtn.disabled = true;

    const body = {
        equations: document.getElementById("ode-input").value.trim(),
        initials: initials,
        parameters: currentParams, // 현재 UI 값을 초기 추정치로 사용
        fit_params: selectedFitParams,
        bounds: bounds, // 생성한 bounds 객체 전달
        observed: selObs,
        doses: doseList,
        t_start: +document.getElementById("sim-start-time").value,
        t_end: +document.getElementById("sim-end-time").value,
        t_steps: +document.getElementById("sim-steps").value,
    };

    // 모달 내 UI 요소 참조
    const msgModal     = document.getElementById("fit-msg-modal");
    const elapsedModal = document.getElementById("fit-elapsed-modal");
    const barModalProg = document.getElementById("fit-progress-bar-modal")?.querySelector('.progress-bar');
    const consoleModal = document.getElementById("fit-console-output-modal");
    const resultModal  = document.getElementById("fit-result-modal");

    if(msgModal) msgModal.textContent = "Fitting in progress…";
    if(elapsedModal) elapsedModal.textContent = "(0s)";
    if(consoleModal) consoleModal.innerHTML = "Waiting for server response...";
    if(resultModal) resultModal.innerHTML = "";
    if(barModalProg) {
        barModalProg.style.width = "0%";
        barModalProg.classList.add('progress-bar-animated');
        barModalProg.parentElement.style.display = 'block'; // progress div 표시
    }


    if (fitTimer) clearInterval(fitTimer);
    const t0 = Date.now();
    fitTimer = setInterval(() => {
        if(elapsedModal) elapsedModal.textContent = ` (${Math.floor((Date.now() - t0) / 1000)}s)`;
        // 가짜 프로그레스 바 업데이트 (실제 진행률 알 수 없으므로)
        if(barModalProg) {
            let currentWidth = parseFloat(barModalProg.style.width);
            if (currentWidth < 90) { // 90%까지만 천천히 증가
                barModalProg.style.width = (currentWidth + 2) + "%";
            }
        }
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
        if (res.status !== "ok") throw new Error(res.message || "Fitting failed.");

        updateInputFields(res.data.params);
        renderFitSummary(res.data.params, res.data.cost);
        autoSimulate();

        if(barModalProg) barModalProg.style.width = "100%";
        if(msgModal) msgModal.textContent = "Fitting Done 🎉";
        
        let consoleOutput = `Fitting process completed.\n`;
        consoleOutput += `Termination status: ${res.data.status || 'N/A'} (${res.data.message || 'No message'})\n`;
        consoleOutput += `Function evaluations: ${res.data.nfev || 'N/A'}\n`;
        consoleOutput += `Jacobian evaluations: ${res.data.njev || 'N/A'}\n`;
        consoleOutput += `Final Cost (SSR/2): ${typeof res.data.cost === 'number' ? res.data.cost.toPrecision(6) : (res.data.cost || 'N/A')}\n`;
        if (res.data.ssr_list) {
            consoleOutput += `SSR per dataset: ${res.data.ssr_list.map(s => typeof s === 'number' ? s.toPrecision(6) : s).join(', ')}\n`;
        }

        if(consoleModal) consoleModal.textContent = consoleOutput;

        const rows = Object.entries(res.data.params)
            .map(([k, v]) => `<tr><td>${k}</td><td>${typeof v === 'number' ? v.toPrecision(6) : v}</td></tr>`)
            .join("");
        if(resultModal) {
            resultModal.innerHTML = `
                <table class="table table-sm table-bordered mb-0">
                    <thead class="table-light"><tr><th>Fitted Parameter</th><th>Value</th></tr></thead>
                    <tbody>${rows}</tbody>
                </table>`;
        }
    })
    .catch(err => {
        if(msgModal) msgModal.innerHTML = `<span class="text-danger"><strong>Error:</strong> ${err.message}</span>`;
        if(consoleModal) consoleModal.textContent = `Error occurred: ${err.message}`;
        if(barModalProg) barModalProg.classList.add('bg-danger');
    })
    .finally(() => {
        clearInterval(fitTimer); fitTimer = null;
        if(barModalProg) barModalProg.classList.remove('progress-bar-animated');
        if(startFittingBtn) startFittingBtn.disabled = false;
    });
}


// --- Helper functions (global) ---
function updateInputFields(dict) {
  for (const [k, v] of Object.entries(dict)) {
    const el = document.getElementById(`param_${k}`);
    if (el) el.value = v;
  }
}
window.updateInputFields = updateInputFields;

function renderFitSummary(dict, cost) {
  const card = document.getElementById("fit-summary-card");
  const box  = document.getElementById("fit-summary");
  if (!card || !box) return;

  const rows = Object.entries(dict)
    .map(([k, v]) => `<tr><td>${k}</td><td>${typeof v === 'number' ? v.toPrecision(6) : v}</td></tr>`)
    .join("");
  box.innerHTML = `
    <table class="table table-sm table-bordered mb-2">
      <thead class="table-light"><tr><th>Parameter</th><th>Value</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="small text-muted mb-0">Cost (SSR/2): ${typeof cost === 'number' ? cost.toPrecision(6) : cost}</p>`;
  card.style.display = "block";
}
window.renderFitSummary = renderFitSummary;

function autoSimulate() {
  const simulateButton = document.getElementById("simulate-btn");
  if (simulateButton) {
    simulateButton.click();
  }
}
window.autoSimulate = autoSimulate;

function updateSelectedBadges() {
  const con = document.getElementById("selected-comp-badges");
  if (!con) return;
  const checkedCheckboxes = [...document.querySelectorAll(".sim-comp-checkbox:checked")];

  if (window._compartments && window._compartments.length > 0) {
    if (checkedCheckboxes.length === 0) {
      con.innerHTML = `<span class="placeholder-badge-area">No compartments selected.</span>`;
    } else {
      con.innerHTML = checkedCheckboxes
        .map(cb => `<span class="badge text-bg-secondary me-1">${cb.value}</span>`)
        .join("");
    }
  } else {
    con.innerHTML = `<span class="placeholder-badge-area">Parse ODEs to select compartments.</span>`;
  }
}

function renderDoses() {
  const con = document.getElementById("dose-list");
  if (!con) return;

  if (!doseList.length) {
    con.innerHTML = `<div class="placeholder-text">No doses registered yet.</div>`;
    return;
  }
  con.innerHTML = `
    <div class="table-responsive">
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
        </table>
    </div>`;
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

  selectedCompartments.forEach(compName => {
    if (data.hasOwnProperty(compName)) {
      traces.push({
        x: time,
        y: data[compName],
        mode: "lines",
        name: compName,
        line: { width: 2 }
      });
    }
  });

  window._obs
    .filter(o => o.selected)
    .forEach(obsDataset => {
      Object.keys(obsDataset.data).forEach(key => {
        if (key.toLowerCase() === "time") return;
        traces.push({
          x: obsDataset.data.Time,
          y: obsDataset.data[key],
          mode: "markers",
          name: `${obsDataset.name} - ${key}`,
          marker: { size: 7, color: obsDataset.color, symbol: 'circle' }
        });
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

  Plotly.react("plot", traces, layout, {responsive: true});
}

function displayPKSummary(pkData) {
  const summaryDiv = document.getElementById("pk-summary");
  if (!summaryDiv || !pkData) return;

  const pkArray = Array.isArray(pkData) ? pkData : Object.entries(pkData).map(([comp, metrics]) => ({ compartment: comp, ...metrics }));

  if (pkArray.length === 0) {
    summaryDiv.innerHTML = `<div class="placeholder-text">No PK summary data available.</div>`;
    return;
  }
  const rows = pkArray.map((entry, i) => {
    const compartmentName = entry.compartment || `Comp ${i+1}`;
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
      <table class="table table-sm table-hover">
        <thead class="table-light">
          <tr>
            <th>Compartment</th><th>C<sub>max</sub></th><th>T<sub>max</sub> (h)</th>
            <th>AUC<sub>last</sub></th><th>Half-life (h)</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function getCSRFToken() {
  const csrfTokenEl = document.querySelector('input[name="csrfmiddlewaretoken"]');
  if (csrfTokenEl) return csrfTokenEl.value;
  const cookies = document.cookie.split('; ');
  for (const cookie of cookies) {
    const [name, value] = cookie.split('=');
    if (name === 'csrftoken') return value;
  }
  return '';
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
    ? `<pre class="bg-light p-2 rounded small border">${window._processedODE.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>`
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