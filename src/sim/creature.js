// ---------------------------------------------------------------------------
//  CREATURES
//
//  Blackboard (written by `sense()`, read by the tree):
//    threat / prey / food / carrion / mate / shelter  -> entity + dist + dir
//    crowd (same-species count), light, zoneMismatch, desperation, air
//
//  Actions only ever write INTENT:
//    c.wantHeading, c.wantSpeed, c.target, c.strikeTarget, c.mode, c.glowWant
//  `motor()` then converts intent into spine muscle amplitude, steering torque
//  and limb mode, and body.js resolves it against water + rock. Predation is
//  resolved here too, because a bite needs the limb geometry to be in reach.
// ---------------------------------------------------------------------------

import { clamp, clamp01, lerp, angDelta, damp, dist2, TAU, PI, uid } from '../core/vec.js';
import { Rand, mixSeed } from '../core/rand.js';
import { genTree, tickTree, registerAction, registerCondition } from './bt.js';
import { SPECIES, PREDATORS_OF } from './species.js';
import { createBody, stepBody, steerBody, bodyCenter } from './body.js';
import { ZONES, WORLD_W, WORLD_H, lightAt, pressureAt, zoneIndexAt, LEVIATHAN_LINE } from './zones.js';

const S_R = 1, S_OK = 2, S_NO = 3;

// ---------------------------------------------------------------------------
export function makeCreature(world, key, x, y, opts = {}) {
  const sp = SPECIES[key];
  const seed = opts.seed ?? ((world.seed ^ mixSeed(uid(), key.length * 977)) >>> 0);
  const rand = new Rand(seed);
  const scale = opts.scale ?? lerp(sp.scale[0], sp.scale[1], rand.f());
  const plane = opts.plane ?? (sp.planes ? sp.planes[0] : 0);
  const angle = opts.angle ?? rand.r(-PI, PI);
  const body = createBody(sp.plan, x, y, angle, scale);
  const c = {
    id: uid(), key, sp, seed, rand, scale,
    x, y, plane,
    mode: opts.mode || (plane === 1 ? 'cling' : (sp.mode0 || (sp.plan.physMode || (sp.prey.length || sp.carrion > 0.5 ? 'swim' : 'swim')))),
    body,
    radius: sp.size * scale * 0.5,
    mass: sp.size * scale * (sp.massScale || 1),
    t: opts.t ?? rand.r(0, 40),
    age: opts.age ?? 0,
    growth: opts.growth ?? lerp(0.78, 1, rand.f()),
    hunger: opts.hunger ?? clamp01(rand.r(0.42, 0.95)),
    health: opts.health ?? clamp01(rand.r(0.72, 1)),
    stamina: 1, air: 1,
    homeZone: sp.zone, zone: zoneIndexAt(y),
    zoneStress: 0,
    nest: opts.nest ? { x: opts.nest.x, y: opts.nest.y } : { x, y },
    territory: sp.nestR * lerp(0.7, 1.4, rand.f()),
    alive: true, deathT: 0, cause: null,
    // intent
    wantHeading: angle, wantSpeed: 0, target: null, targetType: null,
    strikeTarget: null, strikeT: 0, biteCd: 0, glowWant: 0, glow: 0,
    camo: 0, seal: 0, brace: 0, fear: 0, trauma: 0,
    burstT: 0, coolT: 0, restT: 0, latchT: 0,
    alarm: 0, mobT: 0, hungerMode: 0,
    legCount: (sp.plan.limbs.find((l) => l.kind === 'leg') || { count: 0 }).count * 2,
    // ai
    bt: null, intent: '—', intentT: 0, tickN: 0,
    bb: freshBoard(),
    lastSense: -1, senseEvery: 0.11 + rand.r(0, 0.05),
    reproduceCd: sp.reproduce === false ? 1e9 : rand.r(0, sp.reproduce.cd * 0.7),
    courtT: 0, courtCall: 0, courtP: null,
    eggs: 0, kills: 0, meals: 0, distance: 0,
    lod: 0, stuckT: 0, lastX: x, lastY: y, detour: 0, detourT: 0,
    flash: 0, wound: 0, symbiont: 0,
    hatcheryId: opts.hatcheryId ?? null,
    _v: { x: 0, y: 0 },
  };
  c.mode = sp.canCling ? (opts.mode || 'walk') : (plane === 1 ? 'cling' : 'swim');
  if (key === 'snail' || key === 'urchin') c.mode = opts.mode || (plane === 1 ? 'cling' : 'walk');
  // unique behaviour tree: the whole point of the generator
  c.bt = genTree(rand, sp.bt, c);
  c.name = `${sp.name} #${c.id.toString(36).toUpperCase().slice(-4)}`;
  return c;
}

function freshBoard() {
  return {
    threat: null, threatD: 1e9, threatX: 0, threatY: 0, threatN: 0,
    prey: null, preyD: 1e9, preyX: 0, preyY: 0, preyN: 0,
    food: null, foodD: 1e9, foodX: 0, foodY: 0, foodN: 0,
    carrion: null, carrionD: 1e9, carrionX: 0, carrionY: 0,
    mate: null, mateD: 1e9, mateX: 0, mateY: 0, mateScore: 1e9,
    shelter: null, shelterD: 1e9, shelterX: 0, shelterY: 0,
    light: 0.5, crowd: 0, near: 0, desperate: 0, mismatch: 0,
    glitter: null, glitterD: 1e9,
    minnowHerd: 0,
  };
}

// ---------------------------------------------------------------------------
//  perception
// ---------------------------------------------------------------------------
export function sense(c, world) {
  const sp = c.sp, b = c.bb, sen = sp.senses;
  const y = c.y, x = c.x;
  const light = lightAt(y, world.phase);
  b.light = light;
  b.zone = c.zone;
  const pressure = pressureAt(y);
  c.zoneStress = zoneStress(c, y, pressure, light);
  b.mismatch = c.zoneStress;
  b.desperate = clamp01(1 - c.hunger / 0.45) * (c.hunger < 0.45 ? 1 : 0.2);

  // effective range: light, medium turbidity, and the sense modality
  let R = sen.range * c.scale * (0.55 + c.growth * 0.55);
  if (sen.mode === 'visual') R *= 0.3 + 0.85 * Math.pow(light, 0.55);
  else if (sen.mode === 'contact') R *= 1;
  else if (sen.mode === 'vibration') R *= 0.72 + 0.3 * (1 - light);
  else if (sen.mode === 'bio') R *= 0.55 + 0.75 * (1 - light) + 0.35 * world.turbid(y);
  R = clamp(R, 40, 900);
  b.R = R;

  b.threat = null; b.threatD = 1e9; b.threatN = 0;
  b.prey = null; b.preyD = 1e9; b.preyN = 0; b.preyVal = 0;
  b.mate = null; b.mateD = 1e9; b.crowd = 0; b.near = 0; b.mateScore = 1e9;
  b.glitter = null; b.glitterD = 1e9;
  b.minnowHerd = 0;

  const fear = world.fear.at(x, y);
  const list = world.queryCreatures(x, y, R);
  const fov = sen.fov;
  const heading = c.body.angle;
  for (let i = 0; i < list.length; i++) {
    const o = list[i];
    if (o === c || !o.alive) continue;
    if (o.plane !== c.plane && o.key !== 'leviathan' && c.key !== 'leviathan') {
      // the background wall is a different depth; only the leviathan notices
      // things crossing the light line, and glow is visible through murk
      if (!(o.glow > 0.25 && sen.glowBoost)) continue;
    }
    const dx = o.x - x, dy = o.y - y;
    const d2v = dx * dx + dy * dy;
    if (d2v > R * R) continue;
    const d = Math.sqrt(d2v);
    // field of view (soft) — blind behind, unless it is a big disturbance
    const ang = Math.atan2(dy, dx);
    let fovW = 1;
    if (fov < TAU - 0.01) {
      const off = Math.abs(angDelta(heading, ang));
      fovW = clamp01((fov * 0.5 + 0.55) - off) / (fov * 0.5 + 0.55);
    }
    let vis = visibility(o, world, d, R);
    const motion = Math.min(1, o.body.speed / 90);
    vis *= 0.42 + 0.58 * motion * (sen.motionBoost || 1) + 0.16;
    if (o.glow > 0.12) vis *= 1 + (sen.glowBoost || 0) * o.glow * 2.4;
    if (sen.ampullae && o.key === 'crab') vis *= 1.25;
    const detect = vis * fovW;
    if (detect < (sen.stillBlind ? 0.3 : 0.22)) continue;
    b.near++;
    if (o.key === c.key) {
      b.crowd++;
      if (d < b.mateD && o.growth > 0.75 && o.hunger > 0.34) { b.mateD = d; b.mate = o; b.mateX = o.x; b.mateY = o.y; }
      continue;
    }
    const isThreat = (c.sp.fleeFrom || []).includes(o.key) || (PREDATORS_OF[c.key] || []).includes(o.key);
    // An abyssal specialist does not treat the shallows as a hunting ground: its
    // pressure band *is* its foraging map. Without this the leviathan chases a
    // drifting carcass up on top of the reef and then loses a minute of its life
    // climbing back off it — which is what actually happened, in the test log.
    const offLimits = sp.yCeil !== undefined && o.y < sp.yCeil - 320;
    const canEat = !offLimits && (sp.prey || []).includes(o.key) && o.growth > 0.18;
    if (isThreat && detect > 0.35) {
      b.threatN++;
      if (d < b.threatD || (o.sp.apex && d < b.threatD * 2.2)) {
        b.threatD = d; b.threat = o; b.threatX = o.x; b.threatY = o.y;
      }
      if (o.sp.apex) { b.threatD = Math.min(b.threatD, d); }
    }
    if (canEat && (sp.apex || true)) {
      b.preyN++;
      const val = (o.sp.nutrition || 8) * o.growth * (o.sp.apex ? 4 : 1);
      const cost = d / (1 + b.desperate);
      if (val / (cost + 22) > (b.preyVal || 0)) {
        b.prey = o; b.preyD = d; b.preyX = o.x; b.preyY = o.y; b.preyVal = val / (cost + 22);
      }
      if (o.key === 'minnow') b.minnowHerd++;
    }
    // glowing things attract the curious in the dark
    if (o.glow > 0.35 && light < 0.25 && d < b.glitterD) { b.glitterD = d; b.glitter = o; }
  }
  b.preyVal = b.prey ? b.preyVal : 0;

  // food: flora + plankton + carrion
  b.food = null; b.foodD = 1e9; b.foodN = 0;
  const wantFlora = sp.flora || [];
  if (wantFlora.length) {
    const fl = world.queryFlora(x, y, R * 0.9, c.plane);
    for (const p of fl) {
      if (!wantFlora.includes(p.kind)) continue;
      if (p.biomass < 0.12) continue;
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < b.foodD) { b.foodD = d; b.food = p; b.foodX = p.x; b.foodY = p.y; }
      b.foodN++;
    }
  }
  if (wantFlora.includes('plankton')) {
    const pk = world.plankton.at(x, y);
    if (pk > 0.12 && pk * 900 < b.foodD) { b.foodD = pk * 300; b.food = { kind: 'plankton', x: x + (b.preyX - x) * 0, y, biomass: pk, patch: true }; b.foodX = x; b.foodY = y; }
  }
  b.carrion = null; b.carrionD = 1e9;
  if ((sp.carrion || 0) > 0.05) {
    const ca = world.queryCarrion(x, y, R * 1.6);
    for (const k of ca) {
      const d = Math.hypot(k.x - x, k.y - y);
      if (sp.yCeil !== undefined && k.y < sp.yCeil - 320) continue;   // see the note in the prey loop
      if (d < b.carrionD) { b.carrionD = d; b.carrion = k; b.carrionX = k.x; b.carrionY = k.y; }
    }
  }
  // shelter: cave / coral / kelp
  b.shelter = null; b.shelterD = 1e9;
  const sh = sp.shelter;
  if (sh) {
    for (const p of world.queryFlora(x, y, R * 2.1, c.plane)) {
      const wsh = sh[p.kind];
      if (!wsh) continue;
      const d = Math.hypot(p.x - x, p.y - y) / wsh;
      if (d < b.shelterD) { b.shelterD = d; b.shelter = p; b.shelterX = p.x; b.shelterY = p.y; }
    }
  }
  if (sp.lair || c.key === 'crab' || c.key === 'crawler' || c.key === 'angler') {
    const kind = c.key === 'crab' ? 'hatchery' : null;
    const cv = world.terrain.nearestCave(x, y, kind, R * 4.5);
    if (cv) {
      const d = Math.hypot(cv.x - x, cv.y - y) * 0.55;
      if (d < b.shelterD) { b.shelterD = d; b.shelter = { cave: cv, x: cv.x, y: cv.y, kind: 'cave' }; b.shelterX = cv.x; b.shelterY = cv.y; }
    }
  }
  if (fear > 0.16) {
    b.threatN += Math.round(fear * 4);
    // a chemical alarm makes everything within the patch treat the cue as a threat
    if (!b.threat && fear > 0.4) { b.threatD = R * 0.7; b.threat = { x, y, key: 'cue', sp: SPECIES.minnow, fake: true }; }
  }
  // leviathan: the abyss net — anything below the Z3 line, no matter how dark
  if (sp.apex) {
    let best = null, bd = 1e9;
    const all = world.creatures;
    for (let k = 0; k < all.length; k++) {
      const o = all[k];
      if (!o.alive || o === c || o.key === 'leviathan') continue;
      if (o.y < LEVIATHAN_LINE - 8) continue;
      if (o.plane === 1) continue;
      const d = dist2(o.x, o.y, x, y);
      if (d < bd) { bd = d; best = o; }
    }
    if (best) {
      b.prey = best; b.preyD = Math.sqrt(bd); b.preyX = best.x; b.preyY = best.y; b.preyN = 1;
      b.preyVal = 40 * (best.sp.nutrition || 10) / (b.preyD + 40);
    }
    b.threat = null;
  }
  // --- water-borne breeding cue ------------------------------------------
  // Conspecifics are smelled as well as seen: a wide, motion-blind ring lets a
  // receptive animal find a partner it could never have picked out in the murk,
  // and an answering courting call pulls that partner in.
  if (c.sp.reproduce !== false && (c.reproduceCd <= 0 || c.courtT > 0)) {
    const ring = world.queryCreatures(x, y, R * 2.2);
    for (let i = 0; i < ring.length; i++) {
      const o = ring[i];
      if (o === c || o.key !== c.key || !o.alive || o.plane !== c.plane) continue;
      const d = Math.hypot(o.x - x, o.y - y);
      if (d > R * 2.2) continue;
      if (o.growth < 0.75 || o.hunger < 0.34) continue;
      if (o.reproduceCd > 0 && o.courtCall <= 0 && o.courtT <= 0) continue;
      const score = d * (o.courtCall > 0 ? 0.3 : o.courtT > 0 ? 0.55 : 1) - (o.display || 0) * 60;
      if (score < b.mateScore) {
        b.mateScore = score; b.mateD = d; b.mate = o; b.mateX = o.x; b.mateY = o.y;
      }
    }
  }
}

