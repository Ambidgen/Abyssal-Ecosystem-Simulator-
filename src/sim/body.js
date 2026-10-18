// ---------------------------------------------------------------------------
//  SEGMENTED HARDBODY PHYSICS
//
//  Every organism — 3 px minnow or 600 px leviathan — is a chain of rigid
//  plates integrated with position-based Verlet. Nothing is skinned or
//  keyframed: the animals move because their muscles bend the spine and the
//  water resists that bend asymmetrically (high normal drag, low tangential
//  drag) which produces real undulatory thrust. Every limb is its own little
//  articulated chain solved independently each step:
//
//    fin / tentacle / antenna : verlet + passive lag   (fluid follows the body)
//    leg                      : gait phase -> ray cast at the rock -> 2-bone IK
//    mandible / claw          : analytic IK toward a strike target
//
//  Terrain is the same for swimmers and climbers, so a crab can walk a ledge,
//  cling face-on to a vertical cliff, or scuttle across the background wall.
// ---------------------------------------------------------------------------

import { clamp, clamp01, lerp, angDelta, TAU, PI, damp } from '../core/vec.js';
import { lightAt, pressureAt, WORLD_W, WORLD_H } from './zones.js';

const SUB = 3;          // constraint iterations
const FOOT_CAST = 1;    // extra foot-cast attempts on miss

export function createBody(plan, x, y, angle = 0, scale = 1) {
  const n = plan.seg;
  const pts = new Array(n);
  const ring = !!plan.ring;
  const taper = plan.taper || defaultTaper(n);
  const spacing = plan.spacing * scale;
  if (ring) {
    // closed chitinous ring (jelly bell, urchin test): a hard body whose shape
    // is held by a radial spring and driven by a volumetric pulse
    const R = (plan.radius || 6) * 2.1 * scale;
    for (let i = 0; i < n; i++) {
      const a = angle + (i / n) * TAU;
      const px = x + Math.cos(a) * R, py = y + Math.sin(a) * R;
      pts[i] = { x: px, y: py, px, py, r: Math.max(1.6, (plan.pointR || 2.6) * scale), m: 1, a, glow: 0, shellT: 0 };
    }
    const dist = new Float32Array(n);
    const side = 2 * R * Math.sin(PI / n);
    for (let i = 0; i < n; i++) dist[i] = side;
    const body = {
      pts, dist, n, ring: true, baseR: R, ringR: R, scale, plan,
      rest: new Float32Array(n).fill(TAU / n),
      bend: new Float32Array(n), muscle: new Float32Array(n),
      wavePhase: Math.random() * TAU, pulsePhase: Math.random() * TAU,
      angle, angVel: 0, speed: 0, fwd: 0, turnWant: 0,
      thrust: 0, thrustTarget: 0, gaitPhase: 0, support: 0,
      normal: { x: 0, y: -1 }, limbs: [], contact: 0, kinetic: 0,
      cx: x, cy: y,
    };
    buildLimbs(body, plan);
    return body;
  }
  let px = x, py = y;
  for (let i = 0; i < n; i++) {
    const r = (plan.radius || 6) * taper[i] * scale;
    pts[i] = {
      x: px, y: py, px, py, r,
      m: plan.mass === 'joint' ? 1 : 1 + taper[i] * 0.6,
      // plate angle relative to the spine, used by the renderer
      a: angle,
      glow: 0,
      shellT: 0,   // contact/shell flash
    };
    px -= Math.cos(angle) * spacing * (i === 0 ? 0.4 : 1) * (0.85 + taper[i] * 0.3);
    py -= Math.sin(angle) * spacing * (i === 0 ? 0.4 : 1) * (0.85 + taper[i] * 0.3);
  }
  const dist = new Float32Array(Math.max(0, n - 1));
  for (let i = 0; i < n - 1; i++) dist[i] = spacing * (0.85 + taper[i] * 0.3);
  const rest = plan.restBend ? Float32Array.from(plan.restBend) : new Float32Array(n);
  const body = {
    pts, dist, rest,
    n, scale, plan,
    bend: new Float32Array(n),
    muscle: new Float32Array(n),
    wavePhase: Math.random() * TAU,
    angle, angVel: 0,
    speed: 0, fwd: 0, turnWant: 0,
    thrust: 0, thrustTarget: 0,
    gaitPhase: 0,
    support: 0,           // 0 swimming .. 1 standing on something
    normal: { x: 0, y: -1 },
    limbs: [],
    contact: 0,
    kinetic: 0,
  };
  buildLimbs(body, plan);
  return body;
}

