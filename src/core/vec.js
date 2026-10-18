// Small math helpers shared by sim + renderer. No allocation in hot paths.

export const TAU = Math.PI * 2;
export const PI = Math.PI;
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
export const smoothstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0 || 1e-6));
  return t * t * (3 - 2 * t);
};
/** shortest signed angular difference b-a */
export function angDelta(a, b) {
  let d = (b - a) % TAU;
  if (d > PI) d -= TAU;
  else if (d < -PI) d += TAU;
  return d;
}
/** frame-rate independent exponential smoothing */
export const damp = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));

export const dist = (x0, y0, x1, y1) => Math.hypot(x1 - x0, y1 - y0);
export const dist2 = (x0, y0, x1, y1) => {
  const dx = x1 - x0, dy = y1 - y0;
  return dx * dx + dy * dy;
};
export const len = (x, y) => Math.hypot(x, y);

export function norm(x, y) {
  const l = Math.hypot(x, y);
  return l > 1e-9 ? { x: x / l, y: y / l } : { x: 1, y: 0 };
}

/** rotate (x,y) by angle */
export function rot(x, y, a) {
  const c = Math.cos(a), s = Math.sin(a);
  return { x: x * c - y * s, y: x * s + y * c };
}

export function approach(cur, target, delta) {
  const d = target - cur;
  if (Math.abs(d) <= delta) return target;
  return cur + Math.sign(d) * delta;
}

let _uid = 1;
export const uid = () => _uid++;
export function resetUid(v = 1) { _uid = v; }

/** simple object pool to keep the GC quiet in the particle systems */
export class Pool {
  constructor(factory, reset) {
    this.free = [];
    this.factory = factory;
    this.reset = reset;
  }
  get() {
    const o = this.free.pop();
    return o === undefined ? this.factory() : o;
  }
  put(o) {
    if (this.reset) this.reset(o);
    if (this.free.length < 4096) this.free.push(o);
  }
}