/** how visible is `o` to the perceiver — camouflage, cover and murk */
export function visibility(o, world, d, R) {
  let v = clamp01(1 - d / (R * 1.25) * 0.55);
  v *= clamp01(0.32 + o.sp.size * o.scale / 70);
  if (o.camo > 0.02) v *= 1 - o.camo * 0.92;
  if (o.seal > 0.5) v *= 0.55;
  // cover from kelp / coral / cave
  const cover = world.coverAt(o.x, o.y);
  v *= 1 - cover * 0.55;
  if (o.mode === 'cling') v *= 0.7;
  return clamp01(v + 0.08);
}

/** health drain when out of the endemic zone (cold/pressure/light mismatch) */
export function zoneStress(c, y, pressure, light) {
  const home = c.homeZone;
  const z = zoneIndexAt(y);
  if (z === home) return 0;
  const dz = z - home;
  const sp = c.sp;
  let s = Math.abs(dz) * 0.42;
  if (dz > 0) {
    // deeper than home: pressure + cold crush shallow-adapted bodies
    s *= 1 + (pressure - ZONES[home].pressure) * 0.10;
    if (sp.phys.compressible > 1.2) s *= 1.35;      // gas-filled organs suffer most
  } else {
    // shallower: photic damage + desiccation-analogue for abyssal fauna
    s *= 0.8 + light * 1.9;
    if (light > 0.5 && home === 3) s *= 2.1;
    if (sp.zoneUp) s *= sp.zoneUp;
  }
  // eels/kelp species tolerate their neighbours better
  if (sp.tolerance) s *= 1 - sp.tolerance;
  return clamp(s, 0, 3.4);
}

// ---------------------------------------------------------------------------
//  motor: intent -> muscles, steering, gait, buoyancy
// ---------------------------------------------------------------------------
export function motor(c, dt, world) {
  const b = c.body, sp = c.sp, P = sp.phys;
  b.thrustTarget = clamp01(Math.abs(c.wantSpeed) / Math.max(6, P.cruise * (c.growth * 0.6 + 0.55)));
  if (c.burstT > 0) { c.burstT -= dt; b.thrustTarget = 1; }
  if (c.coolT > 0) { c.coolT -= dt; b.thrustTarget = Math.min(b.thrustTarget, 0.24); }
  if (c.seal > 0.4 || (c.mode === 'cling' && Math.abs(c.wantSpeed) < 2 && c.key === 'snail')) b.thrustTarget *= 0.2;

  // --- depth ceiling ------------------------------------------------------
  // An abyssal body cannot simply decide to ascend: the gases and tissues that
  // work at 9 atm fail in the light. So above its ceiling its upward thrust
  // vector is mirrored — it may turn, but it may not climb. Combined with
  // zoneStress this is why the leviathan guards the line instead of patrolling
  // the reef.
  if (sp.yCeil !== undefined && c.y < sp.yCeil + 16 && Math.sin(c.wantHeading) < 0) {
    c.wantHeading = -c.wantHeading;
    if (c.mode === 'swim') b.thrustTarget *= 0.75;
  }

  // turn: walkers turn along the surface, swimmers rotate the whole carcase
  let dh = angDelta(b.angle, c.wantHeading);
  const turnRate = (sp.turn ?? (P.cruise > 90 ? 3.1 : 4.4)) * (0.35 + b.thrust * 0.9) * (c.mode === 'walk' || c.mode === 'cling' ? 2.6 : 1);
  if (Math.abs(dh) > 2.1 && c.mode === 'swim') b.thrustTarget *= 0.55;
  steerBody(b, dh, turnRate, dt);
  b.turnWant = clamp(dh * 0.8, -1, 1);

  // --- ground / wall following -------------------------------------------
  if (c.mode === 'walk' || c.mode === 'cling') {
    const plane = world.terrain.plane(c.plane);
    const cl = plane.clearance(b.pts[0].x, b.pts[0].y, _cl2);
    if (c.mode === 'walk') {
      // align the carapace with the tangent of the surface under it
      const g = plane.groundBelow(b.pts[0].x, b.pts[0].y, 90);
      if (g > 0) {
        const slope = plane.slopeAt(b.pts[0].x, g);
        const wantAng = Math.abs(angDelta(b.angle, slope)) < Math.abs(angDelta(b.angle, slope + PI)) ? slope : slope + PI;
        steerBody(b, angDelta(b.angle, wantAng), 6.5, dt);
        // walk up onto slopes below ~48 deg, otherwise cling instead
        if (Math.abs(slope) > 0.84 && c.sp.canCling) c.mode = 'cling';
      } else if (cl.d > 30) {
        c.mode = 'swim';                    // stepped off the rock: swim/fall
      }
      // gravity keeps it on the ground; the legs do the rest (see body.js)
    } else {
      // cling: face-on to the rock, free movement over the silhouette
      const wantAng = c.wantHeading;
      steerBody(b, angDelta(b.angle, wantAng), 3.4, dt);
    }
  }

  // --- breathing / lung mechanics ----------------------------------------
  if (sp.burst) {
    if (c.burstT > 0) {
      c.stamina = Math.max(0, c.stamina - sp.burst.cost * dt * 1.9);
      c.air = Math.max(0, c.air - sp.burst.cost * dt * 1.4);
    } else {
      c.stamina = Math.min(1, c.stamina + sp.burst.recover * dt * (c.air > 0.25 ? 1 : 0.35));
      c.air = Math.min(1, c.air + 0.008 * dt * (c.zone < 3 ? 1 : 0.4));
    }
    if (c.stamina < 0.06) c.coolT = Math.max(c.coolT, 0.9);
    if (sp.airAt) {
      // an air-breathing predator has to break off the hunt and inflate: that is
      // what keeps the Pyre Lungshark a ambush window instead of a terminator
      const eff = b.thrust < 0.45 ? 0.4 : b.thrust;
      c.air = Math.max(0, c.air - (0.012 + eff * 0.05) * dt);
    }
  } else {
    // sustained bursts are expensive: panic and hard swimming both burn the
    // oxygen reserve, so a chase has an end — prey that runs forever is
    // uncatchable and the food web never resolves.
    const effort = b.thrust < 0.45 ? 0 : (b.thrust - 0.45);
    const panic = c.fear * 0.2 + (c.intent === 'hunt' || c.intent === 'chase' || c.intent === 'sweep' ? 0.13 : 0);
    c.stamina = clamp(c.stamina + (0.17 - effort * 0.5 - panic) * dt, 0, 1);
  }

  // buoyancy trim: pelagic animals hold their band, demersal ones sink
  if (sp.phys.lung) {
    const want = c.air > 0.4 ? -0.004 : 0.012;
    for (let i = 0; i < b.n; i++) b.pts[i].y += want * dt * 60 * (0.4 + b.thrust);
  }

  // glow organs follow intent
  c.glow = damp(c.glow, c.glowWant, 2.6, dt);

  // record motion (used by lateral-line predators + stats)
  const v = c._v;
  v.x = (b.pts[0].x - c.lastX) / Math.max(dt, 1e-4);
  v.y = (b.pts[0].y - c.lastY) / Math.max(dt, 1e-4);
  c.distance += Math.hypot(b.pts[0].x - c.lastX, b.pts[0].y - c.lastY);
  c.speed = Math.hypot(v.x, v.y);
  c.lastX = b.pts[0].x; c.lastY = b.pts[0].y;
  c.x = b.pts[0].x; c.y = b.pts[0].y;
}
const _cl2 = { d: 0, nx: 0, ny: 0, which: 0 };

// ---------------------------------------------------------------------------
//  navigation: reactive pathfinding around rock, biased to safe depth bands
// ---------------------------------------------------------------------------
const CAND = [];
for (let i = -5; i <= 5; i++) CAND.push(i * 0.32);