function defaultTaper(n) {
  const t = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1 || 1);
    // blunt head, widest third of the way back, long tapering tail
    t[i] = 0.42 + 0.58 * Math.sin(Math.pow(clamp01(u * 1.06 + 0.02), 0.72) * PI * 0.86) * 1.15;
  }
  t[0] = Math.max(t[0], 0.86);
  return t;
}

// ---------------------------------------------------------------------------
// limbs
export function buildLimbs(body, plan) {
  const scale = body.scale;
  body.limbs = [];
  const defs = plan.limbs || [];
  for (const d of defs) {
    const count = d.count || 1;
    for (let k = 0; k < count; k++) {
      const t = count === 1 ? 0.5 : k / (count - 1);
      let seg;
      if (d.seg === 'tail') seg = body.n - 1;
      else if (d.seg === undefined || d.seg === null) seg = Math.round(lerp(0, body.n - 1, t));
      else if (typeof d.seg === 'number') seg = d.seg;
      else seg = Math.round(lerp(d.seg[0], d.seg[1], t));
      const sides = d.side === 'both' ? [-1, 1] : [d.side ?? 1];
      for (const side of sides) {
        body.limbs.push(makeLimb(body, d, side, k, clamp(seg, 0, body.n - 1), scale));
      }
    }
  }
}

function makeLimb(body, def, side, index, seg, scale) {
  const len = (def.len || [8, 8]).map((v) => v * scale);
  const anchor = body.pts[seg];
  const kind = def.kind || 'fin';
  const L = {
    kind, side, index, seg, def,
    len,
    // points: [hip, mid, tip] (hip is the shared spine point, so store from 1)
    pts: [],
    base: def.base !== undefined ? def.base : (kind === 'leg' ? 0.95 : 0.55),
    amp: (def.amp ?? 0.5) * (kind === 'leg' ? 1 : 1),
    freq: def.freq ?? 1,
    phase: (def.phase ?? 0) + index * (def.phaseStep ?? (TAU / Math.max(1, (def.count || 1) * 2))) + (side < 0 ? PI : 0),
    stiffness: def.stiffness ?? 0.5,
    drag: def.drag ?? (kind === 'tentacle' ? 0.94 : 0.86),
    active: def.active ?? (kind !== 'leg'),
    gait: def.gait ?? 'tripod',
    reach: (def.reach ?? 26) * scale,
    buoy: def.buoy ?? (kind === 'tentacle' ? -0.012 : kind === 'fin' ? -0.006 : 0.01),
    foot: { x: anchor.x + side * 6, y: anchor.y, planted: false, age: 0, slide: 0 },
    target: null,
    strike: 0,
    open: 1,
    quality: 1,
    drive: 0,
  };
  const dir = anchor.a === undefined ? 0 : anchor.a;
  const outward = dir + side * L.base;
  let px = anchor.x + Math.cos(outward) * 2, py = anchor.y + Math.sin(outward) * 2;
  for (let i = 0; i < len.length; i++) {
    const a = outward + (i === 0 ? 0 : 0);
    px += Math.cos(a) * len[i] * 0.4;
    py += Math.sin(a) * len[i] * 0.4;
    L.pts.push({ x: px, y: py, px, py, r: Math.max(0.7, (def.r ?? 1.8) * scale * (1 - i * 0.22)) });
  }
  return L;
}

/** where the limb joins the body (interpolated hip position) */
function hipOf(body, L, out) {
  const a = body.pts[L.seg];
  const b = body.pts[Math.min(body.n - 1, L.seg + 1)];
  const ang = a.a;
  const off = (body.pts[L.seg].r * 0.55);
  out.x = a.x + Math.cos(ang + PI / 2) * off * L.side;
  out.y = a.y + Math.sin(ang + PI / 2) * off * L.side;
  out.a = ang;
  out.r = a.r;
  return out;
}

