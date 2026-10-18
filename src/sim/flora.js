// ---------------------------------------------------------------------------
//  FLORA  (also driven by procedurally generated behaviour trees)
//
//  Plants are not scenery: each one is an organism with biomass, a growth
//  budget, and a tiny tree it ticks a few times a second. Kelp is a verlet
//  stipe that decides each cycle whether to reach for the light, thicken,
//  shed blades or release spores. Coral hosts symbiotic algae that feed it
//  when the light is right, and bleaches when it is not. Barnacle crust and
//  biofilm convert the plankton + nutrient fields into edible biomass on the
//  Wall, which is what the snail pastures and the crab ledges run on.
//
//  Kelp + coral also write into world.cover, the concealment field the
//  perception layer uses — that is why the eel can hide and the minnow
//  shoal survives on the reef.
// ---------------------------------------------------------------------------

import { clamp, clamp01, lerp, damp, TAU, PI, uid } from '../core/vec.js';
import { Rand, fbm1, hash2 } from '../core/rand.js';
import { node, tickTree, registerAction, registerCondition, genTree } from './bt.js';
import { lightAt, ZONES, WORLD_W, WORLD_H } from './zones.js';
import { kelpSuitability, coralSuitability } from './terrain.js';

export const FLORA = {
  kelp: {
    name: 'Bullwhip Kelp', kind: 'kelp', segs: [14, 26], segLen: 15, grazers: 0.55,
    band: [1180, 2620], cover: 0.5, nutrition: 0.5, palette: ['#2f5d24', '#4f8a2f', '#79ad3d'],
    codex: 'Drives from the Z3 outcrop shelves up through Z2; the forest the eels wear.',
  },
  kelpDwarf: {
    name: 'Understrip', kind: 'kelp', segs: [7, 12], segLen: 9, grazers: 0.8,
    band: [700, 1500], cover: 0.32, nutrition: 0.6, palette: ['#35571f', '#5f8a2a'],
    codex: 'Short tough kelp on the Wall bench; first to be cropped by urchins.',
  },
  coral: {
    name: 'Lattice Coral', kind: 'coral', segs: [0, 0], grazers: 0.3,
    band: [430, 860], cover: 0.62, nutrition: 0.35, palette: ['#e8748e', '#f0a35f', '#b56bd6', '#6fd6c8'],
    codex: 'Branching, calcified, patient. Its branches are the minnows\u2019 only real wall.',
  },
  mat: {
    name: 'Sulphur Mat', kind: 'mat', segs: [0, 0], grazers: 0.9,
    band: [2700, 3600], cover: 0.06, nutrition: 0.55, palette: ['#d8c25a', '#a8863c', '#6d5a2a'],
    codex: 'Chemosynthetic skin over the vents: the only primary production in the Abyss.',
  },
  biofilm: {
    name: 'Wall Periphyton', kind: 'biofilm', segs: [0, 0], grazers: 1.0,
    band: [640, 2900], cover: 0.04, nutrition: 0.4, palette: ['#5f7a58', '#7e9464'],
    codex: 'A slime coat on the background rock. Snails farm it, crabs raid the farms.',
  },
  barnacle: {
    name: 'Ring Barnacle', kind: 'barnacle', segs: [0, 0], grazers: 0.7,
    band: [700, 2700], cover: 0.12, nutrition: 0.85, palette: ['#cbd6d8', '#9fb0b5', '#6f8288'],
    codex: 'Sessile filter feeder on every ledge; the calorie bank of the Wall.',
  },
  anemone: {
    name: 'Anvil Anemone', kind: 'anemone', segs: [6, 10], segLen: 6, grazers: 0.2,
    band: [430, 1700], cover: 0.4, nutrition: 0.3, palette: ['#c9547a', '#8e3d7a', '#f0b0c8'],
    codex: 'Stinging columns on the reef lip; minnows nest between the tentacles.',
  },
  worm: {
    name: 'Vent Tube Worm', kind: 'worm', segs: [4, 7], segLen: 11, grazers: 0.25,
    band: [2900, 3600], cover: 0.1, nutrition: 0.4, palette: ['#c8443e', '#e8d9c8'],
    codex: 'Grows a calcified tube over the mat and feeds its bacterial tenant.',
  },
};