export function navigate(c, tx, ty, world, speedMul = 1, opts = {}) {
  const b = c.body;
  // hard depth ceiling: abyssal specialists will pursue to the edge of their
  // trench and no further — they hold the line rather than patrol the whole column
  const ceil = c.sp.yCeil;
  if (ceil !== undefined && ty < ceil) ty = ceil;
  const direct = Math.atan2(ty - b.pts[0].y, tx - b.pts[0].x);
  const plane = world.terrain.plane(c.plane);
  let best = direct, bestScore = -1e9;
  const reach = 34 + c.radius * 2.4;
  const needBand = opts.band != null;
  for (let k = 0; k < CAND.length; k++) {
    const a = direct + CAND[k] + c.detour;
    const cast = plane.cast(b.pts[0].x, b.pts[0].y, Math.cos(a), Math.sin(a), reach * (1.2 + Math.abs(CAND[k])), _nav);
    let s = -Math.abs(CAND[k]) * 1.5;
    if (!cast.hit) s += 2.4; else s -= clamp01(1 - cast.t / reach) * 3.2;
    // Vertical effort is costly — but only *unnecessary* vertical effort. If the
    // target is straight below us, diving is the cheap option, so the penalty is
    // measured against what the goal already asks for.
    const dy = Math.sin(a);
    s -= Math.max(0, Math.abs(dy) - Math.abs(Math.sin(direct))) * (opts.band ? 0.35 : 1.15);
    if (needBand) {
      const yAhead = b.pts[0].y + dy * 90;
      const zAhead = zoneIndexAt(yAhead);
      if (zAhead === opts.band) s += 3.4;
      else if (zAhead !== c.homeZone && !opts.desperate) s -= 1.4 * Math.abs(zAhead - c.homeZone);
    }
    if (s > bestScore) { bestScore = s; best = a; }
  }
  c.wantHeading = best;
  const dd = Math.hypot(tx - b.pts[0].x, ty - b.pts[0].y);
  const spd = Math.min(1, dd / 60) * speedMul;
  c.wantSpeed = (c.sp.phys.cruise || 60) * clamp01(spd) * (c.sp.phys.cruise ? 1 : 1) * spdCapped(c);
  // stuck detection -> commit to a detour (this is what makes them round rocks)
  const moved = Math.hypot(b.pts[0].x - (c._px ?? b.pts[0].x), b.pts[0].y - (c._py ?? b.pts[0].y));
  if (moved < 0.35 && c.lod === 0) c.stuckT += 0.05; else c.stuckT = Math.max(0, c.stuckT - 0.02);
  if (c.stuckT > 0.7) { c.detour = (c.rand ? c.rand.r(-1, 1) : Math.random() * 2 - 1) * 1.3; c.detourT = 1.6; c.stuckT = 0; }
  if (c.detourT > 0) { c.detourT -= 0.016; if (c.detourT <= 0) c.detour = 0; }
  c._px = b.pts[0].x; c._py = b.pts[0].y;
  return dd;
}
const _nav = { hit: false, t: 0, x: 0, y: 0, nx: 0, ny: 0 };

/** stamina caps speed; desperate animals still move but slower when spent */
function spdCapped(c) {
  const base = c.burstT > 0 ? 1 : clamp01(0.32 + c.stamina * 0.75);
  return base * (0.7 + c.hunger * 0.35);
}

// ---------------------------------------------------------------------------
//  combat + feeding
// ---------------------------------------------------------------------------
/** live position of the jaw / mandible tip (long bodies bite with their head, not their middle) */
export function mouthOf(c) {
  const m = c.body.mouth;
  if (!m) return { x: c.x, y: c.y };
  const fwd = c.body.head && m === c.body.head ? 1 : (c.body.tail && m === c.body.tail ? -1 : 1);
  const r = plan_jaw_reach(c);
  return { x: m.x + Math.cos(m.a) * r * fwd, y: m.y + Math.sin(m.a) * r * fwd };
}
function plan_jaw_reach(c) {
  return c.radius * 0.6 + (c.key === 'leviathan' ? 46 * c.scale : 4);
}

/** strike range measured from the mouth to any part of the target's body */
export function inReach(c, o, mult = 1) {
  if (!o || o.fake || !o.alive) return false;
  const m = mouthOf(c);
  const r = (reachOf(c) * 0.85 + c.radius * 0.55 + (o.radius || 4) * 0.5) * mult;
  if (o.body) {
    for (let i = 0; i < o.body.n; i++) {
      const p = o.body.pts[i];
      if (dist2(m.x, m.y, p.x, p.y) < r * r) return true;
    }
  }
  return dist2(m.x, m.y, o.x, o.y) < (r + o.radius) * (r + o.radius);
}

export function reachOf(c) {
  return (c.sp.size * c.scale * 0.62) + (c.key === 'leviathan' ? 96 * c.scale : 8);
}

export function tryBite(c, o, world, dt, mult = 1) {
  if (c.biteCd > 0 || !o || o.fake || !o.alive) return false;
  o.radius = o.radius || 4;
  const sp = c.sp;
  const rr = reachOf(c);
  const d = Math.hypot(o.x - c.x, o.y - c.y);
  if (d > rr + o.radius) return false;
  c.biteCd = sp.biteCd ?? (sp.apex ? 0.46 : 0.32);
  c.strikeT = 1;
  c.strikeTarget = { x: o.x, y: o.y };
  world.stats.predation++;
  const armor = o.sp.armor ?? 0;
  const dmg = sp.damage * c.growth * mult * (1 - armor) / Math.max(0.6, o.hpScale || 1);
  hurt(o, dmg, world, c, 'attack');
  // knock-back: an impulse into the victim's chain (this is what makes strikes read)
  const kx = (o.x - c.x) / (d || 1), ky = (o.y - c.y) / (d || 1);
  const imp = (4 + dmg * 0.7) * (sp.apex ? 3.2 : 1) / Math.max(0.5, o.mass * 0.06);
  for (let i = 0; i < o.body.n; i++) {
    const p = o.body.pts[i];
    const w = 1 - i / o.body.n * 0.45;
    p.px -= kx * imp * w; p.py -= ky * imp * w;
    p.flash = 1;
  }
  world.fx.blood(o.x, o.y, Math.min(14, 3 + dmg * 0.5), o.sp.render.body);
  // spines and shells hurt the attacker back
  if (o.sp.spiny) hurt(c, o.sp.spiny * 9 * mult, world, o, 'spine');
  if (o.defense > 0.4 && Math.random() < 0.35) c.stamina = Math.max(0, c.stamina - 0.1);
  if (o.sp.symbiont && o.key === 'minnow') c.stamina = Math.max(0, c.stamina - 0.05);
  if (o.alive && (o.sp.fleeFrom || []).includes(c.key)) o.fear = Math.min(1.6, o.fear + 0.7);
  if (!o.alive) consume(c, o, world);
  return true;
}

export function consume(c, o, world) {
  const gain = (o.sp.nutrition || 12) * o.growth * o.scale * 0.02 / Math.max(0.35, (c.sp.size / 26));
  c.hunger = clamp01(c.hunger + gain * (o.alive ? 1 : 0.8));
  c.health = clamp01(c.health + gain * 0.12);
  c.kills++; c.meals++;
  world.stats.meal(c.key, o.key);
  c.intent = 'consume';
  // leftovers feed the abyss: a partial carcass
  world.spawnCarrion(o.x, o.y, o.mass * 0.55, o.key, true);
}

export function hurt(o, amount, world, by, kind) {
  if (!o.alive) return;
  const dmg = amount / Math.max(0.4, o.sp.hp * (0.6 + o.growth * 0.7));
  o.health -= dmg;
  o.wound = Math.min(1, o.wound + dmg * 1.4);
  o.flash = 1;
  if (kind === 'attack') {
    o.trauma = Math.min(1.4, o.trauma + 0.35);
    if (o.sp.fleeFrom && by && o.sp.fleeFrom.includes(by.key)) o.fear = 1.4;
  }
  if (o.health <= 0) killCreature(o, world, kind === 'starve' ? 'starvation' : kind === 'zone' ? 'zone exposure' : by ? `taken by ${by.sp.name}` : 'injury', by);
}

export function killCreature(o, world, cause, by) {
  if (!o.alive) return;
  o.alive = false;
  o.cause = cause;
  o.deathT = 0;
  world.stats.death(o.key, cause);
  world.spawnCarrion(o.x, o.y, o.mass * 1.15, o.key, false, o);
  world.fx.blood(o.x, o.y, 12, o.sp.render.body);
  // death throes: a burst of muscle the physics resolves into a final thrash
  o.body.thrustTarget = 0;
  o.finalThrust = 1;
  // prey species release an alarm cue; predators do not
  if ((o.sp.fleeFrom || []).length) world.fear.add(o.x, o.y, 1.1);
  if (by) by.target = null;
  if (o.key === 'minnow' || o.key === 'darter') world.log(`${o.sp.name} taken — ${cause}`, o.x, o.y, 'kill');
  if (by && by.sp.apex) world.log(`THE LEVIATHAN TAKES ${o.sp.name.toUpperCase()}`, o.x, o.y, 'apex');
}

// ---------------------------------------------------------------------------
//  ACTIONS  (registered into the BT engine)
// ---------------------------------------------------------------------------
const A = registerAction;
const C = registerCondition;

function toward(c, x, y, mul, opts) { return navigate(c, x, y, c.world, mul, opts); }

A('FleeThreat', (c, n) => {
  const b = c.bb;
  if (!b.threat) return S_NO;
  const tx = b.threat.x, ty = b.threat.y;
  const away = Math.atan2(c.y - ty, c.x - tx);
  const hard = n.params.hard ? 1.35 : 1;
  navigate(c, c.x + Math.cos(away) * 220, c.y + Math.sin(away) * 220, c.world, 1.15 * hard, { desperate: true });
  if (c.sp.flee && c.stamina > 0.25 && b.threatD < (n.params.r ?? 160) * 0.6) c.burstT = Math.max(c.burstT, 0.5);
  c.fear = Math.min(1.6, c.fear + 0.05);
  c.intent = 'flee';
  return b.threatD > (n.params.r ?? 160) * 1.35 ? S_OK : S_R;
}, { r: { min: 90, max: 420 }, patience: { min: 2, max: 6 } });

A('BurstEscape', (c) => {
  if (c.stamina < 0.18) return S_NO;
  c.burstT = Math.max(c.burstT, c.sp.burst ? c.sp.burst.dur : 0.75);
  c.coolT = c.sp.burst ? 1.5 : 0.6;
  const b = c.bb;
  const away = b.threat ? Math.atan2(c.y - b.threat.y, c.x - b.threat.x) : c.wantHeading - PI * 0.35;
  navigate(c, c.x + Math.cos(away) * 260, c.y + Math.sin(away) * 260, c.world, 1.5, { desperate: true });
  c.world.fx.jet(c.x, c.y, away + PI, c.sp.size * c.scale);
  c.intent = 'burst';
  return S_R;
});

A('FreezeHide', (c, n) => {
  c.wantSpeed = 0; c.body.thrustTarget = 0;
  c.camo = Math.min(1, c.camo + 0.08);
  c.intent = 'freeze';
  c.timers = c.timers || {};
  c.timers.freeze = (c.timers.freeze || 0) + 1 / 60;
  if (c.bb.threat && c.bb.threatD < 70) { c.timers.freeze = 0; return c.sp.mode0 === 'swim' ? S_NO : S_OK; }
  if (c.timers.freeze > (n.params.dur ?? 1.6)) { c.timers.freeze = 0; return S_OK; }
  return S_R;
}, { dur: { min: 0.4, max: 4 }, patience: { min: 1, max: 5 } });

A('RetreatToShelter', (c, n) => {
  const b = c.bb;
  if (!b.shelter) return S_NO;
  navigate(c, b.shelter.x, b.shelter.y + (b.shelter.kind === 'cave' ? 0 : 8), c.world, 1.1, { desperate: true });
  c.intent = 'shelter';
  const d = Math.hypot(b.shelter.x - c.x, b.shelter.y - c.y);
  if (d < 44) { c.camo = Math.min(1, c.camo + 0.2); c.health = Math.min(1, c.health + 0.0009); return S_OK; }
  return S_R;
}, { r: { min: 200, max: 900 }, patience: { min: 2.5, max: 7 } });