// ---------------------------------------------------------------------------
//  main step
// ---------------------------------------------------------------------------
export function stepBody(c, dt, world) {
  const b = c.body;
  const terrain = world.terrain.plane(c.plane || 0);
  const plan = b.plan;
  const P0 = c.sp.phys;

  // --- intent -> motor ---------------------------------------------------
  b.thrust = damp(b.thrust, b.thrustTarget, 7, dt);
  const light = lightAt(c.y, world.phase);
  const pressure = pressureAt(c.y);
  const P = P0;

  // Depth compresses gas-filled organs, so an animal's buoyant weight grows as
  // it sinks. A lung shark with an empty lung is simply heavier than water and
  // has to swim or drop into the dark.
  const compression = 1 + P.compressible * (pressure - 1) * 0.02;
  const air = c.air === undefined ? 1 : c.air;
  const density = P.lung
    ? P.density * (1 + (1 - air) * 0.15 + (compression - 1) * 0.55)
    : P.density * lerp(1, compression, 0.4);
  let weight = (density - 1) * (P.weightGain ?? 1400);
  // Abyssal fauna have no gas bladder to cheat with: away from their pressure
  // they simply lose lift and sink back. This is the physical half of the
  // leviathan holding its line — the behavioural half is in its tree.
  const ceiling = c.sp.yCeil;
  // Tuned so that the loss of lift is stronger than a desperate stroke but far
  // short of a free-fall: ~120 px/s^2 a few hundred pixels above the line.
  if (ceiling !== undefined && c.y < ceiling) {
    let ballast = Math.min(700, (ceiling - c.y) * 0.25);
    // ...but it must not be sucked onto the seabed: an animal lying on rock has no
    // water beneath it to displace, so the sink has to ease off or it grinds there
    // forever. Losing lift near the floor is what lets it lift off and leave.
    if (c.y > world.terrain.plane(c.plane).surfaceY(c.x) - c.radius * 2.4) ballast *= 0.28;
    weight += ballast;
  }
  c.density = density;
  const dt2 = dt * dt;

  for (let i = 0; i < b.n; i++) {
    const p = b.pts[i];
    let vx = (p.x - p.px) * P.inertia;
    let vy = (p.y - p.py) * P.inertia;
    // buoyant weight (px/s^2 integrated Verlet-style)
    vy += weight * dt2;
    // Pressure homeostasis, applied to every segment rather than to the body as a
    // whole: an abyssal animal has no bladder to trade depth with, so the shallow
    // water above its band physically resists it. This is what keeps the leviathan
    // on its line instead of drifting up over the reef and being stranded there.
    if (ceiling !== undefined && p.y < ceiling) vy += (ceiling - p.y) * 3.2 * dt2;
    // fluid entrainment: viscosity drags the body toward the local flow
    const cur = world.currentAt(p.x, p.y, c.t);
    const entr = P.entrain ?? 0.028;
    vx += (cur.x / 60 - vx) * entr;
    vy += (cur.y / 60 - vy) * entr;
    p.px = p.x; p.py = p.y;
    p.x += vx; p.y += vy;
  }

  // --- anisotropic water drag (this is what makes them swim) -------------
  applyWaterDrag(b, P);

  // --- muscle wave (spines) or volumetric pulse (rings) -------------------
  const thrust = b.thrust;
  const waveN = plan.waveNumber ?? 0.8;
  const amp = (plan.waveAmp ?? 0.5) * thrust;
  b.wavePhase += dt * (plan.waveFreq ?? 9) * (0.35 + thrust * 1.5);
  if (b.ring) {
    // a bell contracts sharply then relaxes: jet propulsion with no animation
    b.pulsePhase += dt * (plan.pulseFreq ?? 2.4) * (0.45 + thrust * 1.9);
    const contract = Math.max(0, Math.sin(b.pulsePhase));
    const extra = Math.min(1, c.pulse || 0);
    b.ringR = b.baseR * (1 - 0.34 * contract - 0.22 * extra) * (0.94 + 0.06 * Math.sin(b.wavePhase * 0.5));
    for (let i = 0; i < b.n; i++) b.muscle[i] = Math.sin(b.wavePhase - i * (plan.waveNumber ?? 0.4)) * amp * 0.35;
  } else {
    const turnBias = clamp(b.turnWant, -1, 1) * (plan.turnBend ?? 0.42);
    for (let i = 1; i < b.n - 1; i++) {
      const u = i / (b.n - 1);
      const envelope = plan.headStiff ? clamp01((u - plan.headStiff) / (1 - (plan.headStiff ?? 0))) : 1;
      b.muscle[i] = Math.sin(b.wavePhase - i * waveN) * amp * envelope + turnBias * (0.35 + u * 0.9) * (0.25 + thrust * 0.75);
    }
  }

  // --- constraints --------------------------------------------------------
  for (let it = 0; it < SUB; it++) {
    solveDistance(b);
    if (b.ring) solveRing(b); else solveBend(b, it === 0);
  }
  updatePlateAngles(b);

  // --- speed governor: keeps BT "thrust" meaningful without breaking the look
  const head = b.pts[0];
  const v = { x: head.x - head.px, y: head.y - head.py };
  const fwd = v.x * Math.cos(b.angle) + v.y * Math.sin(b.angle);
  b.fwd = fwd / dt;
  b.speed = Math.hypot(v.x, v.y) / dt;
  const want = (c.wantSpeed || 0);
  const err = want - fwd / dt;
  const walkLike = c.mode === 'walk' || c.mode === 'cling';
  if (Math.abs(err) > 1) {
    const push = clamp(err, -P.maxAccel * dt, P.maxAccel * dt) * dt * (walkLike ? 0.16 : 0.4);
    const cx = Math.cos(b.angle) * push, cy = Math.sin(b.angle) * push;
    for (let i = 0; i < b.n; i++) {
      const w = i === 0 ? 1 : 0.45;
      b.pts[i].x += cx * w; b.pts[i].y += cy * w;
    }
  }

  // --- limbs ---------------------------------------------------------------
  b.gaitPhase += dt * (plan.gaitFreq ?? 5.2) * (0.25 + Math.min(2, Math.abs(c.wantSpeed || 0) / Math.max(1, c.cruise || 40)));
  stepLimbs(c, b, terrain, dt, world);

  // --- climbers are hauled along by their planted feet (real locomotion) ---
  if (walkLike) {
    let fx = 0, fy = 0, fn = 0;
    for (let li = 0; li < b.limbs.length; li++) {
      const L = b.limbs[li];
      if (L.kind !== 'leg' || !L.foot.planted) continue;
      fx += L.foot.x; fy += L.foot.y; fn++;
    }
    if (fn > 0) {
      fx /= fn; fy /= fn;
      let dx = fx - b.pts[0].x, dy = fy - b.pts[0].y;
      const d = Math.hypot(dx, dy);
      if (d > 1) {
        const step = Math.min(d, (P.cruise || 30) * dt * 1.1);
        const ux = dx / d * step, uy = dy / d * step;
        for (let i = 0; i < b.n; i++) { b.pts[i].x += ux * 0.3; b.pts[i].y += uy * 0.3; }
      }
    }
    // grip: planted feet arrest sliding, so a climber only moves when it steps
    const grip = fn > 0 ? (c.mode === 'cling' ? 0.66 : 0.4) : 0.03;
    if (grip > 0.05) {
      for (let i = 0; i < b.n; i++) {
        const p = b.pts[i];
        p.px += (p.x - p.px) * grip;
        p.py += (p.y - p.py) * grip;
      }
    }
  }

  // --- collision -----------------------------------------------------------
  let support = 0, contact = 0;
  const rv = world._rv || (world._rv = {});
  for (let i = 0; i < b.n; i++) {
    const p = b.pts[i];
    const res = terrain.resolve(p.x, p.y, p.r + 1, rv);
    if (res.hit) {
      p.x = res.x; p.y = res.y;
      // friction: kill the velocity component into the surface + some tangent
      const dx = p.x - p.px, dy = p.y - p.py;
      const into = dx * res.nx + dy * res.ny;
      if (into < 0) { p.px += into * res.nx * 1.05; p.py += into * res.ny * 1.05; }
      p.px = lerp(p.px, p.x, P.groundFriction * 0.35);
      p.py = lerp(p.py, p.y, P.groundFriction * 0.35);
      support += 1;
      contact = Math.max(contact, Math.min(1, -into * 0.4 + 0.2));
      p.shellT = Math.max(p.shellT, Math.min(1, -into * 0.12));
      if (!res.nx && !res.ny) { }
    }
  }
  b.support = support / b.n;
  b.contact = contact;
  // keep the whole animal inside the world
  for (let i = 0; i < b.n; i++) {
    const p = b.pts[i];
    if (p.y < 60 + p.r) { p.y = 60 + p.r; p.py = Math.max(p.py, p.y); }
    if (p.y > WORLD_H - 6) { p.y = WORLD_H - 6; p.py = Math.min(p.py, p.y); }
    if (p.x < 6) p.x = 6; else if (p.x > WORLD_W - 6) p.x = WORLD_W - 6;
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) respawnPoint(p, c);
  }

  // --- climber adhesion: pull the body onto the surface it is scaling -----
  if (c.mode === 'cling') {
    const cl = world._cl || (world._cl = {});
    terrain.clearance(head.x, head.y, cl);
    const want2 = 10 + b.pts[1]?.r * 0.2;
    if (cl.d > want2 + 6) {
      const pull = Math.min(cl.d - want2, 14);
      for (let i = 0; i < b.n; i++) { b.pts[i].x -= cl.nx * pull * 0.55; b.pts[i].y -= cl.ny * pull * 0.55; }
    } else if (cl.d < -2) {
      for (let i = 0; i < b.n; i++) { b.pts[i].x += cl.nx * 4; b.pts[i].y += cl.ny * 4; }
    }
  }
  b.kinetic = Math.min(1, b.speed / (P.cruise * 2.2));
}

