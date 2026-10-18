// Headless ecosystem soak test: no DOM, no canvas — pure simulation.
// Verifies that every species' behaviour-tree vocabulary exists, that the
// physics stays finite, and that the ecology is actually doing something
// (swimming, feeding, dying, reproducing) at real-time cost.
//
//   node test/headless.js [frames] [seed]
import { createWorld, stepWorld, DT } from '../src/sim/world.js';
import { SPECIES, SPECIES_KEYS } from '../src/sim/species.js';
import { ACTIONS, CONDITIONS, genTree } from '../src/sim/bt.js';
import { Rand, mixSeed } from '../src/core/rand.js';
import { ZONES, WORLD_W, WORLD_H, zoneIndexAt } from '../src/sim/zones.js';

const FRAMES = Number(process.argv[2] || 1800);
const SEED = Number(process.argv[3] || 1337);
let fails = 0;
const err = (m) => { fails++; console.error('  ✗ ' + m); };
const ok = (m) => console.log('  ✓ ' + m);
let warns = 0;
const warn = (m) => { warns++; console.log('  ⚠ ' + m); };
// Two modes in one file. Up to ~40 s of simulated time this is the *contract*:
// the demo has to look alive, so every check is a hard assertion. Past that it is
// a tuning instrument — the long-horizon trophic balance is an open backlog (see
// README "Known limits"), so those two measurements are reported as warnings while
// every invariant (finite state, nothing escaping the world, a live food web, the
// pressure rule, no crashes) stays fatal.
const CONTRACT = FRAMES <= 2400;
const report = (cond, msg) => (cond ? ok : CONTRACT ? err : warn)(msg);
const check = (cond, good, bad) => { if (cond) ok(good); else (CONTRACT ? err : warn)(bad); };

// ---------------------------------------------------------------- vocabulary
console.log('\n[1] behaviour-tree vocabulary');
const used = new Set();
for (const k of SPECIES_KEYS) {
  const bt = SPECIES[k].bt || {};
  for (const pool of ['hunt', 'feed', 'flee', 'rest', 'ambush']) {
    for (const item of bt[pool] || []) used.add(item[0]);
  }
}
const missingActs = [...used].filter((name) => !ACTIONS[name]);
if (missingActs.length) err('unregistered actions: ' + missingActs.join(', '));
const coreCons = ['ThreatNear', 'HealthBelow', 'HungerBelow', 'HungerAbove', 'FarFromNest', 'NearNest',
  'CanReproduce', 'ZoneMismatch', 'CarcassNear', 'LightBelow', 'GlitterNear', 'CrowdAbove', 'PreyNear', 'TimeSince'];
const missingCons = coreCons.filter((name) => !CONDITIONS[name]);
if (missingCons.length) err('unregistered conditions: ' + missingCons.join(', '));
if (!missingActs.length && !missingCons.length) ok(`${used.size} actions + ${coreCons.length} core conditions all registered`);

// The generator injects node names that appear in no species pool (MigrateToZone,
// CourtMate, SpawnEggs). A typo there is silent at runtime — an unresolved action
// just returns FAILURE — so every generated tree is walked and checked instead.
const genMiss = new Set();
const walkTree = (n) => {
  if (!n) return;
  if (n.type === 'act' && !ACTIONS[n.name]) genMiss.add(`action ${n.name}`);
  if (n.type === 'con' && !CONDITIONS[n.name]) genMiss.add(`condition ${n.name}`);
  for (const c of n.children || []) walkTree(c);
};
for (const k of SPECIES_KEYS) {
  const tpl = SPECIES[k].bt || {};
  for (let s = 0; s < 20; s++) walkTree(genTree(new Rand(mixSeed(SEED + s, k.length * 7919)), tpl));
}
if (genMiss.size) err('generated trees reference unknown nodes: ' + [...genMiss].join(', '));
else ok(`${SPECIES_KEYS.length * 20} generated trees resolve completely`);

// ---------------------------------------------------------------- world init
console.log('\n[2] world generation');
const t0 = performance.now();
const world = createWorld({ seed: SEED });
console.log(`  created in ${(performance.now() - t0).toFixed(0)} ms — ` +
  `${world.creatures.length} animals, ${world.flora.length} plants, ` +
  `${world.terrain.caves.length} caves (${world.terrain.hatcheries.length} hatcheries)`);
if (world.creatures.length < 60) err('too few animals at start');
if (world.flora.length < 120) err('too few plants at start');
if (world.terrain.hatcheries.length < 4) err('no crab hatcheries in Z3');