A('ClingToRock', (c) => {
  if (!c.sp.canCling) return S_NO;
  const plane = c.world.terrain.plane(c.plane);
  const cl = plane.clearance(c.x, c.y, _cl3);
  if (cl.d > 90) {
    navigate(c, c.x - cl.nx * 120, c.y - cl.ny * 120, c.world, 0.9, { band: c.zone });
    c.intent = 'to-rock';
    return S_R;
  }
  c.mode = 'cling';
  c.wantSpeed = 0;
  c.camo = Math.min(1, c.camo + 0.06);
  c.intent = 'cling';
  return S_OK;
});
const _cl3 = { d: 0, nx: 0, ny: 0, which: 0 };

A('AlarmCall', (c) => {
  if (c.alarm > 0) return S_NO;
  c.alarm = 1.4;
  c.world.fear.add(c.x, c.y, c.sp.social?.n ? 0.55 : 0.25);
  c.world.fx.ring(c.x, c.y, '#bff6ff', 30);
  c.intent = 'alarm';
  return S_OK;
});

A('MobPredator', (c) => {
  const b = c.bb;
  if (!b.threat || b.threat.sp.size * b.threat.scale > c.sp.size * 2.4) return S_NO;
  navigate(c, b.threat.x + Math.cos(c.t * 3) * 50, b.threat.y + Math.sin(c.t * 3) * 40, c.world, 1.05);
  c.mobT = 1;
  c.intent = 'mob';
  if (!b.threat.fake && Math.hypot(b.threat.x - c.x, b.threat.y - c.y) < c.sp.size * 0.9) {
    tryBite(c, b.threat, c.world, 1 / 60, 0.35);
    b.threat.fleeCd = 0.5;
  }
  return S_R;
});

// ---- feeding ---------------------------------------------------------------
A('HuntPrey', (c, n) => {
  const b = c.bb;
  if (!b.prey) return S_NO;
  if (b.preyD > (n.params.range ?? 260) * (0.6 + b.desperate * 0.9)) return S_NO;
  const lead = 0.22;
  const tx = b.prey.x + (b.prey._v?.x || 0) * lead, ty = b.prey.y + (b.prey._v?.y || 0) * lead;
  navigate(c, tx, ty, c.world, 1.12 + b.desperate * 0.3, { desperate: b.desperate > 0.4 });
  c.target = b.prey; c.intent = 'hunt';
  c.strikeTarget = b.prey.sp.apex ? null : { x: tx, y: ty };
  if (c.biteCd <= 0 && b.preyD < reachOf(c) * 3.2) {
    c.strikeT = 1;
    if (tryBite(c, b.prey, c.world, 1 / 60, 1)) return S_OK;
  }
  return S_R;
}, { range: { min: 120, max: 900 } });

A('ChasePrey', (c, n) => huntLike(c, n, 1.18, 0.55), { patience: { min: 3, max: 8 } });
A('LungeStrike', (c, n) => {
  const b = c.bb;
  if (!b.prey) return S_NO;
  if (b.preyD < (c.sp.size * c.scale * 3.4 + b.prey.radius)) {
    if (c.stamina > 0.14) { c.burstT = Math.max(c.burstT, 0.28); c.stamina -= 0.09; }
    c.strikeTarget = { x: b.prey.x, y: b.prey.y };
    c.strikeT = 1;
    navigate(c, b.prey.x, b.prey.y, c.world, 1.4);
    if (tryBite(c, b.prey, c.world, 1 / 60, 1.25)) return S_OK;
    return S_R;
  }
  return S_NO;
});
A('BurstChase', (c, n) => {
  const b = c.bb;
  if (!b.prey || c.stamina < 0.22) return S_NO;
  c.burstT = Math.max(c.burstT, c.sp.burst ? c.sp.burst.dur * 0.8 : 0.6);
  c.coolT = c.sp.burst ? c.sp.burst.dur * 1.2 : 0.8;
  return huntLike(c, n, 1.6, 0.9);
});
A('AmbushRise', (c) => {
  const b = c.bb;
  if (!b.prey) return S_NO;
  if (b.preyY < c.y - 40 && b.preyD < 240) {
    c.burstT = Math.max(c.burstT, 0.42);
    navigate(c, b.preyX, b.preyY, c.world, 1.5);
    c.intent = 'rise-strike';
    if (tryBite(c, b.prey, c.world, 1 / 60, 1.3)) return S_OK;
    return S_R;
  }
  return S_NO;
});
A('StalkPrey', (c, n) => {
  const b = c.bb;
  if (!b.prey) return S_NO;
  const d = b.preyD;
  const want = clamp(d - 4, 26, 90);
  const a = Math.atan2(b.preyY - c.y, b.preyX - c.x);
  navigate(c, b.preyX - Math.cos(a) * want, b.preyY - Math.sin(a) * want, c.world, 0.42);
  c.camo = Math.max(c.camo, 0.45);
  c.target = b.prey;
  c.intent = 'stalk';
  if (d < 46) return c.rand.f() < 0.06 ? S_OK : S_R;
  return S_R;
});
A('SnapStrike', (c) => {
  const t = c.bb.prey || c.bb.carrion;
  if (!t) return S_NO;
  c.strikeTarget = { x: t.x, y: t.y };
  if (Math.hypot(t.x - c.x, t.y - c.y) < reachOf(c) + t.radius * 0.8) {
    c.strikeT = 1;
    const o = c.bb.prey;
    if (o && tryBite(c, o, c.world, 1 / 60, 1.1)) return S_OK;
    if (!o && c.bb.carrion) { feedCarrion(c, 1.6); return S_R; }
  }
  navigate(c, t.x, t.y, c.world, 1.05);
  return S_R;
});
A('CrushPrey', (c) => {
  const t = c.bb.prey;
  if (!t) return S_NO;
  if (Math.hypot(t.x - c.x, t.y - c.y) < reachOf(c) + t.radius) {
    if (tryBite(c, t, c.world, 1 / 60, 1.35)) { c.world.fx.click(t.x, t.y); return S_OK; }
  }
  navigate(c, t.x, t.y, c.world, 1);
  c.strikeTarget = { x: t.x, y: t.y };
  return S_R;
});
A('MandibleStrike', (c) => {
  const b = c.bb;
  if (!b.prey) return S_NO;
  const reach = reachOf(c) + 30;
  c.strikeTarget = { x: b.preyX, y: b.preyY };
  if (b.preyD < reach * 3.1) {
    c.strikeT = 1;
    c.glowWant = 1;
    if (c.biteCd <= 0) {
      const o = b.prey;
      // the precise strike: mandibles clamp, then the whole body sweeps it in
      if (tryBite(c, o, c.world, 1 / 60, 1.5)) {
        c.hunger = clamp01(c.hunger + 0.1);
        c.world.log(`leviathan strike on ${o.sp.name}`, c.x, c.y, 'apex');
        return S_OK;
      }
    }
    navigate(c, b.preyX, b.preyY, c.world, 1.25, { desperate: true });
    return S_R;
  }
  return S_NO;
});
A('SweepHunt', (c) => {
  const b = c.bb;
  const t = b.prey;
  if (!t) return S_NO;
  const a = Math.atan2(c.y - t.y, c.x - t.x) + PI;
  c.strikeTarget = { x: t.x, y: t.y };
  c.wantHeading = a;
  c.wantSpeed = (c.sp.phys.cruise || 60) * 0.8 * spdCapped(c);
  c.glowWant = 0.85;
  c.intent = 'sweep';
  if (b.preyD < reachOf(c) * 3.2 && tryBite(c, t, c.world, 1 / 60, 1.1)) return S_OK;
  return S_R;
});
A('ConsumePrey', (c) => {
  const b = c.bb;
  if (!b.prey || b.prey.alive === false) return S_NO;
  if (b.preyD < reachOf(c) * 2.4) {
    const o = b.prey;
    o.health -= 0.6;
    if (o.health <= 0) killCreature(o, c.world, 'eaten by the leviathan', c);
    consume(c, o, c.world);
    return S_OK;
  }
  return S_R;
});
A('SnapAt', (c) => {
  const t = c.bb.prey || c.bb.carrion;
  if (!t) return S_NO;
  c.strikeTarget = { x: t.x, y: t.y };
  c.biteCd = Math.max(c.biteCd, 0.18);
  if (t.alive && tryBite(c, t, c.world, 1 / 60, 0.55)) return S_OK;
  return S_R;
});
A('EnvenomPrey', (c) => {
  const b = c.bb;
  if (!b.prey || b.preyD > c.sp.size * c.scale * 1.1) return S_NO;
  const o = b.prey;
  c.strikeTarget = { x: o.x, y: o.y };
  if (c.biteCd <= 0) {
    c.biteCd = 0.9;
    hurt(o, o.sp.size > 22 ? 3 : 16, c.world, c, 'attack');
    o.fear = 1.2;
    c.world.fx.sting(o.x, o.y);
    if (!o.alive) consume(c, o, c.world);
    return S_OK;
  }
  return S_R;
});
A('DriftIntoPrey', (c) => {
  const b = c.bb;
  if (!b.prey) return S_NO;
  c.glowWant = 0.3;
  driftToward(c, b.preyX, b.preyY, 0.75);
  return S_R;
});
A('Camouflage', (c) => {
  const sp = c.sp;
  if (!sp.camo) return S_NO;
  // stillness + kelp proximity = invisible. Any motion breaks the illusion.
  const still = Math.abs(c.wantSpeed) < 3;
  let nearKelp = false;
  for (const p of c.world.queryFlora(c.x, c.y, 120, c.plane)) if (p.kind === 'kelp' || p.kind === 'anemone') { nearKelp = true; break; }
  const want = still ? (nearKelp ? sp.camo.whileStill : 0.5) : sp.camo.moving;
  c.camo = damp(c.camo, want, 2.2, 1 / 60);
  c.wantSpeed = 0;
  c.mode = 'swim';
  c.body.thrustTarget = 0.02;
  c.intent = 'camouflage';
  return c.camo > 0.7 ? S_OK : S_R;
});
A('CoilAndWait', (c, n) => {
  const b = c.bb;
  c.wantSpeed = 0; c.body.thrustTarget = 0.05;
  c.camo = damp(c.camo, 0.55, 1.6, 1 / 60);
  c.coil = Math.min(1, (c.coil || 0) + 0.02);
  c.intent = 'coil';
  if (b.prey && b.preyD < (n.params.d ?? 90)) { c.timers = c.timers || {}; c.timers.pounce = (c.timers.pounce || 0) + 1 / 60; if (c.timers.pounce > 0.2) { c.timers.pounce = 0; return S_OK; } }
  else c.coil = Math.max(0, (c.coil || 0) - 0.01);
  return S_R;
}, { d: { min: 40, max: 160 } });
A('Pounce', (c) => {
  const b = c.bb;
  if (!b.prey) return S_NO;
  c.burstT = Math.max(c.burstT, 0.42);
  c.strikeTarget = { x: b.preyX, y: b.preyY };
  c.strikeT = 1;
  c.camo = 0;
  navigate(c, b.preyX + (b.prey._v?.x || 0) * 0.12, b.preyY, c.world, 1.75, { desperate: true });
  c.intent = 'pounce';
  c.world.fx.jet(c.x, c.y, c.body.angle + PI, c.sp.size * c.scale * 1.4);
  if (tryBite(c, b.prey, c.world, 1 / 60, 1.5)) return S_OK;
  return S_R;
});
A('LurePrey', (c, n) => {
  const b = c.bb;
  c.glowWant = 1;
  c.lureT = (c.lureT || 0) + 1 / 60;
  if (b.prey && b.preyD < (n.params.d ?? 70)) return S_OK;
  // hold station, drift slightly toward the nearest curious thing
  c.wantSpeed = (c.sp.phys.cruise || 40) * 0.18 * spdCapped(c);
  const tx = b.prey ? b.preyX : c.x + Math.cos(c.t * 0.6) * 40;
  const ty = b.prey ? b.preyY : c.y - 6 + Math.sin(c.t * 0.8) * 10;
  navigate(c, tx, ty - 0, c.world, 0.3);
  c.strikeTarget = b.prey ? { x: b.preyX, y: b.preyY } : null;
  c.intent = 'lure';
  return S_R;
}, { d: { min: 40, max: 140 }, patience: { min: 3, max: 10 } });
A('SitAndLure', (c) => {
  c.wantSpeed = 0; c.glowWant = 1; c.body.thrustTarget = 0.03;
  const plane = c.world.terrain.plane(c.plane);
  const g = plane.groundBelow(c.x, c.y, 240);
  if (g > 0) navigate(c, c.x, g - 24, c.world, 0.5);
  c.intent = 'sit';
  return S_R;
});
A('AmbushStalk', (c, n) => {
  // hold position just outside prey detection, then commit
  const b = c.bb;
  if (!b.prey) return S_NO;
  const keep = clamp(b.preyD, 40, 130);
  const a = Math.atan2(b.preyY - c.y, b.preyX - c.x);
  navigate(c, b.preyX - Math.cos(a) * keep, b.preyY - Math.sin(a) * keep, c.world, 0.5);
  c.camo = Math.max(c.camo, 0.55);
  c.target = b.prey;
  c.strikeTarget = { x: b.preyX, y: b.preyY };
  c.intent = 'ambush';
  if (b.preyD < keep + 24 && c.rand.chance(0.05)) return S_OK;   // let the strike branch take over
  return S_R;
}, { d: { min: 40, max: 200 } });
A('VacuumStrike', (c, n, dt) => {
  // the abyssal predator opens its jaws and inhales: anything close enough gets
  // dragged toward the mouth, which is how it eats things faster than itself
  const b = c.bb;
  let tgt = b.prey;
  let td = b.preyD;
  if (!tgt) {
    for (const o of c.world.abyssNet) {
      if (!o.alive || o === c || o.fake) continue;
      if (o.zone < 3) continue;
      const d = Math.hypot(o.x - c.x, o.y - c.y);
      if (d < td) { tgt = o; td = d; }
    }
  }
  if (!tgt || td > 240) return S_NO;
  motor(c, tgt.x, tgt.y, (c.sp.phys.cruise || 60) * 0.55, dt, 1.1);
  c.intent = 'hunt';
  const pull = clamp01(1 - td / 240) * (tgt.stats.hardbody ? 0.55 : 1) * dt * 46;
  for (let i = 0; i < tgt.body.n; i++) {
    const p = tgt.body.pts[i];
    p.x += (c.x - p.x) * pull * 0.02;
    p.y += (c.y - p.y) * pull * 0.02;
    p.px += (c.x - p.x) * pull * 0.012;
    p.py += (c.y - p.y) * pull * 0.012;
  }
  if (inReach(c, tgt, 1.4)) {
    c.strikeT = 1;
    if (tryBite(c, tgt, c.world, dt, 1.2)) return S_OK;
  }
  return S_R;
}, { patience: { min: 2, max: 6 } });