function respawnPoint(p, c) {
  p.x = c.x; p.y = c.y; p.px = p.x; p.py = p.y;
}

function applyWaterDrag(b, P) {
  const n = b.n, pts = b.pts;
  const kN = P.dragNormal, kT = P.dragTangent;
  for (let i = 0; i < n - 1; i++) {
    const a = pts[i], c2 = pts[i + 1];
    let tx = c2.x - a.x, ty = c2.y - a.y;
    const l = Math.hypot(tx, ty) || 1;
    tx /= l; ty /= l;
    const nx = -ty, ny = tx;
    const vx = ((a.x - a.px) + (c2.x - c2.px)) * 0.5;
    const vy = ((a.y - a.py) + (c2.y - c2.py)) * 0.5;
    const vn = vx * nx + vy * ny;
    const vt = vx * tx + vy * ty;
    const fx = -(nx * vn * kN + tx * vt * kT) * 0.5;
    const fy = -(ny * vn * kN + ty * vt * kT) * 0.5;
    a.px -= fx; a.py -= fy;
    c2.px -= fx; c2.py -= fy;
  }
  // head point also needs its own damping (it has only one neighbour)
  const h = pts[0];
  h.px += (h.x - h.px) * kT * 0.4;
  h.py += (h.y - h.py) * kT * 0.4;
}

