/* ============================================================ */
/* tooltip.js — 계산 정보 팝업                                     */
/* ============================================================ */
/**
 * 두 페이지(시뮬레이터와 NCA 계산기)가 같은 팝업을 쓴다. script.js 안에
 * 두면 NCA 쪽에서 script.js 를 통째로 끌어와야 하고, 베껴 두면 한쪽만
 * 고치는 날이 온다. 그래서 따로 뺐다.
 *
 * 두 페이지 모두 이 파일을 뒤 스크립트보다 먼저 defer 로 싣는다 — defer 는
 * 문서에 적힌 순서를 지키므로 뒤 파일에서 그냥 부르면 된다.
 */

/** 속성값 안에 넣어도 안전하도록 따옴표와 꺾쇠를 이스케이프한다. */
/** 표 머리글의 ⓘ. 정의·수식·주의를 각각 실어 보낸다 — 하나로 이어 붙이면
 *  팝업에서 다시 나눌 수 없다. */
function infoButton(col) {
  return `<button type="button" class="pk-info" tabindex="0" aria-label="About ${escapeAttr(col.key)}"
    data-tip-def="${escapeAttr(col.definition || '')}"
    data-tip-formula="${escapeAttr(col.formula || '')}"
    data-tip-note="${escapeAttr(col.caveat || '')}">i</button>`;
}

function escapeAttr(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/* ============================================================ */
/* Tooltip — 계산 정보 팝업                                       */
/* ============================================================ */
/**
 * 표 머리글의 ⓘ 에 붙는 설명. 세 부분을 늘 같은 순서로 보여 준다.
 *
 *   정의    이 값이 무엇인가
 *   수식    어떻게 계산했는가 — 코드 상자에 넣어 글이 아니라 식임을 보인다
 *   주의    무엇이 이 값을 잘못 읽게 만드는가
 *
 * 셋째가 가장 값어치 있다. 정의와 수식은 교과서에도 있지만, "이 앱에서 이
 * 숫자가 언제 거짓말을 하는가"는 여기서만 말할 수 있다.
 *
 * CSS 만으로 만들던 예전 방식(::after + content: attr(data-tip))에는 두
 * 가지 문제가 있었다. 하나는 세 부분을 나눠 꾸밀 수 없다는 것이고, 다른
 * 하나는 자리를 잡는 방식이었다 — absolute 라서 위치 잡힌 조상을 찾아
 * 붙는데, 그 조상을 만들어 주는 규칙이 #pk-summary 에만 걸려 있어 다른
 * 표에서는 엉뚱한 곳에 떴다. 게다가 .table-responsive 의 overflow 가
 * 잘라 냈다.
 *
 * 그래서 팝업 하나를 body 에 두고 fixed 로 띄운다. 조상이 무엇이든,
 * 어디서 잘리든 상관이 없어진다.
 */
const Tooltip = {
  _el: null,
  _anchor: null,

  _panel() {
    if (this._el) return this._el;
    const el = document.createElement('div');
    el.className = 'tip-pop';
    el.setAttribute('role', 'tooltip');
    el.hidden = true;
    document.body.appendChild(el);
    this._el = el;
    return el;
  },

  show(anchor) {
    const def = anchor.dataset.tipDef || '';
    const formula = anchor.dataset.tipFormula || '';
    const note = anchor.dataset.tipNote || '';
    if (!def && !formula && !note) return;

    const panel = this._panel();
    panel.innerHTML =
      (def ? `<p class="tip-def">${escapeAttr(def)}</p>` : '') +
      (formula ? `<code class="tip-formula">${escapeAttr(formula)}</code>` : '') +
      (note ? `<p class="tip-note">${escapeAttr(note)}</p>` : '');

    panel.hidden = false;
    this._anchor = anchor;
    this._place(anchor);
  },

  hide() {
    if (!this._el) return;
    this._el.hidden = true;
    this._anchor = null;
  },

  /** 트리거 바로 아래에 두되, 화면 밖으로 나가면 안쪽으로 당긴다. */
  _place(anchor) {
    const panel = this._el;
    const a = anchor.getBoundingClientRect();

    // 폭을 먼저 확정해야 높이를 잰 값이 맞는다.
    panel.style.left = '0px';
    panel.style.top = '0px';
    const p = panel.getBoundingClientRect();
    const margin = 8;

    let left = a.left + a.width / 2 - p.width / 2;
    left = Math.min(Math.max(left, margin), window.innerWidth - p.width - margin);

    // 아래에 자리가 없으면 위로 뒤집는다.
    let top = a.bottom + 6;
    if (top + p.height > window.innerHeight - margin) {
      const above = a.top - p.height - 6;
      if (above >= margin) top = above;
      else top = Math.max(margin, window.innerHeight - p.height - margin);
    }

    panel.style.left = Math.round(left) + 'px';
    panel.style.top = Math.round(top) + 'px';
  },

  init() {
    // 표는 수시로 다시 그려지므로 문서 단위로 위임한다.
    document.addEventListener('mouseover', (event) => {
      const anchor = event.target.closest('.pk-info');
      if (anchor) this.show(anchor);
    });
    document.addEventListener('mouseout', (event) => {
      const anchor = event.target.closest('.pk-info');
      if (anchor && anchor === this._anchor) this.hide();
    });
    document.addEventListener('focusin', (event) => {
      const anchor = event.target.closest('.pk-info');
      if (anchor) this.show(anchor);
    });
    document.addEventListener('focusout', (event) => {
      const anchor = event.target.closest('.pk-info');
      if (anchor && anchor === this._anchor) this.hide();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') this.hide();
    });
    // 팝업은 fixed 라 스크롤을 따라오지 않는다. 따라오게 만드는 대신 닫는다 —
    // 스크롤한다는 것은 이미 다른 곳을 보고 있다는 뜻이다.
    window.addEventListener('scroll', () => this.hide(), true);
    window.addEventListener('resize', () => this.hide());
  },
};
