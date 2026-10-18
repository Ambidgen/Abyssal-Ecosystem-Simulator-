// ---------------------------------------------------------------------------
//  WORLD / ECOLOGY
//
//  Owns: terrain, fields (nutrients, plankton, cover, fear), the spatial hash,
//  particles, carrion, eggs, the tide clock, and the stats that describe who
//  ate whom. `step(dt)` is the whole ecosystem tick and touches no DOM, so the
//  simulation can run headless (see test/headless.js) or be drawn at any zoom.
//
//  Emergent loops that fall out of the parts:
//   * nutrients -> plankton -> filter feeders -> minnows -> eels/sharks ->
//     leviathan; and death -> carrion -> scavengers -> nutrients.
//   * hunger widens an animal's acceptable travel radius, so sated animals sit
//     on their territory while starving ones cross zones — which costs them
//     health, which makes them bolder still, which feeds the abyss.
//   * the tide: a vertical surge every cycle that rips loose kelp, lifts
//     marine snow, and pushes the careless over the Z3 line into the dark.
// ---------------------------------------------------------------------------

import { Rand, hash2, fbm1 } from '../core/rand.js';
import { clamp, clamp01, lerp, damp, TAU, PI, Pool, resetUid, uid } from '../core/vec.js';
import { SpatialHash, Field } from '../core/spatial.js';
import { WORLD_W, WORLD_H, ZONES, zoneIndexAt, lightAt, pressureAt, LEVIATHAN_LINE } from './zones.js';
import { generateTerrain } from './terrain.js';
import { SPECIES, POPULATION, SPAWN_ORDER } from './species.js';
import { makeCreature, updateCreature, updateCarrion, killCreature, hurt } from './creature.js';
import { makeFlora, stepFlora, takeFlora, seedFlora, FLORA } from './flora.js';

export const DT = 1 / 60;

export const DEFAULT_CFG = {
  maxCreatures: 420,
  maxFlora: 900,
  popScale: 1,
  tidePeriod: 96,      // seconds per tide cycle
  dayPeriod: 420,      // seconds per light cycle
  startLeviathan: 2,
  nutrientFloor: 0.06,
};