export function centroidOf(b, out) {
  let x = 0, y = 0;
  for (let i = 0; i < b.n; i++) { x += b.pts[i].x; y += b.pts[i].y; }
  out.x = x / b.n; out.y = y / b.n;
  return out;
}

/** radial spring that keeps a ring a ring (hard shell), at the pulse radius */
function solveRing(b) {
  const pts = b.pts, n = b.n;
  const cen = centroidOf(b, _cen);
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    let dx = p.x - cen.x, dy = p.y - cen.y;
    const d = Math.hypot(dx, dy) || 1e-6;
    const k = (d - b.ringR) / d * 0.55;
    p.x -= dx * k; p.y -= dy * k;
  }
}

function solveDistance(b) {
  const pts = b.pts, d0 = b.dist;
  const last = b.ring ? pts.length : pts.length - 1;
  for (let i = 0; i < last; i++) {
    if (b.ring && i === pts.length - 1) {
      // closing constraint of the loop
      const a2 = pts[pts.length - 1], c2 = pts[0];
      let dx2 = c2.x - a2.x, dy2 = c2.y - a2.y;
      const l2 = Math.hypot(dx2, dy2) || 1e-6;
      const diff2 = (l2 - d0[i]) / l2 * 0.5;
      a2.x += dx2 * diff2; a2.y += dy2 * diff2;
      c2.x -= dx2 * diff2; c2.y -= dy2 * diff2;
      continue;
    }
    const a = pts[i], c = pts[i + 1];
    let dx = c.x - a.x, dy = c.y - a.y;
    let l = Math.hypot(dx, dy);
    if (l < 1e-6) { dx = 0.001; l = 0.001; }
    const diff = (l - d0[i]) / l * 0.5;
    a.x += dx * diff; a.y += dy * diff;
    c.x -= dx * diff; c.y -= dy * diff;
  }
}

function solveBend(b, record) {
  const pts = b.pts, n = b.n;
  const k = b.plan.bendStiff ?? 0.34;
  for (let i = 1; i < n - 1; i++) {
    const a = pts[i - 1], o = pts[i], c = pts[i + 1];
    const a1 = Math.atan2(o.y - a.y, o.x - a.x);
    const a2 = Math.atan2(c.y - o.y, c.x - o.x);
    const cur = angDelta(a1, a2);
    const target = b.rest[i] + (b.muscle[i] || 0);
    const err = clamp(angDelta(cur, target), -1.2, 1.2) * k;
    if (record) b.bend[i] = cur;
    // rotate the outer points about the joint in opposite directions
    rotateAbout(a, o, err * 0.5);
    rotateAbout(c, o, -err * 0.5);
  }
  if (record) { b.bend[0] = 0; b.bend[n - 1] = 0; }
}

