// ---------------------------------------------------------------------------
//  BEHAVIOUR TREES  (generated procedurally, one per individual organism)
//
//  A tree is a tiny recursive structure of 5 node kinds:
//    sel   fallback      first child that is not FAILURE drives the animal
//    seq   conjunction   every child must succeed
//    con   condition     reads the blackboard, no side effects
//    act   action        writes an *intent* (heading / speed / target / mode)
//    dec   decorator     inverter | cooldown | chance  (adds individuality)
//
//  Nothing here knows about physics: actions only set `c.want*` fields, and
//  the motor layer in creature.js turns intents into muscle + limb commands.
//  That split is what lets the same tree drive a fish, a crab or the
//  leviathan, and lets us draw the tree live in the inspector.
//
//  `genTree()` builds a tree from (a) the species' behavioural vocabulary,
//  (b) the individual's temperament vector, (c) its own RNG stream. So two
//  animals of the same species genuinely prioritise differently: one is a
//  nervous grazer that bolts at 40 px of threat distance, its sibling hunts at
//  hunger 0.45 instead of 0.72.
// ---------------------------------------------------------------------------

import { clamp, clamp01 } from '../core/vec.js';

export const RUNNING = 1, SUCCESS = 2, FAILURE = 3;

export const ACTIONS = Object.create(null);
export const CONDITIONS = Object.create(null);

export function registerAction(name, fn, meta = {}) {
  ACTIONS[name] = fn;
  ACTIONS[name].meta = meta;
}
export function registerCondition(name, fn, meta = {}) {
  CONDITIONS[name] = fn;
  CONDITIONS[name].meta = meta;
}

let _nid = 1;
export function node(type, name, params = {}, children = []) {
  return {
    id: _nid++, type, name, params, children,
    st: { s: 0, t: 0, cool: 0, child: 0, age: 0, runs: 0, last: 0 },
    depth: 0,
  };
}
export const act = (n, p) => node('act', n, p || {});
export const con = (n, p) => node('con', n, p || {});
// both composites silently drop `null` children so generator branches can
// be conditional without noise
export const sel = (...ch) => node('sel', 'selector', {}, ch.filter(Boolean));
export const seq = (...ch) => node('seq', 'sequence', {}, ch.filter(Boolean));
export const dec = (kind, child, p) => node('dec', kind, p || {}, [child]);

// ---------------------------------------------------------------------------
//  evaluation
// ---------------------------------------------------------------------------
export function tickTree(root, c, dt) {
  root.st.age += dt;
  return _tick(root, c, dt);
}

function _tick(n, c, dt) {
  const st = n.st;
  st.t += dt;
  if (st.cool > 0) st.cool -= dt;
  let s;
  switch (n.type) {
    case 'sel': {
      // PURE PRIORITY SELECTOR. Every tick re-reads the tree from the top, so a
      // branch that outranks the one currently acting can always take over:
      // hunger interrupts a patrol, a shadow interrupts a feed, crossing the
      // abyss line interrupts everything. The preempted branch is not ticked at
      // all while it is outranked, so it resumes exactly where it left off.
      s = FAILURE;
      const ch = n.children;
      let i = 0;
      for (; i < ch.length; i++) {
        const r = _tick(ch[i], c, dt);
        if (r === RUNNING || r === SUCCESS) { s = r; break; }
      }
      st.child = s === FAILURE ? -1 : i;
      break;
    }
    case 'seq': {
      s = SUCCESS;
      const ch = n.children;
      for (let i = 0; i < ch.length; i++) {
        const r = _tick(ch[i], c, dt);
        if (r === FAILURE) { s = FAILURE; break; }
        if (r === RUNNING) { s = RUNNING; break; }
      }
      break;
    }
    case 'dec': {
      const child = n.children[0];
      let r = FAILURE;
      const kind = n.name;
      if (kind === 'cooldown') {
        if (st.cool <= 0) { r = _tick(child, c, dt); if (r !== FAILURE) st.cool = n.params.t ?? 3; }
      } else if (kind === 'inverter') {
        r = _tick(child, c, dt);
        r = r === SUCCESS ? FAILURE : r === FAILURE ? SUCCESS : RUNNING;
      } else if (kind === 'chance') {
        if (st.runs === 0 || st.t > (n.params.every ?? 0.7)) {
          st.t = 0;
          st.mem = (c.rand ? c.rand.f() : Math.random()) < (n.params.p ?? 0.5) ? 1 : 0;
        }
        r = st.mem ? _tick(child, c, dt) : FAILURE;
      } else if (kind === 'timeout') {
        if (st.age > (n.params.t ?? 4)) { st.age = 0; r = FAILURE; }
        else { r = _tick(child, c, dt); if (r !== RUNNING) st.age = 0; }
      } else {
        r = _tick(child, c, dt);
      }
      s = r;
      break;
    }
    case 'con': {
      const f = CONDITIONS[n.name];
      s = f ? (f(c, n.params, dt) ? SUCCESS : FAILURE) : FAILURE;
      break;
    }
    case 'act': {
      const f = ACTIONS[n.name];
      s = f ? f(c, n, dt) : FAILURE;
      st.runs++;
      // patience: a running action that never resolves gets force-failed so the
      // animal re-decides. Thresholds are per-individual (generated).
      if (s === RUNNING && n.params.patience && st.t > n.params.patience) {
        st.t = 0;
        s = FAILURE;
      }
      break;
    }
    default: s = FAILURE;
  }
  st.last = st.s;
  st.s = s;
  return s;
}