export function createWorld(opts = {}) {
  const seed = (opts.seed ?? 1337) >>> 0;
  const cfg = { ...DEFAULT_CFG, ...(opts.cfg || {}) };
  const rand = new Rand(seed);
  resetUid(1);

  const world = {
    seed, cfg, rand,
    terrain: generateTerrain(seed),
    creatures: [],
    flora: [],
    carrion: [],
    eggs: [],
    particles: [],
    time: 0,
    frame: 0,
    tide: rand.f(),
    phase: rand.f(),
    speedMul: 1,
    paused: false,
    pop: {}, cap: {},
    stats: {
      web: {}, deaths: {}, births: {}, meals: {}, byCause: {}, predation: 0, scavenge: 0, grazing: 0,
      start: 0, t: 0, history: [], peak: {},
      reset() { this.web = {}; this.deaths = {}; this.births = {}; this.meals = {}; this.byCause = {}; },
      interact(a, b) {
        const m = this.web[a] || (this.web[a] = {});
        m[b] = (m[b] || 0) + 1;
      },
      meal(a, b) { this.interact(a, b); this.meals[a] = (this.meals[a] || 0) + 1; },
      death(k, cause) {
        this.deaths[k] = (this.deaths[k] || 0) + 1;
        this.byCause[cause] = (this.byCause[cause] || 0) + 1;
      },
      birth(k) { this.births[k] = (this.births[k] || 0) + 1; },
    },
    events: [],
    fx: null,
  };

  // ---- fields ------------------------------------------------------------
  world.nutrients = new Field(WORLD_W, WORLD_H, 72, 0.006, 0.05);
  world.plankton = new Field(WORLD_W, WORLD_H, 72, 0.02, 0.045);
  world.cover = new Field(WORLD_W, WORLD_H, 56, 0.55, 0.16);
  world.fear = new Field(WORLD_W, WORLD_H, 96, 0.32, 0.2);

  // ---- spatial hashes ----------------------------------------------------
  world.hash = new SpatialHash(WORLD_W, WORLD_H, 150);
  world.floraHash = new SpatialHash(WORLD_W, WORLD_H, 150);
  world.carrionHash = new SpatialHash(WORLD_W, WORLD_H, 200);

  // ---- pools -------------------------------------------------------------
  const particles = [];
  world.fx = makeFx(world, particles);
  world.particles = particles;

  for (const k of SPAWN_ORDER) { world.pop[k] = 0; world.cap[k] = Math.round((POPULATION[k] || 8) * cfg.popScale); }

  // ---- fertility + flora are seeded after the spawners exist (boot) ---

  // ---- spawning ----------------------------------------------------------
  world.spawnCreature = (key, x, y, opts = {}) => {
    if (world.creatures.length >= cfg.maxCreatures) return null;
    const c = makeCreature(world, key, x, y, opts);
    c.world = world;
    world.creatures.push(c);
    world.pop[key] = (world.pop[key] || 0) + 1;
    return c;
  };
  world.spawnFlora = (kind, x, y, opts = {}) => {
    if (world.flora.length >= cfg.maxFlora) return null;
    const P = world.terrain.plane(opts.plane ?? 0);
    const py = (y === undefined || y === null || !Number.isFinite(y)) ? P.surfaceY(x) : y;
    const p = makeFlora(world, kind, x, py, opts);
    p.plane = opts.plane ?? 0;
    world.flora.push(p);
    return p;
  };
  world.spawnCarrion = (x, y, mass, key, partial, owner) => {
    const k = {
      id: uid(), x, y, vx: 0, vy: 0, mass, maxMass: mass, r: clamp(6 + mass * 0.5, 6, 30),
      key, partial: !!partial, rot: rand.r(0, TAU), spin: rand.r(-1, 1), t: 0,
      zone: zoneIndexAt(y), resting: false, warm: owner && owner.key === 'minnow' ? 0.4 : 0,
      eatenBy: 0, pieces: Array.from({ length: 4 }, () => ({ a: rand.r(0, TAU), d: rand.r(0.4, 1), s: rand.r(0.5, 1.2) })),
    };
    world.carrion.push(k);
    return k;
  };
  world.consumeCarrion = (k) => {
    const i = world.carrion.indexOf(k);
    if (i >= 0) world.carrion.splice(i, 1);
    // last bite releases the nutrients back into the column
    world.nutrients.addClamped(k.x, k.y, 0.12 + k.maxMass * 0.01, 8);
    for (let n = 0; n < 5; n++) world.fx.flake(k.x, k.y, 1);
  };
  world.spawnEgg = (parent, x, y) => {
    const sp = parent.sp;
    world.eggs.push({
      id: uid(), key: parent.key, x, y, vx: rand.r(-4, 4), vy: rand.r(-2, 6),
      t: 0, hatch: lerp(18, 46, rand.f()) * (sp.reproduce.cd > 150 ? 1.5 : 1),
      plane: parent.plane, seed: (parent.seed + uid() * 2654435761) >>> 0,
      nest: { x: parent.nest.x, y: parent.nest.y }, wob: rand.r(0, TAU),
      alive: true,
    });
    world.stats.birth(parent.key);
  };
  world.emitSpores = (p, n) => {
    for (let k = 0; k < n; k++) {
      world.fx.spore(p.x + rand.r(-14, 14), (p.topY ?? p.y) + rand.r(-8, 8));
    }
    if (world.flora.length < cfg.maxFlora * 0.94 && rand.chance(0.5)) {
      const nx = clamp(p.x + rand.r(-190, 190), 30, WORLD_W - 30);
      const ny = world.terrain.plane(p.plane).surfaceY(nx);
      if (Math.abs(ny - p.y) < 560) world.spawnFlora(p.variant || p.kind, nx, ny, { plane: p.plane, growth: 0.1, biomass: 0.5 });
    }
  };

  // ---- queries -----------------------------------------------------------
  world.queryCreatures = (x, y, r, out) => {
    const arr = out || [];
    arr.length = 0;
    world.hash.query(x, y, r, (o) => { if (arr.length < 96) arr.push(o); });
    return arr;
  };
  world.queryFlora = (x, y, r, plane = 0) => {
    const arr = [];
    world.floraHash.query(x, y, r, (o) => { if (o.plane === plane) arr.push(o); });
    return arr;
  };
  world.queryCarrion = (x, y, r) => {
    const arr = [];
    world.carrionHash.query(x, y, r, (o) => arr.push(o));
    return arr;
  };
  world.takeFlora = (p, amount) => takeFlora(p, amount);
  world.coverAt = (x, y) => clamp01(world.cover.at(x, y) * 0.7);
  world.turbid = (y) => ZONES[zoneIndexAt(y)].turbidity;
  world.alive = () => {
    let n = 0;
    for (const c of world.creatures) if (c.alive) n++;
    return n;
  };
  /** best nearby feeding ground for a grazer/filter feeder */
  world.planktonTarget = (x, y, r) => {
    let bx = 0, by = 0, best = -1;
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * TAU + hash2(Math.round(x / 60), Math.round(y / 60), 4) * 0.5;
      const px = clamp(x + Math.cos(a) * r * 0.7, 20, WORLD_W - 20);
      const py = clamp(y + Math.sin(a) * r * 0.5, 40, WORLD_H - 40);
      const v = world.plankton.at(px, py) + world.cover.at(px, py) * 0.35;
      if (v > best) { best = v; bx = px; by = py; }
    }
    return best > 0.06 ? { x: bx, y: by, v: best } : null;
  };
  /** coarse "where is the food" gradient used by desperate migrants */
  world.foodGradient = (x, y, r, sp) => {
    let bx = 0, by = 0, best = -1e9;
    const wantsFlora = sp.flora && sp.flora.length;
    const hunts = sp.prey && sp.prey.length;
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * TAU;
      for (const f of [0.45, 0.85]) {
        const px = clamp(x + Math.cos(a) * r * f, 20, WORLD_W - 20);
        const py = clamp(y + Math.sin(a) * r * f * 0.65, 40, WORLD_H - 40);
        let v = 0;
        if (wantsFlora || sp.carrion > 0.3) v += world.plankton.at(px, py) * 0.7 + world.cover.at(px, py) * 0.9;
        if (hunts) {
          // hunting grounds = where the prey's own food is
          for (const pk of sp.prey) {
            const s2 = SPECIES[pk];
            if (!s2) continue;
            if (zoneIndexAt(py) === s2.zone) v += 0.45;
            v += world.plankton.at(px, py) * 0.25;
          }
        }
        // safer: prefer one's own band a little
        const zz = zoneIndexAt(py);
        v -= Math.abs(zz - sp.zone) * 0.16;
        if (v > best) { best = v; bx = px; by = py; }
      }
    }
    return { x: bx, y: by, v: best };
  };

  // ---- currents / tide ---------------------------------------------------
  const cur = { x: 0, y: 0 };
  world.currentAt = (x, y, t) => {
    const tz = world.tide * TAU;
    const surge = Math.sin(tz) * 0.8 + Math.sin(tz * 2 + 1.1) * 0.28;
    const depthF = clamp01(1 - Math.abs(y / WORLD_H - 0.55) * 1.5);
    const band = fbm1(x / 700 + y * 0.0008, world.seed + 6, 2);
    cur.y = surge * 15 * (0.4 + depthF) + Math.sin(t * 0.6 + y * 0.004) * 1.6;
    cur.x = Math.sin(y * 0.005 + t * 0.22) * 7 * (0.5 + band * 0.9) + band * 6;
    // vent plumes push upward hard
    for (const v of world.terrain.vents) {
      const d = Math.hypot(x - v.x, y - (v.y - 60));
      if (d < 190) { const k = (1 - d / 190); cur.y -= 46 * k * k * v.power; cur.x += Math.sin(t * 2 + v.phase) * 8 * k; }
    }
    return cur;
  };

  // ---- event log ---------------------------------------------------------
  world.log = (text, x, y, kind = 'info') => {
    const e = { text, x, y, kind, t: world.time, id: uid() };
    world.events.push(e);
    if (world.events.length > 90) world.events.shift();
    return e;
  };

  // ---- initial fauna -----------------------------------------------------
  world.reset = (keepSeed = true) => {
    world.creatures.length = 0;
    world.flora.length = 0;
    world.carrion.length = 0;
    world.eggs.length = 0;
    world.particles.length = 0;
    world.events.length = 0;
    world.time = 0; world.frame = 0;
    for (const k of SPAWN_ORDER) world.pop[k] = 0;
    world.nutrients.v.fill(0); world.plankton.v.fill(0); world.cover.v.fill(0); world.fear.v.fill(0);
    world.rand = new Rand(keepSeed ? seed : (Math.random() * 1e9) >>> 0);
    world.terrain = generateTerrain(world.rand.seed);
    for (let y = 40; y < WORLD_H; y += 72) for (let x = 40; x < WORLD_W; x += 72) {
      world.nutrients.addClamped(x, y, 0.25, 3);
      world.plankton.addClamped(x, y, 0.5 * lightAt(y, 0.2) + 0.1, 4);
    }
    seedFlora(world, world.rand, 1);
    populate(world, world.rand);
  };
  boot(world, rand);

  return world;
}

