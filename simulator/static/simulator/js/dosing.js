const doseList = [];
let observedData = null;

document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("dose-form");
  const doseContainer = document.getElementById("dose-list");

  document.getElementById("type").addEventListener("change", e => {
    const show = e.target.value === "infusion";
    document.getElementById("duration-label").style.display = show ? "block" : "none";
  });

  document.getElementById("selected-comp-badges").addEventListener("click", (e) => {
    if (e.target.classList.contains("badge")) {
      const comp = e.target.textContent;
      const checkbox = document.querySelector(`.sim-comp-checkbox[value="${comp}"]`);
      if (checkbox) {
        checkbox.checked = false;
        updateSelectedBadges();
      }
    }
  });
  
  document.addEventListener("change", (e) => {
    if (e.target.classList.contains("sim-comp-checkbox")) {
      updateSelectedBadges();
    }
  });
  document.getElementById("obs-upload").addEventListener("change", function (e) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function (event) {
      const lines = event.target.result.split("\n").filter(Boolean);
      const header = lines[0].split(",");
      const timeIdx = header.findIndex(h => h.trim().toLowerCase() === "time");
      
      if (timeIdx === -1) {
        alert("CSV에 'Time' 열이 필요합니다.");
        return;
      }

      const obs = {};
      header.forEach((h, idx) => {
        if (idx === timeIdx) return;
        obs[h.trim()] = [];
      });

      const time = [];

      for (let i = 1; i < lines.length; i++) {
        const values = lines[i].split(",");
        if (values.length <= timeIdx) continue;
        time.push(parseFloat(values[timeIdx]));

        header.forEach((h, idx) => {
          if (idx === timeIdx) return;
          const val = parseFloat(values[idx]);
          if (!isNaN(val)) {
            obs[h.trim()].push(val);
          } else {
            obs[h.trim()].push(null);
          }
        });
      }

      observedData = { Time: time, ...obs };
      alert("✅ Observed data loaded!");
    };

    reader.readAsText(file);
  });

  form.addEventListener("submit", e => {
    e.preventDefault();

    const dose = {
      compartment: document.getElementById("compartment").value,
      type: document.getElementById("type").value,
      amount: parseFloat(document.getElementById("amount").value),
      start_time: parseFloat(document.getElementById("start_time").value),
      duration: parseFloat(document.getElementById("duration").value) || 0,
      repeat_every: parseFloat(document.getElementById("repeat_every").value),
      repeat_until: parseFloat(document.getElementById("repeat_until").value)
    };

    if (Number.isNaN(dose.repeat_every)) dose.repeat_every = null;
    if (Number.isNaN(dose.repeat_until)) dose.repeat_until = null;

    doseList.push(dose);
    renderDoses();
    form.reset();
    document.getElementById("duration-label").style.display = "none";
  });
});

// 시뮬레이션 실행
document.getElementById("simulate-btn").onclick = () => {
  // const odeText = window._processedODE || document.getElementById("ode-input").value.trim();
  const odeText = document.getElementById("ode-input").value.trim();
  const simStart = parseFloat(document.getElementById("sim-start-time").value);
  const simEnd = parseFloat(document.getElementById("sim-end-time").value);
  const simSteps = parseInt(document.getElementById("sim-steps").value);

  const logScale = document.getElementById("log-scale").checked;  

  const simSelect = document.getElementById("sim-compartments");
  const selectedComps = Array.from(document.querySelectorAll(".sim-comp-checkbox"))
    .filter(cb => cb.checked)
    .map(cb => cb.value);

  const initials = {};
  const params = {};

  (window._compartments || []).forEach(c => {
    const val = document.querySelector(`input[name="init_${c}"]`).value;
    initials[c] = parseFloat(val);
  });

  (window._parameters || []).forEach(p => {
    const val = document.querySelector(`input[name="param_${p}"]`).value;
    params[p] = parseFloat(val);
  });

  fetch("/simulate/", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRFToken": getCSRFToken(),
    },
    body: JSON.stringify({
      equations: odeText,
      compartments: selectedComps,
      parameters: params,
      initials: initials,
      doses: doseList,
      t_start: simStart,
      t_end: simEnd,
      t_steps: simSteps,
      log_scale: logScale
    })
  })
  .then(res => res.json())
  .then(data => {
    if (data.status === "ok") {
      alert("✅ Simulation succeeded!");
      plotSimulationResult(data.data.profile, logScale, selectedComps);
      displayPKSummary(data.data.pk);
    } else {
      alert("Simulation error: " + data.message);
    }
  })
  .catch(err => alert("Error: " + err));
};

