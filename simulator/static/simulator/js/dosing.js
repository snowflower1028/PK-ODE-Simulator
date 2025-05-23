const doseList = [];

document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("dose-form");
  const doseContainer = document.getElementById("dose-list");

  // Infusion type일 때만 duration 필드 표시
  document.getElementById("type").addEventListener("change", e => {
    const show = e.target.value === "infusion";
    document.getElementById("duration-label").style.display = show ? "block" : "none";
  });

  // dose 추가 처리
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

    // NaN 방지 처리
    if (Number.isNaN(dose.repeat_every)) dose.repeat_every = null;
    if (Number.isNaN(dose.repeat_until)) dose.repeat_until = null;

    doseList.push(dose);
    renderDoses();
    form.reset();
    document.getElementById("duration-label").style.display = "none";
  });

  function renderDoses() {
    doseContainer.innerHTML = "";
    doseList.forEach((dose, index) => {
      const card = document.createElement("div");
      card.className = "dose-card";
      card.innerHTML = `
        <div class="dose-card-header">
          <strong>Dose ${index + 1}</strong>
          <button onclick="removeDose(${index})">🗑️</button>
        </div>
        <ul>
          <li><b>Compartment:</b> ${dose.compartment}</li>
          <li><b>Type:</b> ${dose.type}</li>
          <li><b>Amount:</b> ${dose.amount}</li>
          <li><b>Start Time:</b> ${dose.start_time} h</li>
          ${dose.type === "infusion" ? `<li><b>Duration:</b> ${dose.duration} h</li>` : ""}
          ${dose.repeat_every && dose.repeat_until ? `<li><b>Repeat:</b> every ${dose.repeat_every} h until ${dose.repeat_until} h</li>` : ""}
        </ul>
      `;
      doseContainer.appendChild(card);
    });
  }

  window.removeDose = function(index) {
    doseList.splice(index, 1);
    renderDoses();
  };
});

// 시뮬레이션 실행
document.getElementById("simulate-btn").onclick = () => {
  const odeText = document.getElementById("ode-input").value;
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
      compartments: window._compartments,
      parameters: params,
      initials: initials,
      doses: doseList
    })
  })
    .then(res => res.json())
    .then(data => {
      console.log("Server response:", data);
      if (data.status === "ok") {
        alert("✅ Simulation succeeded!");
        plotSimulationResult(data.data.profile);
        displayPKSummary(data.data.pk);
      } else {
        alert("Simulation error: " + data.message);
      }
    })
    .catch(err => alert("Error: " + err));
};

// CSRF 토큰 추출
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

// Plotly로 결과 시각화
function plotSimulationResult(data) {
  const time = data["Time"];
  const traces = [];

  for (const key in data) {
    if (key === "Time") continue;
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
    yaxis: { title: "Concentration", type: "linear" },
    legend: { orientation: "h" }
  };

  Plotly.newPlot("plot", traces, layout);
}

// ODE 입력 분석
function parseODE() {
  const text = document.getElementById("ode-input").value;
  const lines = text.split("\n").map(line => line.trim()).filter(Boolean);

  const compartments = new Set();
  const parameters = new Set();

  lines.forEach(line => {
    const [lhs, rhs] = line.split("=").map(s => s.trim());
    const compMatch = lhs.match(/^d([A-Za-z0-9_]+)dt$/);
    if (!compMatch) return;
    const comp = compMatch[1];
    compartments.add(comp);

    const symbols = rhs.match(/[A-Za-z_][A-Za-z0-9_]*/g);
    symbols.forEach(sym => {
      if (sym !== comp) parameters.add(sym);
    });
  });

  renderSymbolInputs([...compartments], [...parameters]);
}

// 입력 폼 자동 생성
function renderSymbolInputs(compList, paramList) {
  const initDiv = document.getElementById("init-values");
  const paramDiv = document.getElementById("param-values");
  initDiv.innerHTML = "";
  paramDiv.innerHTML = "";

  compList.forEach(c => {
    const label = document.createElement("label");
    label.innerHTML = `${c}: <input type="number" name="init_${c}" step="any" value="1.0">`;
    initDiv.appendChild(label);
    initDiv.appendChild(document.createElement("br"));
  });

  paramList.forEach(p => {
    const label = document.createElement("label");
    label.innerHTML = `${p}: <input type="number" name="param_${p}" step="any" value="0.1">`;
    paramDiv.appendChild(label);
    paramDiv.appendChild(document.createElement("br"));
  });

  // 전역에 저장
  window._compartments = compList;
  window._parameters = paramList;
}

function displayPKSummary(pk) {
  const container = document.getElementById("pk-summary") || document.createElement("div");
  container.id = "pk-summary";
  container.innerHTML = "<h2>📊 PK Summary</h2>";

  for (const comp in pk) {
    const row = pk[comp];
    container.innerHTML += `
      <b>${comp}</b>: 
      Cmax = ${row.Cmax.toFixed(4)}, 
      Tmax = ${row.Tmax.toFixed(2)} h, 
      AUC = ${row.AUC.toFixed(2)}<br>
    `;
  }

  document.body.appendChild(container);
}