/** the water column has to be fertile before anything can live in it */
function boot(world, rand) {
  for (let y = 40; y < WORLD_H; y += 72) {
    for (let x = 40; x < WORLD_W; x += 72) {
      const light = lightAt(y, 0.2);
      world.nutrients.addClamped(x, y, 0.25 + 0.4 * Math.max(0, 1 - y / WORLD_H), 3);
      world.plankton.addClamped(x, y, 0.55 * light + 0.12, 4);
    }
  }
  seedFlora(world, rand, 1);
  populate(world, rand);
}

// ---------------------------------------------------------------------------
//  initial fauna distribution
// ---------------------------------------------------------------------------
function bandFor(key) {
  const sp = SPECIES[key];
  const z = ZONES[sp.zone];
  return { top: z.top + 40, bottom: z.bottom - 40 };
}
function populate(world, rand) {
  const T = world.terrain;
  for (const key of SPAWN_ORDER) {
    const sp = SPECIES[key];
    const cap = world.cap[key];
    const n = Math.max(1, Math.round(cap * (key === 'leviathan' ? Math.min(1, world.cfg.startLeviathan / Math.max(1, cap)) : 0.72)));
    const band = bandFor(key);
    for (let k = 0; k < n; k++) {
      let x, y, plane = 0;
      if (key === 'crab') {
        const cav = T.hatcheryAt(k);
        x = cav.mouth.x; y = cav.mouth.y;
      } else if (key === 'snail') {
        plane = 1;
        const L = T.bgLedges[k % T.bgLedges.length];
        x = lerp(L.x0, L.x1, rand.f()); y = L.y - 10;
      } else if (key === 'leviathan') {
        x = lerp(0.62, 0.92, rand.f()) * WORLD_W;
        y = lerp(ZONES[3].top + 160, WORLD_H - 300, rand.f());
      } else {
        const spot = randSpot(world, band, 60);
        x = spot.x; y = spot.y;
      }
      const c = world.spawnCreature(key, x, y, { plane, hatcheryId: key === 'crab' ? (T.hatcheryAt(k).id) : undefined, nest: { x, y } });
      if (!c) break;
    }
  }
}
function randSpot(world, band, minClear) {
  const T = world.terrain;
  const P = T.plane(0);
  for (let k = 0; k < 30; k++) {
    const x = rand2();
    const y = lerp(band.top, band.bottom, Math.random());
    const c = P.clearance(x, y, _spot);
    if (c.d > minClear) return { x, y };
  }
  const x = rand2();
  return { x, y: lerp(band.top, band.bottom, 0.5) };
  function rand2() { return lerp(200, WORLD_W - 200, Math.random()); }
}
const _spot = { d: 0, nx: 0, ny: 0, which: 0 };

