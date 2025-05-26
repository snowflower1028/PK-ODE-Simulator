const doseList = [];

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
  const odeText = document.getElementById("ode-input").value;
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

  for (const key of selectedComps) {
    if (!(key in data)) continue;
    traces.push({
      x: time,
      y: data[key],
      mode: "lines",
      name: key
    });
  }

  const layout = {
    title: "Concentration-Time Profile",
    xaxis: { title: "Time (hr)" },
    yaxis: {
      title: "Concentration",
      type: logScale ? "log" : "linear"
    },
    legend: { orientation: "h" }
  };

  Plotly.newPlot("plot", traces, layout);
}


function parseODE() {
  const text = document.getElementById("ode-input").value;
  const lines = text.split("\n").map(line => line.trim()).filter(Boolean);

  const compartments = new Set();
  const rhsExpressions = [];

  lines.forEach(line => {
    const [lhs, rhs] = line.split("=").map(s => s.trim());
    const match = lhs.match(/^d([A-Za-z0-9_]+)dt$/);
    if (match) {
      compartments.add(match[1]);
      rhsExpressions.push(rhs);
    }
  });

  const parameters = new Set();

  rhsExpressions.forEach(rhs => {
    const symbols = rhs.match(/[A-Za-z_][A-Za-z0-9_]*/g) || [];
    symbols.forEach(sym => {
      if (!compartments.has(sym)) {
        parameters.add(sym);
      }
    });
  });

  renderSymbolInputs([...compartments], [...parameters]);
}

function renderSymbolInputs(compList, paramList) {
  const initDiv = document.getElementById("init-values");
  const paramDiv = document.getElementById("param-values");

  initDiv.innerHTML = "";
  paramDiv.innerHTML = "";

  // 초기값 영역
  compList.forEach(c => {
    const wrapper = document.createElement("div");
    wrapper.className = "d-flex align-items-center mb-2";

    const label = document.createElement("label");
    label.textContent = `${c}:`;
    label.setAttribute("for", `init_${c}`);
    label.className = "mb-0 me-2 text-end";
    label.style.width = "70px";

    const input = document.createElement("input");
    input.type = "number";
    input.step = "any";
    input.value = "1.0";
    input.name = `init_${c}`;
    input.id = `init_${c}`;
    input.className = "form-control form-control-sm";
    input.style.flex = "1";

    wrapper.appendChild(label);
    wrapper.appendChild(input);
    initDiv.appendChild(wrapper);
  });

  // 파라미터 영역
  paramList.forEach(p => {
    const wrapper = document.createElement("div");
    wrapper.className = "d-flex align-items-center mb-2";

    const label = document.createElement("label");
    label.textContent = `${p}:`;
    label.setAttribute("for", `param_${p}`);
    label.className = "mb-0 me-2 text-end";
    label.style.width = "70px";

    const input = document.createElement("input");
    input.type = "number";
    input.step = "any";
    input.value = "0.1";
    input.name = `param_${p}`;
    input.id = `param_${p}`;
    input.className = "form-control form-control-sm";
    input.style.flex = "1";

    wrapper.appendChild(label);
    wrapper.appendChild(input);
    paramDiv.appendChild(wrapper);
  });

  const doseSelect = document.getElementById("compartment");
  doseSelect.innerHTML = "";
  compList.forEach(c => {
    const opt = document.createElement("option");
    opt.value = c;
    opt.textContent = c;
    doseSelect.appendChild(opt);
  });

  // simulate compartments (checkbox 메뉴)
  const simMenu = document.getElementById("sim-compartments-menu");
  simMenu.innerHTML = "";
  compList.forEach(c => {
    const li = document.createElement("li");
    li.innerHTML = `
      <label class="dropdown-item">
        <input type="checkbox" class="form-check-input me-2 sim-comp-checkbox" value="${c}" checked>
        ${c}
      </label>
    `;
    simMenu.appendChild(li);
  });

  updateSelectedBadges();

  window._compartments = compList;
  window._parameters = paramList;
}

function displayPKSummary(pk) {
  const container = document.getElementById("pk-summary");
  container.innerHTML = "";

  const table = document.createElement("table");
  table.className = "table table-sm table-striped table-bordered";

  const header = `
    <thead class="table-light">
      <tr>
        <th>Compartment</th>
        <th>C<sub>max</sub></th>
        <th>T<sub>max</sub> (h)</th>
        <th>AUC</th>
      </tr>
    </thead>
  `;

  const rows = Object.entries(pk).map(([comp, metrics]) => `
    <tr>
      <td>${comp}</td>
      <td>${metrics.Cmax?.toFixed(4) ?? "-"}</td>
      <td>${metrics.Tmax?.toFixed(2) ?? "-"}</td>
      <td>${metrics.AUC?.toFixed(2) ?? "-"}</td>
    </tr>
  `).join("");

  table.innerHTML = header + `<tbody>${rows}</tbody>`;
  container.appendChild(table);
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