/** the chain of nodes currently driving the animal (for the inspector) */
export function activePath(root, out = []) {
  let n = root;
  let guard = 0;
  while (n && guard++ < 24) {
    out.push(n);
    if (n.children.length) {
      const run = n.children.find((ch) => ch.st.s === RUNNING);
      n = run || n.children[n.st.child] || n.children[0];
    } else break;
  }
  return out;
}

export function leafCount(n) {
  if (!n.children.length) return 1;
  let s = 0;
  for (const c of n.children) s += leafCount(c);
  return s;
}

// ---------------------------------------------------------------------------
//  generator
// ---------------------------------------------------------------------------
/**
 * @param {Rand} rand        individual RNG stream
 * @param {object} tpl       species template: {acts, cons, temperament, must, hungerLadder}
 */
/** identify a generated branch by any condition/action name inside it */
function branchName(n) {
  // composites all answer to the name 'sequence'/'selector', so identity has to
  // be read off the leaves underneath — otherwise nothing ever matches here
  let seen = '';
  (function walk(k, d) {
    if (!k || d > 3) return;
    if (!k.children || !k.children.length) { seen += (k.name || '') + ','; return; }
    for (const c of k.children) walk(c, d + 1);
  })(n, 0);
  if (/ReturnToNest|PatrolTerritory/.test(seen)) return 'home';
  if (/ForageNearby|Threaten/.test(seen)) return 'content';
  return seen;
}

function huntRank(nm) {
  return /hunt|chase|sweep|pursue|vacuum|migrate|forage|scavenge|stalk/i.test(nm) ? 0 : 1;
}

