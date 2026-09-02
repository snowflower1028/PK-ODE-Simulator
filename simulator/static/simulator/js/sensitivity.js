/**
 * sensitivity.js  ──  파라미터 하나를 훑어 보는 화면
 * ────────────────────────────────────────────────────────────
 * 모달에서 파라미터와 배수 범위를 받아 /sweep/ 에 한 번 보내고,
 * 돌아온 곡선들을 Sensitivity 카드에 겹쳐 그린다.
 *
 * 솔버 한 번이 수십 밀리초라 스무 번을 돌아도 0.2초 남짓이다. 그래서
 * 진행률 표시도, 백그라운드 작업도 없이 요청 한 번으로 끝낸다.
 *
 * script.js 의 State 에서 투여 목록만 빌려 오고, 나머지 값은 화면의
 * 입력칸에서 직접 읽는다 — 시뮬레이션이 보내는 것과 같은 값을 같은 곳에서
 * 읽어야 스윕의 기준선이 화면의 곡선과 일치한다.
 */
(function () {
  "use strict";

  const modalEl = document.getElementById("sensitivityModal");
  if (!modalEl) return;

  const els = {
    button: document.getElementById("sensitivity-btn"),
    param: document.getElementById("sens-param"),
    current: document.getElementById("sens-current"),
    from: document.getElementById("sens-from"),
    to: document.getElementById("sens-to"),
    points: document.getElementById("sens-points"),
    preview: document.getElementById("sens-preview"),
    variable: document.getElementById("sens-variable"),
    status: document.getElementById("sens-status"),
    run: document.getElementById("sens-run"),
    card: document.getElementById("sensitivity-card"),
    caption: document.getElementById("sensitivity-caption"),
    plot: document.getElementById("sensitivity-plot"),
    table: document.getElementById("sensitivity-table"),
  };

  /* ---------------------------------------------------------- */
  /* 화면에서 현재 모델 상태를 읽는다                              */
  /* ---------------------------------------------------------- */
  function valueInputs(selector, prefix) {
    return Array.prototype.slice.call(document.querySelectorAll(selector)).map((input) => ({
      name: input.id.slice(prefix.length),
      value: +input.value,
    }));
  }

  function currentParameters() {
    const out = {};
    valueInputs('#param-values input[id^="param_"]', "param_").forEach((p) => { out[p.name] = p.value; });
    return out;
  }

  function currentInitials() {
    const out = {};
    valueInputs('#init-values input[id^="init_"]', "init_").forEach((p) => { out[p.name] = p.value; });
    return out;
  }

  function plottableVariables() {
    return Array.prototype.slice
      .call(document.querySelectorAll("#sim-compartments-menu .sim-comp-checkbox"))
      .map((cb) => cb.value);
  }

  function csrfToken() {
    const el = document.querySelector('input[name="csrfmiddlewaretoken"]');
    if (el) return el.value;
    const hit = document.cookie.split("; ").find((c) => c.startsWith("csrftoken="));
    return hit ? hit.split("=")[1] : "";
  }

  /* ---------------------------------------------------------- */
  /* 훑을 값 만들기                                               */
  /* ---------------------------------------------------------- */
  /** 배수 범위를 로그 간격으로 나눈다.
   *  ×0.5 – ×2 를 로그로 나누면 기준값(×1)이 정확히 가운데 온다.
   *  선형으로 나누면 ×1.25 가 가운데가 되어 한쪽으로 치우친다. */
  function sweepValues(base, from, to, points) {
    if (!(base > 0) || !(from > 0) || !(to > 0) || points < 2) return [];
    const lo = Math.log(from);
    const hi = Math.log(to);
    const out = [];
    for (let i = 0; i < points; i += 1) {
      const t = i / (points - 1);
      out.push(base * Math.exp(lo + (hi - lo) * t));
    }
    // 표시와 요청에 쓰기 좋게 유효숫자 6자리로 다듬는다.
    return out.map((v) => +v.toPrecision(6));
  }

  function fmt(value, digits) {
    if (value === null || value === undefined || Number.isNaN(value)) return "-";
    return (+value).toPrecision(digits || 4);
  }

  function refreshPreview() {
    const name = els.param.value;
    const base = currentParameters()[name];
    els.current.textContent = base === undefined ? "" : "currently " + fmt(base, 4);

    const values = sweepValues(base, +els.from.value, +els.to.value, +els.points.value);
    if (!values.length) {
      els.preview.textContent = "Enter a positive range.";
      return;
    }
    els.preview.textContent = values.map((v) => fmt(v, 3)).join("   ");
  }

  /* ---------------------------------------------------------- */
  /* 모달 열기                                                    */
  /* ---------------------------------------------------------- */
  modalEl.addEventListener("show.bs.modal", () => {
    const params = currentParameters();
    const names = Object.keys(params);

    els.param.innerHTML = names.map((n) => `<option value="${n}">${n}</option>`).join("");
    const vars = plottableVariables();
    els.variable.innerHTML = vars.map((v) => `<option value="${v}">${v}</option>`).join("");

    // 농도로 쓰이는 파생 변수가 있으면 그쪽을 먼저 고른다 — 대개 그리고 싶은 것이다.
    const derived = Array.prototype.slice
      .call(document.querySelectorAll("#derived-values .derived-box strong"))
      .map((el) => el.textContent.trim());
    const preferred = vars.find((v) => derived.includes(v));
    if (preferred) els.variable.value = preferred;

    els.status.textContent = "";
    els.status.className = "sens-status";
    refreshPreview();
  });

  [els.param, els.from, els.to, els.points].forEach((el) => {
    el.addEventListener("input", refreshPreview);
    el.addEventListener("change", refreshPreview);
  });

  // 파싱 전에는 훑을 파라미터가 없다.
  if (els.button) {
    const sync = () => {
      const ready = document.querySelectorAll('#param-values input[id^="param_"]').length > 0;
      els.button.disabled = !ready;
      els.button.title = ready
        ? "Sweep one parameter and see how the profile moves"
        : "Parse ODEs first — there are no parameters to sweep yet";
      if (ready) {
        els.button.setAttribute("data-bs-toggle", "modal");
        els.button.setAttribute("data-bs-target", "#sensitivityModal");
      }
    };
    const target = document.getElementById("param-values");
    if (target) new MutationObserver(sync).observe(target, { childList: true, subtree: true });
    sync();
  }

  /* ---------------------------------------------------------- */
  /* 실행                                                         */
  /* ---------------------------------------------------------- */
  els.run.addEventListener("click", async () => {
    const target = els.param.value;
    const params = currentParameters();
    const values = sweepValues(params[target], +els.from.value, +els.to.value, +els.points.value);

    if (!values.length) {
      setStatus("Enter a positive range and at least two points.", "warn");
      return;
    }

    const stepsInput = document.getElementById("dropdown-sim-steps");
    const payload = {
      equations: document.getElementById("ode-input").value.trim(),
      initials: currentInitials(),
      parameters: params,
      doses: (window.State && window.State.doseList) || State.doseList || [],
      t_start: +document.getElementById("sim-start-time").value,
      t_end: +document.getElementById("sim-end-time").value,
      t_steps: stepsInput ? +stepsInput.value : 200,
      sweep: {
        mode: "scan",
        target: target,
        values: values,
        variable: els.variable.value,
      },
    };

    els.run.disabled = true;
    setStatus("Running " + values.length + " simulations…", null);

    try {
      const response = await fetch("/sweep/", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRFToken": csrfToken() },
        body: JSON.stringify(payload),
      });
      const result = await response.json();
      if (result.status !== "ok") throw new Error(result.message || "Sweep failed.");

      render(result.data);
      setStatus("Done — see the Sensitivity card below.", "ok");
      bootstrap.Modal.getInstance(modalEl).hide();
    } catch (error) {
      setStatus(error.message, "warn");
    } finally {
      els.run.disabled = false;
    }
  });

  function setStatus(text, kind) {
    els.status.textContent = text || "";
    els.status.className = "sens-status" + (kind ? " is-" + kind : "");
  }

  /* ---------------------------------------------------------- */
  /* 결과 그리기                                                  */
  /* ---------------------------------------------------------- */
  /** 값이 커질수록 진해지는 한 계열. 색상이 바뀌면 순서가 아니라
   *  범주로 읽히므로, 색조는 앱의 파랑에 고정하고 밝기만 움직인다. */
  function shade(t) {
    const lightness = 74 - 46 * t;
    return `hsl(212, 78%, ${lightness}%)`;
  }

  function render(data) {
    const runs = data.runs || [];
    if (!runs.length) return;

    const variable = data.variable;
    const logY = document.getElementById("log-scale").checked;

    const traces = runs.map((run, i) => {
      const isBase = i === data.baseline_index;
      return {
        x: run.profile.Time,
        y: run.profile[variable],
        mode: "lines",
        name: run.label,
        line: {
          color: isBase ? "#1d1d1f" : shade(runs.length > 1 ? i / (runs.length - 1) : 0.5),
          width: isBase ? 3 : 1.8,
          dash: isBase ? "solid" : "solid",
        },
      };
    });

    Plotly.react(
      els.plot,
      traces,
      {
        xaxis: { title: "Time", zeroline: false, gridcolor: "rgba(0,0,0,0.05)" },
        yaxis: {
          title: variable,
          type: logY ? "log" : "linear",
          zeroline: false,
          gridcolor: "rgba(0,0,0,0.05)",
          exponentformat: "power",
        },
        legend: { orientation: "h", yanchor: "bottom", y: 1.02, xanchor: "right", x: 1 },
        margin: { t: 30, r: 20, b: 50, l: 60 },
        paper_bgcolor: "rgba(0,0,0,0)",
        plot_bgcolor: "rgba(0,0,0,0)",
      },
      { responsive: true }
    );

    const rows = runs.map((run, i) => {
      const pk = run.pk || {};
      const mark = i === data.baseline_index
        ? ' <span class="sens-base">baseline</span>' : "";
      return `<tr>
          <td>${fmt(run.value, 4)}${mark}</td>
          <td>${fmt(pk.c_max)}</td>
          <td>${fmt(pk.t_max)}</td>
          <td>${fmt(pk.auc_last)}</td>
          <td>${fmt(pk.auc_inf_obs)}</td>
          <td>${fmt(pk.half_life)}</td>
        </tr>`;
    }).join("");

    els.table.innerHTML = `
      <div class="table-responsive">
        <table class="table table-sm table-hover">
          <thead class="table-light">
            <tr>
              <th>${data.target}</th>
              <th>C<sub>max</sub></th>
              <th>T<sub>max</sub></th>
              <th>AUC<sub>0–last</sub></th>
              <th>AUC<sub>0–∞</sub></th>
              <th>t<sub>½</sub></th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;

    els.caption.textContent =
      `${data.target} · ${fmt(runs[0].value, 3)} – ${fmt(runs[runs.length - 1].value, 3)} · ${runs.length} runs · showing ${variable}`;
    els.card.style.display = "block";
    els.card.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
})();