function getCSRFToken() {
  const name = "csrftoken";
  const cookies = document.cookie.split("; ");
  for (const cookie of cookies) {
    if (cookie.startsWith(name + "=")) {
      return decodeURIComponent(cookie.split("=")[1]);
    }
  }
  return "";
}

function plotSimulationResult(data, logScale, selectedComps) {
  const time = data["Time"];
  const traces = [];

  document.getElementById("plot-placeholder").style.display = "none";
  document.getElementById("plot").style.display = "block";

  // Simulated data
  for (const key of selectedComps) {
    if (!(key in data)) continue;
    traces.push({
      x: time,
      y: data[key],
      mode: "lines",
      name: key
    });
  }

  // Observed data overlay
  if (observedData && observedData.Time) {
    for (const key in observedData) {
      if (key === "Time") continue;
      traces.push({
        x: observedData.Time,
        y: observedData[key],
        mode: "markers",
        name: key + " (obs)",
        marker: { symbol: "circle", size: 6 },
        type: "scatter"
      });
    }
  }

  const layout = {
    title: "Concentration-Time Profile",
    xaxis: { title: "Time (hr)" },
    yaxis: {
      title: "Concentration",
      type: logScale ? "log" : "linear"
    },
    legend: { orientation: "h" },
    paper_bgcolor: "#f8f9fa00",
    plot_bgcolor: "#f8f9fa00"
  };

  Plotly.newPlot("plot", traces, layout);
}

function parseODE() {
  const text = document.getElementById("ode-input").value;

  fetch("/parse/", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRFToken": getCSRFToken()
    },
    body: JSON.stringify({ text })
  })
  .then(res => res.json())
  .then(data => {
    if (data.status !== "ok") return alert("Parse failed");
    
    const { compartments, parameters, processed_ode, derived_expressions } = data.data;

    window._compartments = compartments;
    window._parameters = parameters;
    window._processedODE = processed_ode;
    window._derivedExpressions = derived_expressions;

    renderSymbolInputs(compartments, parameters, derived_expressions);
  });
}

function renderSymbolInputs(compList, paramList, derivedList) {
  const initDiv  = document.getElementById("init-values");
  const paramDiv = document.getElementById("param-values");
  initDiv.innerHTML  = "";
  paramDiv.innerHTML = "";

  /* 초기값 입력창 ----------------------------- */
  compList.forEach(c => {
    const wrap  = document.createElement("div");
    wrap.className = "d-flex align-items-center mb-2";

    wrap.innerHTML = `
      <label for="init_${c}" class="mb-0 me-2 text-end" style="width:70px;">${c}:</label>
      <input type="number" step="any" value="1.0"
             id="init_${c}" name="init_${c}"
             class="form-control form-control-sm flex-grow-1">
    `;
    initDiv.appendChild(wrap);
  });

  /* (A) 실제 입력 파라미터 -------------------- */
  paramList.forEach(p => {
    const row = document.createElement("div");
    row.className = "d-flex align-items-center mb-2";
    row.innerHTML = `
      <label for="param_${p}" class="mb-0 me-2 text-end" style="width:70px;">${p}:</label>
      <input type="number" step="any"
             id="param_${p}" name="param_${p}"
             class="form-control form-control-sm flex-grow-1">
    `;
    paramDiv.appendChild(row);
  });

  /* (B) 자동 계산 파라미터(derived) ----------------------------- */
  Object.entries(derivedList)
    .filter(([k]) => !paramList.includes(k))
    .forEach(([k, expr]) => {
      const div   = document.createElement("div");
      div.className = "derived-box";
      div.title = "Auto-calculated";

      // 아이콘 + 이름 + 수식(<code> 태그)
      div.innerHTML =
        `<i class="bi bi-calculator"></i> <strong>${k}</strong> = ` +
        `<code>${expr}</code>`;

      paramDiv.appendChild(div);
    });

  /* ▼ 나머지 UI 재생성 로직은 유지 ▼ */
  const doseSelect = document.getElementById("compartment");
  doseSelect.innerHTML = "";
  compList.forEach(c => {
    const opt = document.createElement("option");
    opt.value = c; opt.textContent = c;
    doseSelect.appendChild(opt);
  });

  const simMenu = document.getElementById("sim-compartments-menu");
  simMenu.innerHTML = "";
  compList.forEach(c => {
    simMenu.insertAdjacentHTML("beforeend", `
      <li>
        <label class="dropdown-item">
          <input type="checkbox" class="form-check-input me-2 sim-comp-checkbox" value="${c}" checked>
          ${c}
        </label>
      </li>`);
  });

  updateSelectedBadges();

  window._compartments = compList;   // 재확인
  window._parameters   = paramList;  // 입력 파라미터만!
}