export function genTree(rand, tpl) {
  const temper = tpl.temperament || {};
  const bold = clamp01(temper.boldness ?? 0.5);
  const nerv = clamp01(temper.nervousness ?? 0.5);
  const aggr = clamp01(temper.aggression ?? 0.5);
  const soci = clamp01(temper.sociability ?? 0.5);
  const curio = clamp01(temper.curiosity ?? 0.5);

  const hungerStart = clamp(0.55 + rand.r(-0.18, 0.22) - nerv * 0.1, 0.25, 0.92);
  const threatR = Math.round(clamp(150 + nerv * 260 + rand.r(-40, 90), 70, 460));
  const preyR = Math.round(clamp(190 + aggr * 320 + rand.r(-50, 120), 90, 620));

  /** randomised parameter set for an action, from its meta spec */
  function paramsFor(name, base = {}) {
    const meta = (ACTIONS[name] && ACTIONS[name].meta) || {};
    const p = { ...base };
    for (const k in meta) {
      const spec = meta[k];
      if (base[k] !== undefined) continue;      // explicit params beat randomised ones
      if (typeof spec !== 'object' || spec === null || spec.min === undefined) continue;
      const jitter = 1 + (rand.f() - 0.5) * (spec.jitter ?? 0.34);
      let v = (spec.min + (spec.max - spec.min) * (0.5 + (rand.f() - 0.5) * 0.7)) * jitter;
      if (spec.round) v = Math.round(v);
      p[k] = clamp(v, spec.min * 0.4, spec.max * 2.2);
    }
    return p;
  }
  function mkAct(name, base) { return act(name, paramsFor(name, base)); }
  function mkCon(name, base) { return con(name, paramsFor(name, base)); }

  function c_hungry(v) { return clamp01(1.5 - v) * 0.9; }
  /** a few distinct picks so one animal can own several hunting moves */
  function pickMany(pool, k) {
    const out = [];
    if (!pool) return out;
    const used = new Set();
    for (let i = 0; i < k * 3 && out.length < k; i++) {
      const n = pick(pool);
      if (!used.has(n)) { used.add(n); out.push(n); }
    }
    for (const n of out) used.delete(n);
    return out;
  }
  function many(names, range, tag) {
    return names.slice(0, 3).map((nm) => mkAct(nm, { range, ladder: tag }));
  }
  /** pick from a weighted pool, respecting temperament */
  function pick(pool) {
    const items = pool
      .map((k) => {
        const w = typeof k === 'string' ? [k, 1] : k;
        let mul = 1;
        const name = w[0];
        if (/hunt|strike|attack|ambush|pounce|burst|consume|lash|grab/i.test(name)) mul *= 0.35 + aggr * 2.1;
        if (/flee|hide|freeze|retreat|play|dive|burrow|clamp/i.test(name)) mul *= 0.35 + nerv * 2.1;
        if (/school|follow|court|protect|alarm|mob|shoal/i.test(name)) mul *= 0.2 + soci * 2.4;
        if (/explore|wander|lurk|inspect|drift|investigate/i.test(name)) mul *= 0.3 + curio * 2.0;
        if (/forage|graze|filter|scavenge|bask|rest|gulp/i.test(name)) mul *= 0.6 + (1 - bold) * 1.1;
        return [name, w[1] * Math.max(0.05, mul)];
      });
    return rand.weighted(items);
  }

  const branches = [];

  // ---- 1. self preservation: threats ------------------------------------
  // Fleeing is a *state with an exit*: ThreatNear carries hysteresis (see the
  // condition) so an animal that has put distance on its predator goes back to
  // feeding. Without that the whole reef would starve from sheer nerves.
  const fleePool = tpl.flee || [['FleeThreat', 3]];
  const fleeMoves = pickMany(fleePool, 3).map((nm) => mkAct(nm, { r: threatR }));
  const threatBranch = seq(
    con('ThreatNear', { r: threatR, r2: threatR * threatR }),
    sel(
      ...shuffle(rand, [
        seq(mkCon('HealthBelow', { v: 0.42 }), mkAct('BurstEscape')),
        ...fleeMoves,
        mkAct('FreezeHide', { dur: rand.r(0.6, 2.4) }),
        mkAct('RetreatToShelter', { r: threatR * 3 }),
        tpl.canCling ? mkAct('ClingToRock') : null,
        soci > 0.45 ? mkAct('AlarmCall') : null,
        soci > 0.6 ? seq(con('CrowdAbove', { n: 3 }), mkAct('MobPredator')) : null,
      ])
    )
  );
  branches.push(threatBranch);

  // ---- 1b. breathing: an air-breathing animal must surface, and that trumps feeding
  if (tpl.needsAir || tpl.airAt) {
    branches.push(seq(con('AirLow', { v: 0.6 }), sel(mkAct('GulpAir'), mkAct('ReturnHome', { speed: 1.15 }))));
  }

  // ---- 2. hunger escalation ladder ---------------------------------------
  // Each rung unlocks at a lower hunger and authorises a bigger travel radius,
  // so a sated animal sits its territory while a starving one will cross the
  // whole world — including hostile zones — to reach the next feeding ground.
  // Rung order is fixed (it IS the priority); only the moves inside a rung are
  // shuffled, which is what makes individuals differ in style, not in need.
  const hunts = pickMany(tpl.hunt, 3);
  const feeds = pickMany(tpl.feed, 3);
  const pursuit = hunts.slice().sort((a, b) => huntRank(a) - huntRank(b));
  const risky = [];
  if (tpl.mustFeed) risky.push(seq(con('HungerBelow', { v: 0.2 }), mkAct('ForageDesperate')));
  if (tpl.hunt) {
    risky.push(rung(0.14, pursuit, Math.round(preyR * 3.2), 'crosszone'));
    risky.push(rung(0.30, pursuit, Math.round(preyR * 2.0), 'far'));
    risky.push(rung(0.48, pursuit, Math.round(preyR * 1.35), 'mid'));
    risky.push(seq(con('HungerBelow', { v: hungerStart }),
      seq(con('PreyNear', { r: preyR }), alt(hunts.slice(0, 2), Math.round(preyR * 1.15), 'near'))));
  }
  if (tpl.feed) {
    risky.push(rung(0.20, feeds, Math.round(preyR * 2.4), 'far'));
    risky.push(rung(0.40, feeds, Math.round(preyR * 1.6), 'mid'));
  }
  risky.push(seq(con('HungerBelow', { v: 0.34 }), mkAct('MigrateToFood', { range: 900 })));
  risky.push(seq(con('HungerBelow', { v: 0.16 }), mkAct('DriftDown')));
  branches.push(sel(...risky.filter(Boolean)));

  /** a hunger gate plus a *choice* of ways to satisfy it */
  function rung(v, names, range, tag) {
    if (!names || !names.length) return null;
    return seq(con('HungerBelow', { v }), alt(names, range, tag));
  }
  function alt(names, range, tag) {
    const acts = names.slice(0, 3).map((nm) => mkAct(nm, { range, ladder: tag }));
    return acts.length > 1 ? sel(...shuffle(rand, acts)) : acts[0];
  }

  // ---- 3. zone / depth stress -------------------------------------------
  if (tpl.zoneStrict) {
    // An abyssal specialist does not negotiate: while it is out of its pressure
    // band this overrides everything else, so it cannot be distracted by food,
    // a mate or a threat while it is finding its way back down.
    branches.unshift(seq(con('ZoneMismatch', {}), mkAct('MigrateToZone', { zone: tpl.homeZone ?? 1, tough: 1, patience: 1e9 })));
  }
  const zoneBranch = seq(
    con('ZoneMismatch', {}),
    sel(mkAct('ReturnHome', { speed: 1 }), mkAct('MigrateToZone', { zone: tpl.homeZone ?? 1, tough: 1 }), mkAct('HardenShell'), mkAct('TuckIntoCrevice'))
  );
  if (tpl.zoneAvoid !== false) branches.push(zoneBranch);

  // ---- 4. territory + nest fidelity (well-fed animals hold position) ----
  const homeBranch = seq(
    con('HungerAbove', { v: hungerStart + 0.16 }),
    sel(
      seq(con('FarFromNest', { d: tpl.nestR ?? 260 }), mkAct('ReturnToNest')),
      mkAct('PatrolTerritory', { r: (tpl.nestR ?? 260) * 0.8 }),
      tpl.rest ? mkAct(pick(tpl.rest)) : null,
      soci > 0.4 ? mkAct('SchoolWith', { r: rand.r(40, 130) }) : null,
      tpl.canCling ? dec('cooldown', mkAct('ClimbWall'), { t: rand.r(6, 18) }) : null,
      tpl.bask ? mkAct('BaskLight') : null,
      mkAct('HoldGround'),
    )
  );
  branches.push(homeBranch);

  // ---- 5. content foraging + opportunistic strikes -----------------------
  // Well-fed predators take what wanders into reach but do not pursue: this is
  // the "stable, non-aggressive, stays near home" state the brief asks for.
  if (tpl.feed || tpl.hunt) {
    const opts = [];
    if (tpl.hunt && hunts.length) {
      opts.push(seq(con('PreyNear', { r: Math.round(preyR * (bold > 0.5 ? 1.4 : 0.85)) }),
        alt(hunts.slice(0, 2), Math.round(preyR * 1.05), 'opportunistic')));
    }
    if (tpl.feed) opts.push(alt(feeds, Math.round(preyR * 0.8), 'local'));
    opts.push(mkAct('ForageNearby', { range: 150 }));
    if (tpl.hunt) opts.push(seq(con('PreyNear', { r: 90 }), mkAct('Threaten')));
    const huntBranch = seq(con('HungerBelow', { v: Math.min(0.97, hungerStart + 0.3) }), sel(...shuffle(rand, opts)));
    // carnivores feed first and hold territory second; grazers keep the order
    if (tpl.hunt) branches.splice(Math.min(branches.length, 3), 0, huntBranch);
    else branches.push(huntBranch);
  }

  // ---- 6. reproduction (inserted at high priority, see below) ------------
  const broodBranch = tpl.reproduce === false ? null : seq(
    // ready, already paired, or answering a call
    sel(con('CanReproduce', {}), con('Courting', {}), con('HeardCall', {})),
    // a mature clutch gets laid; otherwise go and find someone to court
    sel(
      seq(con('Gestating', {}), dec('cooldown', mkAct('SpawnEggs'), { t: rand.r(2, 6) })),
      mkAct('CourtMate', { patience: rand.r(10, 26) }),
    ),
  );

  // ---- 7. scavenging / opportunism (shared by most carnivores) ----------
  if (aggr > 0.32) {
    branches.push(seq(con('CarcassNear', { r: Math.round(preyR * 1.9) }), mkAct('Scavenge')));
  }
  if (curio > 0.5) {
    branches.push(dec('cooldown', seq(con('LightBelow', { v: 0.2 }), con('GlitterNear', { r: 260 }), mkAct('InvestigateLight')), { t: rand.r(4, 14) }));
  }

  // ---- 8. default: explore / drift --------------------------------------
  branches.push(sel(
    mkAct('Wander', { bias: rand.r(0.15, 0.9), step: rand.r(1.4, 4.6) }),
    mkAct('Drift'),
    mkAct('HoldGround'),
  ));

  let root = sel(...branches);

  // Breeding outranks foraging and territory: an animal that is fat, healthy and
  // ready does not keep grazing — it goes looking for a mate. It still sits below
  // survival, so a starving or frightened animal never breeds. This has to run
  // against root.children: `sel` copied the branch list, so the array is read-only
  // from here on.
  if (broodBranch) {
    let at = root.children.length;
    for (let i = 0; i < root.children.length; i++) {
      const nm = branchName(root.children[i]);
      if (nm === 'home' || nm === 'content') { at = i; break; }
    }
    root.children.splice(at, 0, broodBranch);
    assignDepth(broodBranch, 1);
  }

  // ---- post-passes: personality mutations --------------------------------
  if (rand.chance(0.34)) root = dec('chance', root, { p: rand.r(0.55, 0.9), every: rand.r(0.4, 1.4) });
  // insert an opportunistic ambush sequence forambush predators
  if (tpl.ambush) {
    const amb = seq(con('PreyNear', { r: Math.round(preyR * 0.8) }), mkAct(pick(tpl.ambush)));
    root.children.splice(1 + (rand.chance(0.5) ? 1 : 0), 0, amb);
  }
  // nervous individuals insert a "flight first, think later" override at the top
  if (nerv > 0.62) {
    root.children.unshift(seq(con('ThreatNear', { r: Math.round(threatR * 0.6), r2: threatR * threatR * 0.36 }), mkAct('FleeThreat', { r: threatR, hard: 1 })));
  }
  // some individuals hoard safety: repeat the shelter branch deeper down
  if (tpl.caveBound && rand.chance(0.6)) {
    root.children.push(seq(con('TimeSince', { t: rand.r(12, 40) }), mkAct('RetreatToShelter', { r: 700 })));
  }
  // a rare "rogue" trait: a wholly extra behaviour copied from another branch
  if (rand.chance(0.22) && root.children.length > 3) {
    const src = root.children[rand.i(1, root.children.length - 1)];
    if (src.children.length) {
      const clone = shallowClone(rand.pick(src.children));
      root.children[rand.i(0, root.children.length - 1)] = clone;
    }
  }
  // small chance of an additional decorator wrapping a random branch
  if (rand.chance(0.5)) {
    const idx = rand.i(0, root.children.length - 1);
    const kinds = [['cooldown', { t: rand.r(2, 9) }], ['timeout', { t: rand.r(3, 12) }], ['chance', { p: rand.r(0.35, 0.85) }]];
    const k = rand.pick(kinds);
    root.children[idx] = dec(k[0], root.children[idx], k[1]);
  }


  assignDepth(root, 0);
  root.stats = { hungerStart, threatR, preyR, bold, nerv, aggr, soci, curio };
  return root;
}

