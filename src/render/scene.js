// ---------------------------------------------------------------------------
//  SCENE COMPOSITOR
//
//  Draw order is depth order: water, background cliff, murk veil, foreground
//  rock, flora, drifting snow, animals (sorted so the near plane overlaps the
//  far one), glow pass, then the atmospheric overlays (light shafts near the
//  surface, pressure haze deep down, the third-zone line, vignette).
//
//  The light at any pixel comes from the simulation's own `lightAt()`, so the
//  painter never invents its own mood — a bioluminescent animal is only bright
//  because the zone it lives in is dark.
// ---------------------------------------------------------------------------

import { TAU, PI, clamp, clamp01, lerp, smoothstep } from '../core/vec.js';
import { hash2, noise1 } from '../core/rand.js';
import { ZONES, WORLD_W, WORLD_H, LEVIATHAN_LINE, lightAt, zoneIndexAt, depthLabel, pressureLabel } from '../sim/zones.js';
import { TerrainLayers } from './terrainDraw.js';
import { drawCreature, drawCarrion, drawEgg, rgba, shade } from './creatureDraw.js';
import { drawFlora } from './floraDraw.js';

export class Scene {
  constructor(world, canvas) {
    this.world = world;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.terrain = new TerrainLayers(world);
    this.showFoodWeb = false;
    this.showBodies = false;
    this.showField = false;
    this.selected = null;
    this.quality = 1;
  }

  render(cam, opts = {}) {
    const ctx = this.ctx, w = this.world;
    const W = cam.vw, H = cam.vh;
    cam.applyScreen(ctx);
    ctx.clearRect(0, 0, W, H);
    this.drawWater(ctx, cam, W, H);

    cam.apply(ctx);
    const view = { x0: cam.x, y0: cam.y, x1: cam.x + cam.w, y1: cam.y + cam.h };

    // --- background cliff --------------------------------------------------
    this.terrain.draw(ctx, cam, 1);
    // everything behind the front plane sits under a veil of water
    ctx.save();
    const veil = ctx.createLinearGradient(0, view.y0, 0, view.y1);
    for (let k = 0; k <= 8; k++) {
      const t = k / 8;
      const y = lerp(view.y0, view.y1, t);
      const z = ZONES[zoneIndexAt(y)];
      veil.addColorStop(t, rgba(rgbHex(z.deep), 0.5 + z.turbidity * 0.22));
    }
    ctx.fillStyle = veil;
    ctx.fillRect(view.x0 - 10, view.y0 - 10, cam.w + 20, cam.h + 20);
    ctx.restore();
    this.drawFlora(ctx, cam, 1, view);

    // --- foreground rock ---------------------------------------------------
    this.terrain.draw(ctx, cam, 0);

    // --- flora, then animals ----------------------------------------------
    this.drawFlora(ctx, cam, 0, view);
    this.drawParticles(ctx, cam, view, 'snow');
    this.drawVents(ctx, cam, view);
    this.drawFalls(ctx, cam, view);

    const list = [];
    for (const c of w.creatures) {
      if (!c.alive && c.deathT > 3) continue;
      if (!cam.visible(c.x, c.y, c.radius * 3 + 30)) continue;
      list.push(c);
    }
    list.sort((a, b) => (a.plane - b.plane) || (a.y - b.y));
    for (const c of list) {
      drawCreature(ctx, c, w, {
        selected: this.selected === c,
        showVectors: this.showBodies,
        zoom: cam.zoom,
      });
    }

    for (const k of w.carrion) {
      if (!cam.visible(k.x, k.y, k.r + 20)) continue;
      drawCarrion(ctx, k, w);
    }
    for (const e of w.eggs) {
      if (!cam.visible(e.x, e.y, 12)) continue;
      drawEgg(ctx, e, w);
    }

    this.drawParticles(ctx, cam, view, 'front');
    if (this.showFoodWeb) this.drawFoodWeb(ctx, cam, view);
    if (this.showField) this.drawFieldOverlay(ctx, cam, view);
    this.drawZoneLines(ctx, cam, view);
    if (this.selected && this.selected.alive) this.drawLeash(ctx, this.selected);

    // --- atmosphere ---------------------------------------------------------
    cam.applyScreen(ctx);
    this.drawSurface(ctx, cam, W, H);
    this.drawShafts(ctx, cam, W, H);
    this.drawMurk(ctx, cam, W, H);
    this.drawVignette(ctx, cam, W, H);
  }