function rotateAbout(p, o, ang) {
  if (ang === 0) return;
  const s = Math.sin(ang), c = Math.cos(ang);
  const dx = p.x - o.x, dy = p.y - o.y;
  p.x = o.x + dx * c - dy * s;
  p.y = o.y + dx * s + dy * c;
  // verlet stores velocity as a position pair, so the previous position has to
  // turn with the body — otherwise a kinematic steer invents velocity out of
  // nothing and the carcase shoots away from the rotation
  if (p.px !== undefined) {
    const ex = p.px - o.x, ey = p.py - o.y;
    p.px = o.x + ex * c - ey * s;
    p.py = o.y + ex * s + ey * c;
  }
}

function updatePlateAngles(b) {
  const pts = b.pts, n = b.n;
  if (b.ring) {
    const cen = centroidOf(b, _cen2);
    const apex = pts[0];
    b.angle = Math.atan2(apex.y - cen.y, apex.x - cen.x);
    b.cx = cen.x; b.cy = cen.y;
    b.x = cen.x; b.y = cen.y;
    for (let i = 0; i < n; i++) {
      pts[i].a = Math.atan2(pts[i].y - cen.y, pts[i].x - cen.x);
      pts[i].r = Math.max(1.6, (b.plan.pointR || 2.6) * b.scale);
    }
    return;
  }
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)], c = pts[Math.min(n - 1, i + 1)];
    const ang = Math.atan2(c.y - a.y, c.x - a.x);
    if (i === 0) b.angle = ang + PI;      // heading = head->neck reversed
    pts[i].a = i === 0 ? ang + PI : ang;
  }
  // heading should point from neck to head
  const h = pts[0], nk = pts[Math.min(1, n - 1)];
  b.angle = Math.atan2(h.y - nk.y, h.x - nk.x);
  b.x = h.x; b.y = h.y;
}

/** kinematic steering: rotate the whole carcase about its head */
export function steerBody(b, dAngle, rate, dt) {
  const max = rate * dt;
  const d = clamp(dAngle, -max, max);
  if (Math.abs(d) < 1e-5) return;
  const h = b.ring ? centroidOf(b, _cen3) : b.pts[0];
  b.angVel = d / dt;
  for (let i = b.ring ? 0 : 1; i < b.n; i++) rotateAbout(b.pts[i], h, d);
  for (const L of b.limbs) {
    for (const p of L.pts) rotateAbout(p, h, d);
  }
}

// ---------------------------------------------------------------------------
//  limbs: three solvers
// ---------------------------------------------------------------------------
export function stepLimbs(c, b, terrain, dt, world) {
  const mode = c.mode;
  const limbs = b.limbs;
  // Off-screen animals skip the expensive IK; their bodies still integrate, so
  // they stay physically believable without spending the frame budget.
  const skip = c.lod >= 2 ? 1 : 0;
  const stride = c.lod === 0 ? 1 : 2;
  for (let li = 0; li < limbs.length; li++) {
    const L = limbs[li];
    if (skip) continue;
    if (stride === 2 && L.kind === 'leg' && (L.index & 1)) { continue; }
    if (L.kind === 'leg') stepLeg(c, b, L, terrain, dt, mode);
    else if (L.kind === 'mandible' || L.kind === 'claw') stepJaw(c, b, L, dt);
    else stepPassive(b, L, dt, c);
  }
}

