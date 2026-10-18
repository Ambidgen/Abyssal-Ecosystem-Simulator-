// ---------------------------------------------------------------------------
//  Camera: world<->screen transform, clamped to the world box, with smooth
//  follow, shake and a zoom that keeps the point under the cursor fixed.
//  It also publishes itself as world.camera, which the simulation reads for
//  level-of-detail (animals far from view think and animate less).
// ---------------------------------------------------------------------------

import { clamp, damp } from '../core/vec.js';
import { WORLD_W, WORLD_H } from '../sim/zones.js';

export class Camera {
  constructor(vw = 1280, vh = 720) {
    this.vw = vw; this.vh = vh;
    this.dpr = 1;
    this.cx = WORLD_W * 0.28; this.cy = WORLD_H * 0.3;
    this.tx = this.cx; this.ty = this.cy;
    this.zoom = 1; this.zoomT = 1;
    this.minZoom = 0.16; this.maxZoom = 4.2;
    this.follow = null;
    this.shake = 0; this.shakeT = 0;
    this.dragging = false;
  }

  setViewport(vw, vh, dpr) { this.vw = vw; this.vh = vh; this.dpr = dpr || 1; }

  /** visible world size */
  get w() { return this.vw / this.zoom; }
  get h() { return this.vh / this.zoom; }
  get x() { return this.cx - this.w / 2; }
  get y() { return this.cy - this.h / 2; }

  /** the object the simulation reads (LOD + particle spawn region) */
  bind(world) { world.camera = this; return this; }

  worldToScreen(x, y, out) {
    const o = out || {};
    o.x = (x - this.cx) * this.zoom + this.vw * 0.5 + this.ox;
    o.y = (y - this.cy) * this.zoom + this.vh * 0.5 + this.oy;
    return o;
  }
  screenToWorld(sx, sy, out) {
    const o = out || {};
    o.x = (sx - this.vw * 0.5 - this.ox) / this.zoom + this.cx;
    o.y = (sy - this.vh * 0.5 - this.oy) / this.zoom + this.cy;
    return o;
  }

  /** true if a world-space circle is inside the view (plus margin) */
  visible(x, y, r = 0) {
    return x + r > this.x - 60 && x - r < this.x + this.w + 60 &&
           y + r > this.y - 60 && y - r < this.y + this.h + 60;
  }

  panBy(dx, dy) { this.tx -= dx / this.zoom; this.ty -= dy / this.zoom; this.follow = null; }

  zoomAt(sx, sy, factor) {
    const before = this.screenToWorld(sx, sy);
    this.zoomT = clamp(this.zoomT * factor, this.minZoom, this.maxZoom);
    this.zoom = this.zoomT;                       // instant so the anchor holds
    const after = this.screenToWorld(sx, sy);
    this.tx += before.x - after.x;
    this.ty += before.y - after.y;
    this.cx = this.tx; this.cy = this.ty;
  }

  kick(amount) { this.shake = Math.min(26, this.shake + amount); }

  update(dt, world) {
    if (this.follow && this.follow.alive !== false) {
      const f = this.follow;
      this.tx = f.x + (f._v ? clamp(f._v.x, -220, 220) * 0.35 : 0);
      this.ty = f.y + (f._v ? clamp(f._v.y, -220, 220) * 0.3 : 0);
    }
    const k = this.follow ? 6.5 : 9.5;
    this.cx = damp(this.cx, this.tx, k, dt);
    this.cy = damp(this.cy, this.ty, k, dt);
    this.zoom = damp(this.zoom, this.zoomT, 10, dt);
    // keep the frame inside the world unless zoomed far out
    const hw = this.w / 2, hh = this.h / 2;
    this.cx = hw * 2 >= WORLD_W ? WORLD_W / 2 : clamp(this.cx, hw, WORLD_W - hw);
    this.cy = hh * 2 >= WORLD_H ? WORLD_H / 2 : clamp(this.cy, hh * 0.35, WORLD_H - hh);
    if (this.shake > 0.05) {
      this.shakeT += dt * 34;
      this.ox = Math.sin(this.shakeT * 1.7) * this.shake * 0.6;
      this.oy = Math.cos(this.shakeT * 2.3) * this.shake * 0.5;
      this.shake *= Math.pow(0.02, dt);
    } else { this.ox = 0; this.oy = 0; this.shake = 0; }
  }

  /** ctx transform for world-space drawing */
  apply(ctx) {
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.translate(this.vw * 0.5 + this.ox, this.vh * 0.5 + this.oy);
    ctx.scale(this.zoom, this.zoom);
    ctx.translate(-this.cx, -this.cy);
  }
  /** screen-space (HUD) transform */
  applyScreen(ctx) { ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); }
}
