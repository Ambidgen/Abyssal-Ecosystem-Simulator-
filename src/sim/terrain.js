// ---------------------------------------------------------------------------
//  WORLD GEOMETRY  —  6400 x 3600 px side-view canyon, split by depth into
//  four zones. Two planes of rock exist:
//
//   PLANE_MAIN  the real level. A staircase of terraces whose risers are the
//               cliffs. Reefs, the Wall, the kelp outcrop and the abyssal basin
//               are all just terrace tops at different depths:
//
//     x 0..1950     REEF FLAT      y ~556   Z1, coral, shallows
//     x 1950..2520  WALL BENCH     y ~1380  Z2, foot of THE WALL (the riser at
//                                            x~1950 is a near-vertical cliff
//                                            face that fish swim in front of)
//     x 2520..3320  KELP OUTCROP   y ~2140  Z3, rocky outcrop + heavy kelp
//     x 3320..3760  TALUS SLOPE    y ~2760  boulder fields
//     x 3760..6400  ABYSSAL BASIN  y ~3230  Z4, vents, whale falls, trench
//
//   PLANE_BG  the BACKGROUND WALL: a receding, terraced cliff behind the water
//             column (parallax 0.74, scale 0.78, murk-tinted). It is fully
//             climbable and is where the 8-legged crabs and wall snails travel
//             between Z2 and Z3. Same terrain interface as PLANE_MAIN, so the
//             locomotion code does not care which plane an animal is on.
//
//  Caves are discs carved out of PLANE_MAIN -> overhangs, eel lairs, and the
//  Z3 hatcheries the crabs pour out of.
// ---------------------------------------------------------------------------

import { Rand, fbm1, fbm2, noise2, hash2 } from '../core/rand.js';
import { clamp, clamp01, lerp, smoothstep, TAU } from '../core/vec.js';
import { WORLD_W, WORLD_H, ZONES } from './zones.js';

export const COL = 8;
export const COLS = Math.ceil(WORLD_W / COL);
export const ROW = 8;
export const ROWS = Math.ceil(WORLD_H / ROW);
export const Z4_TOP = ZONES[3].top;

/** terrace segments: [x0,x1] with rock top at y. Risers between them = cliffs */
export const SEGMENTS = [
  { id: 0, key: 'reef',    name: 'Reef Flat',     x0: -600, x1: 1900, y: 556,  rough: 74, mounds: 96, riser: 30 },
  { id: 1, key: 'bench',   name: 'Wall Bench',    x0: 1900, x1: 2420, y: 1380, rough: 26, mounds: 26, riser: 24 },
  { id: 2, key: 'outcrop', name: 'Kelp Outcrop',  x0: 2420, x1: 3620, y: 2130, rough: 52, mounds: 84, riser: 34 },
  { id: 3, key: 'talus',   name: 'Talus Slope',   x0: 3620, x1: 4020, y: 2720, rough: 60, mounds: 56, riser: 40 },
  { id: 4, key: 'abyss',   name: 'Abyssal Basin', x0: 4020, x1: 5760, y: 3246, rough: 34, mounds: 14, riser: 46 },
  { id: 5, key: 'east',    name: 'East Rise',     x0: 5760, x1: 7000, y: 2440, rough: 70, mounds: 96, riser: 36 },
];

export const KELP_SEG = 2, REEF_SEG = 0, BENCH_SEG = 1, ABYSS_SEG = 4, TALUS_SEG = 3;

/** background cliff: terraces hanging in the Z2/Z3 bands, receding into murk */
const BG_SEGMENTS = [
  { x0: -700, x1: 900,  y: 900 },
  { x0: 900,  x1: 2050, y: 1180 },
  { x0: 2050, x1: 2960, y: 1010 },
  { x0: 2960, x1: 3820, y: 1420 },
  { x0: 3820, x1: 4680, y: 1230 },
  { x0: 4680, x1: 5560, y: 1680 },
  { x0: 5560, x1: 7100, y: 1380 },
];