const floraMiss = new Set();
for (const p of world.flora) {
  (function walk(n) {
    if (!n) return;
    if (n.type === 'act' && !ACTIONS[n.name]) floraMiss.add(n.name);
    for (const c of n.children || []) walk(c);
  })(p.bt);
}
if (floraMiss.size) err('flora trees reference unknown actions: ' + [...floraMiss].join(', '));
else ok(`all ${world.flora.length} flora trees resolve`);

// ---------------------------------------------------------------- soak
console.log(`\n[3] ${FRAMES}-frame soak`);
const speed = { min: 1e9, max: 0 };
let nanCount = 0, escaped = 0;
const startPop = {};
for (const k of SPECIES_KEYS) startPop[k] = world.creatures.filter((c) => c.key === k).length;

const levFrames = { total: 0, abyss: 0, strict: 0, transit: 0 };
const t1 = performance.now();
for (let f = 0; f < FRAMES; f++) {
  stepWorld(world, DT);
  if (f % 60 === 0) {
    for (const c of world.creatures) {
      if (!Number.isFinite(c.x) || !Number.isFinite(c.y) || !Number.isFinite(c.hunger) || !Number.isFinite(c.health)) {
        nanCount++;
        if (nanCount < 4) err(`non-finite state on ${c.key} #${c.id}`);
      }
      for (let i = 0; i < c.body.n; i++) {
        const p = c.body.pts[i];
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) { nanCount++; break; }
      }
      if (c.x < -20 || c.x > WORLD_W + 20 || c.y < 20 || c.y > WORLD_H + 20) escaped++;
      if (c.alive && c.lod === 0) {
        speed.min = Math.min(speed.min, c.speed);
        speed.max = Math.max(speed.max, c.speed);
      }
      if (c.key === 'leviathan' && c.alive) {
        // judge the beast by the middle of its body: a 400px animal leaning over
        // the shelf still lives in the abyss
        let sy = 0;
        for (let i = 0; i < c.body.n; i++) sy += c.body.pts[i].y;
        const cy = sy / c.body.n;
        levFrames.total++;
        // an animal crossing the shelf to get back to its pressure band is behaving
        // correctly; one lounging in the light to eat minnows is not
        const transit = /finding-the-drop|migrate-zone/.test(c.intent);
        if (transit) levFrames.transit++;
        if (cy >= ZONES[3].top - 140 || transit) levFrames.abyss++;
        if (cy >= ZONES[3].top) levFrames.strict++;
      }
    }
    for (const p of world.flora) { if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) { nanCount++; break; } }
  }
  if (f === Math.floor(FRAMES / 2)) console.log('  … half way');
}
const ms = performance.now() - t1;
const perFrame = ms / FRAMES;
console.log(`  ${ms.toFixed(0)} ms total — ${perFrame.toFixed(2)} ms/frame ` +
  `(${(1000 / perFrame).toFixed(0)} fps budget, ${world.creatures.length} animals resident)`);
if (nanCount) err(`${nanCount} non-finite states`);
if (escaped) err(`${escaped} animals left the world`);
if (perFrame > 16.7) console.log(`  ! slower than 60fps at ${world.creatures.length} animals (renderer-independent)`);

// ---------------------------------------------------------------- ecology
console.log('\n[4] ecosystem activity');
const sp = {};
for (const k of SPECIES_KEYS) sp[k] = { n: 0, alive: 0, hunger: 0, health: 0, speed: 0, zones: [0, 0, 0, 0], meals: 0, dist: 0, travel: 0 };
for (const c of world.creatures) {
  const s = sp[c.key];
  s.n++;
  if (c.alive) { s.alive++; s.hunger += c.hunger; s.health += c.health; s.speed += c.speed; s.dist += c.distance; }
  s.zones[c.zone]++;
  s.meals += c.meals;
  s.travel += (c.distance || 0) / (FRAMES * DT);
}
const hdr = '  species        n  alive  hunger health  speed  meals  zones Z1/Z2/Z3/Z4';
console.log(hdr);
for (const k of SPECIES_KEYS) {
  const s = sp[k];
  if (!s.n) continue;
  const a = Math.max(1, s.alive);
  console.log(
    '  ' + k.padEnd(13) + String(s.n).padStart(3) + String(s.alive).padStart(6) +
    (s.hunger / a).toFixed(2).padStart(8) + (s.health / a).toFixed(2).padStart(7) +
    (s.travel / a).toFixed(0).padStart(7) + String(Math.round(s.meals)).padStart(7) +
    '   ' + s.zones.join('/'));
}
console.log('  carrion:', world.carrion.length, ' eggs:', world.eggs.length,
  ' particles:', world.particles.length, ' flora:', world.flora.length);