// ---------------------------------------------------------------------------
//  flora behaviour trees: growth as a decision
// ---------------------------------------------------------------------------
const F_ACT = Object.create(null);
function fa(n, f, meta = {}) { F_ACT[n] = f; F_ACT[n].meta = meta; registerAction(n, f, meta); }
function fc(n, f) { registerCondition(n, f); }

fa('GrowShoot', (p) => {
  if (p.biomass < 0.12 || p.growth >= 1.02) return 3;
  p.wantLen = Math.min(p.maxLen, p.len + 6);
  p.wantThick = Math.min(1.4, p.thick + 0.03);
  p.growth = clamp01(p.growth + 0.02);
  return 1;
});
fa('GrowFast', (p) => {
  if (p.biomass < 0.2) return 3;
  p.wantLen = Math.min(p.maxLen, p.len + 16);
  p.wantThick = Math.min(1.6, p.thick + 0.06);
  return 1;
});
fa('ReachLight', (p) => {
  const light = lightAt(p.y, p.world.phase);
  p.tropism = clamp(0.15 + light * 1.1 - p.depthBias, -0.5, 1);
  return p.tropism > 0.05 ? 2 : 3;
});
fa('Thicken', (p) => { p.wantThick = Math.min(1.8, p.thick + 0.08); p.growth = clamp01(p.growth + 0.01); return 2; });
fa('Retract', (p) => { p.wantLen = Math.max(p.minLen, p.len * 0.86); p.retreat = 1; return 2; });
fa('ClosePolyp', (p) => { p.open = damp(p.open, 0.1, 1.5, 0.2); return 2; });
fa('OpenPolyp', (p) => {
  p.open = damp(p.open, 1, 1.2, 0.2);
  const gain = p.kind === 'coral' ? 0.02 * clamp01(p.bb.light * (p.symbiont || 0.7)) : 0.012 * p.bb.plankton;
  p.biomass = clamp01(p.biomass + gain);
  return 2;
});
fa('FeedSymbionts', (p) => {
  const light = p.bb.light;
  if (light < 0.18) return 3;
  p.symbiont = clamp01((p.symbiont || 0.6) + 0.05);
  // macroalgae put on tissue fast (real kelp grows tens of cm a day) and can
  // re-leaves even in the dark using stored reserves; corals are slow
  const fast = p.kind === 'kelp' ? 0.05 : p.kind === 'mat' ? 0.035 : 0.014;
  const nut = p.world.nutrients.at(p.x, p.y);
  p.biomass = clamp01(p.biomass + (fast + 0.10 * light + 0.03 * nut) * (p.eaten > 0 ? 1.7 : 1));
  if (p.eaten > 0) p.eaten = Math.max(0, p.eaten - 0.04);
  return 2;
});
fa('Bleach', (p) => {
  p.symbiont = Math.max(0, (p.symbiont || 0.6) - 0.08);
  p.bleached = clamp01((p.bleached || 0) + 0.06);
  return 2;
});
fa('ReleaseSpores', (p, n) => {
  if (p.biomass < 0.45 || p.sporeCd > 0) return 3;
  p.sporeCd = n?.cooldown ?? 30;
  p.world.emitSpores(p, 5 + Math.floor(p.rand.f() * 7));
  return 2;
});
fa('SettleHoldfast', (p) => {
  p.grip = 1;
  p.world.cover.addClamped(p.x, p.y, 0.2, 3);
  return 2;
});
fa('SpreadMat', (p) => {
  if (p.biomass > 0.7 && p.world.flora.length < p.world.cfg.maxFlora) {
    p.world.spawnFlora(p.kind, p.x + p.rand.r(-40, 40), p.y, { from: p });
    p.biomass -= 0.18;
  }
  return 2;
});
fa('TrapGrazer', (p) => {
  const g = p.bb.grazer;
  if (!g) return 3;
  p.world.fx.sting(g.x, g.y);
  g.stamina = Math.max(0, g.stamina - 0.05);
  return 2;
});
fa('SinkSediment', (p) => {
  p.world.nutrients.addClamped(p.x, p.y + 20, 0.01, 6);
  return 2;
});
fa('Idle', () => 1);