// ---------------------------------------------------------------------------
//  particles
// ---------------------------------------------------------------------------
function makeFx(world, list) {
  const MAX = 2200;
  const push = (p) => {
    if (list.length >= MAX) list.shift();
    list.push(p);
    return p;
  };
  const base = (kind, x, y, life, size, color, glow = 0) => ({
    kind, x, y, vx: 0, vy: 0, life, max: life, size, color, glow, drag: 0.985, buoy: 0, spin: 0, rot: 0,
  });
  return {
    list,
    ambient() {
      // marine snow: constant, slow, and the base of the detritus food web
      if (list.length < MAX * 0.72) {
        const cam = world.camera;
        const x = cam ? cam.x + (Math.random() - 0.5) * cam.w * 1.4 : Math.random() * WORLD_W;
        const y = cam ? cam.y + (Math.random() - 0.5) * cam.h * 1.4 : Math.random() * WORLD_H;
        push({ ...base('snow', clamp(x, 0, WORLD_W), clamp(y, 0, WORLD_H), 900, 0.6 + Math.random() * 1.7, '#cfe4ee', 0), drift: Math.random() * TAU, life: 900, max: 900 });
      }
    },
    blood(x, y, n, color) {
      for (let k = 0; k < n; k++) {
        const a = Math.random() * TAU;
        push({ ...base('blood', x, y, lerp(0.6, 2.4, Math.random()), lerp(1, 3.6, Math.random()), color || '#e8f6ff', 0.06),
          vx: Math.cos(a) * lerp(6, 60, Math.random()), vy: Math.sin(a) * lerp(6, 60, Math.random()), drag: 0.93 });
      }
    },
    flake(x, y, n) {
      for (let k = 0; k < n; k++) {
        const a = Math.random() * TAU;
        push({ ...base('flake', x, y, lerp(1, 3, Math.random()), lerp(1, 2.6, Math.random()), '#e9e2cf', 0), vx: Math.cos(a) * 22, vy: Math.sin(a) * 10 - 6, drag: 0.94 });
      }
    },
    bubble(x, y, n) {
      for (let k = 0; k < n; k++) {
        push({ ...base('bubble', x + (Math.random() - 0.5) * 12, y, lerp(1.6, 4.2, Math.random()), lerp(1, 3.2, Math.random()), '#dff6ff', 0.18),
          vy: -lerp(24, 70, Math.random()), vx: (Math.random() - 0.5) * 12, drag: 0.995, wobble: Math.random() * TAU });
      }
    },
    jet(x, y, a, size) {
      for (let k = 0; k < 5; k++) {
        push({ ...base('jet', x + Math.cos(a) * size * 0.4, y + Math.sin(a) * size * 0.4, 0.55, 1 + Math.random() * 2.4, '#bfe9ff', 0.12),
          vx: Math.cos(a + (Math.random() - 0.5) * 0.7) * lerp(30, 110, Math.random()), vy: Math.sin(a) * 40, drag: 0.9 });
      }
    },
    ring(x, y, color, size) {
      push({ ...base('ring', x, y, 0.75, size, color, 0.3), grow: 1 });
    },
    spark(x, y, color) {
      push({ ...base('spark', x, y, 0.35, 2.4, color || '#ffe57a', 0.8) });
    },
    click(x, y) {
      push({ ...base('ring', x, y, 0.32, 14, '#ffd8a8', 0.2), grow: 1.4 });
    },
    sting(x, y) {
      for (let k = 0; k < 4; k++) push({ ...base('sting', x, y, 0.5, 1.6, '#fff2a8', 0.55), vx: (Math.random() - 0.5) * 40, vy: (Math.random() - 0.5) * 40 });
    },
    smoke(x, y, color) {
      for (let k = 0; k < 8; k++) push({ ...base('smoke', x, y, 0.8, 6 + Math.random() * 8, color || '#8fb0c4', 0), vx: (Math.random() - 0.5) * 30, vy: (Math.random() - 0.5) * 30, drag: 0.9 });
    },
    spore(x, y) {
      push({ ...base('spore', x, y, lerp(3, 9, Math.random()), 1.4 + Math.random() * 1.6, '#a8e88f', 0.1), buoy: -0.4, vy: -lerp(4, 16, Math.random()), vx: (Math.random() - 0.5) * 26, drag: 0.995 });
    },
    glitter(x, y, color) {
      push({ ...base('glitter', x, y, 1.4, 2.2, color || '#bff6ff', 1) });
    },
  };
}

