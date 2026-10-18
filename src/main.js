// ---------------------------------------------------------------------------
//  APP SHELL
//
//  Fixed-timestep simulation, variable-timestep rendering. The sim always
//  advances in exact 1/60 s steps; "speed" changes how many of those steps run
//  per displayed frame, which is why physics stays stable at 4× and why the
//  animals never tunnel through rock.
// ---------------------------------------------------------------------------

import { DT, createWorld, stepWorld } from './sim/world.js';
import { SPECIES, SPECIES_KEYS } from './sim/species.js';
import { WORLD_W, WORLD_H, ZONES, zoneIndexAt } from './sim/zones.js';
import { Camera } from './render/camera.js';
import { Scene } from './render/scene.js';
import { Hud } from './ui/hud.js';
import { clamp } from './core/vec.js';

const SPEEDS = [0.25, 0.5, 1, 2, 4];

export class App {
  constructor(canvas, uiRoot) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.cam = new Camera();
    this.seed = 1337;
    this.world = createWorld({ seed: this.seed });
    this.cam.bind(this.world);
    this.scene = new Scene(this.world, canvas);
    this.hud = new Hud(uiRoot, this);
    this.paused = false;
    this.speedIdx = 2;
    this.speed = SPEEDS[this.speedIdx];
    this.acc = 0;
    this.info = { fps: 60, ms: 0, paused: false, speedMul: 1 };
    this.fpsT = 0; this.frames = 0; this.msAvg = 0;
    this.drag = null;
    this.lastEvent = 0;
    this.jitter = 0;
    this.resize();
    this.bind();
    this.cam.cx = this.cam.tx = WORLD_W * 0.3;
    this.cam.cy = this.cam.ty = ZONES[0].bottom + 120;
    this.cam.zoom = this.cam.zoomT = Math.min(this.canvas.clientWidth / 1500, 1.15);
    this.world.log('the ecosystem begins', WORLD_W / 2, 200, 'info');
  }

  // ------------------------------------------------------------- lifecycle
  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.cam.setViewport(w, h, dpr);
  }

  bind() {
    const cv = this.canvas;
    window.addEventListener('resize', () => this.resize());
    cv.addEventListener('pointerdown', (e) => {
      cv.setPointerCapture(e.pointerId);
      this.drag = { x: e.clientX, y: e.clientY, t: performance.now(), moved: 0 };
    });
    cv.addEventListener('pointermove', (e) => {
      if (!this.drag) return;
      const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y;
      this.drag.x = e.clientX; this.drag.y = e.clientY;
      this.drag.moved += Math.abs(dx) + Math.abs(dy);
      if (this.drag.moved > 4) this.cam.panBy(dx, dy);
    });
    cv.addEventListener('pointerup', (e) => {
      const d = this.drag;
      this.drag = null;
      if (d && d.moved < 5) this.pick(e.clientX, e.clientY);
    });
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = cv.getBoundingClientRect();
      this.cam.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.pow(0.9988, -e.deltaY * (e.deltaMode === 1 ? 16 : 1)));
    }, { passive: false });
    window.addEventListener('keydown', (e) => this.key(e));
  }

  key(e) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    const k = e.key.toLowerCase();
    if (k === ' ') { e.preventDefault(); this.togglePause(); }
    else if (k >= '1' && k <= '5') { this.speedIdx = +k - 1; this.speed = SPEEDS[this.speedIdx]; }
    else if (k === 'f') this.toggleFollow();
    else if (k === 'r') this.regenerate();
    else if (k === 'w') this.toggle('showFoodWeb');
    else if (k === 'b') this.toggle('showBodies');
    else if (k === 'd') this.toggle('showField');
    else if (k === 'z') this.cam.zoomAt(this.canvas.clientWidth / 2, this.canvas.clientHeight / 2, 1.6);
    else if (k === 'x') this.cam.zoomAt(this.canvas.clientWidth / 2, this.canvas.clientHeight / 2, 1 / 1.6);
    else if (k === 'escape') { this.scene.selected = null; this.cam.follow = null; }
    else if (k === 'arrowup') this.cam.panBy(0, -60);
    else if (k === 'arrowdown') this.cam.panBy(0, 60);
    else if (k === 'arrowleft') this.cam.panBy(-60, 0);
    else if (k === 'arrowright') this.cam.panBy(60, 0);
  }

  // ------------------------------------------------------------- controls
  togglePause() { this.paused = !this.paused; }
  cycleSpeed() { this.speedIdx = (this.speedIdx + 1) % SPEEDS.length; this.speed = SPEEDS[this.speedIdx]; }
  toggle(name) { this.scene[name] = !this.scene[name]; }
  toggleFollow() {
    const s = this.scene.selected;
    if (!s) return;
    this.cam.follow = this.cam.follow === s ? null : s;
  }
  lookAt(x, y, zoom) {
    this.cam.follow = null;
    this.cam.tx = clamp(x, 0, WORLD_W); this.cam.ty = clamp(y, 0, WORLD_H);
    if (zoom) this.cam.zoomT = clamp(zoom, this.cam.minZoom, this.cam.maxZoom);
  }
  jumpToZone(i) {
    const z = ZONES[i];
    this.lookAt(this.cam.cx, (z.top + z.bottom) / 2);
  }
  selectNearestOf(key) {
    let best = null, bd = 1e18;
    const cx = this.cam.cx, cy = this.cam.cy;
    for (const c of this.world.creatures) {
      if (!c.alive || c.key !== key) continue;
      const d = (c.x - cx) ** 2 + (c.y - cy) ** 2;
      if (d < bd) { bd = d; best = c; }
    }
    if (best) { this.scene.selected = best; this.lookAt(best.x, best.y); }
  }
  pick(sx, sy) {
    const p = this.cam.screenToWorld(sx, sy);
    let best = null, bd = 1e18;
    for (const c of this.world.creatures) {
      if (!c.alive) continue;
      const d = Math.hypot(c.x - p.x, c.y - p.y);
      const grab = Math.max(16, c.radius * 2.4);
      if (d < grab && d < bd) { bd = d; best = c; }
    }
    this.scene.selected = best;
    if (!best) this.cam.follow = null;
  }
  regenerate(seed) {
    this.seed = (seed !== undefined ? seed : (Math.random() * 1e9) | 0) >>> 0;
    this.world = createWorld({ seed: this.seed });
    this.cam.bind(this.world);
    this.scene.world = this.world;
    this.scene.terrain.world = this.world;
    this.scene.terrain.T = this.world.terrain;
    this.scene.terrain.invalidate();
    this.scene.selected = null;
    this.hud.selId = null;
    this.world.log('new world — seed ' + this.seed, WORLD_W / 2, 160, 'info');
  }

  // --------------------------------------------------------------- the loop
  start() {
    let last = performance.now();
    const tick = (now) => {
      const raw = (now - last) / 1000;
      last = now;
      const dt = Math.min(raw, 0.1);
      this.frame(dt);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  frame(dt) {
    const t0 = performance.now();
    if (!this.paused) {
      this.acc += dt * this.speed;
      let steps = 0;
      const maxSteps = this.speed > 2 ? 12 : 5;
      while (this.acc >= DT && steps < maxSteps) {
        stepWorld(this.world, DT);
        this.acc -= DT;
        steps++;
      }
      if (this.acc > DT * 6) this.acc = 0;      // never spiral after a stall
    }
    // the sim reads the camera for level of detail; keep it current
    this.cam.update(dt, this.world);

    // apex events deserve the camera
    const ev = this.world.events;
    if (ev.length && ev[ev.length - 1].id !== this.lastEvent) {
      const e = ev[ev.length - 1];
      this.lastEvent = e.id;
      if (e.kind === 'apex') { this.cam.kick(13); if (this.cam.follow === null) this.lookAt(e.x, e.y); }
      else if (e.kind === 'danger') this.cam.kick(5);
    }

    this.ctx.fillStyle = '#02060c';
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.scene.render(this.cam, { hud: true });

    // stats
    this.frames++;
    this.fpsT += dt;
    this.msAvg = this.msAvg * 0.9 + (performance.now() - t0) * 0.1;
    if (this.fpsT > 0.4) {
      this.info.fps = this.frames / this.fpsT;
      this.frames = 0; this.fpsT = 0;
    }
    this.info.ms = this.msAvg;
    this.info.paused = this.paused;
    this.info.speedMul = this.speed;
    this.hud.update(dt, this.world, this.cam, this.scene.selected, this.info);
  }
}

/** boot */
export function boot() {
  const canvas = document.getElementById('view');
  const ui = document.getElementById('ui');
  const app = new App(canvas, ui);
  window.app = app;
  app.start();
  const load = document.getElementById('loading');
  if (load) {
    load.querySelector('.what').textContent =
      `${app.world.creatures.length} animals · ${app.world.flora.length} plants · ${app.world.terrain.caves.length} caves, seed ${app.world.seed}`;
    setTimeout(() => load.classList.add('gone'), 260);
  }
  return app;
}

export { SPECIES, SPECIES_KEYS, zoneIndexAt };
