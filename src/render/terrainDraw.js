// ---------------------------------------------------------------------------
//  TERRAIN RENDERER
//
//  Rock is static, so it is baked into world-aligned tiles (offscreen
//  canvases) and blitted. The tiles are rasterised straight from the
//  simulation's own 4 px collision grid, which means what you see is exactly
//  what collides: the reef terrace, the wall, the kelp outcrop shelves, the
//  talus, the abyssal basin, and every cave mouth is a hole in the rock.
//
//  Two planes are baked: the foreground silhouette (plane 0, parallax 1) and
//  the background cliff the crabs climb (plane 1, parallax 0.74), which is
//  darker and murkier so it reads as distance.
// ---------------------------------------------------------------------------

import { clamp, clamp01, lerp, smoothstep } from '../core/vec.js';
import { hash2 } from '../core/rand.js';
import { ZONES, WORLD_H, lightAt, zoneIndexAt } from '../sim/zones.js';

export const TILE_W = 640;          // world px per tile
export const TILE_H = 480;

/** rock colour by depth: sunlit reef -> cold wall -> black basalt */
function rockColor(depthT, light, relief, cave) {
  //  depthT 0 = surface, 1 = hadal floor
  const warm = [78, 92, 86], mid = [42, 58, 68], cold = [18, 26, 38], abyss = [8, 11, 18];
  let r, g, b;
  if (depthT < 0.34) { const t = depthT / 0.34; r = lerp(warm[0], mid[0], t); g = lerp(warm[1], mid[1], t); b = lerp(warm[2], mid[2], t); }
  else if (depthT < 0.66) { const t = (depthT - 0.34) / 0.32; r = lerp(mid[0], cold[0], t); g = lerp(mid[1], cold[1], t); b = lerp(mid[2], cold[2], t); }
  else { const t = (depthT - 0.66) / 0.34; r = lerp(cold[0], abyss[0], t); g = lerp(cold[1], abyss[1], t); b = lerp(cold[2], abyss[2], t); }
  const m = 0.78 + relief * 0.5;
  const lit = 0.42 + light * 0.85;
  r *= m * lit; g *= m * lit; b *= m * lit;
  if (cave) { r *= 0.42; g *= 0.42; b *= 0.5; }
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

export class TerrainLayers {
  constructor(world) {
    this.world = world;
    this.T = world.terrain;
    this.cache = new Map();
    this.hits = 0; this.misses = 0;
    this.q = 0;
  }

  invalidate() { this.cache.clear(); }

  _quality(zoom, dpr) { return clamp(Math.round(Math.log2(Math.max(0.05, zoom * (dpr || 1)))), -2, 1); }

  /** bake or fetch one tile */
  tile(plane, tx, ty, q) {
    const key = plane + ':' + tx + ',' + ty + ':' + q;
    const hit = this.cache.get(key);
    if (hit) { hit.used = this.frames || 0; this.hits++; return hit; }
    this.misses++;
    const cv = this._bake(plane, tx, ty, q);
    const t = { cv, used: this.frames || 0 };
    this.cache.set(key, t);
    // LRU-ish: keep the memory bounded no matter how much the player roams
    if (this.cache.size > 44) {
      let oldest = null, ok = null;
      for (const [k, v] of this.cache) if (!oldest || v.used < oldest) { oldest = v.used; ok = k; }
      if (ok) this.cache.delete(ok);
    }
    return t;
  }

  _bake(planeIndex, tx, ty, q) {
    const bake = Math.pow(2, q);                        // canvas px per world px * ...
    const cell = 4 / bake;                              // collision grid cell, in canvas px
    const cw = Math.round(TILE_W * bake), ch = Math.round(TILE_H * bake);
    const cv = document.createElement('canvas');
    cv.width = cw; cv.height = ch;
    const g = cv.getContext('2d');
    const x0 = tx * TILE_W, y0 = ty * TILE_H;
    const T = this.T;
    const P = T.plane(planeIndex);
    const depthOf = (y) => clamp01(y / WORLD_H);

    g.fillStyle = '#000';
    g.globalAlpha = 0;
    g.fillRect(0, 0, cw, ch);
    g.globalAlpha = 1;

    if (planeIndex === 1) {
      // background cliff: a silhouette per column, no caves, flatter lighting
      const step = Math.max(1, Math.round(6 * bake));
      let prevY = -1;
      const runs = [];
      for (let x = 0; x < TILE_W; x += step) {
        const wx = x0 + x;
        let sy = P.surfaceY(wx);
        if (sy < y0 - 200) sy = y0 - 200;
        runs.push([x, sy]);
      }
      for (const [x, sy] of runs) {
        if (sy > y0 + TILE_H) continue;
        const top = Math.max(0, (sy - y0) * bake);
        const h = ch - top;
        if (h <= 0) continue;
        const light = lightAt(sy) * 0.5;
        const rel = 0.5 + 0.5 * hash2((x0 + x) * 0.02, sy * 0.02);
        g.fillStyle = rockColor(depthOf(sy) * 0.94 + 0.06, light, rel, false);
        g.fillRect(x * bake, top, step * bake + 1, h);
        if (prevY >= 0 && Math.abs(sy - prevY) > 300) {
          // a riser: paint the near-vertical face slightly lit
          g.fillStyle = 'rgba(190,220,235,0.05)';
          g.fillRect(x * bake, Math.min(top, prevY), step * bake, 8);
        }
        prevY = sy;
      }
      // bg ledges read as shelves with a shadow under the lip
      for (const L of (P.ledges || [])) {
        if (L.x1 < x0 || L.x0 > x0 + TILE_W || L.y < y0 - 30 || L.y > y0 + TILE_H + 30) continue;
        const px = (L.x0 - x0) * bake, pw = (L.x1 - L.x0) * bake, py = (L.y - y0) * bake;
        g.fillStyle = 'rgba(0,0,0,0.34)';
        g.fillRect(px, py + 1.5 * bake, pw, 7 * bake);
        g.fillStyle = 'rgba(150,190,205,0.06)';
        g.fillRect(px, py - 1 * bake, pw, 1.6 * bake);
      }
      return cv;
    }

    // ---- foreground plane: rasterise the collision grid -------------------
    const GC = T.grid ? 4 : 4;
    const grid = T.grid, GCOLS = T.GCOLS, GROWS = T.GROWS;
    const i0 = clamp(Math.floor(x0 / GC), 0, GCOLS - 1);
    const i1 = clamp(Math.ceil((x0 + TILE_W) / GC), 0, GCOLS - 1);
    const j0 = clamp(Math.floor(y0 / GC), 0, GROWS - 1);
    const j1 = clamp(Math.ceil((y0 + TILE_H) / GC), 0, GROWS - 1);
    const solidCols = new Float32Array(i1 - i0 + 1).fill(-1);

    for (let j = j0; j <= j1; j++) {
      const wy = j * GC;
      if (wy < y0 - GC || wy > y0 + TILE_H) continue;
      const py = (wy - y0) * bake;
      const light = lightAt(wy);
      const dep = depthOf(wy);
      for (let i = i0; i <= i1; i++) {
        const v = grid[j * GCOLS + i];
        const wx = i * GC;
        const isSolid = v === -2;
        const isCave = v >= 0;
        if (!isSolid && !isCave) continue;
        if (isCave && wy < T.surfaceY(wx)) continue;         // cave disc biting into open water
        if (isSolid && solidCols[i - i0] < 0) solidCols[i - i0] = py;
        const relief = 0.5 + 0.5 * hash2(i * 0.61, j * 0.61);
        const strata = 0.9 + 0.1 * Math.sin((wy + relief * 26) * 0.085);
        g.fillStyle = rockColor(dep, light, relief * strata, isCave);
        g.fillRect((wx - x0) * bake, py, cell + 0.7, cell + 0.7);
      }
    }

    // ---- surface treatment: lit lip, algae, coraline crust ---------------
    for (let i = i0; i <= i1; i++) {
      const top = solidCols[i - i0];
      if (top < 0) continue;
      const wx = i * GC;
      const sy = T.surfaceY(wx);
      const zoneI = zoneIndexAt(sy);
      const light = lightAt(sy);
      const px = (wx - x0) * bake;
      // lit edge
      g.fillStyle = `rgba(${180 + zoneI * -30},${225 - zoneI * 26},${235 - zoneI * 12},${0.1 + light * 0.24})`;
      g.fillRect(px, top - 1.4 * bake, cell + 0.7, 2.2 * bake);
      // weed line: only where there is light
      if (light > 0.06) {
        const a = clamp01(light * 0.5);
        g.fillStyle = `rgba(${60 + 40 * a | 0},${150 * a + 40 | 0},${70 * a + 30 | 0},${a * 0.5})`;
        g.fillRect(px, top + 1.5 * bake, cell + 0.7, (3 + 9 * hash2(i * 0.3, 7.1)) * bake);
      }
      // warm vent staining in the abyss
      if (zoneI === 3) {
        const s = 0.5 + 0.5 * hash2(i * 0.17, 3.3);
        if (s > 0.86) { g.fillStyle = 'rgba(180,110,50,0.18)'; g.fillRect(px, top + 2 * bake, cell, (5 + 10 * s) * bake); }
      }
    }

    // ---- cave mouths: a dark ellipse with a soft rim ---------------------
    for (const c of T.caves) {
      if (c.x + c.r < x0 || c.x - c.r > x0 + TILE_W || c.y + c.r < y0 || c.y - c.r > y0 + TILE_H) continue;
      const px = (c.x - x0) * bake, py = (c.y - y0) * bake, pr = c.r * bake;
      const grd = g.createRadialGradient(px, py, pr * 0.2, px, py, pr);
      grd.addColorStop(0, 'rgba(2,4,8,0.92)');
      grd.addColorStop(0.72, 'rgba(4,8,14,0.5)');
      grd.addColorStop(1, 'rgba(6,10,16,0)');
      g.fillStyle = grd;
      g.beginPath();
      g.ellipse(px, py, pr, pr * 0.9, 0, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = c.kind === 'hatchery' ? 'rgba(226,180,120,0.2)' : 'rgba(150,190,210,0.1)';
      g.lineWidth = 1.4 * bake;
      g.beginPath();
      g.ellipse(px, py, pr * 0.86, pr * 0.78, 0, 0, Math.PI * 2);
      g.stroke();
    }

    // ---- silt texture over the whole tile -------------------------------
    g.globalAlpha = 0.5;
    for (let k = 0; k < 260; k++) {
      const rx = hash2(k * 1.7 + tx * 13, ty * 7.3 + k * 0.31);
      const px = (rx - Math.floor(rx)) * cw;
      const ry = hash2(k * 3.1 + ty * 5.7, tx * 2.9 + k * 0.77);
      const py = (ry - Math.floor(ry)) * ch;
      const wy = y0 + py / bake;
      if (!T.plane(0).solidAt(x0 + px / bake, wy)) continue;
      g.fillStyle = k % 3 ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.09)';
      g.fillRect(px, py, 1.5 * bake, 1.2 * bake);
    }
    g.globalAlpha = 1;
    return cv;
  }

  /**
   * Draw every tile the camera can see for one plane.
   *
   * NOTE on parallax: the background cliff is *collidable* terrain — crabs walk
   * on it and fish swim in front of it — so it is drawn in true world
   * coordinates. Faking depth by sliding it would detach the animals from the
   * rock they are standing on. Instead it recedes through murk, contrast loss
   * and a cooler tint, which is how haze actually works underwater.
   */
  draw(ctx, cam, planeIndex) {
    this.frames = (this.frames || 0) + 1;
    const q = this._quality(cam.zoom, cam.dpr);
    this.q = q;
    const viewW = cam.w, viewH = cam.h;
    const cx = cam.cx, cy = cam.cy;
    const tx0 = Math.floor((cx - viewW / 2 - TILE_W) / TILE_W);
    const tx1 = Math.floor((cx + viewW / 2 + TILE_W) / TILE_W);
    const ty0 = Math.floor((cy - viewH / 2 - TILE_H) / TILE_H);
    const ty1 = Math.floor((cy + viewH / 2 + TILE_H) / TILE_H);
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const t = this.tile(planeIndex, tx, ty, q);
        ctx.drawImage(t.cv, tx * TILE_W, ty * TILE_H, TILE_W, TILE_H);
      }
    }
  }
}