function displayPKSummary(pk) {
  const container = document.getElementById("pk-summary");
  container.innerHTML = "";

  const table = document.createElement("table");
  table.className = "table";  // ✅ 이 스타일만 사용하면 됩니다

  // thead
  const thead = document.createElement("thead");
  thead.innerHTML = `
    <tr>
      <th scope="col">#</th>
      <th scope="col">Compartment</th>
      <th scope="col">C<sub>max</sub></th>
      <th scope="col">T<sub>max</sub> (h)</th>
      <th scope="col">AUC</th>
    </tr>
  `;

  // tbody
  const tbody = document.createElement("tbody");
  Object.entries(pk).forEach(([comp, metrics], idx) => {
    const row = document.createElement("tr");
    row.innerHTML = `
      <th scope="row">${idx + 1}</th>
      <td>${comp}</td>
      <td>${metrics.Cmax?.toFixed(4) ?? "-"}</td>
      <td>${metrics.Tmax?.toFixed(2) ?? "-"}</td>
      <td>${metrics.AUC?.toFixed(2) ?? "-"}</td>
    `;
    tbody.appendChild(row);
  });

  table.appendChild(thead);
  table.appendChild(tbody);
  container.appendChild(table);

  // Show/hide placeholders
  document.getElementById("pk-summary-placeholder").style.display = "none";
  container.style.display = "block";
}


function updateSelectedBadges() {
  const container = document.getElementById("selected-comp-badges");
  container.innerHTML = "";
  const selected = Array.from(document.querySelectorAll(".sim-comp-checkbox"))
    .filter(cb => cb.checked)
    .map(cb => cb.value);

  selected.forEach(comp => {
    const badge = document.createElement("span");
    badge.className = "badge bg-secondary me-1";
    badge.textContent = comp;
    container.appendChild(badge);
  });
}

function renderDoses() {
  const container = document.getElementById("dose-list");
  container.innerHTML = "";

  if (doseList.length === 0) {
    container.innerHTML = "<p class='text-muted'>No doses registered.</p>";
    return;
  }

  const table = document.createElement("table");
  table.className = "table table-sm table-bordered table-striped";
  table.innerHTML = `
    <thead class="table-light">
      <tr>
        <th>#</th>
        <th>Compartment</th>
        <th>Type</th>
        <th>Amount</th>
        <th>Start Time</th>
        <th>Duration</th>
        <th>Repeat every</th>
        <th>Repeat until</th>
        <th>Action</th>
      </tr>
    </thead>
    <tbody>
      ${doseList.map((dose, i) => `
        <tr>
          <td>${i + 1}</td>
          <td>${dose.compartment}</td>
          <td>${dose.type}</td>
          <td>${dose.amount}</td>
          <td>${dose.start_time}</td>
          <td>${dose.type === "infusion" ? dose.duration : "-"}</td>
          <td>${dose.repeat_every || "-"}</td>
          <td>${dose.repeat_until || "-"}</td>
          <td>
            <button class="btn btn-sm btn-outline-danger" onclick="removeDose(${i})">🗑️</button>
          </td>
        </tr>
      `).join("")}
    </tbody>
  `;
  container.appendChild(table);
}

function showProcessedModal() {
  const modalBody = document.getElementById("modal-body");

  const compBadges = window._compartments.map(c => `<span class="badge bg-primary me-1">${c}</span>`).join("");
  const paramBadges = window._parameters.map(p => `<span class="badge bg-secondary me-1">${p}</span>`).join("");

  const processedODE = window._processedODE || "ODE not parsed yet";

  modalBody.innerHTML = `
    <h6><i class="bi bi-box"></i> Compartments</h6>
    <div class="mb-3">${compBadges}</div>
    <h6><i class="bi bi-sliders"></i> Parameters</h6>
    <div class="mb-3">${paramBadges}</div>
    <h6><i class="bi bi-file-code"></i> Processed ODEs</h6>
    <pre class="bg-light p-2 rounded small">${processedODE}</pre>
  `;

  const modal = new bootstrap.Modal(document.getElementById("processedModal"));
  modal.show();
}

window.removeDose = function(index) {
  doseList.splice(index, 1);
  renderDoses();
};