function shuffle(rand, arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = rand.i(0, i);
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}
function shallowClone(n) {
  const c = node(n.type, n.name, { ...n.params }, n.children.map(shallowClone));
  c.st = { s: 0, t: 0, cool: 0, child: 0, age: 0, runs: 0, last: 0, mem: 0 };
  return c;
}
function assignDepth(n, d) {
  n.depth = d;
  for (const ch of n.children) assignDepth(ch, d + 1);
}

// ---------------------------------------------------------------------------
//  readouts (inspector panel + debug overlay)
// ---------------------------------------------------------------------------
export function label(n) {
  if (n.type === 'sel') return 'FALLBACK';
  if (n.type === 'seq') return 'SEQUENCE';
  if (n.type === 'dec') return n.name.toUpperCase();
  const p = fmtParams(n.params);
  return `${n.name}${p ? ' ' + p : ''}`;
}
export function fmtParams(p) {
  const keys = Object.keys(p || {});
  if (!keys.length) return '';
  return '[' + keys.slice(0, 4).map((k) => {
    const v = p[k];
    return `${k}:${typeof v === 'number' ? (Math.abs(v) < 1 ? v.toFixed(2) : Math.round(v)) : v}`;
  }).join(' ') + ']';
}

export function treeText(n, depth = 0, out = []) {
  const status = ['·', '▶', '✓', '✗'][n.st.s] || '·';
  out.push('  '.repeat(depth) + status + ' ' + label(n));
  for (const ch of n.children) treeText(ch, depth + 1, out);
  return out;
}

