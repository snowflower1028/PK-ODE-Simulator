/* ============================================================ */
/* resize.js — 사이드바와 플롯 크기                                 */
/* ============================================================ */
/**
 * 두 페이지가 같은 껍데기(사이드바 + 손잡이 + 플롯)를 쓴다. script.js 안에
 * 두면 NCA 쪽에서 시뮬레이터 코드를 통째로 끌어와야 하므로 따로 뺐다.
 *
 * 페이지마다 다른 것은 어떤 플롯을 지켜보느냐뿐이다. 쓰는 쪽에서 init 전에
 * PLOTS 와 PLOT_KEY 를 갈아 끼운다 — 키까지 갈아야 하는 것은, 저장할 때
 * 지금 목록에 있는 것만 쓰기 때문이다. 키를 함께 쓰면 NCA 페이지를 한 번
 * 여는 것만으로 시뮬레이터가 기억해 둔 플롯 높이가 지워진다.
 *
 * 사이드바 폭은 일부러 한 키를 함께 쓴다. 창을 어떻게 나눠 쓰는지는 도구가
 * 아니라 사람의 습관이라, 도구를 옮겼다고 달라질 이유가 없다.
 */

/* ============================================================ */
/* Resize — 사이드바 너비와 플롯 높이를 사용자가 정한다            */
/* ============================================================ */
/**
 * 어느 쪽이 넓어야 하는지는 지금 무엇을 하는지에 달려 있다. ODE 를 고칠 때는
 * 왼쪽이, 결과를 읽을 때는 오른쪽이 넓어야 한다. 정답을 하나 고르는 대신
 * 손잡이를 준다.
 *
 * 크기는 세션이 아니라 localStorage 에 둔다 — 창을 어떻게 나눠 쓰는지는
 * 모델의 일부가 아니라 이 브라우저의 습관이다. (사이드바 접힘 상태와 같은 자리)
 */