A('PatrolBoundary', (c) => {
  // the leviathan swims the line at the bottom of Z3 and eats what crosses it
  const line = LEVIATHAN_LINE + 60;
  const y = line + Math.sin(c.t * 0.18 + c.seed) * 150;
  const x = clamp(c.x + Math.cos(c.t * 0.1 + c.seed) * 400, 200, WORLD_W - 200);
  navigate(c, x, y, c.world, 0.62, { desperate: true });
  c.glowWant = 0.55 + 0.35 * Math.sin(c.t * 0.5);
  c.intent = 'patrol-line';
  return S_R;
});
A('DarkenGlow', (c) => { c.glowWant = 0; c.intent = 'dark'; return S_OK; });
A('DimAndSink', (c) => {
  c.glowWant = 0;
  c.wantSpeed = (c.sp.phys.cruise || 50) * 0.4;
  c.wantHeading = PI / 2 + Math.sin(c.t * 0.3) * 0.5;
  c.intent = 'sink';
  return S_R;
});
A('LureDisplay', (c) => {
  c.glowWant = 1;
  c.wantSpeed = (c.sp.phys.cruise || 50) * 0.45;
  const b = c.bb;
  const tx = b.prey ? b.preyX : c.x + Math.cos(c.t * 0.25) * 300;
  const ty = b.prey ? b.preyY : Math.max(LEVIATHAN_LINE + 40, c.y + Math.sin(c.t * 0.2) * 120);
  navigate(c, tx, ty, c.world, 0.55, { desperate: true });
  c.intent = 'display';
  return S_R;
});

// ---- flora feeding ---------------------------------------------------------
A('GrazeSurface', (c, n) => feedFlora(c, n, 1), { r: { min: 120, max: 600 }, patience: { min: 4, max: 12 } });
A('PeckKelp', (c, n) => feedFlora(c, n, 0.9, 'kelp'));
A('BiteCoral', (c, n) => feedFlora(c, n, 0.8, 'coral'));
A('GrazekKelp', (c, n) => feedFlora(c, n, 1.25, 'kelp'));
A('TearKelp', (c, n) => feedFlora(c, n, 1.0, 'kelp'));
A('GrazeBiofilm', (c, n) => feedFlora(c, n, 0.7, 'biofilm'));
A('ScrapeBarnacle', (c, n) => feedFlora(c, n, 1.1, 'barnacle'));
function feedFlora(c, n, rate, only) {
  const b = c.bb;
  let f = b.food;
  if (only && (!f || f.kind !== only)) {
    // search a bit wider for that specific flora
    const near = c.world.queryFlora(c.x, c.y, (n.params.r ?? 240), c.plane);
    f = null;
    let bd = 1e9;
    for (const p of near) if ((!only || p.kind === only) && p.biomass > 0.1) {
      const d = Math.hypot(p.x - c.x, p.y - c.y);
      if (d < bd) { bd = d; f = p; }
    }
  }
  if (!f || f.biomass < 0.04) return S_NO;
  if (!f.patch) {
    navigate(c, f.x, f.y, c.world, 0.72, { band: null });
    if (Math.hypot(f.x - c.x, f.y - c.y) > c.radius + 26) { c.intent = 'to-graze'; return S_R; }
  }
  c.target = f; c.intent = 'graze';
  c.wantSpeed = Math.min(c.wantSpeed, (c.sp.phys.cruise || 40) * 0.3);
  // a grazing animal crops a plant over seconds, not in one frame, otherwise
  // the flora bank is stripped faster than primary production can pay it back
  const take = rate * 0.0035 * (c.hunger < 0.4 ? 1.35 : 1);
  if (f.patch) {
    c.hunger = clamp01(c.hunger + take * 2.6);
    c.world.stats.grazing += take;
    c.world.plankton.addClamped(c.x, c.y, -0.02, 4);
  } else {
    const got = c.world.takeFlora(f, take);
    c.hunger = clamp01(c.hunger + got * 1.5);
    c.world.stats.grazing += got * 0.5;
    c.health = Math.min(1, c.health + got * 0.2);
  }
  c.meals++;
  if (c.hunger > 0.98) return S_OK;
  return S_R;
}
A('FilterFeed', (c, n) => {
  const pk = c.world.plankton.at(c.x, c.y);
  c.wantSpeed = Math.max(c.wantSpeed, (c.sp.phys.cruise || 40) * 0.22);
  c.gape = 1;
  c.intent = 'filter';
  if (pk > 0.14) {
    const gain = 0.02 * pk * (c.sp.size < 20 ? 1 : 0.7);
    c.hunger = clamp01(c.hunger + gain);
    c.world.plankton.addClamped(c.x, c.y, -0.012, 4);
    c.world.nutrients.addClamped(c.x, c.y, 0.004, 3);
    c.meals++;
  } else if (pk < 0.08) {
    // move toward the bloom
    const t = c.world.planktonTarget(c.x, c.y, n.params.range ?? 380);
    if (t) { navigate(c, t.x, t.y, c.world, 0.8); return S_R; }
  }
  return pk > 0.2 ? S_R : S_NO;
}, { range: { min: 160, max: 720 }, patience: { min: 4, max: 14 } });
A('PulseStingFeed', (c) => {
  c.pulse = 1;
  c.wantSpeed = (c.sp.phys.cruise || 24) * 0.5;
  const b = c.bb;
  if (b.prey && inReach(c, b.prey, 1.5)) { c.strikeTarget = { x: b.preyX, y: b.preyY }; if (tryBite(c, b.prey, c.world, 1 / 60, 0.8)) return S_OK; }
  const pk = c.world.plankton.at(c.x, c.y);
  if (pk > 0.1) { c.hunger = clamp01(c.hunger + 0.02 * pk); c.world.plankton.addClamped(c.x, c.y, -0.0035, 5); }
  return S_R;
});
A('ForageNearby', (c, n) => forage(c, n, 1), { range: { min: 80, max: 420 }, patience: { min: 3, max: 8 } });
A('ForageDesperate', (c, n) => forage(c, n, 1.9));
function forage(c, n, mul) {
  const b = c.bb;
  if (b.food) { navigate(c, b.foodX, b.foodY, c.world, 0.85 * mul, { desperate: mul > 1 }); c.intent = 'forage'; return S_R; }
  if (b.carrion) { navigate(c, b.carrionX, b.carrionY, c.world, 0.95 * mul, { desperate: true }); c.intent = 'to-carrion'; return S_R; }
  const t = c.world.planktonTarget(c.x, c.y, n.params.range ?? 300);
  if (t) { navigate(c, t.x, t.y, c.world, 0.75 * mul); c.intent = 'to-bloom'; return S_R; }
  return S_NO;
}
A('MigrateToFood', (c, n) => {
  // cross-zone pathfinding: head for the richest water within a huge radius
  const t = c.world.foodGradient(c.x, c.y, n.params.range ?? 900, c.sp);
  if (!t) return S_NO;
  if (t.v < 0.12 && c.hunger > 0.12) return S_NO;      // nothing better anywhere
  const d = Math.hypot(t.x - c.x, t.y - c.y);
  if (d < 90) return S_OK;                              // arrived
  navigate(c, t.x, t.y, c.world, 1.05, { desperate: true });
  c.intent = 'migrate';
  return S_R;
}, { range: { min: 400, max: 1800 }, patience: { min: 4, max: 14 } });
A('DriftDown', (c) => {
  // letting go of the rock: this is how animals end up below the third zone
  c.wantHeading = PI / 2 + Math.sin(c.t * 0.7) * 0.6;
  c.wantSpeed = (c.sp.phys.cruise || 40) * 0.2;
  c.body.thrustTarget = Math.max(0.05, c.body.thrustTarget * 0.4);
  c.intent = 'drift-down';
  return S_R;
});
A('Scavenge', (c, n) => {
  const b = c.bb;
  const k = b.carrion;
  if (!k || k.mass <= 0) return S_NO;
  navigate(c, k.x, k.y, c.world, 1.0, { desperate: true });
  c.intent = 'scavenge';
  if (Math.hypot(k.x - c.x, k.y - c.y) < k.r + c.radius + 14) { feedCarrion(c, n.params.rate ?? 1); return b.desperate > 0.6 ? S_R : S_OK; }
  return S_R;
}, { rate: { min: 0.4, max: 2.4 }, patience: { min: 4, max: 12 } });
function feedCarrion(c, rate) {
  c.world.stats.scavenge += rate / 60;
  const k = c.bb.carrion;
  if (!k || k.mass <= 0) return false;
  const take = 0.5 * rate * (0.6 + c.growth * 0.6);
  k.mass -= take;
  c.hunger = clamp01(c.hunger + take * 0.02 / Math.max(0.4, c.sp.size / 24));
  c.health = Math.min(1, c.health + take * 0.004);
  c.meals++;
  c.world.stats.meal(c.key, 'carrion');
  c.world.fx.flake(k.x, k.y, 1);
  if (k.mass <= 0) c.world.consumeCarrion(k);
  return true;
}
A('GulpCarrion', (c) => { const ok = feedCarrion(c, 1.3); return ok ? S_R : S_NO; });
A('Burrow', (c) => {
  const plane = c.world.terrain.plane(c.plane);
  const g = plane.groundBelow(c.x, c.y, 120);
  if (g < 0) return S_NO;
  c.wantSpeed = 0; c.burrow = Math.min(1, (c.burrow || 0) + 0.05);
  c.camo = Math.max(c.camo, c.burrow * 0.8);
  c.intent = 'burrow';
  return S_OK;
});
A('AnchorFeet', (c) => {
  c.grip = 1; c.wantSpeed = 0;
  c.intent = 'anchor';
  return S_OK;
});