function stepParticles(world, dt) {
  const list = world.particles;
  for (let i = list.length - 1; i >= 0; i--) {
    const p = list[i];
    p.life -= dt;
    if (p.life <= 0) { list.splice(i, 1); continue; }
    // a particle that ever loses its coordinates can never come back, and the
    // out-of-bounds test below is false for NaN — so drop it here
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) { list.splice(i, 1); continue; }
    if (p.kind === 'snow' || p.kind === 'spore' || p.kind === 'flake' || p.kind === 'bubble') {
      const c = world.currentAt(p.x, p.y, world.time + (p.drift || 0));
      p.vx = damp(p.vx, c.x * 0.9 + Math.sin(world.time * 0.6 + (p.drift || 0)) * 3, 1.4, dt);
      p.vy = damp(p.vy, (p.kind === 'bubble' ? -34 : p.kind === 'spore' ? -12 : 9) + c.y * 0.6, 1.2, dt);
      p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.kind === 'snow') {
        // snow reaching rock becomes nutrients
        if (world.terrain.plane(0).solidAt(p.x, p.y)) {
          world.nutrients.addClamped(p.x, p.y, 0.006, 6);
          list.splice(i, 1);
          continue;
        }
      }
      if (p.y > WORLD_H || p.y < 0 || p.x < 0 || p.x > WORLD_W) { list.splice(i, 1); continue; }
    } else {
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.vx *= p.drag; p.vy = p.vy * p.drag + 6 * dt;
      if (p.buoy) p.vy += p.buoy * dt * 60;
      if (p.grow) p.size += 90 * dt * p.grow;
    }
  }
  // ambient snow + vent bubbles keep running
  world.fx.ambient();
  if (world.frame % 6 === 0) for (const v of world.terrain.vents) world.fx.bubble(v.x + (Math.random() - 0.5) * 16, v.y - 6, 1 + Math.round(Math.random()));
}

