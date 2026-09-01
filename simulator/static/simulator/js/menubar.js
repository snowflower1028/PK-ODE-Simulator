/**
 * menubar.js  ──  상단 메뉴 바 동작
 * ────────────────────────────────────────────────────────────
 * 메뉴 항목은 자체 로직을 갖지 않는다. 화면에 이미 있는 컨트롤을
 * 대신 눌러 줄 뿐이므로 script.js 의 이벤트 바인딩은 그대로 유지된다.
 *
 *   data-proxy="#id"        클릭 시 해당 요소를 click() 한다.
 *                           대상이 disabled 면 메뉴 항목도 흐리게 표시한다.
 *   data-proxy-check="#id"  체크박스 상태를 메뉴에 체크 표시로 반영한다.
 *   data-help-tab="#id"     Help 모달을 열면서 해당 탭을 활성화한다.
 *   data-example="key"      예제 모델을 ODE 입력창에 채우고 Parse 한다.
 */
(function () {
  "use strict";

  /* ---------------------------------------------------------- */
  /* 1. 예제 모델                                                */
  /* ---------------------------------------------------------- */
  const EXAMPLES = {
    iv1c: {
      label: "1-compartment IV bolus",
      text: ["dA1dt = -(CL/V)*A1", "C1 = A1/V"].join("\n"),
    },
    oral1c: {
      label: "1-compartment oral absorption",
      text: [
        "dAgdt = -ka*Ag",
        "dA1dt = ka*Ag - (CL/V)*A1",
        "C1 = A1/V",
      ].join("\n"),
    },
    iv2c: {
      label: "2-compartment IV bolus",
      text: [
        "dA1dt = -(CL/V1)*A1 - (Q/V1)*A1 + (Q/V2)*A2",
        "dA2dt = (Q/V1)*A1 - (Q/V2)*A2",
        "C1 = A1/V1",
        "C2 = A2/V2",
      ].join("\n"),
    },
    mm: {
      label: "Michaelis-Menten elimination",
      text: ["dA1dt = -Vmax*C/(Km + C)", "C = A1/V"].join("\n"),
    },
  };

  /* ---------------------------------------------------------- */
  /* 2. 메뉴 상태 동기화                                          */
  /* ---------------------------------------------------------- */

  /** 메뉴가 열릴 때 항목의 disabled / 체크 상태를 실제 컨트롤에 맞춘다. */
  function syncMenu(menuRoot) {
    menuRoot.querySelectorAll("[data-proxy]").forEach((item) => {
      const target = document.querySelector(item.dataset.proxy);
      const off = !target || target.disabled;
      item.classList.toggle("disabled", off);
      item.toggleAttribute("aria-disabled", off);
    });

    menuRoot.querySelectorAll("[data-proxy-check]").forEach((item) => {
      const target = document.querySelector(item.dataset.proxyCheck);
      const on = !!(target && target.checked);
      item.classList.toggle("app-menu-checked", on);
      item.setAttribute("aria-checked", String(on));
      item.setAttribute("role", "menuitemcheckbox");
    });
  }

  document.addEventListener("show.bs.dropdown", (event) => {
    const menu = event.target.querySelector(".app-menu");
    if (menu) syncMenu(menu);
  });

  /* ---------------------------------------------------------- */
  /* 3. 클릭 위임                                                */
  /* ---------------------------------------------------------- */
  document.addEventListener("click", (event) => {
    const item = event.target.closest("[data-proxy], [data-example]");
    if (!item) return;

    // 예제 모델 불러오기
    if (item.dataset.example) {
      loadExample(item.dataset.example);
      return;
    }

    // 기존 컨트롤 대리 클릭
    const target = document.querySelector(item.dataset.proxy);
    if (!target || target.disabled) return;

    target.click();

    // 토글이라면 방금 바뀐 상태를 메뉴에 즉시 반영한다
    // (Log Y 처럼 메뉴가 열린 채로 남는 항목이 있다).
    if (item.dataset.proxyCheck) {
      const menu = item.closest(".app-menu");
      if (menu) syncMenu(menu);
    }
  });

  /** 예제 ODE 를 입력창에 채우고 곧바로 Parse 한다. */
  function loadExample(key) {
    const example = EXAMPLES[key];
    const input = document.getElementById("ode-input");
    if (!example || !input) return;

    if (input.value.trim() && input.value.trim() !== example.text) {
      const ok = window.confirm(
        'Replace the current ODE system with "' + example.label + '"?'
      );
      if (!ok) return;
    }

    input.value = example.text;
    input.dispatchEvent(new Event("input", { bubbles: true }));

    const parseBtn = document.getElementById("parse-btn");
    if (parseBtn) parseBtn.click();
  }

  /* ---------------------------------------------------------- */
  /* 4. New Session                                              */
  /* ---------------------------------------------------------- */
  /* 상태가 State, DOM, Plotly, 피팅 모달에 흩어져 있어 부분 초기화는
     빠뜨리기 쉽다. 새로 읽어들이는 편이 확실하고 의미도 정확하다. */
  const newSessionBtn = document.getElementById("new-session-btn");
  if (newSessionBtn) {
    newSessionBtn.addEventListener("click", () => {
      const ode = document.getElementById("ode-input");
      const dirty = !!(ode && ode.value.trim());
      if (dirty && !window.confirm(
        "Start a new session? The current model, doses and observed data will be discarded."
      )) return;
      window.location.reload();
    });
  }

  /* ---------------------------------------------------------- */
  /* 5. 단축키                                                    */
  /* ---------------------------------------------------------- */
  /* 브라우저가 선점한 조합(Ctrl+N, Ctrl+R, Ctrl+L 등)은 피하고,
     가로채도 사용자가 놀라지 않는 것만 쓴다. */
  const SHORTCUTS = {
    "ctrl+enter": "#simulate-btn",
    "ctrl+s": "#export-session-btn",
    "ctrl+o": "#import-session-input",
    "ctrl+/": '[data-help-tab="#help-quickstart"]',
  };

  function chordOf(event) {
    if (!event.ctrlKey && !event.metaKey) return null;
    if (event.altKey) return null;
    const key = event.key === "Enter" ? "enter" : event.key.toLowerCase();
    return "ctrl+" + key;
  }

  document.addEventListener("keydown", (event) => {
    const chord = chordOf(event);
    if (!chord) return;

    const selector = SHORTCUTS[chord];
    if (!selector) return;

    // 모달이나 오프캔버스가 열려 있으면 뒤쪽 화면을 조작하지 않는다.
    if (document.querySelector(".modal.show, .offcanvas.show")) return;

    const target = document.querySelector(selector);
    if (!target || target.disabled) return;

    event.preventDefault();
    target.click();
  });

  /* ---------------------------------------------------------- */
  /* 6. Help 모달 탭 선택                                         */
  /* ---------------------------------------------------------- */
  const helpModal = document.getElementById("helpModal");
  if (helpModal) {
    helpModal.addEventListener("show.bs.modal", (event) => {
      const wanted = event.relatedTarget && event.relatedTarget.dataset.helpTab;
      if (!wanted) return;
      const trigger = helpModal.querySelector('[data-bs-target="' + wanted + '"]');
      if (!trigger || trigger.classList.contains("active")) return;
      // Bootstrap 이 아직 로드되지 않았을 수 있으므로 존재를 확인한다.
      if (window.bootstrap && window.bootstrap.Tab) {
        window.bootstrap.Tab.getOrCreateInstance(trigger).show();
      }
    });
  }
})();