fc('BiomassHigh', (p, q) => p.biomass > (q.v ?? 0.6));
fc('BiomassLow', (p, q) => p.biomass < (q.v ?? 0.35));
fc('GrazerNear', (p, q) => !!p.bb.grazer && p.bb.grazerD < (q.r ?? 70));
fc('LightAbove', (p, q) => p.bb.light > (q.v ?? 0.3));
fc('LightBelow', (p, q) => p.bb.light < (q.v ?? 0.12));
fc('NutrientAbove', (p, q) => p.bb.nutrient > (q.v ?? 0.25));
fc('Crowded', (p) => p.bb.neighbors > (p.sp.maxN ?? 6));
fc('OldEnough', (p, q) => p.age > (q.t ?? 20));

/** a small, individual tree per plant */
export function genFloraTree(rand, kind) {
  const branches = [];
  if (kind === 'kelp') {
    branches.push(seqish(rand, [
      con('GrazerNear', { r: rand.r(50, 90) }),
      pick1(rand, [act('Retract'), act('Thicken'), act('SinkSediment')]),
    ]));
    branches.push(seqish(rand, [con('LightAbove', { v: rand.r(0.2, 0.5) }), act('ReachLight'), pick1(rand, [act('GrowFast'), act('GrowShoot')])]));
    branches.push(seqish(rand, [con('NutrientAbove', { v: rand.r(0.15, 0.4) }), act('GrowShoot')]));
    branches.push(seqish(rand, [con('BiomassHigh', { v: rand.r(0.5, 0.8) }), con('OldEnough', { t: rand.r(10, 40) }), act('ReleaseSpores')]));
    branches.push(act('Idle'));
  } else if (kind === 'coral') {
    branches.push(seqish(rand, [con('GrazerNear', { r: rand.r(40, 80) }), act('ClosePolyp')]));
    branches.push(seqish(rand, [con('LightAbove', { v: rand.r(0.3, 0.7) }), pick1(rand, [act('FeedSymbionts'), act('OpenPolyp')])]));
    branches.push(seqish(rand, [con('LightBelow', { v: 0.12 }), act('ClosePolyp'), act('Thicken')]));
    branches.push(seqish(rand, [con('NutrientAbove', { v: rand.r(0.1, 0.3) }), act('GrowShoot')]));
    branches.push(seqish(rand, [con('BiomassLow', { v: rand.r(0.1, 0.3) }), act('Bleach')]));
    branches.push(seqish(rand, [con('OldEnough', { t: rand.r(30, 90) }), act('ReleaseSpores')]));
    branches.push(act('Idle'));
  } else if (kind === 'barnacle' || kind === 'biofilm') {
    branches.push(seqish(rand, [con('NutrientAbove', { v: rand.r(0.1, 0.3) }), pick1(rand, [act('OpenPolyp'), act('GrowShoot')])]));
    branches.push(seqish(rand, [con('GrazerNear', { r: 60 }), act('ClosePolyp')]));
    branches.push(seqish(rand, [con('BiomassHigh', { v: 0.65 }), act('SpreadMat')]));
    branches.push(act('Idle'));
  } else {
    branches.push(seqish(rand, [con('NutrientAbove', { v: rand.r(0.12, 0.35) }), pick1(rand, [act('GrowShoot'), act('SpreadMat')])]));
    branches.push(seqish(rand, [con('GrazerNear', { r: 80 }), act('Thicken')]));
    branches.push(seqish(rand, [con('BiomassHigh', { v: 0.7 }), act('ReleaseSpores')]));
    branches.push(act('Idle'));
  }
  const root = node('sel', 'growth', {}, branches);
  assignDepth(root, 0);
  return root;
  function act(n) { return node('act', n, {}); }
  function con(n, p) { return node('con', n, p || {}); }
  function seqish(rand2, kids) { return node(rand2.chance(0.25) ? 'sel' : 'seq', 'metabolism', {}, kids.filter(Boolean)); }
  function pick1(rand2, kids) { return node('sel', 'strategy', {}, kids); }
}
function assignDepth(n, d) { n.depth = d; for (const c of n.children) assignDepth(c, d + 1); }