// ---------------------------------------------------------------------------
//  main tick
// ---------------------------------------------------------------------------
export function stepWorld(world, dt = DT) {
  world.time += dt;
  world.frame++;
  world.tide = (world.tide + dt / world.cfg.tidePeriod) % 1;
  world.phase = (world.phase + dt / world.cfg.dayPeriod) % 1;
  world.speedMul = 1;

  // --- rebuild spatial indexes -------------------------------------------
  world.hash.clear();
  world.floraHash.clear();
  world.carrionHash.clear();
  for (const c of world.creatures) if (c.alive) world.hash.insert(c, c.x, c.y);
  for (const p of world.flora) world.floraHash.insert(p, p.x, p.y);
  for (const k of world.carrion) world.carrionHash.insert(k, k.x, k.y);

  // --- fields -------------------------------------------------------------
  stepFields(world, dt);

  // --- fauna --------------------------------------------------------------
  const cam = world.camera;
  for (let i = world.creatures.length - 1; i >= 0; i--) {
    const c = world.creatures[i];
    // LOD by camera distance: far animals think and sense less often
    if (cam) {
      const d = Math.hypot(c.x - cam.cx, c.y - cam.cy);
      const r = Math.max(cam.w, cam.h) * 0.6;
      c.lod = d < r ? 0 : d < r * 2.1 ? 1 : 2;
    } else c.lod = 0;
    updateCreature(c, dt, world);
    c.zone = zoneIndexAt(c.y);
    // zone crossing events
    if (c.alive && c.sp.apex === false && c.zone === 3 && c._lastZone !== 3) {
      world.log(`${c.sp.name} crossed into the Abyss`, c.x, c.y, 'danger');
    }
    if (c.alive) c._lastZone = c.zone;
    if (!c.alive && c.deathT > 5.5) {
      world.pop[c.key] = Math.max(0, (world.pop[c.key] || 1) - 1);
      world.creatures.splice(i, 1);
    }
  }

  // --- carrion + eggs ------------------------------------------------------
  for (let i = world.carrion.length - 1; i >= 0; i--) {
    const k = world.carrion[i];
    updateCarrion(k, dt, world);
    if (k.mass <= 0) world.consumeCarrion(k);
  }
  for (let i = world.eggs.length - 1; i >= 0; i--) {
    const e = world.eggs[i];
    e.t += dt;
    const c = world.currentAt(e.x, e.y, world.time);
    e.x += (e.vx + c.x * 0.4) * dt; e.y += (e.vy + c.y * 0.4 + 3) * dt;
    const P = world.terrain.plane(e.plane);
    const g = P.groundBelow(e.x, e.y, 220);
    if (g > 0) { e.y = g - 5; e.vy = 0; e.vx *= 0.6; e.settled = true; }
    if (e.t > e.hatch) {
      world.eggs.splice(i, 1);
      const sp = SPECIES[e.key];
      const cap = world.cap[e.key];
      if (world.pop[e.key] < cap) {
        const baby = world.spawnCreature(e.key, e.x, e.y - 6, {
          plane: e.plane, growth: 0.2, hunger: 0.8, health: 1,
          nest: { x: e.x, y: e.y }, age: 0,
        });
        if (baby) { baby.mode = sp.canCling ? 'walk' : 'swim'; }
        world.fx.glitter(e.x, e.y, '#cfeaff');
      }
    }
  }

  // --- flora ---------------------------------------------------------------
  for (let i = world.flora.length - 1; i >= 0; i--) {
    const p = world.flora[i];
    p.lod = cam ? (Math.hypot(p.x - cam.cx, p.y - cam.cy) > Math.max(cam.w, cam.h) ? 1 : 0) : 0;
    const dead = stepFlora(p, dt, world);
    if (dead) world.flora.splice(i, 1);
  }

  // --- crab hatcheries: the caves in Z3 keep pouring out juveniles --------
  hatcheryTick(world, dt);
  // --- larval rain: recolonisation so the ecosystem cannot dead-end -------
  recruitTick(world, dt);

  // --- particles ----------------------------------------------------------
  stepParticles(world, dt);

  // --- stats ---------------------------------------------------------------
  world.stats.t = world.time;
  if (world.frame % 45 === 0) {
    const snap = { t: world.time, pop: {}, hp: {}, hunger: {} };
    for (const k of SPAWN_ORDER) {
      let n = 0, hp = 0, hu = 0;
      for (const c of world.creatures) if (c.key === k && c.alive) { n++; hp += c.health; hu += c.hunger; }
      snap.pop[k] = n;
      snap.hp[k] = n ? hp / n : 0;
      snap.hunger[k] = n ? hu / n : 0;
      world.stats.peak[k] = Math.max(world.stats.peak[k] || 0, n);
    }
    world.stats.history.push(snap);
    if (world.stats.history.length > 260) world.stats.history.shift();
  }
  return world;
}