/** passive chains: fins, tentacles, antennae — verlet with drag + muscle */
function stepPassive(b, L, dt, c) {
  const hip = _hip;
  hipOf(b, L, hip);
  const thrust = b.thrust;
  const P = L.pts;
  const activeAmp = L.amp * (0.3 + thrust * 1.5);
  let px = hip.x, py = hip.y;
  for (let i = 0; i < P.length; i++) {
    const p = P[i];
    // inertia + fluid damping (these trails are pure physics, not animation)
    const vx = (p.x - p.px) * L.drag;
    const vy = (p.y - p.py) * L.drag + L.buoy * dt * dt * 3400;
    p.px = p.x; p.py = p.y;
    p.x += vx; p.y += vy;
    // active flutter: a wave travelling outward along the limb
    if (L.active) {
      const a = hip.a + (PI / 2) * L.side + Math.sin(b.wavePhase * L.freq + L.phase - i * 0.75) * activeAmp;
      const k = 0.42 * thrust * (i + 1) * 0.4;
      p.x += Math.cos(a) * k;
      p.y += Math.sin(a) * k;
    }
    // keep the chain inextensible
    let dx = p.x - px, dy = p.y - py;
    let l = Math.hypot(dx, dy) || 1e-6;
    const rest = L.len[i];
    const diff = (l - rest) / l;
    p.x -= dx * diff * (i === 0 ? 1 : 0.6);
    p.y -= dy * diff * (i === 0 ? 1 : 0.6);
    if (i > 0) {
      const q = P[i - 1];
      q.x += dx * diff * 0.22; q.y += dy * diff * 0.22;
    }
    px = p.x; py = p.y;
  }
}

/**
 * ONE leg of an 8-legged climber. The foot is not animated: we aim a ray at
 * the rock (biased by the local relief so the gait picks real holds), cast it,
 * then stick the foot to that point for the stance phase and swing it for the
 * rest. Works identically on a flat ledge, a vertical cliff or a ceiling, and
 * on the background wall plane.
 */
function stepLeg(c, b, L, terrain, dt, mode) {
  const hip = _hip;
  hipOf(b, L, hip);
  const cling = mode === 'cling';

  // ---- gait clock (advanced once per frame in stepBody) -------------------
  const count = Math.max(1, c.legCount || (L.def.count || 4));
  const cyc = (b.gaitPhase + L.phase) % TAU;
  const stance = cyc > PI * 0.42;             // ~68% of the cycle the foot is loaded

  // ---- where should this foot go? ---------------------------------------
  //  walk:  legs fan fore->aft around "down" (down = against the rock normal)
  //  cling: legs radiate all the way around the carapace, in the screen plane
  let downAng;
  if (cling) {
    downAng = b.angle + PI / 2;
  } else {
    const cl = terrain.clearance(hip.x, hip.y, _cl);
    downAng = Math.atan2(-cl.ny, -cl.nx);
    b.upAngle = downAng + PI;
  }
  const k = (L.index + (L.side < 0 ? 0.5 : 0)) / count;         // 0..1 along body
  const spread = (k - 0.5) * (cling ? TAU * 0.46 : 1.55);
  const swing = Math.cos(cyc) * (L.def.stride ?? (cling ? 0.5 : 0.8));
  const aimAng = cling
    ? (L.side < 0 ? downAng + PI : downAng) + spread * 2.15 + swing * 0.34
    : downAng + spread + swing * 0.55;
  const reach = L.reach * (cling ? 1.1 : 1) * (1 + 0.12 * Math.sin(cyc * 2));

  const aim = terrain.footAim
    ? terrain.footAim(hip.x, hip.y, Math.cos(aimAng), Math.sin(aimAng), reach, L.index + (L.side < 0 ? 16 : 0))
    : { dx: Math.cos(aimAng), dy: Math.sin(aimAng), len: reach, quality: 1 };
  let cast = terrain.cast(hip.x, hip.y, aim.dx, aim.dy, Math.max(12, aim.len), _cast);
  // a missed cast on a big step: try again with a couple of fallback angles
  if (!cast.hit) {
    for (let f = 1; f <= FOOT_CAST * 2; f++) {
      const a2 = aimAng + (f % 2 ? 1 : -1) * 0.4 * Math.ceil(f / 2);
      cast = terrain.cast(hip.x, hip.y, Math.cos(a2), Math.sin(a2), Math.max(12, aim.len * 1.25), _cast);
      if (cast.hit) break;
    }
  }
  let fx, fy, canPlant;
  if (cast.hit) {
    fx = cast.x; fy = cast.y;
    canPlant = true;
  } else {
    // no rock within reach: leg hangs/paddles at full extension
    fx = hip.x + aim.dx * aim.len; fy = hip.y + aim.dy * aim.len;
    canPlant = false;
  }
  const grounded = cling ? true : b.support > 0.015;
  const planted = canPlant && stance && grounded;

  const F = L.foot;
  if (planted) {
    // stick: the foot only creeps while loaded (gives the scuttle its weight)
    F.x = damp(F.x, fx, 1.6, dt);
    F.y = damp(F.y, fy, 1.6, dt);
  } else {
    F.x = damp(F.x, fx, 15, dt);
    F.y = damp(F.y, fy, 15, dt);
  }
  F.planted = planted;
  F.age = planted ? F.age + dt : 0;
  L.ground = canPlant;

  solveChainIK(b, L, hip, F.x, F.y);
}