// ---------------------------------------------------------------------------
export function makeFlora(world, kind, x, y, opts = {}) {
  const sp = FLORA[kind] || FLORA.kelp;
  const rand = new Rand(((opts.seed ?? uid()) * 2654435761) >>> 0);
  const p = {
    id: uid(), kind: sp.kind, variant: kind, sp, world,
    x, y, plane: opts.plane ?? 0,
    age: 0, growth: opts.growth ?? rand.r(0.25, 0.95), biomass: opts.biomass ?? rand.r(0.35, 0.9),
    thick: rand.r(0.7, 1.2), wantThick: 1, open: rand.f(), grip: 1, retreat: 0,
    symbiont: kind === 'coral' ? rand.r(0.5, 0.9) : 0, bleached: 0,
    sporeCd: rand.r(0, 25), palIdx: rand.i(0, Math.max(0, sp.palette.length - 1)),
    tropism: 0.4, pulse: 0, open: rand.f(), wantLen: 0, eaten: 0,
    lean: rand.r(-0.55, 0.55), depthBias: rand.r(0, 0.4),
    seed: rand.seed, rand,
    bt: genFloraTree(rand, sp.kind),
    bb: { light: 0.5, nutrient: 0, plankton: 0, grazer: null, grazerD: 1e9, neighbors: 0 },
    pts: [], blades: [], branches: [], cells: null,
    eaten: 0, t: rand.r(0, 10), tickEvery: 0.42 + rand.r(0, 0.5),
    shade: rand.r(0.75, 1.15),
  };
  const band = sp.band;
  const segLen = sp.segLen || 12;
  p.minLen = sp.segs[0] * segLen * 0.35;
  p.maxLen = sp.segs[1] * segLen * lerp(0.6, 1.35, rand.f());
  p.len = clamp(p.maxLen * (0.35 + p.growth * 0.7), p.minLen, 560) || p.minLen;
  p.wantLen = p.len;
  p.nSeg = Math.round(lerp(sp.segs[0], sp.segs[1], clamp01(p.growth))) || 0;

  if (sp.kind === 'kelp') {
    // verlet stipe: anchored holdfast, buoyant nodes, current-driven sway
    const n = Math.max(4, p.nSeg);
    p.segLen = sp.segLen * rand.r(0.85, 1.15);
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const px = x + Math.sin(t * 2 + p.lean) * 10 * t;
      const py = y - t * p.len;
      p.pts.push({ x: px, y: py, px, py, r: 1.6 + (1 - t) * 1.4 });
    }
    p.blades = [];
    for (let i = 2; i <= n; i += 1) {
      if (rand.chance(0.72)) p.blades.push({ i, side: rand.chance(0.5) ? 1 : -1, w: rand.r(7, 15), l: rand.r(14, 26), ph: rand.r(0, TAU) });
    }
  } else if (sp.kind === 'coral') {
    buildCoral(p, rand);
  } else if (sp.kind === 'anemone' || sp.kind === 'worm') {
    const n = Math.max(3, Math.round(lerp(sp.segs[0], sp.segs[1], p.growth)));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const px = x + Math.sin(t * 1.6 + p.lean) * 3;
      const py = y - t * (p.len * 0.5);
      p.pts.push({ x: px, y: py, px, py, r: 2 + (1 - t) * 2 });
    }
    if (sp.kind === 'anemone') {
      p.tentacles = [];
      const tn = 6 + rand.i(0, 6);
      for (let k = 0; k < tn; k++) {
        const a = -PI * 0.9 + (k / (tn - 1)) * PI * 0.8;
        p.tentacles.push({ a, l: rand.r(9, 20), ph: rand.r(0, TAU) });
      }
    }
  } else if (sp.kind === 'mat' || sp.kind === 'biofilm') {
    p.r = rand.r(26, 74) * (0.6 + p.growth);
    p.blobs = Array.from({ length: 9 }, (_, k) => ({ a: (k / 9) * TAU + rand.r(-0.2, 0.2), d: rand.r(0.55, 1), r: rand.r(6, 18) }));
  } else if (sp.kind === 'barnacle') {
    p.r = rand.r(6, 13);
    p.cluster = Array.from({ length: 3 + rand.i(0, 5) }, () => ({ dx: rand.r(-16, 16), dy: rand.r(-9, 9), r: rand.r(3.4, 7), open: rand.f() }));
  }
  return p;
}