function stepFields(world, dt) {
  const N = world.nutrients, PK = world.plankton, COV = world.cover, FEAR = world.fear;
  N.step(dt); PK.step(dt); COV.step(dt); FEAR.step(dt);
  // plankton: light-limited growth on nutrients, stronger in the photic zone
  const { cols, rows, cell } = PK;
  const v = PK.v, nv = N.v;
  for (let y = 0; y < rows; y++) {
    const wy = y * cell + cell * 0.5;
    const light = lightAt(wy, world.phase);
    const k = 0.10 * light;
    if (k <= 0.0005) { continue; }
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      const nut = nv[i];
      if (nut <= 0.01) { v[i] *= 1 - 0.02 * dt; continue; }
      const g = k * nut * (1 - v[i] * 0.28) * dt;
      v[i] = Math.min(5, v[i] + g);
      nv[i] = Math.max(0, nut - g * 0.55);
    }
  }
  // abyssal chemosynthesis: a slow nutrient source near the vents + trench
  for (const vt of world.terrain.vents) {
    N.addClamped(vt.x, vt.y - 24, 0.05 * dt * (0.5 + 0.5 * Math.sin(world.time * 0.35 + vt.phase)) * vt.power, 6);
  }
  // deep water constantly upwells nutrients
  for (let k = 0; k < 6; k++) {
    const x = ((world.frame * 37 + k * 977) % 100) / 100 * WORLD_W;
    N.addClamped(x, WORLD_H - 260 - (k * 90), 0.02 * dt * 3, 6);
  }
  // plankton sinking out of the photic zone becomes snow
  // natural mortality of plankton feeds the detritus pool (and back again)
  for (let i = 0; i < v.length; i += 3) {
    if (v[i] > 1.4) { v[i] -= 0.005 * dt * 60; N.v[i] = Math.min(7, N.v[i] + 0.006 * dt * 60); }
  }
  // the deep box is a nutrient reservoir: upwelling never fully stops, so the
  // chemosynthetic floor of the food web cannot be grazed out of existence
  const bottomRow = (rows - 1) * cols;
  for (let x = 0; x < cols; x++) {
    const i = bottomRow + x;
    if (N.v[i] < 0.75) N.v[i] = lerp(N.v[i], 0.75 + 0.25 * Math.sin(world.time * 0.07 + x), 0.25);
    const i2 = bottomRow - cols + x;
    if (i2 >= 0 && N.v[i2] < 0.4) N.v[i2] = lerp(N.v[i2], 0.4, 0.12);
  }
  FEAR.decay = 0.3;
  COV.decay = 0.5;
}