export function generateTerrain(seed = 1337) {
  const rnd = new Rand(seed ^ 0x7a12);

  // ---- terrace field builder ---------------------------------------------
  function buildProfile(arr, segs, sd, opts = {}) {
    for (let i = 0; i < COLS; i++) {
      const x = i * COL;
      let s = segs[0], t = 0;
      for (let k = 0; k < segs.length; k++) {
        if (x >= segs[k].x0 && x < segs[k].x1) { s = segs[k]; t = k; break; }
        if (x >= segs[k].x1) s = segs[k];
      }
      const nxt = segs[Math.min(segs.length - 1, t + 1)];
      const prv = segs[Math.max(0, t - 1)];
      let y = s.y;
      const rw = (s.riser || 30);
      // steep ramp into the next terrace down / up
      if (x > s.x1 - rw && nxt !== s) y = lerp(s.y, nxt.y, smoothstep(0, 1, (x - (s.x1 - rw)) / (rw * 2)));
      else if (x < s.x0 + rw && prv !== s) y = lerp(prv.y, s.y, smoothstep(0, 1, (x - (s.x0 - rw)) / (rw * 2)));
      const rough = (s.rough || 24);
      y += fbm1(x / (rough * 0.72), sd + t * 37, 3) * rough;
      const mound = s.mounds || 0;
      if (mound > 0) {
        const m = Math.pow(Math.max(0, fbm1(x / (mound * 2.6), sd + 900 + t * 13, 3) * 0.5 + 0.5), 2.2);
        y -= m * mound;                                     // rubble rises upward
      }
      if (opts.trench) {
        const tr = Math.pow(Math.max(0, fbm1(x / 640, sd + 77, 2) * 0.5 + 0.5), 2.4) * opts.trench;
        y += tr;
      }
      if (opts.jagged) y += Math.abs(fbm1(x / 38, sd + 13, 3)) * opts.jagged;
      arr[i] = clamp(y, 120, WORLD_H - 20);
    }
  }

  // ---- main plane --------------------------------------------------------
  const floorTop = new Float32Array(COLS);
  buildProfile(floorTop, SEGMENTS, seed + 3, { trench: 250, jagged: 22 });

  // side walls of the canyon: thin frame with terraces, gives the shaft edges
  const leftFace = new Float32Array(ROWS);
  const rightFace = new Float32Array(ROWS);
  for (let j = 0; j < ROWS; j++) {
    const y = j * ROW;
    const depth = clamp01(y / WORLD_H);
    const th = lerp(300, 130, depth) + Math.round(y / 168) * 0;
    const jut = (v) => (v > 0.55 ? (v - 0.55) * 900 : 0);
    leftFace[j] = clamp(th * 0.55 + jut(fbm1(y / 210, seed + 501, 3) * 0.5 + 0.5) + fbm1(y / 62, seed + 55, 2) * 26, 40, 720);
    rightFace[j] = WORLD_W - clamp(th * 0.6 + jut(fbm1(y / 240, seed + 907, 3) * 0.5 + 0.5) + fbm1(y / 70, seed + 91, 2) * 26, 40, 720);
  }

  // ---- background plane --------------------------------------------------
  const bgTop = new Float32Array(COLS);
  buildProfile(bgTop, BG_SEGMENTS, seed + 3001, { jagged: 40 });

  // ---- samplers ----------------------------------------------------------
  const colAt = (arr, x) => {
    const gx = x / COL;
    let i = Math.floor(gx);
    if (i < 0) i = 0; else if (i > COLS - 2) i = COLS - 2;
    return lerp(arr[i], arr[i + 1], gx - i);
  };
  const rowAt = (arr, y) => {
    const gy = y / ROW;
    let j = Math.floor(gy);
    if (j < 0) j = 0; else if (j > ROWS - 2) j = ROWS - 2;
    return lerp(arr[j], arr[j + 1], gy - j);
  };

  /** segment id that owns column x */
  const segAt = (x) => {
    for (const s of SEGMENTS) if (x >= s.x0 && x < s.x1) return s.id;
    return x < SEGMENTS[0].x0 ? 0 : SEGMENTS.length - 1;
  };

  // ---- caves -------------------------------------------------------------
  const caves = [];
  const rawSolid = (x, y) => {
    if (x < 0 || x > WORLD_W || y > WORLD_H - 2) return true;
    if (y < 40) return false;
    if (y >= colAt(floorTop, x)) return true;
    if (x <= rowAt(leftFace, y)) return true;
    if (x >= rowAt(rightFace, y)) return true;
    return false;
  };
  const DIRS = [[1, 0], [-1, 0], [0, -1], [0.78, -0.62], [-0.78, -0.62], [0.62, 0.78], [-0.62, 0.78]];
  function tryCarve(x, y, r, kind, zone) {
    if (caves.length > 70) return false;
    if (!rawSolid(x, y)) return false;
    let openDir = null;
    for (const [dx, dy] of DIRS) {
      for (let d = r * 0.5; d < r * 3.2; d += 12) {
        if (!rawSolid(x + dx * d, y + dy * d)) { openDir = [dx, dy]; break; }
      }
      if (openDir) break;
    }
    if (!openDir) return false;
    for (const c of caves) if ((c.x - x) ** 2 + (c.y - y) ** 2 < (c.r + r) ** 2 * 0.28) return false;
    const id = caves.length;
    caves.push({
      id, x, y, r, kind, zone,
      mouth: { x: x + openDir[0] * r * 0.92, y: y + openDir[1] * r * 0.92 },
      dir: Math.atan2(openDir[1], openDir[0]),
      seed: (seed + id * 7919) >>> 0,
      jag: Array.from({ length: 14 }, (_, k) => 0.82 + hash2(k, id, seed) * 0.36),
      bubbles: hash2(id, 3, seed) * TAU,
    });
    return true;
  }
  // hatcheries: under the kelp outcrop shelf + along the Wall's base (Z3)
  for (let k = 0; k < 40 && caves.filter((c) => c.kind === 'hatchery').length < 11; k++) {
    const x = lerp(SEGMENTS[KELP_SEG].x0 - 130, SEGMENTS[KELP_SEG].x1 + 120, rnd.f());
    const surf = colAt(floorTop, x);
    const y = surf + rnd.r(120, 420);
    tryCarve(x, clamp(y, ZONES[2].top + 40, ZONES[2].bottom - 60), rnd.r(84, 132), 'hatchery', 2);
  }
  // guarantee at least 5 hatcheries clinging to the Wall riser (Z2/Z3 edge)
  let guard = 0;
  while (caves.filter((c) => c.kind === 'hatchery').length < 5 && guard++ < 200) {
    const x = SEGMENTS[BENCH_SEG].x0 - rnd.r(30, 260);
    const y = lerp(ZONES[1].top + 200, ZONES[2].top - 60, rnd.f());
    tryCarve(x, y, rnd.r(78, 126), 'hatchery', rnd.chance(0.5) ? 1 : 2);
  }
  // lairs (eels), refuges (school fish), warrens (Z4 scavengers)
  for (let k = 0; k < 40; k++) {
    const pick = rnd.f();
    let x, y, zone, kind;
    if (pick < 0.34) {                                  // on the Wall face, Z2
      x = SEGMENTS[BENCH_SEG].x0 - rnd.r(60, 420);
      y = lerp(ZONES[1].top + 90, ZONES[1].bottom - 80, rnd.f());
      zone = 1; kind = 'lair';
    } else if (pick < 0.62) {                            // outcrop flank, Z3
      x = SEGMENTS[KELP_SEG].x0 - rnd.r(160, 420);
      y = lerp(ZONES[2].top + 20, ZONES[2].bottom - 120, rnd.f());
      zone = 2; kind = rnd.chance(0.5) ? 'lair' : 'refuge';
    } else if (pick < 0.82) {                            // reef edge overhangs, Z1/Z2
      x = SEGMENTS[REEF_SEG].x1 - rnd.r(60, 520);
      y = lerp(SEGMENTS[REEF_SEG].y + 60, ZONES[1].bottom - 120, rnd.f());
      zone = y > ZONES[1].top ? 1 : 0; kind = 'refuge';
    } else {                                             // abyss warrens, Z4
      x = lerp(SEGMENTS[ABYSS_SEG].x0 + 100, SEGMENTS[ABYSS_SEG].x1, rnd.f());
      y = colAt(floorTop, x) - rnd.r(-140, 40);
      zone = 3; kind = 'warren';
    }
    tryCarve(clamp(x, 120, WORLD_W - 120), clamp(y, 200, WORLD_H - 100), rnd.r(46, 116), kind, zone);
  }
  // cave mouths in the side walls (extra hiding + crab access)
  for (let k = 0; k < 18; k++) {
    const y = lerp(ZONES[0].bottom + 60, WORLD_H - 260, rnd.f());
    const onLeft = rnd.chance(0.5);
    const x = onLeft ? rowAt(leftFace, y) - rnd.r(20, 90) : rowAt(rightFace, y) + rnd.r(20, 90);
    tryCarve(clamp(x, 140, WORLD_W - 140), y, rnd.r(44, 96), rnd.chance(0.3) ? 'hatchery' : 'refuge', ZONES.findIndex((z) => y >= z.top && y < z.bottom));
  }

  const hatcheries = caves.filter((c) => c.kind === 'hatchery');
  // Fallback hatcheries: if generation failed, stamp some into the outcrop.
  if (hatcheries.length < 4) {
    for (let k = 0; k < 6; k++) {
      const x = lerp(SEGMENTS[KELP_SEG].x0, SEGMENTS[KELP_SEG].x1, (k + 0.5) / 6);
      const y = colAt(floorTop, x) + 190;
      caves.push({
        id: caves.length, x, y, r: 108, kind: 'hatchery', zone: 2,
        mouth: { x, y: y - 96 }, dir: -Math.PI / 2, seed: (seed + k * 17) >>> 0,
        jag: Array.from({ length: 14 }, () => 1), bubbles: k,
      });
      hatcheries.push(caves[caves.length - 1]);
    }
  }

  // ---- ledges: terrace tops, split into perches --------------------------
  const ledges = [];
  for (const s of SEGMENTS) {
    const span = Math.max(0, Math.min(s.x1, WORLD_W) - Math.max(s.x0, 0));
    if (span < 200) continue;
    const n = Math.max(1, Math.round(span / 520));
    for (let k = 0; k < n; k++) {
      const x0 = lerp(Math.max(s.x0, 0), Math.min(s.x1, WORLD_W), k / n) + 10;
      const x1 = lerp(Math.max(s.x0, 0), Math.min(s.x1, WORLD_W), (k + 1) / n) - 10;
      ledges.push({
        id: ledges.length, plane: 0, seg: s.id, key: s.key, x0, x1,
        y: Math.min(colAt(floorTop, (x0 + x1) / 2), colAt(floorTop, x0), colAt(floorTop, x1)) + 4,
        depth: 60, grit: Array.from({ length: 5 }, (_, m) => ({ o: (m + rnd.f()) / 5, r: rnd.r(3, 11) })),
      });
    }
  }
  // wall ledges from the side faces
  for (const [side, arr] of [['left', leftFace], ['right', rightFace]]) {
    let start = -1;
    for (let j = 2; j < ROWS - 2; j++) {
      const inward = side === 'left' ? arr[j] - arr[j - 2] : arr[j - 2] - arr[j];
      if (inward > 30) { if (start < 0) start = j; }
      else if (start >= 0) {
        const y = start * ROW;
        const x0 = side === 'left' ? 0 : arr[j] + COL;
        const x1 = side === 'left' ? arr[start] - COL : WORLD_W;
        if (x1 - x0 > 80) {
          ledges.push({
            id: ledges.length, plane: 0, seg: -1, key: 'wall', side, y, x0, x1,
            depth: inward, grit: Array.from({ length: 3 }, (_, m) => ({ o: (m + rnd.f()) / 3, r: rnd.r(3, 9) })),
          });
        }
        start = -1;
      }
    }
  }
  const bgLedges = [];
  for (const s of BG_SEGMENTS) {
    const span = Math.min(s.x1, WORLD_W) - Math.max(s.x0, 0);
    if (span < 200) continue;
    const n = Math.max(1, Math.round(span / 460));
    for (let k = 0; k < n; k++) {
      const x0 = lerp(Math.max(s.x0, 0), Math.min(s.x1, WORLD_W), k / n) + 12;
      const x1 = lerp(Math.max(s.x0, 0), Math.min(s.x1, WORLD_W), (k + 1) / n) - 12;
      bgLedges.push({
        id: bgLedges.length, plane: 1, x0, x1,
        y: colAt(bgTop, (x0 + x1) / 2) + 2,
        depth: 90 + rnd.r(0, 80),
        grit: Array.from({ length: 6 }, (_, m) => ({ o: (m + rnd.f()) / 6, r: rnd.r(4, 13) })),
      });
    }
  }

  // ---- vents + whale falls in the basin ---------------------------------
  const vents = [];
  for (let k = 0; k < 7; k++) {
    const x = lerp(0.6, 0.94, (k + rnd.r(0.1, 0.8)) / 7) * WORLD_W;
    vents.push({ x, y: colAt(floorTop, x) - 2, r: rnd.r(24, 62), power: rnd.r(0.4, 1), phase: rnd.r(0, TAU), id: k });
  }
  const falls = [];
  for (let k = 0; k < 3; k++) {
    const x = lerp(0.62, 0.92, (k + rnd.r(0.05, 0.7)) / 3) * WORLD_W;
    falls.push({ x, y: colAt(floorTop, x) - 12, s: rnd.r(0.8, 1.3), rot: rnd.r(-0.12, 0.12), seed: (seed + k * 3133) >>> 0, id: k });
  }

  // ---- plane factory -----------------------------------------------------
  /**
   * A terrain "plane" exposes the same query API. `arr` is the rock-top field.
   * The background plane has no caves/side walls; it is pure cliff + shelf.
   */
  function makePlane(index, arr, extra = {}) {
    const P = {
      index,
      // the x of this plane's deepest water — the bearing every abyssal animal
      // uses when it has wandered somewhere it cannot survive
      get deepestX() {
        if (P._deepX === undefined) {
          let best = WORLD_W * 0.5, bd = -1;
          for (let x = 60; x < WORLD_W - 60; x += 24) {
            const d = P.surfaceY(x);
            if (d > bd) { bd = d; best = x; }
          }
          P._deepX = best;
        }
        return P._deepX;
      },
      parallax: index === 1 ? 0.74 : 1,
      scale: index === 1 ? 0.78 : 1,
      murk: index === 1 ? 0.62 : 0,
      ledges: index === 1 ? bgLedges : ledges,
      vents: index === 1 ? [] : vents,
      falls: index === 1 ? [] : falls,
      caves: index === 1 ? [] : caves,
      surfaceArr: arr,

      surfaceY(x) { return colAt(arr, x); },
      /** y of the surface at the point (faces + caves considered, main only) */
      solidAt(x, y) {
        if (index === 0) {
          const gi = gIndex(x, y);
          return gi === -2;
        }
        if (x < 2 || x > WORLD_W - 2 || y > WORLD_H - 2) return true;
        if (y < 40) return false;
        return y >= colAt(arr, x);
      },
      inCave(x, y) {
        if (index !== 0) return null;
        return cavesAt(x, y);
      },
      clearance(x, y, out) {
        let d = colAt(arr, x) - y, nx = 0, ny = -1, which = 0;
        if (index === 0) {
          const dl = x - rowAt(leftFace, y);
          const dr = rowAt(rightFace, y) - x;
          if (dl < d) { d = dl; nx = 1; ny = 0; which = 1; }
          if (dr < d) { d = dr; nx = -1; ny = 0; which = 2; }
        }
        const cave = index === 0 ? cavesAt(x, y) : null;
        if (cave) {
          const dx = x - cave.x, dy = (y - cave.y) * 1.1;
          const dd = Math.hypot(dx, dy) || 1;
          const inside = cave.r - dd;
          if (inside < d) { d = inside; nx = -dx / dd; ny = -(dy / 1.1) / dd; which = 3; }
        }
        out.d = d; out.nx = nx; out.ny = ny; out.which = which;
        const l = Math.hypot(out.nx, out.ny) || 1;
        out.nx /= l; out.ny /= l;
        return out;
      },
      /** push a circle of radius r out of the rock; fills out.x/.y/.nx/.ny/.hit */
      resolve(x, y, r, out) {
        const cave = index === 0 ? cavesAt(x, y) : null;
        if (cave) {
          const dx = x - cave.x, dy = (y - cave.y) * 1.1;
          const dd = Math.hypot(dx, dy);
          const maxR = Math.max(6, cave.r - r * 0.8);
          if (dd > maxR && dd > 1e-3) {
            out.x = cave.x + (dx / dd) * maxR;
            out.y = cave.y + (dy / dd) * maxR;
            out.nx = -dx / dd; out.ny = -dy / dd; out.hit = 1; out.g = 3;
            return out;
          }
          out.hit = 0; out.x = x; out.y = y; return out;
        }
        const fy = colAt(arr, x);
        const dFloor = fy - y;
        let best = dFloor, kind = 0;
        if (index === 0) {
          const dl = x - rowAt(leftFace, y);
          const dr = rowAt(rightFace, y) - x;
          if (dl < best) { best = dl; kind = 1; }
          if (dr < best) { best = dr; kind = 2; }
        }
        if (best >= r) { out.hit = 0; out.x = x; out.y = y; return out; }
        if (kind === 0) {
          const a = colAt(arr, x - r - 4), b = colAt(arr, x + r + 4);
          const slope = (b - a) / (2 * (r + 4));
          const inv = 1 / Math.hypot(1, slope);
          out.x = x; out.y = fy - r;
          out.nx = -slope * inv; out.ny = -inv;
        } else if (kind === 1) {
          const a = rowAt(leftFace, y - 18), b = rowAt(leftFace, y + 18);
          const sl = (b - a) / 36, inv = 1 / Math.hypot(1, sl);
          out.x = rowAt(leftFace, y) + r; out.y = y;
          out.nx = inv; out.ny = -sl * inv;
        } else {
          const a = rowAt(rightFace, y - 18), b = rowAt(rightFace, y + 18);
          const sl = (b - a) / 36, inv = 1 / Math.hypot(1, sl);
          out.x = rowAt(rightFace, y) - r; out.y = y;
          out.nx = -inv; out.ny = -sl * inv;
        }
        out.hit = 1; out.g = kind;
        return out;
      },
      /** ray march to the first rock surface (leg IK foot placement) */
      cast(x, y, dx, dy, maxLen, out) {
        const l = Math.hypot(dx, dy) || 1;
        const ux = dx / l, uy = dy / l;
        out.hit = false; out.t = maxLen; out.nx = -ux; out.ny = -uy;
        out.x = x + ux * maxLen; out.y = y + uy * maxLen;
        if (P.solidAt(x, y)) {
          const c = P.clearance(x, y, out._n || (out._n = {}));
          out.hit = true; out.t = 0; out.nx = c.nx; out.ny = c.ny;
          return out;
        }
        for (let t = 6; t < maxLen; t += 6) {
          const px = x + ux * t, py = y + uy * t;
          if (P.solidAt(px, py)) {
            const back = Math.max(0, t - 4);
            out.hit = true; out.t = back;
            out.x = x + ux * back; out.y = y + uy * back;
            const c = P.clearance(px, py, out._n || (out._n = {}));
            out.nx = c.nx; out.ny = c.ny;
            return out;
          }
        }
        return out;
      },
      slopeAt(x, y) {
        const a = colAt(arr, x - 14), b = colAt(arr, x + 14);
        return Math.atan2(b - a, 28);
      },
      steepness(x, y) {
        const a = colAt(arr, x - 16), b = colAt(arr, x + 16);
        return Math.abs(b - a) / 32;
      },
      groundBelow(x, y, reach = 300) {
        for (let d = 0; d <= reach; d += 8) if (P.solidAt(x, y + d)) return y + d;
        return -1;
      },
      ceilingAbove(x, y, reach = 300) {
        for (let d = 0; d <= reach; d += 8) if (P.solidAt(x, y - d)) return y - d;
        return -1;
      },
      ledgeAt(x, y, tol = 34) {
        let best = null, bd = tol;
        for (const L of P.ledges) {
          if (x < L.x0 - 40 || x > L.x1 + 40) continue;
          const d = Math.abs(y - L.y);
          if (d < bd) { bd = d; best = L; }
        }
        return best;
      },
      /** closest ledge whose top is at/above y in the vertical window */
      ledgeNear(x, y, win = 400) {
        let best = null, bd = Infinity;
        for (const L of P.ledges) {
          if (Math.abs(L.y - y) > win) continue;
          const cx = clamp(x, L.x0, L.x1);
          const d = (cx - x) ** 2 * 0.06 + (L.y - y) ** 2;
          if (d < bd) { bd = d; best = L; }
        }
        return best;
      },
      /**
       * Aim a foot at a rock hold. Returns a jittered ray direction biased by
       * the local relief; the caller's IK casts it and finds real contact.
       * `idx` gives each leg its own hold so a gait never looks symmetrical.
       */
      footAim(x, y, dirX, dirY, spread, idx = 0) {
        const base = Math.atan2(dirY, dirX);
        const h = hash2(Math.round(x / 13) + idx * 31, Math.round(y / 13) - idx * 17, seed + index * 7);
        const wob = (h - 0.5) * 0.95;
        const len = spread * (0.72 + 0.5 * hash2(idx, Math.round(y / 24), seed + 5));
        return {
          dx: Math.cos(base + wob),
          dy: Math.sin(base + wob),
          len,
          quality: 0.35 + 0.65 * h,
        };
      },
      freeSpot(x, y, minClear = 46, tries = 26) {
        for (let k = 0; k < tries; k++) {
          const px = clamp(x + rnd.r(-190, 190), 160, WORLD_W - 160);
          const py = clamp(y + rnd.r(-150, 150), 90, WORLD_H - 90);
          const c = P.clearance(px, py, P._q || (P._q = {}));
          if (c.d > minClear) return { x: px, y: py };
        }
        const surf = colAt(arr, clamp(x, 160, WORLD_W - 160));
        return { x: clamp(x, 160, WORLD_W - 160), y: Math.max(90, surf - minClear - 12) };
      },
      /** anchor point on the rock for flora, near x, inside a depth band */
      floraSpot(bandTop, bandBottom, x, tries = 14) {
        for (let k = 0; k < tries; k++) {
          const sx = clamp(x + rnd.r(-110, 110), 40, WORLD_W - 40);
          const sy = colAt(arr, sx);
          if (sy > bandTop && sy < bandBottom && Math.abs(P.slopeAt(sx, sy)) < 1.0 && !P.inCave(sx, sy)) return { x: sx, y: sy };
        }
        const sx = clamp(x, 40, WORLD_W - 40);
        return { x: sx, y: colAt(arr, sx) };
      },
      /** anchor on a vertical face: scans for rock whose surface is steep */
      faceAnchor(y0, y1, x0, x1, tries = 16) {
        for (let k = 0; k < tries; k++) {
          const y = lerp(y0, y1, rnd.f());
          const x = lerp(x0, x1, rnd.f());
          const c = P.clearance(x, y, P._f || (P._f = {}));
          if (c.d < 2 && Math.abs(c.ny) < 0.65) return { x, y: y + 4, nx: c.nx, ny: c.ny };
          // on top of a steep flank: nudge toward the surface
          const sx = clamp(x + c.nx * (c.d < 0 ? -c.d : 0), x0, x1);
          const sy = colAt(arr, sx);
          if (sy > y0 && sy < y1 && Math.abs(P.slopeAt(sx, sy)) > 0.5) return { x: sx, y: sy, nx: 0, ny: -1 };
        }
        const x = lerp(x0, x1, 0.5);
        return { x, y: colAt(arr, x), nx: 0, ny: -1 };
      },
    };
    return P;
  }

  // ---- collision grid ----------------------------------------------------
  // Rock + caves baked into a 4 px index grid: -2 solid, -1 water, >=0 cave id.
  // Sampling it is a single load, which is what makes hundreds of IK legs and
  // perception raycasts affordable every frame.
  const GC = 4;
  const GCOLS = Math.ceil(WORLD_W / GC) + 1;
  const GROWS = Math.ceil(WORLD_H / GC) + 1;
  const grid = new Int16Array(GCOLS * GROWS);
  const rowBase = (yy) => clamp(Math.floor(yy / GC), 0, GROWS - 1) * GCOLS;
  {
    const colCache = new Float32Array(GCOLS);
    for (let i = 0; i < GCOLS; i++) colCache[i] = colAt(floorTop, i * GC);
    const rowL = new Float32Array(GROWS), rowR = new Float32Array(GROWS);
    for (let j = 0; j < GROWS; j++) { const yy = j * GC; rowL[j] = rowAt(leftFace, yy); rowR[j] = rowAt(rightFace, yy); }
    for (let j = 0; j < GROWS; j++) {
      const yy = j * GC;
      const base = j * GCOLS;
      const fy = (x) => colCache[clamp(Math.round(x / GC), 0, GCOLS - 1)];
      for (let i = 0; i < GCOLS; i++) {
        const xx = i * GC;
        let v = -1;
        if (xx < 2 || xx > WORLD_W - 2 || yy > WORLD_H - 2) v = -2;
        else if (yy >= 40 && (yy >= fy(xx) || xx <= rowL[j] || xx >= rowR[j])) v = -2;
        grid[base + i] = v;
      }
    }
    // carve the caves
    for (let ci = 0; ci < caves.length; ci++) {
      const c = caves[ci];
      const i0 = clamp(Math.floor((c.x - c.r) / GC), 0, GCOLS - 1);
      const i1 = clamp(Math.ceil((c.x + c.r) / GC), 0, GCOLS - 1);
      const j0 = clamp(Math.floor((c.y - c.r) / GC), 0, GROWS - 1);
      const j1 = clamp(Math.ceil((c.y + c.r) / GC), 0, GROWS - 1);
      for (let j = j0; j <= j1; j++) {
        const yy = j * GC;
        for (let i = i0; i <= i1; i++) {
          const xx = i * GC;
          const dx = xx - c.x, dy = (yy - c.y) * 1.1;
          if (dx * dx + dy * dy < c.r * c.r) grid[j * GCOLS + i] = ci;
        }
      }
    }
  }
  const gIndex = (x, y) => {
    const i = (x / GC) | 0, j = (y / GC) | 0;
    if (i < 0 || j < 0 || i >= GCOLS || j >= GROWS) return -2;
    return grid[(j < 0 ? 0 : j >= GROWS ? GROWS - 1 : j) * GCOLS + (i < 0 ? 0 : i >= GCOLS ? GCOLS - 1 : i)];
  };

  function cavesAt(x, y) {
    const gi = gIndex(x, y);
    return gi >= 0 ? caves[gi] : null;
  }
  function cavesAtScan(x, y) {
    for (let k = 0; k < caves.length; k++) {
      const c = caves[k];
      if (Math.abs(x - c.x) > c.r + 24 || Math.abs(y - c.y) > c.r + 24) continue;
      const dx = x - c.x, dy = (y - c.y) * 1.1;
      if (dx * dx + dy * dy < c.r * c.r) return c;
    }
    return null;
  }

  const planes = [makePlane(0, floorTop), makePlane(1, bgTop)];

  // ---- links between the planes -----------------------------------------
  // A crab on the real rock can slip into the background wall where the two
  // surfaces are vertically close, and every hatchery has a bg exit.
  const links = [];
  for (const L of ledges) {
    const cand = bgLedges.reduce((best, B) => {
      if (B.x1 < L.x0 - 620 || B.x0 > L.x1 + 620) return best;
      const d = Math.abs(B.y - L.y) + Math.abs((B.x0 + B.x1) / 2 - (L.x0 + L.x1) / 2) * 0.18;
      return !best || d < best.d ? { d, B } : best;
    }, null);
    if (cand && cand.d < 620) links.push({ main: L.id, bg: cand.B.id, cost: cand.d });
  }
  for (const c of hatcheries) {
    const B = bgLedges.reduce((best, b) => {
      const d = Math.abs(b.y - c.y) + Math.abs(clamp(c.x, b.x0, b.x1) - c.x) * 0.3;
      return !best || d < best.d ? { d, B: b } : best;
    }, null);
    if (B) links.push({ cave: c.id, bg: B.B.id, cost: B.d });
  }
  function bgLinkFor(mainX, mainY) {
    let best = null, bd = 1e9;
    for (const L of links) {
      const a = L.main !== undefined ? ledges[L.main] : null;
      const B = bgLedges[L.bg];
      if (!B) continue;
      const ax = a ? (a.x0 + a.x1) / 2 : (caves[L.cave] ? caves[L.cave].x : 0);
      const ay = a ? a.y : (caves[L.cave] ? caves[L.cave].y : 0);
      const d = (ax - mainX) ** 2 + (ay - mainY) ** 2;
      if (d < bd) { bd = d; best = { ledge: B, cave: L.cave }; }
    }
    return best;
  }

  const terrain = {
    seed, COL, COLS, ROW, ROWS,
    floorTop, bgTop, leftFace, rightFace, grid, GC, GCOLS, GROWS,
    SEGMENTS, BG_SEGMENTS,
    planes, ledges, bgLedges, links, bgLinkFor,
    caves, hatcheries, lairs: caves.filter((c) => c.kind !== 'hatchery'),
    vents, falls,
    colAt, rowAt, segAt,

    /** convenience: main-plane queries without touching .planes */
    surfaceY(x) { return colAt(floorTop, x); },
    solidAt(x, y) { return planes[0].solidAt(x, y); },
    plane(i) { return planes[i | 0] || planes[0]; },
    inCave(x, y) { return cavesAt(x, y); },
    nearestCave(x, y, kind = null, maxD = Infinity) {
      let best = null, bd = maxD * maxD;
      for (const c of caves) {
        if (kind && c.kind !== kind) continue;
        const d = (c.x - x) ** 2 + (c.y - y) ** 2;
        if (d < bd) { bd = d; best = c; }
      }
      return best;
    },
    hatcheryAt(k) { return hatcheries[((k % hatcheries.length) + hatcheries.length) % hatcheries.length]; },
    /** band of x that has open water at this y (keeps spawns out of rock) */
    waterSpan(y) {
      let a = 120, b = WORLD_W - 120;
      const step = 40;
      for (let x = 120; x < WORLD_W - 120; x += step) if (!planes[0].solidAt(x, y)) { a = x; break; }
      for (let x = WORLD_W - 120; x > 120; x -= step) if (!planes[0].solidAt(x, y)) { b = x; break; }
      return { a: Math.min(a, b), b: Math.max(a, b) };
    },
    reliefAt(x, y) {
      return 0.5 + 0.5 * fbm2(x / 74, y / 58, seed + 44, 3);
    },
  };
  return terrain;
}