/** simple tidy layout for the inspector's live tree diagram */
export function layoutTree(root, cellW = 92, cellH = 20) {
  const nodes = [], links = [];
  let leaf = 0;
  (function walk(n, parent) {
    const me = { n, x: 0, y: n.depth * cellH, w: cellW, h: cellH - 3, id: nodes.length };
    nodes.push(me);
    if (parent) links.push([parent, me]);
    if (!n.children.length) {
      me.x = leaf++ * cellW;
    } else {
      const start = leaf;
      for (const ch of n.children) walk(ch, me);
      const a = nodes[start].x, b = nodes[nodes.length - 1].x;
      me.x = (a + b) / 2;
    }
    return me;
  })(root, null);
  return { nodes, links, w: Math.max(1, leaf) * cellW, h: (maxDepth(root) + 1) * cellH };
}
function maxDepth(n) {
  let m = n.depth;
  for (const ch of n.children) m = Math.max(m, maxDepth(ch));
  return m;
}

/** rough one-line personality summary, shown in the inspector */
export function personality(root) {
  const s = root.stats || {};
  const bits = [];
  bits.push(s.bold > 0.62 ? 'bold' : s.bold < 0.34 ? 'timid' : 'measured');
  bits.push(s.nerv > 0.62 ? 'skittish' : s.nerv < 0.34 ? 'placid' : 'watchful');
  bits.push(s.aggr > 0.62 ? 'ruthless' : s.aggr < 0.34 ? 'non-aggressive' : 'opportunistic');
  bits.push(s.soci > 0.62 ? 'gregarious' : s.soci < 0.3 ? 'solitary' : 'tolerant');
  if (s.curio > 0.6) bits.push('curious');
  return bits.join(', ');
}

