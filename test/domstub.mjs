// ---------------------------------------------------------------------------
//  A miniature DOM + Canvas2D, just enough to run the real app headlessly.
//  The point is not fidelity, it is *execution*: every painter in src/render
//  and every line of src/ui/hud.js gets driven with live simulation data, and
//  anything that throws or feeds a NaN into a canvas call is a real bug.
// ---------------------------------------------------------------------------

export const problems = [];
const seen = new Set();
const bad = (where, args) => {
  const st = (new Error().stack || '').split('\n')
    .map((l) => l.trim().replace(/^at\s+/, '').replace(/^\(?/, '').replace(/\)?$/, ''))
    .filter((l) => l.includes('/src/'))
    .slice(0, 2).join('  <-  ');
  const sig = where + '@' + st;
  if (seen.has(sig)) return;
  seen.add(sig);
  problems.push(`${where}: ${JSON.stringify(args)}\n      at ${st}`);
};

let calls = 0;
export const counters = {
  get calls() { return calls; },
  reset() { calls = 0; problems.length = 0; },
};

const NUMERIC = {
  moveTo: 2, lineTo: 2, arcTo: 3, quadraticCurveTo: 4, bezierCurveTo: 6,
  rect: 4, fillRect: 4, strokeRect: 4, clearRect: 4, translate: 2, scale: 2,
  rotate: 1, setTransform: 6, transform: 6, ellipse: 7, arc: 5, roundRect: 4,
  createLinearGradient: 4, createRadialGradient: 6, fillText: 3, strokeText: 3,
};

function makeCtx(canvas) {
  const props = {};
  const grad = { addColorStop(o, c) { if (!Number.isFinite(o) || typeof c !== 'string') bad('addColorStop', [o, c]); } };
  const target = {
    canvas,
    save() {}, restore() {}, beginPath() {}, closePath() {}, clip() {}, fill() {}, stroke() {},
    setLineDash(a) { if (Array.isArray(a)) for (const v of a) if (!Number.isFinite(v)) bad('setLineDash', a); },
    getLineDash() { return []; },
    measureText(t) { return { width: String(t).length * 6, actualBoundingBoxAscent: 7, actualBoundingBoxDescent: 2 }; },
    createLinearGradient(...a) { chk('createLinearGradient', a); return grad; },
    createRadialGradient(...a) { chk('createRadialGradient', a, 6); return grad; },
    createConicGradient() { return grad; },
    createPattern() { return { setTransform() {} }; },
    drawImage(img, ...a) { if (!img) bad('drawImage(null)', a); chk('drawImage', a, a.length); },
    putImageData() {}, getImageData(x, y, w, h) { return { data: new Uint8ClampedArray(Math.max(1, (w | 0) * (h | 0) * 4)), width: w | 0, height: h | 0 }; },
    createImageData(w, h) { return { data: new Uint8ClampedArray(Math.max(1, (w | 0) * (h | 0) * 4)), width: w | 0, height: h | 0 }; },
    reset() {},
  };
  function chk(name, args, n = NUMERIC[name] ?? args.length) {
    calls++;
    for (let i = 0; i < n; i++) if (typeof args[i] === 'number' && !Number.isFinite(args[i])) bad(name, args);
  }
  return new Proxy(target, {
    get(t, k) {
      if (k in t) return t[k];
      if (typeof k === 'symbol') return undefined;
      if (k in props) return props[k];      // style-ish property: last value set
      return (...a) => { chk(String(k), a); };
    },
    set(t, k, v) {
      props[k] = v;
      if (k === 'fillStyle' || k === 'strokeStyle' || k === 'shadowColor') {
        if (typeof v === 'number' || (v === null) || (typeof v === 'string' && /NaN|undefined/.test(v))) bad(`ctx.${String(k)}`, [v]);
      }
      if (k === 'globalAlpha' && !Number.isFinite(v)) bad('globalAlpha', [v]);
      if (k === 'lineWidth' && (!Number.isFinite(v) || v < 0)) bad('lineWidth', [v]);
      return true;
    },
  });
}