/** analytic multi-bone IK, knee/elbow pushed to the natural side */
function solveChainIK(b, L, hip, tx, ty) {
  const P = L.pts;
  const bendDir = L.side > 0 ? 1 : -1;
  let bx = hip.x, by = hip.y;
  for (let i = 0; i < P.length; i++) {
    const seg = L.len[i];
    const p = P[i];
    let dx = tx - bx, dy = ty - by;
    const d = Math.hypot(dx, dy);
    if (i === P.length - 1) {
      // last bone: land on target (clamped to reachable)
      const l = Math.max(1e-4, d);
      p.x = bx + (dx / l) * Math.min(seg, l);
      p.y = by + (dy / l) * Math.min(seg, l);
      break;
    }
    // next joint: bisect toward target with a sideways pop for joint curvature
    const rest = seg;
    const nx = dx / (d || 1), ny = dy / (d || 1);
    const wob = clamp01(1 - d / (rest * 2.2)) * 0.55;
    const px = -ny * bendDir, py = nx * bendDir;
    const tx2 = bx + nx * rest * (1 - wob * 0.35) + px * rest * wob;
    const ty2 = by + ny * rest * (1 - wob * 0.35) + py * rest * wob;
    const l2 = Math.max(1e-4, Math.hypot(tx2 - bx, ty2 - by));
    p.x = bx + ((tx2 - bx) / l2) * rest;
    p.y = by + ((ty2 - by) / l2) * rest;
    bx = p.x; by = p.y;
  }
}

/** mandibles / claws: spring-loaded strike toward c.strikeTarget */
function stepJaw(c, b, L, dt) {
  const hip = _hip2;
  hipOf(b, L, hip);
  const P = L.pts;
  const t = c.strikeT || 0;
  const closing = L.def.close ?? 0.22;
  const openAmt = clamp01(1 - t);
  let aim;
  if (c.strikeTarget && t > 0.02) {
    aim = { x: c.strikeTarget.x, y: c.strikeTarget.y };
  } else {
    // rest pose: slightly open, wobbling with the body wave
    const a = hip.a + L.side * (0.35 + openAmt * 0.75) + Math.sin(b.wavePhase * 0.7 + L.index) * 0.09;
    const total = L.len.reduce((s, v) => s + v, 0) * closing * (0.4 + openAmt);
    aim = { x: hip.x + Math.cos(a) * (L.reach * 0.9 + total * 0.2), y: hip.y + Math.sin(a) * (L.reach * 0.9 + total * 0.2) };
  }
  // reach target with a spring so strikes are fast and precise
  L.tx = damp(L.tx ?? aim.x, aim.x, t > 0.02 ? 26 : 8, dt);
  L.ty = damp(L.ty ?? aim.y, aim.y, t > 0.02 ? 26 : 8, dt);
  solveChainIK(b, L, hip, L.tx, L.ty);
}

// scratch objects (no per-frame allocation)
const _hip = { x: 0, y: 0, a: 0, r: 0 };
const _hip2 = { x: 0, y: 0, a: 0, r: 0 };
const _flow = { x: 0, y: 0 };
const _cast = { hit: false, t: 0, x: 0, y: 0, nx: 0, ny: 0 };
const _cast2 = { d: 0, nx: 0, ny: 0, which: 0 };
const _cl = { d: 0, nx: 0, ny: 0, which: 0 };
const _cen = { x: 0, y: 0 };
const _cen2 = { x: 0, y: 0 };
const _cen3 = { x: 0, y: 0 };

/** geometric centre of the animal (used for perception + rendering + predation) */
export function bodyCenter(b, out) {
  let x = 0, y = 0;
  for (let i = 0; i < b.n; i++) { x += b.pts[i].x; y += b.pts[i].y; }
  out.x = x / b.n; out.y = y / b.n;
  return out;
}
/** overall length in px */
export function bodyLength(b) {
  const h = b.pts[0], t = b.pts[b.n - 1];
  return Math.hypot(h.x - t.x, h.y - t.y) + h.r * 2;
}
export { defaultTaper };