/** kelp prefers the Z3 outcrop shelves + shoulders, thick on gentle rock */
export function kelpSuitability(t, x, y) {
  const band = smoothstep(ZONES[2].bottom + 80, ZONES[2].top + 240, y);
  const slope = Math.abs(t.plane(0).slopeAt(x, y));
  const patch = 0.5 + 0.5 * fbm1(x / 240, t.seed + 611, 2);
  return clamp01(band * (1 - clamp01(slope / 1.15)) * (0.25 + 0.75 * patch));
}

/** coral only on the sunlit reef terrace */
export function coralSuitability(t, x, y) {
  const s = SEGMENTS[REEF_SEG];
  const band = 1 - smoothstep(s.y - 140, s.y + 300, y);
  const slope = Math.abs(t.plane(0).slopeAt(x, y));
  const patch = 0.5 + 0.5 * fbm1(x / 130, t.seed + 220, 2);
  return clamp01(band * (1 - clamp01(slope / 1.3)) * (0.2 + 0.8 * patch));
}

/** background wall suitability for barnacles/snail pastures: Z2..Z3 bg rock */
export function wallSuitability(t, x, y) {
  const band = smoothstep(ZONES[3].top, ZONES[1].top, y);
  return clamp01(band * (0.4 + 0.6 * t.reliefAt(x, y)));
}

export { hash2, noise2, fbm2 };