// ---- territory / station holding ------------------------------------------
A('ReturnToNest', (c) => {
  const d = Math.hypot(c.nest.x - c.x, c.nest.y - c.y);
  if (d < c.territory * 0.4) return S_OK;
  navigate(c, c.nest.x, c.nest.y, c.world, 0.8, { band: c.homeZone });
  c.intent = 'return-nest';
  return S_R;
});
A('ReturnHome', (c) => {
  const z = ZONES[c.homeZone];
  const ty = clamp((z.top + z.bottom) * 0.5, 120, WORLD_H - 120);
  navigate(c, c.x, ty, c.world, 0.95, { band: c.homeZone });
  c.intent = 'return-home';
  return Math.abs(c.zone - c.homeZone) < 0.5 ? S_OK : S_R;
});
A('PatrolTerritory', (c, n) => {
  const r = n.params.r ?? c.territory;
  const a = c.t * 0.28 + c.seed % TAU;
  const tx = clamp(c.nest.x + Math.cos(a) * r, 60, WORLD_W - 60);
  const ty = clamp(c.nest.y + Math.sin(a) * r * 0.5, 80, WORLD_H - 80);
  navigate(c, tx, ty, c.world, 0.6, { band: c.homeZone });
  c.intent = 'patrol';
  return S_R;
}, { r: { min: 60, max: 700 } });
A('HoldGround', (c) => {
  c.wantSpeed = Math.min(c.wantSpeed, (c.sp.phys.cruise || 40) * 0.14);
  c.intent = 'hold';
  if (c.mode === 'swim') {
    // station-keeping against the current: small fin corrections
    const cur = c.world.currentAt(c.x, c.y, c.t);
    c.wantHeading = Math.atan2(-cur.y, -cur.x) * 0.25 + c.wantHeading * 0.75;
  }
  return S_R;
});
A('HoldStation', (c) => {
  const plane = c.world.terrain.plane(c.plane);
  const lane = plane === c.world.terrain.plane(0) ? c.world.terrain.plane(0) : plane;
  // wall-huggers hold a lane parallel to the nearest rock face
  const cl = lane.clearance(c.x, c.y, _cl4);
  const side = cl.nx >= 0 ? -1 : 1;
  const want = 60 + c.radius;
  const off = clamp(want - cl.d, -60, 60);
  c.wantHeading = (side < 0 ? PI / 2 : -PI / 2) + (c.detour || 0) + Math.sin(c.t * 0.4 + c.seed) * 0.25;
  navigate(c, c.x + Math.cos(c.wantHeading) * 90 + cl.nx * off, c.y + Math.sin(c.wantHeading) * 90, c.world, 0.55);
  c.intent = 'station';
  return S_R;
});
const _cl4 = { d: 0, nx: 0, ny: 0, which: 0 };
A('MigrateToZone', (c, n) => {
  const z = ZONES[clamp(Math.round(n.params.zone ?? 1), 0, 3)];
  const ty = clamp((z.top + z.bottom) * 0.5 + Math.sin(c.t * 0.2) * 100, 100, WORLD_H - 100);
  if (c.zone === z.id && c.lod === 0) return S_OK;
  const P = c.world.terrain.plane(c.plane);
  const surf = P.surfaceY(c.x);
  const clear = surf - c.y;                       // how much water is under it
  // Is this column even capable of being home? On a shelf that is shallower than
  // its band there is nothing to dive through — it has to travel along the rock to
  // where the water drops. Otherwise it simply sinks toward the band centre.
  const shelf = surf < z.top - 140;
  if (shelf || (clear >= 0 && clear < c.radius * 2.2 + 10)) {
    if (!c.migDirT || c.t > c.migDirT || Math.abs(c.x - (c.migX ?? c.x)) < 70) {
      const want = z.top - 140;
      let gx = P.deepestX;
      for (let s = 1; s <= 46; s++) {
        let hit = false;
        for (const dir of [1, -1]) {
          const x = clamp(c.x + dir * s * 110, 40, WORLD_W - 40);
          if (P.surfaceY(x) > want) { gx = x; hit = true; break; }
        }
        if (hit) break;
      }
      c.migX = gx;
      c.migDirT = c.t + 4;
    }
    // fly a body-length clear of the deck, not skimming it: a 100 m animal dragging
    // its snout along a shelf cannot generate forward motion
    const alt = clamp(Math.min(surf, WORLD_H - 80) - (140 + c.radius * 2), 60, WORLD_H - 60);
    navigate(c, c.migX, alt, c.world, 1.2, { band: z.id, desperate: true });
    // lethal water is a reason to hurry: it crosses the shelf at twice the speed
    // it would bother with when it is merely hungry
    c.wantSpeed = Math.max(c.wantSpeed, c.sp.phys.cruise * 1.9);
    c.intent = 'finding-the-drop';
    return S_R;
  }
  navigate(c, c.x + Math.cos(c.t * 0.3) * 90, ty, c.world, 1.05, { band: z.id, desperate: !!n.params.tough });
  if (n.params.tough) c.wantSpeed = Math.max(c.wantSpeed, c.sp.phys.cruise * 1.7);
  c.intent = 'migrate-zone';
  return S_R;
}, { zone: { min: 0, max: 3, round: true }, patience: { min: 6, max: 18 }, tough: { min: 0, max: 1, round: true } });

A('HardenShell', (c) => { c.brace = 1; c.wantSpeed = 0; c.intent = 'harden'; return S_OK; });
A('BristleUp', (c) => { c.brace = 1; c.wantSpeed *= 0.3; c.spineUp = 1; c.intent = 'bristle'; return S_OK; });
A('SealShell', (c) => { c.seal = 1; c.wantSpeed = 0; c.camo = Math.max(c.camo, 0.5); c.intent = 'seal'; return S_OK; });
A('FlashScalpel', (c) => {
  const b = c.bb;
  if (!b.threat) return S_NO;
  const a = Math.atan2(b.threatY - c.y, b.threatX - c.x);
  c.wantHeading = a;
  c.lash = 1;
  if (b.threatD < 40) { hurt(b.threat, 4, c.world, c, 'attack'); c.world.fx.spark(b.threatX, b.threatY, '#fff6d8'); }
  c.intent = 'flash';
  return S_OK;
});
A('TuckIntoCrevice', (c) => {
  const plane = c.world.terrain.plane(c.plane);
  const cv = plane.caves && plane.caves.length ? c.world.terrain.nearestCave(c.x, c.y, null, 420) : null;
  if (cv) { navigate(c, cv.x, cv.y, c.world, 0.9); c.intent = 'crevice'; return S_R; }
  const cl = plane.clearance(c.x, c.y, _cl5);
  navigate(c, c.x - cl.nx * 30, c.y - cl.ny * 30, c.world, 0.6);
  c.intent = 'crevice';
  return S_R;
});
const _cl5 = { d: 0, nx: 0, ny: 0, which: 0 };
A('DiveToCoral', (c) => {
  const b = c.bb;
  if (!b.shelter) return S_NO;
  navigate(c, b.shelterX, b.shelterY + 10, c.world, 1.1, { desperate: true });
  c.intent = 'dive-coral';
  return b.shelterD < 30 ? S_OK : S_R;
});
A('HideInJellyBell', (c) => {
  let best = null, bd = 1e9;
  for (const o of c.world.queryCreatures(c.x, c.y, 420)) {
    if (o.key !== 'jelly' || !o.alive) continue;
    const d = dist2(o.x, o.y, c.x, c.y);
    if (d < bd) { bd = d; best = o; }
  }
  if (!best) return S_NO;
  navigate(c, best.x, best.y + best.radius * 0.5, c.world, 1.15, { desperate: true });
  c.protector = best;
  c.intent = 'under-bell';
  return bd < 40 * 40 ? S_OK : S_R;
});
A('GuardSchool', (c) => {
  // the symbiosis: place the bell between the herd and the danger
  let herd = 0, hx = 0, hy = 0;
  for (const o of c.world.queryCreatures(c.x, c.y, 260)) {
    if (o.key !== 'minnow') continue;
    herd++; hx += o.x; hy += o.y;
  }
  c.herd = herd;
  if (!herd) return S_NO;
  hx /= herd; hy /= herd;
  const t = c.bb.threat;
  let tx = hx, ty = hy;
  if (t) { tx = lerp(hx, t.x, 0.6); ty = lerp(hy, t.y, 0.6); }
  driftToward(c, tx, ty, 1);
  c.intent = 'guard';
  if (t && c.bb.threatD < 70) { c.pulse = 1; c.world.fx.sting(t.x, t.y); t.stamina = Math.max(0, t.stamina - 0.12); }
  return S_R;
});
function driftToward(c, tx, ty, mul) {
  const a = Math.atan2(ty - c.y, tx - c.x);
  c.wantHeading = a;
  const pulse = 0.5 + 0.5 * Math.sin(c.t * 2.1);
  c.wantSpeed = (c.sp.phys.cruise || 24) * 0.6 * pulse * mul;
  c.pulse = pulse > 0.8 ? 1 : 0;
}