function buildCoral(p, rand) {
  p.branches = [];
  const grow = (x, y, ang, len, depth, width) => {
    const n = 2 + (depth < 2 ? 1 : 0);
    const pts = [{ x, y }];
    let cx = x, cy = y, a = ang;
    for (let s = 0; s < n; s++) {
      a += rand.r(-0.42, 0.42);
      const l = len / n;
      cx += Math.cos(a) * l; cy += Math.sin(a) * l;
      pts.push({ x: cx, y: cy, w: width * (1 - s / (n + 1)), tip: s === n - 1 });
    }
    p.branches.push({ pts, depth, hue: rand.f() });
    if (depth < 3) {
      const forks = depth === 0 ? 3 : rand.chance(0.75) ? 2 : 1;
      for (let k = 0; k < forks; k++) {
        const end = pts[pts.length - 1];
        grow(end.x, end.y, a + rand.r(-0.95, 0.95), len * 0.68, depth + 1, width * 0.66);
      }
    }
  };
  grow(p.x, p.y, -PI / 2 + rand.r(-0.2, 0.2), 26 + 58 * p.growth, 0, 6 + 5 * p.growth);
  p.r = 18 + 46 * p.growth;
}

// ---------------------------------------------------------------------------
export function stepFlora(p, dt, world) {
  p.t += dt;
  p.age += dt;
  p.sporeCd = Math.max(0, p.sporeCd - dt);
  const sp = p.sp;

  // --- physics: kelp / anemone columns sway with the flow ----------------
  const pts = p.pts;
  if (pts.length > 1) {
    const cur = world.currentAt(p.x, p.y, p.t);
    const buoy = (p.kind === 'kelp' ? 0.055 : 0.02) * (0.6 + (p.tropism || 0));
    for (let i = 1; i < pts.length; i++) {
      const q = pts[i];
      const vx = (q.x - q.px) * 0.985;
      const vy = (q.y - q.py) * 0.985;
      q.px = q.x; q.py = q.y;
      q.x += vx + (cur.x * 2.2 + Math.sin(p.t * 0.8 + i * 0.6) * 0.06) * dt * 60 * 0.06;
      q.y += vy - buoy * dt * 60;
    }
    // pin the holdfast, then relax the chain to the wanted length
    pts[0].x = p.x; pts[0].y = p.y;
    const seg = (p.segLen || 12) * clamp(0.7 + p.thick * 0.4, 0.6, 1.6);
    for (let it = 0; it < 3; it++) {
      pts[0].x = p.x; pts[0].y = p.y;
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        let dx = b.x - a.x, dy = b.y - a.y;
        const l = Math.hypot(dx, dy) || 1e-6;
        const diff = (l - seg) / l;
        if (i === 1) { b.x -= dx * diff; b.y -= dy * diff; }
        else { b.x -= dx * diff * 0.5; b.y -= dy * diff * 0.5; a.x -= dx * diff * 0.5; a.y -= dy * diff * 0.5; }
        // keep it growing "up"
        if (b.y > a.y + 2) b.y = a.y + 2;
      }
    }
    p.len = (pts.length - 1) * seg;
    // collision with rock so kelp drapes over the outcrop instead of through it
    const plane = world.terrain.plane(p.plane);
    for (let i = 2; i < pts.length; i++) {
      const q = pts[i];
      const r = plane.resolve(q.x, q.y, 2.2, _fr);
      if (r.hit) { q.x = r.x; q.y = r.y; }
    }
    p.tip = pts[pts.length - 1];
    p.topY = p.tip.y;
  }

  // --- decisions -----------------------------------------------------------
  p._tick = (p._tick || 0) - dt;
  if (p._tick <= 0) {
    p._tick = p.tickEvery * (p.lod ? 3 : 1);
    const bb = p.bb;
    bb.light = lightAt(p.y, world.phase);
    bb.nutrient = world.nutrients.at(p.x, p.y);
    bb.plankton = world.plankton.at(p.x, p.y);
    // grazers sniffing this plant
    bb.grazer = null; bb.grazerD = 1e9;
    const near = world.queryCreatures(p.x, p.y, 90);
    for (const o of near) {
      if (!o.alive) continue;
      if ((o.sp.flora || []).includes(p.kind) || (o.sp.flora || []).includes(sp.kind)) {
        const d = Math.hypot(o.x - p.x, o.y - p.y);
        if (d < bb.grazerD) { bb.grazerD = d; bb.grazer = o; }
      }
      if (o.key === p.kind) bb.neighbors++;
    }
    tickTree(p.bt, p, p.tickEvery);
    // passive fluxes: growth from the water, respiration always
    const g = sp.kind === 'coral' ? 0.02 * bb.light * (p.symbiont || 0) : sp.kind === 'mat' ? 0.016 * (0.3 + bb.nutrient) : 0.014 * (0.2 + bb.light * 0.8) * (0.3 + bb.plankton);
    p.biomass = clamp01(p.biomass + g - 0.006 - p.eaten * 0.02);
    p.eaten = Math.max(0, p.eaten - 0.3);
    if (p.biomass < 0.05) p.dying = (p.dying || 0) + 1; else p.dying = 0;
    // length follows growth
    const wantLen = p.wantLen || p.len;
    p.len = damp(p.len, wantLen, 0.4, p.tickEvery);
    p.thick = damp(p.thick, p.wantThick || 1, 0.5, p.tickEvery);
    if (p.kind === 'coral') p.r = 18 + 46 * p.growth + p.biomass * 12;
    if (p.kind === 'kelp' && p.pts.length > 3) {
      const want = Math.round(clamp(p.len / (p.segLen || 12), 4, sp.segs[1]));
      while (p.pts.length - 1 < want) {
        const a = p.pts[p.pts.length - 1];
        p.pts.push({ x: a.x, y: a.y - (p.segLen || 12), px: a.x, py: a.y - (p.segLen || 12), r: 1.6 });
        if (p.rand.chance(0.6)) p.blades.push({ i: p.pts.length - 1, side: p.rand.chance(0.5) ? 1 : -1, w: p.rand.r(7, 15), l: p.rand.r(14, 26), ph: p.rand.r(0, TAU) });
      }
      while (p.pts.length - 1 > want + 1 && p.pts.length > 4) p.pts.pop();
    }
    // concealment contribution
    if (sp.cover > 0.2) {
      const c = sp.cover * (0.35 + p.growth * 0.65);
      world.cover.addClamped(p.x, p.y - p.len * 0.4, c, 3.2);
      if (p.kind === 'kelp') world.cover.addClamped(p.x, p.y - p.len * 0.75, c * 0.7, 3.2);
    }
  }
  return p.dying > 6;
}
const _fr = { hit: 0, x: 0, y: 0, nx: 0, ny: 0 };

