// Uniform-grid spatial hash for neighbour queries + a coarse scalar field used
// for nutrients / plankton / alarm pheromones. Both are the backbone of the
// perception layer, so creatures never do O(n^2) scans.

export class SpatialHash {
  constructor(w, h, cell) {
    this.cell = cell;
    this.cols = Math.ceil(w / cell);
    this.rows = Math.ceil(h / cell);
    this.buckets = new Array(this.cols * this.rows);
    for (let i = 0; i < this.buckets.length; i++) this.buckets[i] = [];
  }
  clear() {
    for (let i = 0; i < this.buckets.length; i++) this.buckets[i].length = 0;
  }
  _idx(x, y) {
    let cx = (x / this.cell) | 0, cy = (y / this.cell) | 0;
    if (cx < 0) cx = 0; else if (cx >= this.cols) cx = this.cols - 1;
    if (cy < 0) cy = 0; else if (cy >= this.rows) cy = this.rows - 1;
    return cy * this.cols + cx;
  }
  insert(obj, x, y) {
    obj._bucket = this._idx(x, y);
    this.buckets[obj._bucket].push(obj);
  }
  /** visit every object whose stored position is within `radius` of (x,y) */
  query(x, y, radius, fn) {
    const c = this.cell;
    let cx0 = ((x - radius) / c) | 0, cx1 = ((x + radius) / c) | 0;
    let cy0 = ((y - radius) / c) | 0, cy1 = ((y + radius) / c) | 0;
    if (cx0 < 0) cx0 = 0; if (cy0 < 0) cy0 = 0;
    if (cx1 >= this.cols) cx1 = this.cols - 1; if (cy1 >= this.rows) cy1 = this.rows - 1;
    const r2 = radius * radius;
    for (let cy = cy0; cy <= cy1; cy++) {
      const rowBase = cy * this.cols;
      for (let cx = cx0; cx <= cx1; cx++) {
        const b = this.buckets[rowBase + cx];
        for (let i = 0; i < b.length; i++) {
          const o = b[i];
          const dx = o.x - x, dy = o.y - y;
          if (dx * dx + dy * dy <= r2) fn(o, dx, dy);
        }
      }
    }
  }
}

/** coarse scalar field with slow diffusion (nutrients, plankton, fear cues) */
export class Field {
  constructor(w, h, cell, decay = 0.02, diffuse = 0.06) {
    this.cell = cell;
    this.cols = Math.max(1, Math.ceil(w / cell));
    this.rows = Math.max(1, Math.ceil(h / cell));
    const n = this.cols * this.rows;
    this.v = new Float32Array(n);
    this.tmp = new Float32Array(n);
    this.decay = decay;
    this.diffuse = diffuse;
  }
  index(x, y) {
    let cx = (x / this.cell) | 0, cy = (y / this.cell) | 0;
    if (cx < 0) cx = 0; else if (cx >= this.cols) cx = this.cols - 1;
    if (cy < 0) cy = 0; else if (cy >= this.rows) cy = this.rows - 1;
    return cy * this.cols + cx;
  }
  at(x, y) { return this.v[this.index(x, y)]; }
  add(x, y, amt) { this.v[this.index(x, y)] += amt; }
  addClamped(x, y, amt, max) {
    const i = this.index(x, y);
    this.v[i] = Math.min(max, this.v[i] + amt);
  }
  sampleBilinear(x, y) {
    const gx = x / this.cell - 0.5, gy = y / this.cell - 0.5;
    let x0 = Math.floor(gx), y0 = Math.floor(gy);
    const fx = gx - x0, fy = gy - y0;
    const cx = (v) => (v < 0 ? 0 : v >= this.cols ? this.cols - 1 : v);
    const cy = (v) => (v < 0 ? 0 : v >= this.rows ? this.rows - 1 : v);
    x0 = cx(x0); y0 = cy(y0);
    const x1 = cx(x0 + 1), y1 = cy(y0 + 1);
    const v = this.v;
    const a = v[y0 * this.cols + x0], b = v[y0 * this.cols + x1];
    const c = v[y1 * this.cols + x0], d = v[y1 * this.cols + x1];
    return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
  }
  step(dt) {
    const { cols, rows, v, tmp } = this;
    const k = Math.min(0.24, this.diffuse);
    const dec = Math.max(0, 1 - this.decay * dt);
    for (let y = 0; y < rows; y++) {
      const base = y * cols;
      const up = (y > 0 ? base - cols : base);
      const dn = (y < rows - 1 ? base + cols : base);
      for (let x = 0; x < cols; x++) {
        const i = base + x;
        const l = x > 0 ? i - 1 : i;
        const r = x < cols - 1 ? i + 1 : i;
        const avg = (v[l] + v[r] + v[up + x] + v[dn + x]) * 0.25;
        tmp[i] = (v[i] + (avg - v[i]) * k) * dec;
      }
    }
    this.v.set(tmp);
  }
  stats() {
    let sum = 0, max = 0, min = Infinity;
    for (let i = 0; i < this.v.length; i++) {
      const v = this.v[i];
      sum += v;
      if (v > max) max = v;
      if (v < min) min = v;
    }
    return { sum, max, min, mean: sum / this.v.length };
  }
}
