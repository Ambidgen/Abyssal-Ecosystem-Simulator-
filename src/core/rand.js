// Deterministic, dependency-free RNG + value noise.
// Everything in the sim draws from these so a seed fully replays an ecosystem.

export function hashStr(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export function mulberry32(a) {
  let s = a >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Mix two 32-bit ints into a new seed (used to derive per-individual seeds). */
export function mixSeed(a, b) {
  let h = (a >>> 0) ^ Math.imul(b + 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

export class Rand {
  constructor(seed = 1) {
    this.seed = seed >>> 0;
    this.next = mulberry32(this.seed);
  }
  /** float in [0,1) */
  f() { return this.next(); }
  /** float in [a,b) */
  r(a = 0, b = 1) { return a + (b - a) * this.next(); }
  /** integer in [a,b] inclusive */
  i(a, b) { return Math.floor(this.r(a, b + 1 - 1e-9)); }
  chance(p) { return this.next() < p; }
  bool() { return this.next() < 0.5; }
  pick(arr) { return arr[Math.floor(this.next() * arr.length) % arr.length]; }
  /** weighted pick: items = [[value, weight], ...] */
  weighted(items) {
    let total = 0;
    for (const it of items) total += Math.max(0, it[1]);
    if (total <= 0) return items[0][0];
    let t = this.next() * total;
    for (const it of items) {
      t -= Math.max(0, it[1]);
      if (t <= 0) return it[0];
    }
    return items[items.length - 1][0];
  }
  /** roughly gaussian, clamped */
  gauss(mu = 0, sig = 1) {
    const u = (this.next() + this.next() + this.next()) / 3;
    return mu + (u - 0.5) * 3.4641 * sig;
  }
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }
  /** derive an independent sub-stream */
  fork(salt = 0) { return new Rand(mixSeed(this.seed, salt + 1)); }
}

// ---------------------------------------------------------------------------
// hash based value noise (no tables to allocate, stable for any coordinate)

function h2(x, y, seed) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  h ^= h >>> 15; h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const smooth = (t) => t * t * (3 - 2 * t);

/** 2D value noise in [-1,1] */
export function noise2(x, y, seed = 0) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = smooth(x - xi), yf = smooth(y - yi);
  const a = h2(xi, yi, seed), b = h2(xi + 1, yi, seed);
  const c = h2(xi, yi + 1, seed), d = h2(xi + 1, yi + 1, seed);
  const v = (a + (b - a) * xf) * (1 - yf) + (c + (d - c) * xf) * yf;
  return v * 2 - 1;
}

/** 1D value noise in [-1,1] */
export function noise1(x, seed = 0) { return noise2(x, 0.5, seed); }

/** fractal brownian motion, 1D */
export function fbm1(x, seed = 0, oct = 4, lac = 2.0, gain = 0.5) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let o = 0; o < oct; o++) {
    sum += amp * noise1(x * freq, seed + o * 37);
    norm += amp;
    amp *= gain; freq *= lac;
  }
  return sum / norm;
}

/** fractal brownian motion, 2D */
export function fbm2(x, y, seed = 0, oct = 4) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let o = 0; o < oct; o++) {
    sum += amp * noise2(x * freq, y * freq, seed + o * 91);
    norm += amp;
    amp *= 0.5; freq *= 2.03;
  }
  return sum / norm;
}

export { h2 as hash2 };