function makeStyle() {
  const v = {};
  return new Proxy(v, {
    get(t, k) {
      if (k === 'setProperty') return (p, val) => { t[p] = String(val); };
      if (k === 'removeProperty') return (p) => { delete t[p]; };
      if (k === 'getPropertyValue') return (p) => t[p] ?? '';
      if (k === 'cssText') return Object.entries(t).map(([a, b]) => `${a}: ${b}`).join('; ');
      return t[k] ?? '';
    },
    set(t, k, val) { t[k] = String(val); return true; },
  });
}

class ClassList {
  constructor() { this.s = new Set(); }
  add(...c) { for (const x of c) this.s.add(x); }
  remove(...c) { for (const x of c) this.s.delete(x); }
  toggle(c, on) { if (on === undefined) on = !this.s.has(c); on ? this.s.add(c) : this.s.delete(c); return on; }
  contains(c) { return this.s.has(c); }
  get value() { return [...this.s].join(' '); }
}

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.style = makeStyle();
    this.dataset = {};
    this.classList = new ClassList();
    this._text = '';
    this._html = '';
    this.listeners = {};
    this.width = 300; this.height = 150;
    this.clientWidth = 1280; this.clientHeight = 720;
    this.offsetWidth = 1280; this.offsetHeight = 720;
    this._ctx = null;
    this.selectedIndex = 0;
    this.value = '';
  }
  get ownerDocument() { return doc; }
  getContext(kind) { if (kind !== '2d') return null; if (!this._ctx) this._ctx = makeCtx(this); return this._ctx; }
  toDataURL() { return 'data:,'; }
  appendChild(n) { if (!n) { bad('appendChild(null)', []); return n; } n.parentNode = this; this.children.push(n); return n; }
  append(...ns) { for (const n of ns) if (n) this.appendChild(n.nodeType === undefined ? n : n); }
  removeChild(n) { const i = this.children.indexOf(n); if (i >= 0) this.children.splice(i, 1); return n; }
  insertBefore(n) { if (n) { n.parentNode = this; this.children.unshift(n); } return n; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  replaceChildren(...ns) { this.children = []; for (const n of ns) if (n) this.appendChild(typeof n === 'string' ? mkText(n) : n); }
  get className() { return this.classList.value; }
  set className(v) { this.classList.s = new Set(String(v).split(/\s+/).filter(Boolean)); }
  setAttribute(k, v) { if (k === 'class') { this.className = v; return; } this[k] = v; }
  getAttribute(k) { return this[k]; }
  addEventListener(t, fn) { (this.listeners[t] || (this.listeners[t] = [])).push(fn); }
  removeEventListener(t, fn) { const a = this.listeners[t] || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); }
  dispatch(t, ev = {}) { for (const fn of (this.listeners[t] || []).slice()) fn({ type: t, target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, ...ev }); }
  setPointerCapture() {} releasePointerCapture() {} focus() {} blur() {} click() { this.dispatch('click'); }
  getBoundingClientRect() { return { left: 0, top: 0, x: 0, y: 0, width: this.clientWidth, height: this.clientHeight, right: this.clientWidth, bottom: this.clientHeight }; }
  querySelector(sel) { return find(this, sel) || null; }
  querySelectorAll(sel) { return find(this, sel) ? [find(this, sel)] : []; }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); this.children = []; }
  get innerHTML() { return this._html; }
  set innerHTML(v) {
    this._html = String(v);
    this.children = [];
    if (v === '' || v == null) return;
    // crude markup materialiser: enough that querySelector('.x') still works
    const re = /<(\w+)([^>]*)>([^<]*)/g;
    let m;
    while ((m = re.exec(this._html))) {
      const e = new El(m[1]);
      const cls = /class="([^"]*)"/.exec(m[2]);
      if (cls) e.className = cls[1];
      const data = m[2].match(/data-([\w-]+)="([^"]*)"/g) || [];
      for (const d of data) { const kv = /="([^"]*)"/.exec(d); const k = /data-([\w-]+)/.exec(d)[1]; e.dataset[k] = kv ? kv[1] : ''; }
      e._text = m[3].replace(/<[^>]*>/g, '');
      this.appendChild(e);
    }
  }
  get firstChild() { return this.children[0] || null; }
  get lastChild() { return this.children[this.children.length - 1] || null; }
  get nodeType() { return 1; }
  get parentElement() { return this.parentNode; }
  closest() { return null; }
}