const Resize = {
  SIDEBAR_KEY: 'pkSimulator.sidebarWidth',
  PLOT_KEY: 'pkSimulator.plotHeights',
  PLOTS: ['plot', 'fit-plot', 'sensitivity-plot'],

  init() {
    this._restoreSidebar();
    this._bindSidebar();
    this._restorePlotHeights();
    this._watchPlots();
    this.bindPrint();
  },

  /* ---------------- 사이드바 ---------------- */
  /** 지금 창에서의 폭 한계. CSS 가 갖고 있는 값을 읽어 쓴다 — 두 곳에 적어
   *  두면 반드시 어긋난다. max-width 는 50vw 라 창을 줄이면 같이 줄어든다. */
  _limits() {
    const sidebar = document.querySelector('.sidebar');
    if (!sidebar) return { min: 308, max: 460 };
    const cs = getComputedStyle(sidebar);
    // 좁은 화면에서는 사이드바가 본문 위로 쌓이고 max-width 가 none 이 된다.
    // 거기서는 폭이 아무 뜻도 없으므로 자르지 않는다 — 자르면 창을 다시
    // 넓혔을 때 사용자가 정해 둔 폭이 임의의 값으로 바뀌어 있다.
    const max = parseFloat(cs.maxWidth);
    return {
      min: parseFloat(cs.minWidth) || 308,
      max: Number.isFinite(max) ? max : Infinity,
    };
  },

  _restoreSidebar() {
    let saved = null;
    try { saved = localStorage.getItem(this.SIDEBAR_KEY); } catch (e) { /* 무시 */ }
    if (!saved) return;

    // 넓은 모니터에서 정한 폭을 좁은 화면에서 그대로 되살리면 본문이 사라진다.
    const { min, max } = this._limits();
    const px = Math.min(Math.max(parseFloat(saved) || min, min), max);
    document.documentElement.style.setProperty('--apple-sidebar-width', px + 'px');
  },

  _bindSidebar() {
    const handle = document.getElementById('sidebar-resizer');
    const sidebar = document.querySelector('.sidebar');
    if (!handle || !sidebar) return;

    // min/max 는 CSS 가 이미 갖고 있다. 두 곳에 적어 두면 반드시 어긋나므로
    // 여기서 읽어 쓴다.
    const apply = (px) => {
      // 한계는 매번 다시 읽는다. max-width 가 50vw 라 창 크기를 따라 움직이므로,
      // 한 번 읽어 두면 창을 줄인 뒤로는 낡은 값을 쓰게 된다.
      const { min, max } = this._limits();
      const clamped = Math.min(Math.max(px, min), max);
      document.documentElement.style.setProperty('--apple-sidebar-width', clamped + 'px');
      return clamped;
    };

    let dragging = false;
    const onMove = (event) => {
      if (!dragging) return;
      // 사이드바는 왼쪽에 붙어 있으므로 포인터의 x 가 곧 너비다.
      apply(event.clientX - sidebar.getBoundingClientRect().left);
    };
    const stop = () => {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove('is-dragging');
      document.body.classList.remove('is-resizing');
      try {
        localStorage.setItem(this.SIDEBAR_KEY,
          getComputedStyle(document.documentElement).getPropertyValue('--apple-sidebar-width').trim());
      } catch (e) { /* 무시 */ }
      // 폭이 바뀌었으니 플롯도 다시 그려야 한다.
      this._resizePlots();
    };

    handle.addEventListener('pointerdown', (event) => {
      dragging = true;
      handle.classList.add('is-dragging');
      document.body.classList.add('is-resizing');
      handle.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);

    // 키보드로도 옮길 수 있어야 한다 — 손잡이가 tabindex 를 갖고 있다.
    handle.addEventListener('keydown', (event) => {
      const step = event.shiftKey ? 40 : 10;
      if (event.key === 'ArrowLeft') apply(sidebar.offsetWidth - step);
      else if (event.key === 'ArrowRight') apply(sidebar.offsetWidth + step);
      else return;
      event.preventDefault();
      // stop 은 dragging 이 서 있을 때만 일한다. 키보드로 옮길 때는 포인터를
      // 누른 적이 없어 그대로 부르면 아무것도 저장하지 않고 돌아간다 —
      // 화살표로 맞춘 폭이 새로고침 한 번에 사라진다.
      dragging = true;
      stop();
    });
  },

  /* ---------------- 플롯 높이 ---------------- */
  /* CSS 의 resize:vertical 이 손잡이를 그려 주므로 드래그는 브라우저가 맡는다.
     우리가 할 일은 두 가지 — 바뀐 높이를 기억하고, Plotly 에게 알려 주는 것.
     Plotly 는 창 크기만 듣고 요소 크기는 듣지 않는다. */
  _restorePlotHeights() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(this.PLOT_KEY) || '{}'); } catch (e) { saved = {}; }
    this.PLOTS.forEach((id) => {
      const el = document.getElementById(id);
      if (el && saved[id]) el.style.height = saved[id];
    });
  },

  _savePlotHeights() {
    if (this._printing) return;
    const out = {};
    this.PLOTS.forEach((id) => {
      const el = document.getElementById(id);
      if (el && el.style.height) out[id] = el.style.height;
    });
    try { localStorage.setItem(this.PLOT_KEY, JSON.stringify(out)); } catch (e) { /* 무시 */ }
  },

  _resizePlots() {
    this.PLOTS.forEach((id) => {
      const el = document.getElementById(id);
      // 그려진 적 없는 컨테이너에 resize 를 걸면 Plotly 가 던진다.
      if (el && el.offsetParent !== null && el.querySelector('.main-svg')) {
        try { Plotly.Plots.resize(el); } catch (e) { /* 무시 */ }
      }
    });
  },

  /* 인쇄할 때는 플롯을 종이 크기로 줄였다가 되돌린다.
     CSS 로 컨테이너만 줄이면 Plotly 의 SVG 는 그대로 남아 그림이 잘린다.
     Plotly 에게 직접 말해 줘야 다시 그린다. */
  PRINT_HEIGHT: 300,
  _printing: false,

  bindPrint() {
    let saved = null;
    window.addEventListener('beforeprint', () => {
      // 인쇄용으로 줄이는 것은 사용자가 정한 크기가 아니다. 관찰자가 그걸
      // 취향으로 오해해 저장하면, 인쇄 한 번에 화면 설정이 바뀐다.
      this._printing = true;
      saved = {};
      this.PLOTS.forEach((id) => {
        const el = document.getElementById(id);
        if (!el || !el.querySelector('.main-svg')) return;
        saved[id] = el.style.height;
        el.style.height = this.PRINT_HEIGHT + 'px';
        try { Plotly.Plots.resize(el); } catch (e) { /* 무시 */ }
      });
    });
    window.addEventListener('afterprint', () => {
      if (!saved) return;
      Object.entries(saved).forEach(([id, height]) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.style.height = height;
        try { Plotly.Plots.resize(el); } catch (e) { /* 무시 */ }
      });
      saved = null;
      this._printing = false;
    });
  },

  _watchPlots() {
    if (typeof ResizeObserver === 'undefined') return;
    let timer = null;
    const observer = new ResizeObserver(() => {
      this._resizePlots();
      window.clearTimeout(timer);
      timer = window.setTimeout(() => this._savePlotHeights(), 400);
    });
    this.PLOTS.forEach((id) => {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    });
  },
};