function hatcheryTick(world, dt) {
  const T = world.terrain;
  world.hatchT = (world.hatchT || 0) + dt;
  if (world.hatchT < 1) return;
  world.hatchT = 0;
  if (world.pop.crab >= world.cap.crab) return;
  const hs = T.hatcheries;
  if (!hs.length) return;
  const c0 = hs[world.frame % hs.length];
  const near = world.creatures.reduce((n, o) => n + (o.alive && o.key === 'crab' && o.hatcheryId === c0.id ? 1 : 0), 0);
  if (near > 5) return;
  const baby = world.spawnCreature('crab', c0.mouth.x, c0.mouth.y, {
    growth: 0.22 + Math.random() * 0.2, hunger: 0.72, health: 1,
    nest: { x: c0.x, y: c0.y }, hatcheryId: c0.id, plane: 0, mode: 'walk',
  });
  if (baby) {
    world.fx.bubble(c0.mouth.x, c0.mouth.y, 3);
    world.log(`crab emerged from the ${c0.kind} cave`, c0.mouth.x, c0.mouth.y, 'breed');
  }
}

function recruitTick(world, dt) {
  world.recruitT = (world.recruitT || 0) + dt;
  if (world.recruitT < 3.2) return;
  world.recruitT = 0;
  for (const k of SPAWN_ORDER) {
    const n = world.pop[k] || 0;
    const cap = world.cap[k];
    if (n > Math.max(3, cap * 0.45)) continue;
    // surface recruitment: larvae drift down from outside the system
    const sp = SPECIES[k];
    const band = k === 'leviathan' ? { top: ZONES[3].top + 200, bottom: ZONES[3].bottom - 300 }
      : { top: ZONES[sp.zone].top + 60, bottom: ZONES[sp.zone].bottom - 60 };
    const spot = randSpot(world, band, 50);
    const c = world.spawnCreature(k, spot.x, spot.y, { growth: 0.3, hunger: 0.62, nest: { x: spot.x, y: spot.y } });
    if (c) world.log(`larval recruitment: ${sp.name}`, spot.x, spot.y, 'breed');
    return; // one per interval, so recovery is gradual
  }
}
