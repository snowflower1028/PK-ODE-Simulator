/**
 * sensitivity.js  ──  값 하나를 훑어 보는 화면
 * ────────────────────────────────────────────────────────────
 * 모달에서 훑을 대상과 값 목록을 받아 /sweep/ 에 한 번 보내고,
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
    modeDesc: document.getElementById("sens-mode-desc"),
    from: document.getElementById("sens-from"),
    to: document.getElementById("sens-to"),
    points: document.getElementById("sens-points"),
    list: document.getElementById("sens-list"),
    preview: document.getElementById("sens-preview"),
    variable: document.getElementById("sens-variable"),
    status: document.getElementById("sens-status"),
    run: document.getElementById("sens-run"),
    card: document.getElementById("sensitivity-card"),
    caption: document.getElementById("sensitivity-caption"),
    plot: document.getElementById("sensitivity-plot"),
    table: document.getElementById("sensitivity-table"),
  };

  const MODE_TEXT = {
    multiple:
      "Multiples of the current value, spaced evenly on a log scale so the " +
      "baseline sits in the middle. PK parameters span very different " +
      "magnitudes, and a multiple means the same thing for all of them.",
    range:
      "Absolute values, spaced evenly between the two ends. Use this when the " +
      "range means something on its own — doses you can actually give, a " +
      "clearance you have measured.",
    list:
      "The exact values you want, separated by spaces, commas or new lines. " +
      "Paste a column straight from a spreadsheet.",
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

  /** script.js 의 State 는 최상위 const 라 전역 렉시컬 스코프에만 있고
   *  window 에는 올라가지 않는다. 이름으로 직접 집어야 한다. */
  function currentDoses() {
    return (typeof State !== "undefined" && State.doseList) || [];
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
  /* 무엇을 훑는가                                                */
  /* ---------------------------------------------------------- */
  /** 선택값은 "kind:target" 한 문자열로 실어 나른다. 구획 이름과
   *  파라미터 이름이 겹칠 수 있어 이름만으로는 구분되지 않는다. */
  function selectedTarget() {
    const raw = els.param.value || "";
    const cut = raw.indexOf(":");
    if (cut < 0) return { kind: "parameter", target: raw };
    return { kind: raw.slice(0, cut), target: raw.slice(cut + 1) };
  }

  /** 지금 화면에 들어 있는 그 대상의 값. 스윕의 기준점이 된다. */
  function baseValue(sel) {
    if (sel.kind === "parameter") return currentParameters()[sel.target];
    if (sel.kind === "initial") return currentInitials()[sel.target];
    if (sel.kind === "dose") {
      const dose = currentDoses()[+sel.target];
      return dose ? +dose.amount : undefined;
    }
    return undefined;
  }

  function optionGroup(label, options) {
    if (!options.length) return "";
    const body = options
      .map((o) => `<option value="${o.value}">${o.text}</option>`)
      .join("");
    return `<optgroup label="${label}">${body}</optgroup>`;
  }

  function buildTargetList() {
    const params = Object.keys(currentParameters()).map((n) => ({
      value: "parameter:" + n, text: n,
    }));
    const initials = Object.keys(currentInitials()).map((n) => ({
      value: "initial:" + n, text: n + "(0)",
    }));
    const doses = currentDoses().map((d, i) => ({
      value: "dose:" + i,
      text: d.compartment + " dose at " + d.start_time,
    }));

    els.param.innerHTML =
      optionGroup("Parameters", params) +
      optionGroup("Initial values", initials) +
      optionGroup("Doses", doses);
  }

  /* ---------------------------------------------------------- */
  /* 훑을 값 만들기                                               */
  /* ---------------------------------------------------------- */
  function currentMode() {
    const checked = modalEl.querySelector('input[name="sensMode"]:checked');
    return checked ? checked.value : "multiple";
  }

  /* 배수와 절대값은 같은 두 칸을 쓰지만 뜻이 전혀 다르다. 25 – 400 을
     입력해 두고 배수 모드로 넘어가면 ×25 – ×400 이 되어 버리므로, 모드마다
     따로 기억했다가 되돌려 준다. 절대 범위는 대상의 크기에 매인 값이라
     대상이 바뀌면 기억을 버리고 새 기준값에서 다시 잡는다. */
  const remembered = { multiple: { from: 0.5, to: 2 }, range: null };
  let lastMode = "multiple";

  function loadRange(mode, sel) {
    let saved = mode === "range" ? remembered.range : remembered.multiple;
    if (!saved) {
      const base = baseValue(sel);
      saved = base > 0
        ? { from: +(base / 2).toPrecision(4), to: +(base * 2).toPrecision(4) }
        : { from: 0, to: 1 };
    }
    els.from.value = saved.from;
    els.to.value = saved.to;
  }

  function spaced(from, to, points, log) {
    const out = [];
    const lo = log ? Math.log(from) : from;
    const hi = log ? Math.log(to) : to;
    for (let i = 0; i < points; i += 1) {
      const t = i / (points - 1);
      const v = lo + (hi - lo) * t;
      out.push(log ? Math.exp(v) : v);
    }
    return out;
  }

  function rawValues(sel, mode) {
    if (mode === "list") {
      return els.list.value
        .split(/[\s,;]+/)
        .map((s) => parseFloat(s))
        .filter((v) => Number.isFinite(v));
    }

    const from = +els.from.value;
    const to = +els.to.value;
    const points = +els.points.value;
    if (!Number.isFinite(from) || !Number.isFinite(to) || !(points >= 2)) return [];

    if (mode === "range") return spaced(from, to, points, false);

    const base = baseValue(sel);
    if (!(base > 0) || !(from > 0) || !(to > 0)) return [];
    return spaced(from, to, points, true).map((v) => base * v);
  }

  /** 지금 설정으로 실제로 돌 값들. 못 만들면 빈 배열.
   *
   *  배수는 로그 간격이다 — ×0.5 – ×2 를 로그로 나누면 기준값(×1)이 정확히
   *  가운데 오지만, 선형으로 나누면 ×1.25 가 가운데가 되어 한쪽으로 치우친다.
   *  절대 범위는 반대로 선형이 맞다. "5 에서 40 까지 일곱 점" 이라고 말할 때
   *  기대하는 것은 고르게 벌어진 값이지 기하급수가 아니다.
   *
   *  훑는 범위 안에 현재값이 들어 있으면 그 점을 끼워 넣는다. 어디서
   *  출발했는지 보이는 것이 스윕의 절반이고, 배수 모드가 아니면 현재값이
   *  저절로 들어오지는 않는다. 범위 밖이면 넣지 않는다 — 보고 있지도 않은
   *  구간의 곡선을 하나 더 그릴 이유가 없다.
   *
   *  값이 커질수록 진해지는 색을 쓰므로 순서대로 정렬해서 돌려준다. */
  function plannedValues(sel) {
    const values = rawValues(sel, currentMode()).map((v) => +v.toPrecision(6));
    if (!values.length) return [];

    const base = baseValue(sel);
    if (Number.isFinite(base) && base >= Math.min.apply(null, values)
        && base <= Math.max.apply(null, values)) {
      values.push(+base.toPrecision(6));
    }

    values.sort((a, b) => a - b);
    const out = [];
    values.forEach((v) => {
      const last = out[out.length - 1];
      // 끼워 넣은 현재값이 이미 있는 점과 겹칠 수 있어 근사 중복까지 걸러 낸다.
      if (last === undefined || Math.abs(v - last) > 1e-9 * Math.max(Math.abs(v), 1)) out.push(v);
    });
    return out.slice(0, 40);
  }

  function fmt(value, digits) {
    if (value === null || value === undefined || Number.isNaN(value)) return "-";
    return (+value).toPrecision(digits || 4);
  }

  function applyMode() {
    const mode = currentMode();

    if (mode !== lastMode) {
      if (lastMode !== "list") {
        remembered[lastMode] = { from: +els.from.value, to: +els.to.value };
      }
      if (mode !== "list") loadRange(mode, selectedTarget());
      lastMode = mode;
    }

    modalEl.querySelectorAll("[data-sens-mode]").forEach((el) => {
      el.hidden = !el.dataset.sensMode.split(" ").includes(mode);
    });
    els.modeDesc.textContent = MODE_TEXT[mode] || "";
    refreshPreview();
  }

  function refreshPreview() {
    const sel = selectedTarget();
    const base = baseValue(sel);
    els.current.textContent = base === undefined || Number.isNaN(base)
      ? "" : "currently " + fmt(base, 4);

    const values = plannedValues(sel);
    if (!values.length) {
      els.preview.textContent = currentMode() === "list"
        ? "Type or paste the values to run."
        : "Enter a positive range.";
      return;
    }
    els.preview.textContent = values.map((v) => fmt(v, 3)).join("   ");
  }

  /* ---------------------------------------------------------- */
  /* 모달 열기                                                    */
  /* ---------------------------------------------------------- */
  modalEl.addEventListener("show.bs.modal", () => {
    buildTargetList();

    const vars = plottableVariables();
    els.variable.innerHTML = vars.map((v) => `<option value="${v}">${v}</option>`).join("");

    // 농도로 쓰이는 파생 변수가 있으면 그쪽을 먼저 고른다 — 대개 그리고 싶은 것이다.
    const derived = Array.prototype.slice
      .call(document.querySelectorAll("#derived-values .derived-box strong"))
      .map((el) => el.textContent.trim());
    const preferred = vars.find((v) => derived.includes(v));
    if (preferred) els.variable.value = preferred;

    setStatus("", null);
    // 대상 목록을 새로 만들었으니 절대 범위 기억은 더 이상 맞지 않는다.
    remembered.range = null;
    lastMode = currentMode();
    if (lastMode !== "list") loadRange(lastMode, selectedTarget());
    applyMode();
  });

  els.param.addEventListener("change", () => {
    remembered.range = null;
    if (currentMode() === "range") loadRange("range", selectedTarget());
    refreshPreview();
  });

  [els.from, els.to, els.points, els.list].forEach((el) => {
    el.addEventListener("input", refreshPreview);
    el.addEventListener("change", refreshPreview);
  });
  modalEl.querySelectorAll('input[name="sensMode"]').forEach((el) => {
    el.addEventListener("change", applyMode);
  });

  // 파싱 전에는 훑을 대상이 없다.
  if (els.button) {
    const sync = () => {
      const ready = document.querySelectorAll('#param-values input[id^="param_"]').length > 0;
      els.button.disabled = !ready;
      els.button.title = ready
        ? "Sweep one value and see how the profile moves"
        : "Parse ODEs first — there is nothing to sweep yet";
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
    const sel = selectedTarget();
    const values = plannedValues(sel);

    if (values.length < 2) {
      setStatus("Give at least two values to sweep over.", "warn");
      return;
    }

    const stepsInput = document.getElementById("dropdown-sim-steps");
    const payload = {
      equations: document.getElementById("ode-input").value.trim(),
      initials: currentInitials(),
      parameters: currentParameters(),
      doses: currentDoses(),
      t_start: +document.getElementById("sim-start-time").value,
      t_end: +document.getElementById("sim-end-time").value,
      t_steps: stepsInput ? +stepsInput.value : 200,
      sweep: {
        mode: "scan",
        kind: sel.kind,
        target: sel.target,
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