A('Rest', (c) => {
  c.wantSpeed = Math.min(c.wantSpeed, 6);
  c.restT += 1 / 60;
  c.stamina = Math.min(1, c.stamina + 0.22 / 60);
  c.health = Math.min(1, c.health + 0.00035);
  c.intent = 'rest';
  if (c.bb.threat && c.bb.threatD < 120) return S_NO;
  return c.restT > 4 ? S_OK : S_R;
});
A('Glide', (c) => {
  c.wantSpeed = Math.min(c.wantSpeed, (c.sp.phys.cruise || 60) * 0.22);
  c.body.thrustTarget = 0.12;
  c.stamina = Math.min(1, c.stamina + 0.1 / 60);
  c.intent = 'glide';
  return c.stamina > 0.7 ? S_OK : S_R;
});
A('Drift', (c) => {
  c.wantSpeed = 0;
  c.intent = 'drift';
  return S_R;
});
A('BaskLight', (c) => {
  if (c.bb.light < 0.4) return S_NO;
  const z = ZONES[c.homeZone];
  c.wantHeading = -PI / 2;
  navigate(c, c.x, z.top + 60, c.world, 0.4);
  c.health = Math.min(1, c.health + 0.0006 * c.bb.light);
  c.hunger = clamp01(c.hunger - 0.00006);   // symbionts photosynthesise: slow but free
  c.intent = 'bask';
  return S_R;
});
A('GulpAir', (c) => {
  const sp = c.sp;
  if (!sp.airAt || c.air > 0.92) return S_NO;
  const z = ZONES[sp.airAt];
  const ty = z.top + 90;
  navigate(c, c.x, ty, c.world, 0.9, { band: sp.airAt });
  c.intent = 'to-surface';
  if (c.y < ty + 90) {
    c.air = Math.min(1, c.air + 0.5 / 60);
    c.world.fx.bubble(c.x, c.y - 6, 1);
    if (c.air > 0.95) return S_OK;
  }
  return S_R;
}, { patience: { min: 10, max: 26 } });
A('ClimbWall', (c) => {
  if (!c.sp.canCling) return S_NO;
  const T = c.world.terrain;
  // into the background wall: find the linked perch, else crawl upward on rock
  if (c.plane === 0) {
    const link = T.bgLinkFor(c.x, c.y);
    if (link && link.ledge) {
      const B = link.ledge;
      const tx = clamp(c.x, B.x0, B.x1);
      navigate(c, tx, B.y - 16, c.world, 0.9);
      if (Math.hypot(tx - c.x, B.y - 16 - c.y) < 60) {
        c.plane = 1;
        c.mode = 'cling';
        reseatOnPlane(c, c.world, tx, B.y - 20);
        c.world.fx.smoke(c.x, c.y, '#6f8ea3');
        return S_OK;
      }
      return S_R;
    }
    // otherwise just scale the cliff face we are on, upward
    const a = -PI / 2 + Math.sin(c.t * 0.4) * 0.5;
    navigate(c, c.x + Math.cos(a) * 120, c.y + Math.sin(a) * 120, c.world, 0.8, { band: c.zone });
    c.mode = 'cling';
    c.intent = 'climb';
    return S_R;
  }
  const B = c.world.terrain.ledgeNear ? null : null;
  const target = c.world.terrain.plane(1).ledgeNear(c.x, c.y, 700);
  if (!target) return S_NO;
  const tx = clamp(c.x, target.x0, target.x1);
  navigate(c, tx, target.y - 18, c.world, 0.85, { band: c.zone });
  c.mode = 'cling';
  c.intent = 'traverse-wall';
  return Math.hypot(tx - c.x, target.y - c.y) < 50 ? S_OK : S_R;
});
A('DropToFloor', (c) => {
  if (c.plane === 0) {
    // leave the rock and get into the water column
    const plane = c.world.terrain.plane(0);
    const cl = plane.clearance(c.x, c.y, _cl6);
    navigate(c, c.x - cl.nx * 90, c.y - cl.ny * 90 + 20, c.world, 0.9);
    c.mode = 'swim';
    c.intent = 'enter-water';
    if (cl.d > 34) { c.mode = 'swim'; return S_OK; }
    return S_R;
  }
  const T = c.world.terrain;
  const link = T.links.find((L) => L.bg === (c.ledgeId ?? -1)) || null;
  const L0 = link ? T.ledges[link.main] : null;
  const target = L0 || nearestMainLedge(c);
  if (!target) return S_NO;
  const tx = clamp(c.x, target.x0, target.x1);
  navigate(c, tx, target.y - 18, c.world, 0.95, { desperate: true });
  c.intent = 'descend';
  if (Math.hypot(tx - c.x, target.y - c.y) < 60) {
    c.plane = 0; c.mode = 'walk';
    reseatOnPlane(c, c.world, tx, target.y - 16);
    c.world.fx.smoke(c.x, c.y, '#8aa7b8');
    return S_OK;
  }
  return S_R;
});
const _cl6 = { d: 0, nx: 0, ny: 0, which: 0 };
function nearestMainLedge(c) {
  const T = c.world.terrain;
  let best = null, bd = 1e9;
  for (const L of T.ledges) {
    const cx = clamp(c.x, L.x0, L.x1);
    const d = (cx - c.x) ** 2 * 0.1 + (L.y - c.y * (1 / 0.74)) ** 2;
    if (d < bd) { bd = d; best = L; }
  }
  return best;
}
function reseatOnPlane(c, world, x, y) {
  const plane = world.terrain.plane(c.plane);
  const spot = plane.freeSpot(x, y, 20);
  const b = c.body;
  const dx = spot.x - b.pts[0].x, dy = spot.y - b.pts[0].y;
  for (let i = 0; i < b.n; i++) { b.pts[i].x -= dx * (1 - i / b.n); b.pts[i].y -= dy * (1 - i / b.n); }
  for (const L of b.limbs) for (const p of L.pts) { p.x -= dx; p.y -= dy; }
  c.x = spot.x; c.y = spot.y;
  c.nest = c.nest || { x, y };
}
A('Sidestep', (c) => {
  const a = c.body.angle + (c.rand.f() < 0.5 ? PI / 2 : -PI / 2);
  navigate(c, c.x + Math.cos(a) * 70, c.y + Math.sin(a) * 70, c.world, 0.9);
  c.intent = 'sidestep';
  return S_R;
});
A('ContractBell', (c) => { c.pulse = 1; c.wantSpeed = (c.sp.phys.cruise || 24) * 1.4; c.intent = 'contract'; return c.rand.chance(0.1) ? S_OK : S_R; });
A('Wander', (c, n) => {
  const t = (c.t * (n.params.step ?? 2) + (c.seed % 100)) * 0.55;
  const r = 90 + (n.params.bias ?? 0.5) * 320 * (0.4 + c.bb.desperate);
  const z = ZONES[c.homeZone];
  const ty = clamp(c.y + Math.sin(t * 0.7) * r * 0.5, z.top + 30, z.bottom - 30);
  const tx = clamp(c.x + Math.cos(t) * r, 90, WORLD_W - 90);
  navigate(c, tx, ty, c.world, 0.55 + (n.params.bias ?? 0.5) * 0.35, { band: c.homeZone });
  c.intent = 'wander';
  return S_R;
}, { bias: { min: 0.1, max: 1 }, step: { min: 1, max: 5 } });
A('InvestigateLight', (c) => {
  const g = c.bb.glitter;
  if (!g) return S_NO;
  navigate(c, g.x, g.y, c.world, 0.8, { desperate: true });
  c.intent = 'investigate';
  return Math.hypot(g.x - c.x, g.y - c.y) < 60 ? S_OK : S_R;
});
A('Threaten', (c) => {
  const b = c.bb;
  if (!b.prey && !b.threat) return S_NO;
  const t = b.threat || b.prey;
  c.wantHeading = Math.atan2(t.y - c.y, t.x - c.x);
  c.display = 1;
  c.wantSpeed = 0;
  c.intent = 'threaten';
  if (t.sp && t.sp.size < c.sp.size * 0.9 && c.rand.chance(0.02)) { t.fleeCd = 1.2; return S_OK; }
  return c.rand.chance(0.03) ? S_OK : S_R;
});
A('SchoolWith', (c, n) => {
  const soc = c.sp.social;
  if (!soc) return S_NO;
  let cx = 0, cy = 0, ax = 0, ay = 0, vx = 0, vy = 0, n2 = 0;
  const R = n.params.r ?? soc.radius;
  for (const o of c.world.queryCreatures(c.x, c.y, R * 2.4)) {
    if (o === c || o.key !== c.key || !o.alive) continue;
    const d = Math.hypot(o.x - c.x, o.y - c.y);
    if (d > R * 2.4) continue;
    n2++;
    cx += o.x; cy += o.y;
    ax += (o._v?.x || 0); ay += (o._v?.y || 0);
    if (d < soc.sep) { vx -= (o.x - c.x) / (d + 1); vy -= (o.y - c.y) / (d + 1); }
  }
  if (!n2) return S_NO;
  cx /= n2; cy /= n2; ax /= n2; ay /= n2;
  const cohW = soc.coh * 0.9, aliW = soc.align * 0.006;
  const tx = cx + ax * aliW * 100 + vx * 30;
  const ty = cy + ay * aliW * 100 + vy * 30;
  navigate(c, lerp(c.x, tx, cohW), lerp(c.y, ty, cohW), c.world, 0.75);
  c.crowd = n2;
  c.intent = 'school';
  return S_R;
}, { r: { min: 20, max: 180 }, patience: { min: 3, max: 10 } });

// ---- life cycle -------------------------------------------------------------
A('CourtMate', (c, n) => {
  // A courtship is a commitment: the pair latch onto one another, so a dip in
  // hunger or a shadow passing overhead does not break it off half-done. The
  // caller also lights up and emits a call the partner's own tree answers.
  const m = c.courtP && c.courtP.alive ? c.courtP : c.bb.mate;
  if (!m || m === c || !m.alive) { c.courtT = 0; c.courtP = null; return S_NO; }
  c.courtP = m;
  c.courtT = n.params.hold ?? 8;
  m.courtCall = 1.2;
  navigate(c, m.x, m.y, c.world, 0.6);
  c.wantSpeed = Math.min(c.wantSpeed, c.sp.phys.cruise * 0.55);
  c.glowWant = clamp01(Math.max(c.glowWant, 0.75));
  c.display = 1;
  c.intent = 'court';
  const near = dist2(c.x, c.y, m.x, m.y) < ((c.radius + m.radius) * 2.2 + c.sp.size) ** 2;
  if (near && m.reproduceCd <= 0 && c.reproduceCd <= 0) {
    const r = c.sp.reproduce;
    for (const p of [c, m]) {
      p.pregnant = true; p.gestation = 0; p.eggs = 0;
      p.reproduceCd = r.cd * (0.8 + p.rand.f() * 0.5);
      p.courtP = null; p.courtT = 0; p.courtCall = 0;
    }
    c.world.fx.glitter(c.x, c.y, '#cfeaff');
    c.world.log(`${c.sp.name} pair spawned a clutch`, c.x, c.y, 'breed');
    return S_OK;
  }
  return S_R;
}, { hold: { min: 5, max: 14 } });
A('SpawnEggs', (c) => {
  if (c.eggs <= 0) { c.intent = 'gestating'; return S_NO; }   // clutch still maturing: keep feeding
  c.pregnant = false;
  const sp = c.sp;
  const n = clamp(Math.round(c.eggs), 1, 8);
  c.eggs = 0;
  // cavity spawners lay on the rock they call home, the rest release into the water
  const at = /cave|hatchery|nest/.test(sp.reproduce.site || '') ? c.nest : c;
  for (let k = 0; k < n; k++) {
    c.world.spawnEgg(c, at.x + (k - n / 2) * 9 + c.rand.r(-6, 6), at.y + 6 + c.rand.r(-5, 5));
  }
  c.hunger = clamp01(c.hunger - 0.22);
  c.reproduceCd = sp.reproduce.cd * (0.7 + c.rand.f() * 0.7);
  c.intent = 'spawn';
  c.world.log(`${sp.name} spawned ${n} eggs`, c.x, c.y, 'breed');
  return S_OK;
});

function huntLike(c, n, speed, ok) {
  const b = c.bb;
  if (!b.prey) return S_NO;
  navigate(c, b.preyX + (b.prey._v?.x || 0) * 0.15, b.preyY, c.world, speed, { desperate: b.desperate > 0.3 });
  c.target = b.prey;
  c.strikeTarget = { x: b.preyX, y: b.preyY };
  c.intent = 'chase';
  if (inReach(c, b.prey, 1.1) && tryBite(c, b.prey, c.world, 1 / 60, 1.1)) return S_OK;
  return b.preyD > (n.params.range ?? 500) * 1.4 ? S_NO : S_R;
}

