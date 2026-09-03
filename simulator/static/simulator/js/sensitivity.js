/**
 * sensitivity.js  ──  무엇이 곡선을 움직이는지 보는 화면
 * ────────────────────────────────────────────────────────────
 * 모달에서 두 가지를 묻는다.
 *   scan      한 가지 값을 훑으며 곡선이 어떻게 움직이는지 → 겹친 곡선들
 *   tornado   파라미터를 조금씩 흔들어 어느 것이 가장 크게 움직이는지 → 가로 막대
 * 어느 쪽이든 /sweep/ 에 한 번 보내고 결과를 Sensitivity 카드에 그린다.
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
    menu: document.getElementById("sens-param-menu"),
    toggle: document.getElementById("sens-param-toggle"),
    chosen: document.getElementById("sens-chosen"),
    current: document.getElementById("sens-current"),
    modeDesc: document.getElementById("sens-mode-desc"),
    from: document.getElementById("sens-from"),
    to: document.getElementById("sens-to"),
    points: document.getElementById("sens-points"),
    list: document.getElementById("sens-list"),
    preview: document.getElementById("sens-preview"),
    delta: document.getElementById("sens-delta"),
    metric: document.getElementById("sens-metric"),
    variable: document.getElementById("sens-variable"),
    status: document.getElementById("sens-status"),
    run: document.getElementById("sens-run"),
    card: document.getElementById("sensitivity-card"),
    caption: document.getElementById("sensitivity-caption"),
    plot: document.getElementById("sensitivity-plot"),
    table: document.getElementById("sensitivity-table"),
    note: document.getElementById("sensitivity-note"),
    switcher: document.getElementById("sensitivity-switcher"),
  };

  function setNote(text) {
    els.note.textContent = text || "";
    els.note.hidden = !text;
  }

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

  const METRIC_LABEL = {
    c_max: "Cmax",
    t_max: "Tmax",
    auc_last: "AUC 0–last",
    auc_inf_obs: "AUC 0–∞",
    half_life: "Half-life",
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
  function parseTarget(raw, text) {
    const cut = String(raw || "").indexOf(":");
    if (cut < 0) return { kind: "parameter", target: raw, text: text || raw };
    return { kind: raw.slice(0, cut), target: raw.slice(cut + 1), text: text || raw };
  }

  /** 고른 대상들. 여러 개를 골라도 함께 움직이지는 않는다 — 하나씩 따로
   *  훑고 결과를 따로 돌려준다. */
  function selectedTargets() {
    return Array.prototype.slice
      .call(els.menu.querySelectorAll(".sens-target-checkbox:checked"))
      .map((cb) => parseTarget(cb.value, cb.dataset.text));
  }

  /** 미리보기나 범위 시드처럼 하나만 있으면 되는 자리에서 쓴다. */
  function firstTarget() {
    return selectedTargets()[0] || { kind: "parameter", target: "", text: "" };
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

  function menuGroup(label, options) {
    if (!options.length) return "";
    const body = options.map((o) => `
      <li>
        <label class="dropdown-item py-1">
          <input type="checkbox" class="form-check-input me-2 sens-target-checkbox"
                 value="${o.value}" data-text="${o.text}">
          ${o.text}
        </label>
      </li>`).join("");
    return `<li><h6 class="dropdown-header">${label}</h6></li>${body}`;
  }

  /** 고를 수 있는 대상 목록. 앱의 'Plot Compartments' 와 같은 방식 —
   *  체크박스가 든 드롭다운. 여러 개를 고를 수 있으면서도 자리를 덜 먹는다. */
  function buildTargetList() {
    const previous = new Set(selectedTargets().map((s) => s.kind + ":" + s.target));

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

    els.menu.innerHTML =
      menuGroup("Parameters", params) +
      menuGroup("Initial values", initials) +
      menuGroup("Doses", doses);

    // 아직 있는 대상이면 앞서 고른 것을 유지하고, 없으면 첫 파라미터 하나.
    const boxes = els.menu.querySelectorAll(".sens-target-checkbox");
    let restored = 0;
    boxes.forEach((cb) => {
      if (previous.has(cb.value)) { cb.checked = true; restored += 1; }
    });
    if (!restored && boxes.length) boxes[0].checked = true;
  }

  /** 무엇을 고르고 있는지 드롭다운 밖에서도 보이게 한다. */
  function refreshChosen() {
    const chosen = selectedTargets();
    els.toggle.textContent = chosen.length === 1
      ? chosen[0].text
      : (chosen.length ? chosen.length + " selected" : "Choose");
    els.chosen.innerHTML = chosen.length > 1
      ? chosen.map((s) => `<span class="badge text-bg-secondary">${s.text}</span>`).join("")
      : "";
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

  /* ---------------------------------------------------------- */
  /* 무엇을 묻는가 — 하나를 훑을 것인가, 전부를 흔들 것인가        */
  /* ---------------------------------------------------------- */
  function currentView() {
    const checked = modalEl.querySelector('input[name="sensView"]:checked');
    return checked ? checked.value : "scan";
  }

  function applyView() {
    const view = currentView();
    modalEl.querySelectorAll("[data-sens-view]").forEach((el) => {
      el.hidden = el.dataset.sensView !== view;
    });
    els.run.innerHTML = view === "tornado"
      ? '<i class="bi bi-play-circle"></i> Run tornado'
      : '<i class="bi bi-play-circle"></i> Run sweep';
    setStatus("", null);
  }

  function applyMode() {
    const mode = currentMode();

    if (mode !== lastMode) {
      if (lastMode !== "list") {
        remembered[lastMode] = { from: +els.from.value, to: +els.to.value };
      }
      if (mode !== "list") loadRange(mode, firstTarget());
      lastMode = mode;
    }

    modalEl.querySelectorAll("[data-sens-mode]").forEach((el) => {
      el.hidden = !el.dataset.sensMode.split(" ").includes(mode);
    });
    els.modeDesc.textContent = MODE_TEXT[mode] || "";
    refreshPreview();
  }

  function refreshPreview() {
    refreshChosen();
    const chosen = selectedTargets();

    // 하나만 골랐으면 기준값을 옆에 적어 준다. 여럿이면 값이 여럿이라
    // 한 줄에 담기지 않으므로 미리보기 쪽에서 대상마다 보여 준다.
    if (chosen.length === 1) {
      const base = baseValue(chosen[0]);
      els.current.textContent = base === undefined || Number.isNaN(base)
        ? "" : "currently " + fmt(base, 4);
    } else {
      els.current.textContent = "";
    }

    if (!chosen.length) {
      els.preview.textContent = "Pick something to sweep.";
      return;
    }

    const lines = [];
    let total = 0;
    chosen.forEach((sel) => {
      const values = plannedValues(sel);
      total += values.length;
      const width = chosen.length > 1 ? 14 : 0;
      const name = chosen.length > 1 ? (sel.text + " ").padEnd(width, " ") : "";
      lines.push(name + (values.length
        ? values.map((v) => fmt(v, 3)).join("   ")
        : (currentMode() === "list" ? "(type or paste values)" : "(enter a positive range)")));
    });
    if (chosen.length > 1) {
      lines.push("");
      lines.push(`${chosen.length} sweeps · ${total} simulations`);
    }
    els.preview.textContent = lines.join("\n");
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
    if (lastMode !== "list") loadRange(lastMode, firstTarget());
    applyMode();
    applyView();
  });

  modalEl.querySelectorAll('input[name="sensView"]').forEach((el) => {
    el.addEventListener("change", applyView);
  });

  // 체크박스는 메뉴 안에서 만들어지므로 위임해서 듣는다.
  els.menu.addEventListener("change", (event) => {
    if (!event.target.classList.contains("sens-target-checkbox")) return;
    remembered.range = null;
    if (currentMode() === "range") loadRange("range", firstTarget());
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
  function basePayload(sweep) {
    const stepsInput = document.getElementById("dropdown-sim-steps");
    return {
      equations: document.getElementById("ode-input").value.trim(),
      initials: currentInitials(),
      parameters: currentParameters(),
      doses: currentDoses(),
      t_start: +document.getElementById("sim-start-time").value,
      t_end: +document.getElementById("sim-end-time").value,
      t_steps: stepsInput ? +stepsInput.value : 200,
      sweep: sweep,
    };
  }

  async function postSweep(payload) {
    const response = await fetch("/sweep/", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRFToken": csrfToken() },
      body: JSON.stringify(payload),
    });
    const result = await response.json();
    if (result.status !== "ok") throw new Error(result.message || "Sweep failed.");
    return result.data;
  }

  els.run.addEventListener("click", async () => {
    els.run.disabled = true;
    try {
      if (currentView() === "tornado") {
        const delta = +els.delta.value / 100;
        if (!(delta > 0 && delta < 1)) {
          setStatus("Nudge by something between 0 and 100%.", "warn");
          return;
        }
        const count = Object.values(currentParameters()).filter((v) => v).length;
        setStatus("Nudging " + count + " parameters…", null);
        render([await postSweep(basePayload({
          mode: "tornado", delta: delta, variable: els.variable.value,
        }))]);
      } else {
        // 대상마다 따로 훑는다. 한 요청에 여러 대상을 담지 않는 이유는
        // 값 목록이 대상마다 다르기 때문이다 — 배수는 각자의 기준값에
        // 걸리므로 CL 의 ×2 와 V 의 ×2 는 다른 숫자다.
        const chosen = selectedTargets();
        if (!chosen.length) {
          setStatus("Pick something to sweep.", "warn");
          return;
        }
        const jobs = chosen.map((sel) => ({ sel: sel, values: plannedValues(sel) }));
        const usable = jobs.filter((j) => j.values.length >= 2);
        if (!usable.length) {
          setStatus("Give at least two values to sweep over.", "warn");
          return;
        }

        const results = [];
        for (let i = 0; i < usable.length; i += 1) {
          const job = usable[i];
          setStatus(usable.length > 1
            ? `Sweeping ${job.sel.text} (${i + 1} of ${usable.length})…`
            : `Running ${job.values.length} simulations…`, null);
          results.push(await postSweep(basePayload({
            mode: "scan",
            kind: job.sel.kind,
            target: job.sel.target,
            values: job.values,
            variable: els.variable.value,
          })));
        }
        render(results);

        const skipped = jobs.length - usable.length;
        if (skipped) {
          setStatus(`Done — ${skipped} of ${jobs.length} had no usable values and were skipped.`, "warn");
          return;
        }
      }

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

  let lastResult = null;

  /* 여러 대상을 훑으면 결과도 여럿이다. 세로로 죽 쌓으면 다섯 개만 되어도
     스크롤만 하게 되므로, 전부 들고 있다가 한 번에 하나씩 보여 준다.
     이미 받아 둔 자료라 전환은 즉시고 다시 풀지 않는다. */
  let results = [];
  let activeIndex = 0;

  function render(list) {
    results = Array.isArray(list) ? list : [list];
    activeIndex = 0;
    renderSwitcher();
    showResult(0);
    els.card.style.display = "block";
    els.card.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function renderSwitcher() {
    if (results.length < 2) {
      els.switcher.hidden = true;
      els.switcher.innerHTML = "";
      return;
    }
    els.switcher.innerHTML = results.map((d, i) => `
      <button type="button" class="sens-tab${i === activeIndex ? " is-active" : ""}"
              data-index="${i}">${d.target}</button>`).join("");
    els.switcher.hidden = false;
  }

  function showResult(i) {
    const data = results[i];
    if (!data) return;
    activeIndex = i;
    lastResult = data;
    lastTornado = data.mode === "tornado" ? data : null;
    if (data.mode === "tornado") renderTornado(data);
    else renderScan(data);
    els.switcher.querySelectorAll(".sens-tab").forEach((b, j) =>
      b.classList.toggle("is-active", j === i));
  }

  els.switcher.addEventListener("click", (event) => {
    const tab = event.target.closest(".sens-tab");
    if (tab) showResult(+tab.dataset.index);
  });

  function renderScan(data) {
    const runs = data.runs || [];
    if (!runs.length) return;

    const variable = data.variable;
    const logY = document.getElementById("log-scale").checked;

    // 토네이도가 항목 수에 맞춰 늘려 둔 높이를 CSS 기본값으로 되돌린다.
    els.plot.style.height = "";
    setNote("");

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
  }

  /* ---------------------------------------------------------- */
  /* 토네이도                                                     */
  /* ---------------------------------------------------------- */
  /** 서버가 지표를 전부 돌려주므로 순위 기준을 바꿔도 다시 풀 필요가 없다.
   *  마지막 결과를 들고 있다가 그 자리에서 다시 그린다. */
  let lastTornado = null;

  els.metric.addEventListener("change", () => {
    if (lastTornado) renderTornado(lastTornado);
  });

  function renderTornado(data) {
    const metric = els.metric.value;
    const label = METRIC_LABEL[metric] || metric;

    // 흔들린 폭이 큰 것부터 위에 오게 한다. Plotly 는 가로 막대의 첫 항목을
    // 맨 아래에 놓으므로, 오름차순으로 넣어야 위에서부터 큰 것이 보인다.
    const items = (data.items || [])
      .map((it) => {
        const swing = (it.swing || {})[metric];
        return { it: it, swing: swing, span: swing ? Math.abs(swing[1] - swing[0]) : 0 };
      })
      .filter((row) => row.swing)
      .sort((a, b) => a.span - b.span);

    if (!items.length) {
      els.caption.textContent = `Tornado · ${label} could not be computed for ${data.variable}`;
      setNote("");
      Plotly.purge(els.plot);
      els.table.innerHTML = "";
      return;
    }

    const names = items.map((r) => r.it.label);
    const pct = Math.round(data.delta * 1000) / 10;

    const bar = (side, color, name) => ({
      type: "bar",
      orientation: "h",
      y: names,
      x: items.map((r) => r.swing[side]),
      name: name,
      marker: { color: color },
      hovertemplate: "%{y}  %{x:+.2f}%<extra>" + name + "</extra>",
    });

    // 가로 막대는 개수만큼 자리가 필요하다. 고정 높이면 파라미터가 많을 때 뭉갠다.
    els.plot.style.height = Math.max(240, items.length * 44 + 130) + "px";

    Plotly.react(
      els.plot,
      [bar(0, "hsl(212, 78%, 72%)", "−" + pct + "%"),
       bar(1, "hsl(212, 78%, 40%)", "+" + pct + "%")],
      {
        barmode: "overlay",
        bargap: 0.35,
        xaxis: {
          title: "% change in " + label,
          zeroline: true,
          zerolinecolor: "#1d1d1f",
          zerolinewidth: 1.5,
          gridcolor: "rgba(0,0,0,0.05)",
          ticksuffix: "%",
        },
        yaxis: { type: "category", automargin: true },
        legend: { orientation: "h", yanchor: "bottom", y: 1.02, xanchor: "right", x: 1 },
        margin: { t: 30, r: 20, b: 55, l: 20 },
        paper_bgcolor: "rgba(0,0,0,0)",
        plot_bgcolor: "rgba(0,0,0,0)",
      },
      { responsive: true }
    );

    // 표는 영향이 큰 것부터, 즉 그림의 위에서부터 읽히는 순서로.
    const rows = items.slice().reverse().map((row) => {
      const it = row.it;
      const s = (it.sensitivity || {})[metric];
      return `<tr>
          <td>${it.label}</td>
          <td>${fmt(it.low_value)}</td>
          <td>${fmt(it.high_value)}</td>
          <td>${fmt((it.low || {})[metric])}</td>
          <td>${fmt((it.high || {})[metric])}</td>
          <td><strong>${s === null || s === undefined ? "-" : (+s).toFixed(3)}</strong></td>
        </tr>`;
    }).join("");

    els.table.innerHTML = `
      <div class="table-responsive">
        <table class="table table-sm table-hover">
          <thead class="table-light">
            <tr>
              <th>Parameter</th>
              <th>at −${pct}%</th>
              <th>at +${pct}%</th>
              <th>${label} low</th>
              <th>${label} high</th>
              <th title="Normalised sensitivity: a 1% change in the parameter gives S% change in the metric">S</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;

    const base = (data.baseline || {})[metric];
    els.caption.textContent =
      `Tornado · ±${pct}% · ranked by ${label}` +
      (base === null || base === undefined ? "" : ` (baseline ${fmt(base)})`) +
      ` · on ${data.variable}`;

    setNote(gridWarning(data, metric, items));
  }

  /** Tmax 는 곡선의 최고점을 출력 격자 위에서 읽은 값이라 격자 간격보다
   *  가늘게는 움직이지 못한다. 흔들린 폭이 그 정도면 순위가 아니라 반올림을
   *  보고 있는 것이므로 그렇다고 말해 준다. */
  function gridWarning(data, metric, items) {
    if (metric !== "t_max" || !data.time_step) return "";
    const widest = items.reduce((best, r) => {
      const lo = (r.it.low || {}).t_max;
      const hi = (r.it.high || {}).t_max;
      return Number.isFinite(lo) && Number.isFinite(hi)
        ? Math.max(best, Math.abs(hi - lo)) : best;
    }, 0);
    if (widest >= 3 * data.time_step) return "";
    const steps = widest / data.time_step;
    return "Tmax can only land on the output grid, which here is spaced " +
      fmt(data.time_step, 3) + " apart, and the widest nudge moved it " +
      fmt(widest, 3) + " — about " + steps.toFixed(1) + " grid " +
      (steps < 1.5 ? "step" : "steps") + ". These bars are mostly rounding. " +
      "Raise the number of simulation points, or nudge harder, before " +
      "reading anything into the Tmax ranking.";
  }

  /* ---------------------------------------------------------- */
  /* 내보내기 — File > Export > Sensitivity Results               */
  /* ---------------------------------------------------------- */
  /* 화면의 표에는 대표 지표만 싣지만 CSV 에는 계산된 것을 전부 넣는다.
     스프레드시트로 가져가는 이유가 대개 더 파고들기 위해서다. */
  function scanCsvRows(data) {
    return (data.runs || []).map((run, i) => {
      const pk = run.pk || {};
      return {
        swept: data.target,
        value: run.value,
        baseline: i === data.baseline_index ? "yes" : "",
        variable: data.variable,
        Cmax: pk.c_max,
        Tmax: pk.t_max,
        Clast: pk.c_last,
        Tlast: pk.t_last,
        lambda_z: pk.lambda_z,
        "Half-life": pk.half_life,
        "AUC_0-last": pk.auc_last,
        "AUC_0-inf": pk.auc_inf_obs,
        AUC_extrap_pct: pk.auc_extrap_pct,
        "AUMC_0-last": pk.aumc_last,
        "AUMC_0-inf": pk.aumc_inf,
        CL: pk.cl,
        Vz: pk.vz,
        MRT: pk.mrt,
        Vss: pk.vss,
      };
    });
  }

  /* 토네이도는 지표마다 순위가 달라진다. 화면에서 고른 하나만 내보내면
     나머지를 보려고 다시 돌려야 하므로, 파라미터 × 지표를 전부 편다. */
  function tornadoCsvRows(data) {
    const rows = [];
    (data.items || []).forEach((it) => {
      (data.metrics || []).forEach((m) => {
        const swing = (it.swing || {})[m];
        rows.push({
          parameter: it.label,
          metric: METRIC_LABEL[m] || m,
          variable: data.variable,
          delta_pct: Math.round(data.delta * 1000) / 10,
          parameter_baseline: it.base,
          parameter_low: it.low_value,
          parameter_high: it.high_value,
          metric_baseline: (data.baseline || {})[m],
          metric_low: (it.low || {})[m],
          metric_high: (it.high || {})[m],
          pct_change_low: swing ? swing[0] : null,
          pct_change_high: swing ? swing[1] : null,
          S: (it.sensitivity || {})[m],
        });
      });
    });
    return rows;
  }

  const exportBtn = document.getElementById("export-sensitivity-btn");
  if (exportBtn) {
    exportBtn.addEventListener("click", () => {
      if (!lastResult) {
        window.alert("Run a sensitivity analysis first — there is nothing to export yet.");
        return;
      }
      if (typeof exportSummaryToCsv !== "function") return;
      const tornado = lastResult.mode === "tornado";
      exportSummaryToCsv(
        tornado ? tornadoCsvRows(lastResult) : scanCsvRows(lastResult),
        tornado ? "sensitivity_tornado.csv" : "sensitivity_scan.csv"
      );
    });
  }

  /* ---------------------------------------------------------- */
  /* 설정 기억하기                                                */
  /* ---------------------------------------------------------- */
  /* 세션 파일에는 넣지 않는다. 세션은 모델을 담는 것이고, 여기 있는 것은
     "지난번에 어떻게 보고 있었나" 에 가깝다. 사이드바 접힘 상태와 같은
     자리(localStorage)에 둔다. 대상과 절대 범위는 모델에 매인 값이라
     빼고, 어디서든 뜻이 통하는 것만 기억한다. */
  const STORE_KEY = "pkSimulator.sensitivity";

  function saveSettings() {
    try {
      window.localStorage.setItem(STORE_KEY, JSON.stringify({
        view: currentView(),
        mode: currentMode(),
        multiple: { from: +els.from.value, to: +els.to.value },
        points: +els.points.value,
        delta: +els.delta.value,
        metric: els.metric.value,
      }));
    } catch (e) { /* 사생활 보호 모드 등에서 막힐 수 있다 */ }
  }

  function loadSettings() {
    let saved;
    try {
      saved = JSON.parse(window.localStorage.getItem(STORE_KEY) || "null");
    } catch (e) {
      saved = null;
    }
    if (!saved) return;

    if (saved.multiple && saved.multiple.from > 0 && saved.multiple.to > 0) {
      remembered.multiple = { from: saved.multiple.from, to: saved.multiple.to };
    }
    if (saved.points >= 2 && saved.points <= 40) els.points.value = saved.points;
    if (saved.delta > 0 && saved.delta < 100) els.delta.value = saved.delta;
    if (saved.metric && els.metric.querySelector(`[value="${saved.metric}"]`)) {
      els.metric.value = saved.metric;
    }
    const view = modalEl.querySelector(`input[name="sensView"][value="${saved.view}"]`);
    if (view) view.checked = true;
    const mode = modalEl.querySelector(`input[name="sensMode"][value="${saved.mode}"]`);
    if (mode) mode.checked = true;
  }

  loadSettings();
  modalEl.addEventListener("hide.bs.modal", saveSettings);
  els.run.addEventListener("click", saveSettings);
})();