function mkText(t) { return { nodeType: 3, textContent: String(t) }; }

function find(root, sel) {
  // supports '#id' and '.class' lookups over the materialised tree
  const want = String(sel).trim();
  const walk = (n) => {
    for (const c of n.children || []) {
      if (!c || c.nodeType !== 1) continue;
      if (want.startsWith('#') && c.id === want.slice(1)) return c;
      if (want.startsWith('.') && c.classList.contains(want.slice(1).split(/[\s.>:[]/)[0])) return c;
      if (!/[#.]|:/.test(want) && c.tagName === want.toUpperCase()) return c;
      const r = walk(c);
      if (r) return r;
    }
    return null;
  };
  return walk(root);
}

const doc = {
  nodeType: 9,
  documentElement: new El('html'),
  body: new El('body'),
  head: new El('head'),
  createElement: (t) => new El(t),
  createElementNS: (ns, t) => new El(t),
  createTextNode: (t) => mkText(t),
  createDocumentFragment: () => new El('fragment'),
  getElementById(id) { return find(doc.body, '#' + id) || byId[id] || null; },
  querySelector: (s) => find(doc.body, s) || null,
  querySelectorAll: (s) => (find(doc.body, s) ? [find(doc.body, s)] : []),
  addEventListener() {}, removeEventListener() {},
};

/** elements the page declares up front, so getElementById works before boot() builds them */
const byId = {};
export function install({ width = 1280, height = 720, dpr = 2 } = {}) {
  const canvas = new El('canvas');
  canvas.id = 'view';
  canvas.clientWidth = width; canvas.clientHeight = height;
  canvas.width = width * dpr; canvas.height = height * dpr;
  byId.view = canvas;
  const ui = new El('div'); ui.id = 'ui'; byId.ui = ui;
  const loading = new El('div'); loading.id = 'loading'; byId.loading = loading;
  {
    const box = new El('div'); box.classList.add('box');
    for (const c of ['title', 'what', 'hint']) { const e = new El('div'); e.classList.add(c); box.appendChild(e); }
    loading.appendChild(box);
  }
  doc.body.appendChild(canvas); doc.body.appendChild(ui); doc.body.appendChild(loading);

  const raf = [];
  const win = {
    innerWidth: width, innerHeight: height, devicePixelRatio: dpr,
    document: doc,
    listeners: {},
    addEventListener(t, fn) { (win.listeners[t] || (win.listeners[t] = [])).push(fn); },
    removeEventListener() {},
    dispatch(t, ev = {}) { for (const fn of (win.listeners[t] || []).slice()) fn({ type: t, target: doc.body, ...ev, preventDefault() {}, stopPropagation() {} }); },
    requestAnimationFrame(fn) { raf.push(fn); return raf.length; },
    cancelAnimationFrame() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    performance: { now: () => Date.now() },
    _raf: raf,
  };
  globalThis.window = win;
  globalThis.document = doc;
  try { Object.defineProperty(globalThis, 'navigator', { value: win.navigator || { userAgent: 'node' }, configurable: true }); } catch { /* node ships one */ }
  try { globalThis.devicePixelRatio = dpr; } catch { /* readonly */ }
  globalThis.requestAnimationFrame = win.requestAnimationFrame;
  globalThis.cancelAnimationFrame = win.cancelAnimationFrame;
  globalThis.HTMLElement = El;
  globalThis.HTMLCanvasElement = El;
  globalThis.getComputedStyle = win.getComputedStyle;
  globalThis.__canvas = canvas;
  globalThis.__win = win;
  globalThis.__doc = doc;
  return { win, doc, canvas, raf };
}

/** pump n animation frames, giving each a monotonically increasing timestamp */
export function pump(n, step = 16.7, onFrame) {
  const raf = globalThis.__win._raf;
  let t = performance.now();
  for (let i = 0; i < n; i++) {
    t += step;
    const batch = raf.splice(0, raf.length);
    for (const fn of batch) fn(t);
    if (onFrame) onFrame(i);
  }
}

export { doc as document, El };