// ---------------------------------------------------------------------------
//  CONDITIONS
// ---------------------------------------------------------------------------
C('HungerBelow', (c, p) => c.hunger < (p.v ?? 0.5));
C('HungerAbove', (c, p) => c.hunger > (p.v ?? 0.6));
C('HealthBelow', (c, p) => c.health < (p.v ?? 0.5));
C('StaminaBelow', (c, p) => c.stamina < (p.v ?? 0.4));
C('StaminaAbove', (c, p) => c.stamina > (p.v ?? 0.5));
C('ThreatNear', (c, p) => {
  const b = c.bb;
  if (!b.threat) return c._threatOn = false;
  const r = (p.r ?? 160) * (1 + b.desperate * 0.5);
  // is it actually closing on us?
  const vx = (b.threat._v ? b.threat._v.x : 0), vy = (b.threat._v ? b.threat._v.y : 0);
  const dx = c.x - b.threat.x, dy = c.y - b.threat.y;
  const L = Math.hypot(dx, dy) || 1;
  const closing = (vx * dx + vy * dy) / L > 6;
  const on = c._threatOn;
  // enter at r, leave at 1.35r unless it is still coming at us
  const keep = on && (b.threatD > r * 1.35 || (!closing && b.threatD > r * 0.8));
  c._threatOn = b.threatD < r && !keep;
  return c._threatOn;
});
C('PreyNear', (c, p) => !!c.bb.prey && c.bb.preyD < (p.r ?? 200));
C('FoodNear', (c, p) => (!!c.bb.food && c.bb.foodD < (p.r ?? 200)) || (!!c.bb.carrion && c.bb.carrionD < (p.r ?? 200)));
C('CarcassNear', (c, p) => !!c.bb.carrion && c.bb.carrionD < (p.r ?? 320));
C('MateNear', (c, p) => !!c.bb.mate && c.bb.mateD < (p.r ?? 200));
// a courting animal stays in its breeding branch even if its hunger dips, and an
// animal that hears a call abandons what it was doing to answer it
C('Courting', (c) => c.courtT > 0);
C('HeardCall', (c) => c.courtCall > 0 && c.reproduceCd <= 0 && c.hunger > 0.34);
C('Gestating', (c) => c.eggs > 0 || c.pregnant);
C('GlitterNear', (c, p) => !!c.bb.glitter && c.bb.glitterD < (p.r ?? 240));
C('ZoneMismatch', (c) => c.zoneStress > 0.35);
C('InHomeZone', (c) => c.zone === c.homeZone);
C('InZone', (c, p) => c.zone === Math.round(p.zone ?? 0));
C('FarFromNest', (c, p) => Math.hypot(c.nest.x - c.x, c.nest.y - c.y) > (p.d ?? 220));
C('NearNest', (c, p) => Math.hypot(c.nest.x - c.x, c.nest.y - c.y) < (p.r ?? 200));
C('LightBelow', (c, p) => c.bb.light < (p.v ?? 0.2));
C('LightAbove', (c, p) => c.bb.light > (p.v ?? 0.4));
C('CrowdAbove', (c, p) => c.bb.crowd >= (p.n ?? 3));
C('Alone', (c) => c.bb.crowd === 0);
C('CanReproduce', (c) => {
  const sp = c.sp.reproduce;
  return c.hunger > sp.hunger && c.health > sp.health && c.growth > 0.85 && c.reproduceCd <= 0 && c.world.pop[c.key] < c.world.cap[c.key] && c.world.alive();
});
C('TimeSince', (c, p) => {
  c.lastAct = c.lastAct ?? 0;
  const ok = c.t - c.lastAct > (p.t ?? 20);
  if (ok) c.lastAct = c.t;
  return ok;
});
C('AtBoundary', (c) => c.y > LEVIATHAN_LINE - 260 && c.y < LEVIATHAN_LINE + 260);
C('CarryingEgg', (c) => c.eggs > 0);
C('HasTarget', (c) => !!c.target && c.target.alive !== false);
C('TargetFar', (c, p) => !c.target || Math.hypot(c.target.x - c.x, c.target.y - c.y) > (p.d ?? 200));
C('TraumaAbove', (c, p) => c.trauma > (p.v ?? 0.5));
C('AirLow', (c, p) => (c.air ?? 1) < (p.v ?? 0.45));

// ---------------------------------------------------------------------------
//  top-level per-frame update
// ---------------------------------------------------------------------------
export function updateCreature(c, dt, world) {
  c.world = world;
  if (!c.alive) { c.deathT += dt; return; }
  c.t += dt;
  c.biteCd = Math.max(0, c.biteCd - dt);
  c.alarm = Math.max(0, c.alarm - dt);
  c.strikeT = Math.max(0, c.strikeT - dt * 4.2);
  c.reproduceCd = Math.max(0, c.reproduceCd - dt);
  c.mateCd = Math.max(0, (c.mateCd || 0) - dt);
  c.courtT = Math.max(0, (c.courtT || 0) - dt);
  c.courtCall = Math.max(0, (c.courtCall || 0) - dt);
  if (c.courtT <= 0 && c.courtP && (!c.courtP.alive || dist2(c.x, c.y, c.courtP.x, c.courtP.y) > 900 * 900)) c.courtP = null;
  c.fear = Math.max(0, c.fear - dt * 0.35);
  c.trauma = Math.max(0, c.trauma - dt * 0.02);
  c.wound = Math.max(0, c.wound - dt * 0.02);
  c.flash = Math.max(0, c.flash - dt * 3.4);
  c.seal = Math.max(0, c.seal - dt * 0.5);
  c.brace = Math.max(0, c.brace - dt * 0.6);
  c.display = Math.max(0, (c.display || 0) - dt * 1.2);
  c.lash = Math.max(0, (c.lash || 0) - dt * 3);
  c.spineUp = Math.max(0, (c.spineUp || 0) - dt * 1.5);
  c.grip = Math.max(0, (c.grip || 0) - dt * 0.8);
  c.burrow = Math.max(0, (c.burrow || 0) - dt * 0.4);
  if (c.crowd !== undefined && c.lod === 2) c.crowd = 0;

  // --- metabolism ---------------------------------------------------------
  const act0 = c.body.thrust * 0.7 + 0.35;
  const press = pressureAt(c.y);
  const temp = ZONES[c.zone].temp;
  const meta = c.sp.metabolism * (0.55 + act0) * (0.75 + 0.5 * press / 10) * (0.6 + 0.7 * temp);
  c.hunger = clamp01(c.hunger - meta * c.sp.hungerDecay * dt * world.speedMul);
  if (c.pregnant) c.hunger = clamp01(c.hunger - 0.0025 * dt);

  // --- damage: starvation + zone incompatibility + wounds ----------------
  if (c.hunger <= 0.001) {
    c.health -= 0.021 * dt;
    if (!c._starveLogged) { c._starveLogged = true; }
    if (c.health <= 0) { hurt(c, 0.4, world, null, 'starve'); }
  } else if (c.hunger < 0.22) {
    c.health -= 0.0022 * dt;          // slowly failing, and bolder
  }
  if (c.zoneStress > 0) {
    c.health -= 0.0042 * c.zoneStress * dt;
    if (c.zoneStress > 1.6) c.health -= 0.02 * (c.zoneStress - 1.6) * dt;
    if (c.health <= 0) { hurt(c, 0.3, world, null, 'zone'); }
  }
  if (c.sp.phys.lung && c.air < 0.12) {
    c.health -= 0.006 * dt;            // flooded lung
    if (c.health <= 0) hurt(c, 0.3, world, null, 'drowned');
  }
  // well-fed animals recover, and heal slowly
  if (c.hunger > 0.6) c.health = Math.min(1, c.health + 0.0035 * dt);

  // --- desperation reshapes everything -----------------------------------
  c.hungerMode = c.hunger > 0.72 ? 'sated' : c.hunger > 0.45 ? 'foraging' : c.hunger > 0.2 ? 'hungry' : 'desperate';
  if (c.growth < 1) c.growth = Math.min(1, c.growth + 0.0016 * dt * (0.25 + c.hunger) * (c.growth < 0.85 ? 1.6 : 0.5));

  // --- reproduce bookkeeping ---------------------------------------------
  if (c.pregnant) {
    c.gestation = (c.gestation || 0) + dt;
    if (c.gestation > (c.sp.reproduce.cd * 0.18 + 12)) { c.eggs = c.sp.reproduce.eggs; c.gestation = 0; }
  }
  if (c.eggs > 0 && c.hunger > 0.4 && c.rand.chance(dt * 0.02) && c.world.pop[c.key] < c.world.cap[c.key]) {
    c.eggs--;
    c.world.spawnEgg(c, c.x, c.y + 4);
  }

  // --- AI -----------------------------------------------------------------
  const near = c.lod === 0;
  c.lastSense -= dt;
  if (c.lastSense <= 0 || near && c.bb.threatD === 1e9) {
    c.lastSense = c.senseEvery * (c.lod === 0 ? 1 : c.lod === 1 ? 2.6 : 6.5);
    sense(c, world);
  }
  c.btTick = (c.btTick || 0) - dt;
  if (c.btTick <= 0) {
    c.btTick = c.lod === 0 ? 0 : c.lod === 1 ? 1 / 22 : 1 / 8;
    tickTree(c.bt, c, dt * (c.lod ? 2 : 1));
    c.tickN++;
  }
  if (!near) {
    // far away: coast on the last intent so behaviour stays continuous
    c.wantSpeed *= 0.999;
  }
  motor(c, dt, world);
  stepBody(c, dt, world);
  if (c.health <= 0 && c.alive) killCreature(c, world, c.cause || 'wounds', null);

  // symbiosis credit: minnows sheltering under a bell get protection + food
  if (c.key === 'minnow' && c.protector && c.protector.alive) {
    if (Math.hypot(c.protector.x - c.x, c.protector.y - c.y) < 90) {
      c.camo = Math.max(c.camo, 0.3);
      c.health = Math.min(1, c.health + 0.0004 * dt);
    } else c.protector = null;
  }
  if (c.bb.threatD < 999 && c.sp.tolerance !== 0 && c.trauma > 0.9 && c.hunger > 0.6) c.camo = Math.max(c.camo, 0.2);
}

/** drive a swimming carcass + notify the world when it settles */
export function updateCarrion(k, dt, world) {
  k.t += dt;
  const sink = 8 + k.mass * 0.25;
  const cur = world.currentAt(k.x, k.y, k.t);
  k.x += (k.vx + cur.x * 30) * dt;
  k.y += (k.vy + sink) * dt;
  k.vx = damp(k.vx, cur.x * 30, 1.2, dt);
  k.vy = damp(k.vy, sink, 0.7, dt);
  k.rot += k.spin * dt;
  k.spin *= 0.99;
  const plane = world.terrain.plane(0);
  const res = plane.resolve(k.x, k.y, k.r, _res);
  if (res.hit) { k.x = res.x; k.y = res.y; k.vy *= -0.2; k.vx *= 0.6; k.resting = true; }
  const zone = zoneIndexAt(k.y);
  if (zone !== k.zone) { k.zone = zone; if (zone === 3) world.log(`carrion falls into the Abyss`, k.x, k.y, 'fall'); }
  // decomposition feeds the water column
  k.mass -= 0.0035 * dt * (1 + k.warm);
  if (k.t % 1 < dt) world.nutrients.addClamped(k.x, k.y, 0.02 * (1 + k.mass * 0.02), 6);
  if (k.mass <= 0) world.consumeCarrion(k);
}
const _res = { hit: 0, x: 0, y: 0, nx: 0, ny: 0 };

export const ACT = registerAction;