/** remove edible mass; returns how much the eater actually got */
export function takeFlora(p, amount) {
  const avail = Math.min(p.biomass, amount);
  if (avail <= 0) return 0;
  p.biomass -= avail;
  p.eaten += amount * 3;
  if (p.kind === 'coral') p.symbiont = Math.max(0, (p.symbiont || 0) - amount * 0.4);
  p.growth = clamp01(p.growth - amount * 0.12);
  return avail;
}

/**
 * Populate the world. Flora is planted in HABITAT CLUSTERS (a patch of kelp, a
 * coral head, a mat around a vent) rather than uniformly, which is what makes
 * a forest look like a forest and gives the food web real geography: animals
 * have to travel between patches.
 */
export function seedFlora(world, rand, density = 1) {
  const T = world.terrain;
  const P = T.plane(0);
  const Z = ZONES;
  const CLUSTERS = [
    // kind        patches  per-patch  depth band              plane
    ['kelp',        26, [5, 11], [Z[2].top + 20, Z[2].bottom - 60], 0],
    ['kelp',        10, [3, 7],  [Z[1].top + 260, Z[1].bottom - 60], 0],
    ['kelpDwarf',   14, [3, 8],  [Z[0].bottom - 60, Z[1].top + 420], 0],
    ['coral',       34, [3, 9],  [T.SEGMENTS[0].y - 140, T.SEGMENTS[0].y + 420], 0],
    ['anemone',     16, [1, 4],  [T.SEGMENTS[0].y - 60, Z[1].top + 220], 0],
    ['barnacle',    30, [2, 6],  [Z[1].top + 40, Z[2].bottom - 40], 0],
    ['biofilm',     34, [3, 8],  [Z[1].top, Z[2].bottom], 0],
    ['biofilm',     22, [3, 9],  [Z[1].top, Z[2].bottom], 1],
    ['barnacle',    14, [2, 5],  [Z[1].top, Z[2].bottom], 1],
    ['mat',         22, [3, 7],  [Z[3].top + 120, WORLD_H - 60], 0],
    ['worm',        14, [2, 5],  [Z[3].top + 160, WORLD_H - 80], 0],
  ];
  let made = 0;
  for (const [kind, patches, per, band, plane] of CLUSTERS) {
    const n = Math.round(patches * density);
    for (let k = 0; k < n; k++) {
      const cnt = rand.i(per[0], per[1]);
      const cx = rand.r(220, WORLD_W - 220);
      for (let j = 0; j < cnt; j++) {
        const spot = habitatSpot(world, plane, band, cx + rand.r(-140, 140), j * 7);
        if (!spot) continue;
        if (world.flora.length >= world.cfg.maxFlora) return made;
        world.spawnFlora(kind, spot.x, spot.y, { plane });
        made++;
      }
    }
  }
  // the vents must have mats, and the ledges must have crust — that is what the
  // wall snails and the crabs graze on
  for (const v of T.vents) {
    for (let k = 0; k < 6; k++) {
      const x = v.x + rand.r(-150, 150);
      world.spawnFlora('mat', x, P.surfaceY(x), {});
      made++;
    }
  }
  for (const L of T.ledges) {
    if (L.y < Z[1].top || L.y > Z[2].bottom) continue;
    const n = Math.round((L.x1 - L.x0) / 210);
    for (let k = 0; k < n; k++) {
      const x = lerp(L.x0, L.x1, rand.f());
      world.spawnFlora(rand.chance(0.45) ? 'barnacle' : 'biofilm', x, L.y - 3, {});
      made++;
    }
  }
  for (const L of T.bgLedges) {
    const n = Math.round((L.x1 - L.x0) / 150);
    for (let k = 0; k < n; k++) {
      const x = lerp(L.x0, L.x1, rand.f());
      world.spawnFlora(rand.chance(0.5) ? 'biofilm' : 'barnacle', x, L.y - 3, { plane: 1 });
      made++;
    }
  }
  return made;
}

/** walk outward from x until we find rock whose top sits inside the band */
function habitatSpot(world, plane, band, x, salt = 0) {
  const P = world.terrain.plane(plane);
  for (let k = 0; k < 14; k++) {
    const sx = clamp(x + (k % 2 ? 1 : -1) * k * 46 + Math.sin(salt + k) * 22, 40, WORLD_W - 40);
    const sy = P.surfaceY(sx);
    if (sy <= band[0] || sy >= band[1]) continue;
    if (plane === 0 && world.terrain.inCave(sx, sy)) continue;
    if (plane === 0 && world.terrain.solidAt(sx, sy - 3)) continue;
    const slope = Math.abs(world.terrain.plane(plane).slopeAt(sx, sy));
    if (slope > 1.35) continue;
    return { x: sx, y: sy - 1 };
  }
  return null;
}