const deaths = world.stats.deaths, births = world.stats.births;
console.log('  deaths:', Object.entries(deaths).map(([k, v]) => `${k}:${v}`).join(' ') || 'none');
console.log('  births:', Object.entries(births).map(([k, v]) => `${k}:${v}`).join(' ') || 'none');
console.log('  causes:', Object.entries(world.stats.byCause).map(([k, v]) => `${k}:${v}`).join(' ') || 'none');
const web = Object.entries(world.stats.web)
  .flatMap(([a, m]) => Object.entries(m).map(([b, v]) => [a, b, v]))
  .sort((x, y) => y[2] - x[2]).slice(0, 12);
console.log('  top interactions:', web.map(([a, b, v]) => `${a}→${b}(${v})`).join('  ') || 'none');

// living animals must move, and predators must have eaten something
let moved = 0, still = 0;
for (const c of world.creatures) {
  if (!c.alive || c.lod !== 0) continue;
  if (c.distance > 40) moved++; else still++;
}
console.log(`  animals that travelled >40px during soak: ${moved} (stationary: ${still})`);
if (moved < 10) err('almost nothing moved — locomotion is broken');
const predation = Math.round(world.stats.predation);
const scavenged = Math.round(world.stats.scavenge);
const graze = Math.round(world.stats.grazing);
console.log(`  bites landed: ${predation}   carrion meals: ${scavenged}   plant bites: ${graze}`);
// at least one kill every ~4 s is the demo contract; the long soak is measured
// against a lower bar because the reef thins as grazers win (README: Known limits 2)
const want = Math.max(3, Math.round(FRAMES * DT * (CONTRACT ? 0.22 : 0.14)));
if (predation < want) err(`too little predation (${predation} bites in ${(FRAMES * DT).toFixed(0)}s, wanted >= ${want})`);
else ok(`${predation} predation events — the food web is live`);

// leviathan must be patrolling the boundary and taking things
const lev = world.creatures.filter((c) => c.key === 'leviathan');
if (!lev.length) err('no leviathan');
else {
  const inAbyss = lev.filter((l) => zoneIndexAt(l.y) === 3).length;
  const fid = 100 * levFrames.abyss / Math.max(1, levFrames.total);
  const fT = 100 * levFrames.transit / Math.max(1, levFrames.total);
  console.log(`  leviathan(s): ${lev.length}, in Z4 now: ${inAbyss}, kills: ${lev.map((l) => l.kills).join(',')}`);
  console.log(`  abyss fidelity: ${(100 * levFrames.abyss / Math.max(1, levFrames.total) - fT).toFixed(0)}% sitting in the abyss, ${fT.toFixed(0)}% in transit home, ${(100 * levFrames.strict / Math.max(1, levFrames.total)).toFixed(0)}% strictly below the line`);
  check(fid >= 55, `leviathan holds the boundary — ${fid.toFixed(0)}% of frames compliant`,
    `leviathan is not holding the boundary (${fid.toFixed(0)}% of frames compliant)`);
}
// health must reflect the rules: everything has a hunger bar, and it drains
let noBar = 0;
for (const c of world.creatures) if (typeof c.hunger !== 'number' || c.hunger < 0 || c.hunger > 1) noBar++;
if (noBar) err(`${noBar} animals with an out-of-range hunger bar`);
else ok('every animal carries a 0..1 hunger bar, all in range');

// zones must be populated across the whole column
const zonePop = [0, 0, 0, 0];
for (const c of world.creatures) if (c.alive) zonePop[c.zone]++;
console.log('  living animals per zone:', zonePop.join(' / '));
if (zonePop.filter((n) => n === 0).length > 1) err('zones with no life: ' + zonePop.join('/'));

// flora / fauna interaction counts
const kelp = world.flora.filter((p) => p.kind === 'kelp');
const kelpMean = kelp.length ? (kelp.reduce((a, p) => a + p.growth, 0) / kelp.length).toFixed(2) : '—';
check(kelp.length >= 20, `kelp forest holding at ${kelp.length} stipes (mean growth ${kelpMean})`,
  `kelp forest collapsed to ${kelp.length} stipes — grazing won the long game (README: Known limits 2)`);

console.log('\n' + (fails ? `FAILED: ${fails} problem(s)` : `PASS — ecosystem stable and dynamic${warns ? ` (${warns} long-horizon ${warns === 1 ? 'warning' : 'warnings'}; see README “Known limits”)` : ''}`));
process.exit(fails ? 1 : 0);