  // -------------------------------------------------------------- atmosphere
  drawWater(ctx, cam, W, H) {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    const steps = 14;
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const wy = cam.y + t * cam.h;
      const z = ZONES[zoneIndexAt(wy)];
      const f = clamp01((wy - z.top) / Math.max(1, z.bottom - z.top));
      const a = mixRgb(z.water, z.deep, f);
      g.addColorStop(t, `rgb(${a[0]},${a[1]},${a[2]})`);
    }
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  /** the underside of the sea surface, with chop and sun glitter */
  drawSurface(ctx, cam, W, H) {
    const w = this.world;
    if (cam.y + cam.h < -20) return;
    const sy = (0 - cam.cy) * cam.zoom + H * 0.5;
    if (sy < -80 || sy > H + 80) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, W, Math.max(0, sy));
    ctx.clip();
    const g = ctx.createLinearGradient(0, sy - 160, 0, sy);
    g.addColorStop(0, 'rgba(190,240,255,0.55)');
    g.addColorStop(0.6, 'rgba(120,215,240,0.22)');
    g.addColorStop(1, 'rgba(255,255,255,0.05)');
    ctx.fillStyle = g;
    ctx.fillRect(0, sy - 200, W, 200);
    // chop
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    for (let band = 0; band < 3; band++) {
      ctx.lineWidth = (1.6 - band * 0.5) * clamp(cam.zoom, 0.5, 2);
      ctx.beginPath();
      for (let x = -20; x <= W + 20; x += 8) {
        const wx = cam.x + x / cam.zoom;
        const y = sy + band * 7 - Math.sin(wx * 0.012 + w.time * (0.9 + band * 0.2)) * (3 + band * 2)
          - noise1(wx * 0.004 + w.time * 0.2) * 6;
        if (x === -20) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.globalAlpha = 0.5 - band * 0.14;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  /** god rays: they fade out with the photic zone, driven by lightAt() */
  drawShafts(ctx, cam, W, H) {
    const w = this.world;
    const strength = clamp01(1 - (cam.y + cam.h * 0.5) / (ZONES[1].top + 200));
    if (strength <= 0.02) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const n = 9;
    for (let k = 0; k < n; k++) {
      const ph = hash2(k * 3.7, 1.1);
      const sway = Math.sin(w.time * (0.06 + (ph % 1) * 0.05) + k) * 0.35;
      const x = ((k + ph) / n) * W * 1.4 - W * 0.2 + sway * W * 0.12 - ((cam.x * cam.zoom * 0.35) % (W / n));
      const wdt = W * (0.03 + (ph % 0.4) * 0.05);
      const g = ctx.createLinearGradient(x, 0, x + wdt * 1.5, H * 0.9);
      const a = (0.05 + (ph % 1) * 0.05) * strength * (0.6 + 0.4 * Math.sin(w.time * 0.5 + k));
      g.addColorStop(0, `rgba(210,245,255,${a})`);
      g.addColorStop(1, 'rgba(210,245,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(x, -10);
      ctx.lineTo(x + wdt, -10);
      ctx.lineTo(x + wdt * 3.2 + W * 0.1, H);
      ctx.lineTo(x + wdt * 1.4 + W * 0.1, H);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  /** depth haze + pressure tint: darker and bluer the deeper the camera goes */
  drawMurk(ctx, cam, W, H) {
    const wy = cam.y + cam.h * 0.5;
    const z = ZONES[zoneIndexAt(wy)];
    const f = clamp01(0.1 + z.turbidity * 0.5);
    ctx.fillStyle = rgba(rgbHex(z.deep), f * 0.35);
    ctx.fillRect(0, 0, W, H);
    // particulate load in the water column above the outcrop
    const t = smoothstep(ZONES[0].top, ZONES[2].bottom, wy);
    if (t > 0.05) {
      ctx.fillStyle = `rgba(${20 + 10 * (1 - t) | 0},${34 + 12 * (1 - t) | 0},${40 + 14 * (1 - t) | 0},${0.12 * t})`;
      ctx.fillRect(0, 0, W, H);
    }
  }

  drawVignette(ctx, cam, W, H) {
    const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.42, W / 2, H / 2, Math.max(W, H) * 0.78);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, `rgba(0,0,6,${0.32 + 0.3 * clamp01((cam.y / WORLD_H) * 1.2)})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  // ---------------------------------------------------------------- helpers
  drawFlora(ctx, cam, plane, view) {
    const w = this.world;
    for (const p of w.flora) {
      if (p.plane !== plane) continue;
      if (p.x < view.x0 - 90 || p.x > view.x1 + 90 || p.y < view.y0 - 620 || p.y > view.y1 + 90) continue;
      drawFlora(ctx, p, w, { cam });
    }
  }

  drawParticles(ctx, cam, view, layer) {
    const w = this.world;
    const list = w.particles;
    ctx.save();
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      const front = p.kind !== 'snow';
      if ((layer === 'front') !== front) continue;
      if (p.x < view.x0 - 20 || p.x > view.x1 + 20 || p.y < view.y0 - 20 || p.y > view.y1 + 20) continue;
      const t = clamp01(p.life / p.max);
      const a = p.kind === 'snow' ? 0.5 * t : t;
      if (p.glow) {
        ctx.globalCompositeOperation = 'lighter';
      } else {
        ctx.globalCompositeOperation = p.kind === 'blood' ? 'source-over' : 'source-over';
      }
      ctx.globalAlpha = a * (p.kind === 'snow' ? 0.42 : 0.8);
      ctx.fillStyle = p.color || '#cfe4ee';
      const s = p.size * (p.kind === 'blood' ? 0.6 + t * 0.6 : 1);
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(0.3, s), 0, TAU);
      ctx.fill();
    }
    ctx.restore();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  /** hydrothermal vents: chimney + plume, animated by the vent phase */
  drawVents(ctx, cam, view) {
    const w = this.world;
    for (const v of w.terrain.vents) {
      if (v.x < view.x0 - 200 || v.x > view.x1 + 200 || v.y < view.y0 - 400 || v.y > view.y1 + 200) continue;
      const pulse = 0.55 + 0.45 * Math.sin(w.time * 0.35 + v.phase);
      const h = 40 + v.power * 40;
      ctx.save();
      // chimney
      ctx.fillStyle = 'rgba(12,14,18,0.92)';
      ctx.beginPath();
      ctx.moveTo(v.x - 16 - v.power * 6, v.y);
      ctx.lineTo(v.x - 6, v.y - h);
      ctx.lineTo(v.x + 7, v.y - h);
      ctx.lineTo(v.x + 18 + v.power * 6, v.y);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(200,120,60,0.28)';
      ctx.lineWidth = 1.2;
      ctx.stroke();
      // smoke
      ctx.globalCompositeOperation = 'lighter';
      for (let k = 0; k < 7; k++) {
        const t = ((w.time * 0.28 + k * 0.15 + v.phase) % 1);
        const y = v.y - h - t * 260;
        const x = v.x + Math.sin(t * 5 + k + w.time * 0.6) * (10 + t * 46) + w.currentAt(v.x, y, w.time).x * t * 16;
        const r = 8 + t * 44;
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, `rgba(${180 + 60 * pulse | 0},${110 + 40 * pulse | 0},60,${0.2 * (1 - t) * pulse})`);
        g.addColorStop(1, 'rgba(40,20,10,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
      }
      ctx.restore();
    }
  }

  /** the whale-fall equivalents + surface falls that feed the deep */
  drawFalls(ctx, cam, view) {
    const w = this.world;
    for (const f of w.terrain.falls || []) {
      if (f.x < view.x0 - 300 || f.x > view.x1 + 300) continue;
      ctx.save();
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = 'rgba(200,230,240,0.25)';
      ctx.lineWidth = 1;
      for (let k = 0; k < 10; k++) {
        const t = ((w.time * 0.5 + k * 0.1) % 1);
        const y = lerp(f.y0 !== undefined ? f.y0 : 40, f.y1 !== undefined ? f.y1 : 600, t);
        const x = f.x + Math.sin(k * 1.7) * 14 + t * 10;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x - 2, y + 26);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  /** the boundary the leviathan holds: anything below it is prey */
  drawZoneLines(ctx, cam, view) {
    const w = this.world;
    ctx.save();
    ctx.lineWidth = 1.1 / cam.zoom;
    ctx.setLineDash([16 / cam.zoom, 12 / cam.zoom]);
    for (const z of ZONES) {
      if (z.id === 0) continue;
      if (z.top < view.y0 - 20 || z.top > view.y1 + 20) continue;
      const hot = z.id === 3;
      ctx.strokeStyle = hot ? 'rgba(120,244,255,0.22)' : 'rgba(180,220,240,0.09)';
      ctx.beginPath();
      ctx.moveTo(view.x0, z.top);
      ctx.lineTo(view.x1, z.top);
      ctx.stroke();
      if (hot) {
        ctx.setLineDash([]);
        ctx.font = `${11 / cam.zoom}px ui-monospace, monospace`;
        ctx.fillStyle = 'rgba(150,240,255,0.5)';
        const near = w.creatures.filter((c) => c.alive && c.y > z.top && c.y < z.top + 260).length;
        ctx.fillText(`THE LINE · below this anything is prey · ${near} drifting in the kill band`, view.x0 + 12 / cam.zoom, z.top - 6 / cam.zoom);
      }
    }
    ctx.restore();
  }

  drawLeash(ctx, c) {
    ctx.save();
    ctx.strokeStyle = 'rgba(255,210,120,0.3)';
    ctx.setLineDash([4, 6]);
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    ctx.arc(c.nest.x, c.nest.y, c.territory, 0, TAU);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.beginPath();
    ctx.moveTo(c.x, c.y);
    const b = c.body;
    if (b.mouth) ctx.lineTo(b.mouth.x, b.mouth.y);
    if (c.bb && c.bb.prey && c.bb.prey.alive) {
      ctx.strokeStyle = 'rgba(255,120,120,0.45)';
      ctx.beginPath();
      ctx.moveTo(c.x, c.y);
      ctx.lineTo(c.bb.prey.x, c.bb.prey.y);
      ctx.stroke();
    }
    if (c.bb && c.bb.food) {
      ctx.strokeStyle = 'rgba(140,255,170,0.35)';
      ctx.beginPath();
      ctx.moveTo(c.x, c.y);
      ctx.lineTo(c.bb.food.x, c.bb.food.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** trophic links: aggregated from world.stats.web, drawn between herds */
  drawFoodWeb(ctx, cam, view) {
    const w = this.world;
    const centroid = {};
    for (const c of w.creatures) {
      if (!c.alive) continue;
      const k = c.key;
      const o = centroid[k] || (centroid[k] = { x: 0, y: 0, n: 0, zone: 0 });
      o.x += c.x; o.y += c.y; o.n++; o.zone += c.zone;
    }
    for (const k in centroid) { const o = centroid[k]; o.x /= o.n; o.y /= o.n; o.zone /= o.n; }
    ctx.save();
    ctx.lineWidth = 0.9 / cam.zoom;
    ctx.font = `${10 / cam.zoom}px ui-monospace, monospace`;
    for (const a in centroid) {
      const na = centroid[a];
      ctx.fillStyle = 'rgba(210,240,255,0.75)';
      ctx.beginPath(); ctx.arc(na.x, na.y, 3 / cam.zoom, 0, TAU); ctx.fill();
      ctx.fillText(`${a} ×${na.n}`, na.x + 6 / cam.zoom, na.y - 4 / cam.zoom);
      const web = (w.stats.web[a] || {});
      for (const b in web) {
        const nb = centroid[b];
        if (!nb) continue;
        const v = web[b];
        const g = ctx.createLinearGradient(na.x, na.y, nb.x, nb.y);
        g.addColorStop(0, `rgba(255,180,90,${clamp01(v * 0.06)})`);
        g.addColorStop(1, `rgba(120,240,190,${clamp01(v * 0.03)})`);
        ctx.strokeStyle = g;
        ctx.beginPath();
        ctx.moveTo(na.x, na.y);
        ctx.lineTo(nb.x, nb.y);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  drawFieldOverlay(ctx, cam, view) {
    const w = this.world;
    const f = w.plankton;
    const cell = f.cell;
    const i0 = Math.max(0, Math.floor(view.x0 / cell)), i1 = Math.min(f.cols - 1, Math.ceil(view.x1 / cell));
    const j0 = Math.max(0, Math.floor(view.y0 / cell)), j1 = Math.min(f.rows - 1, Math.ceil(view.y1 / cell));
    ctx.save();
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const v = clamp01(f.v[j * f.cols + i] / 3);
        const nu = clamp01(w.nutrients.v[j * w.nutrients.cols + i] / 4);
        if (v < 0.02 && nu < 0.02) continue;
        ctx.fillStyle = `rgba(${90 + nu * 160 | 0},${200 * v + 40 | 0},${120 + nu * 60 | 0},${0.05 + v * 0.3})`;
        ctx.fillRect(i * cell, j * cell, cell, cell);
      }
    }
    ctx.restore();
  }
}

// ------------------------------------------------------------------- colours
function rgbHex(arr) {
  return '#' + [arr[0], arr[1], arr[2]].map((v) => ('0' + (v | 0).toString(16)).slice(-2)).join('');
}
function mixRgb(a, b, t) {
  return [lerp(a[0], b[0], t) | 0, lerp(a[1], b[1], t) | 0, lerp(a[2], b[2], t) | 0];
}
