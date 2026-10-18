// ---------------------------------------------------------------------------
//  SPECIES CODEX
//
//  A species is: a body plan (segment + limb topology), a physics signature
//  (drag anisotropy, buoyancy, compressible gas), a sensory model, a trophic
//  position, and a behaviour-tree TEMPLATE. The template supplies the action
//  vocabulary + temperament; genTree() then emits a unique tree per animal.
//
//  Locomotion families are deliberately different:
//    swim   undulating vertebral chain, thrust from anisotropic water drag
//    drift  buoyant pulse of a segmented bell ring (jellies)
//    walk   8 IK legs, weight through planted feet, sticks to any slope
//    cling  same 8 legs, but face-on to a vertical/background surface
//    root   sessile flora (also BT-driven: growth is a decision, not a curve)
// ---------------------------------------------------------------------------

import { TAU, PI } from '../core/vec.js';
import { LEVIATHAN_LINE } from './zones.js';

export const FLORA_KINDS = ['kelp', 'coral', 'mat', 'biofilm', 'anemone', 'barnacle'];

/** ---- limb-plan helpers ------------------------------------------------- */
function fishLimbs({ dorsal = 1, pec = 1, caudal = true, pelvic = 1, jaw = 0 }) {
  const L = [];
  if (dorsal) L.push({ kind: 'fin', name: 'dorsal', count: dorsal, seg: [2, 4], side: -1, len: [7, 5], r: 1.4, amp: 0.24, freq: 1.1, active: true });
  if (pec) L.push({ kind: 'fin', name: 'pectoral', count: pec, seg: 2, side: 'both', len: [8, 6], r: 1.3, amp: 0.5, freq: 2.4, active: true });
  if (pelvic) L.push({ kind: 'fin', name: 'pelvic', count: pelvic, seg: [4, 6], side: 'both', len: [5, 4], r: 1, amp: 0.4, freq: 2.0, active: true });
  if (caudal) L.push({ kind: 'fin', name: 'caudal', count: 1, seg: 'tail', side: 0, len: [9, 7], r: 1.2, amp: 0.55, freq: 1, active: true, tail: true });
  if (jaw) L.push({ kind: 'mandible', name: 'jaw', count: jaw, seg: 0, side: 'both', len: [5, 4], r: 1.1, amp: 0.2, close: 0.5 });
  return L;
}
function crabLimbs({ legs = 8, claws = 2, antennae = 2 } = {}) {
  const L = [];
  L.push({
    kind: 'leg', name: 'walker', count: legs, seg: [1, 4], side: 'both',
    len: [8, 7, 4], r: 1.5, reach: 26, stride: 0.85, gaitFreq: 6.4, active: true,
  });
  if (claws) L.push({ kind: 'claw', name: 'cheliped', count: claws / 2, seg: 0, side: 'both', len: [9, 7, 5], r: 2.1, reach: 34, close: 0.35, amp: 0.1 });
  if (antennae) L.push({ kind: 'antenna', name: 'antenna', count: antennae / 2, seg: 0, side: 'both', len: [9, 8, 6], r: 0.7, drag: 0.9, amp: 0.12, active: true });
  return L;
}
function eelLimbs(fronds = 5) {
  return [
    { kind: 'fin', name: 'frond', count: fronds, seg: [2, 11], side: 'both', len: [11, 8], r: 1.1, amp: 0.5, freq: 0.85, active: true, leaf: true },
  ];
}
function jellyLimbs(tent = 8, oral = 4) {
  return [
    { kind: 'tentacle', name: 'tentacle', count: tent, seg: 'tail', side: 0, len: [9, 8, 7, 6], r: 0.9, drag: 0.955, amp: 0.3, freq: 0.7, active: true, sting: true },
    { kind: 'tentacle', name: 'oral', count: oral, seg: 'tail', side: 0, len: [7, 6, 5], r: 1.5, drag: 0.94, amp: 0.42, freq: 0.5, active: true, sting: true },
  ];
}
function leviathanLimbs() {
  return [
    // six heavily articulated strike mandibles: 3 bones each, independent IK
    { kind: 'mandible', name: 'mandible', count: 3, seg: 0, side: 'both', len: [26, 22, 15], r: 3.4, reach: 86, close: 0.24, amp: 0.06 },
    { kind: 'fin', name: 'dorsalfin', count: 4, seg: [6, 16], side: -1, len: [16, 12], r: 1.8, amp: 0.3, freq: 0.7, active: true },
    { kind: 'photophore', name: 'lure', count: 1, seg: 0, side: -1, len: [20, 15, 11], r: 1.6, drag: 0.9, amp: 0.5, freq: 0.4, active: true, glow: 1 },
  ];
}
function urchinLimbs(spines = 13) {
  return [
    { kind: 'spine', name: 'spine', count: spines, seg: 'tail', side: 0, len: [11, 8], r: 1.5, drag: 0.9, amp: 0.5, freq: 1.6, active: true },
    { kind: 'leg', name: 'tubefoot', count: 6, seg: [0, 3], side: 'both', len: [5, 4], r: 0.9, reach: 15, stride: 0.4, gaitFreq: 1.6, active: true },
  ];
}
function snailLimbs() {
  return [
    { kind: 'leg', name: 'foot', count: 5, seg: [0, 2], side: 1, len: [6, 5], r: 1.6, reach: 12, stride: 0.3, gaitFreq: 1.1, active: true, wave: true },
    { kind: 'antenna', name: 'eyestalk', count: 2, seg: 0, side: 'both', len: [6, 5], r: 0.9, drag: 0.86, amp: 0.3, freq: 0.5, active: true },
  ];
}
function anglerLimbs() {
  return [
    { kind: 'mandible', name: 'fangrow', count: 3, seg: 0, side: 'both', len: [7, 5], r: 1.3, close: 0.3 },
    { kind: 'fin', name: 'pectoral', count: 1, seg: 3, side: 'both', len: [9, 7], r: 1.2, amp: 0.55, freq: 2.8, active: true },
    { kind: 'fin', name: 'dorsal', count: 1, seg: 4, side: -1, len: [8, 6], r: 1.1, amp: 0.3, freq: 1.2, active: true },
    { kind: 'antenna', name: 'esca', count: 1, seg: 0, side: -1, len: [13, 11, 8], r: 1, drag: 0.9, amp: 0.5, freq: 0.55, active: true, glow: 1 },
  ];
}
function sharkLimbs() {
  return [
    { kind: 'fin', name: 'dorsal', count: 2, seg: [3, 5], side: -1, len: [13, 9], r: 1.6, amp: 0.2, freq: 0.9, active: true, notch: true },
    { kind: 'fin', name: 'pectoral', count: 1, seg: 3, side: 'both', len: [15, 11], r: 1.7, amp: 0.42, freq: 1.5, active: true, rigid: true },
    { kind: 'fin', name: 'pelvic', count: 1, seg: 6, side: 'both', len: [8, 6], r: 1.2, amp: 0.34, freq: 1.5, active: true },
    { kind: 'fin', name: 'caudal', count: 1, seg: 'tail', side: 0, len: [17, 13], r: 2, amp: 0.62, freq: 1, active: true, tail: true, heterocercal: true },
    { kind: 'mandible', name: 'jaw', count: 2, seg: 0, side: 'both', len: [7, 5], r: 1.5, close: 0.42 },
  ];
}
function crawlerLimbs() {
  return [
    { kind: 'leg', name: 'walker', count: 6, seg: [1, 4], side: 'both', len: [7, 6, 4], r: 1.2, reach: 22, stride: 0.8, gaitFreq: 7.5, active: true },
    { kind: 'antenna', name: 'antenna', count: 2, seg: 0, side: 'both', len: [14, 12, 9], r: 0.7, drag: 0.92, amp: 0.2, freq: 0.7, active: true },
    { kind: 'mandible', name: 'pincer', count: 2, seg: 0, side: 'both', len: [6, 5], r: 1.1, close: 0.5 },
  ];
}
function garpikeLimbs() {
  return [
    { kind: 'mandible', name: 'needle', count: 4, seg: 0, side: 'both', len: [6, 4], r: 0.9, close: 0.6 },
    { kind: 'fin', name: 'dorsal', count: 1, seg: 5, side: -1, len: [9, 7], r: 1.2, amp: 0.26, freq: 1.3, active: true },
    { kind: 'fin', name: 'pectoral', count: 1, seg: 3, side: 'both', len: [7, 5], r: 1, amp: 0.5, freq: 2.6, active: true },
    { kind: 'fin', name: 'caudal', count: 1, seg: 'tail', side: 0, len: [10, 8], r: 1.2, amp: 0.5, freq: 1, active: true, tail: true },
  ];
}
function tangLimbs() {
  return [
    { kind: 'fin', name: 'dorsal', count: 2, seg: [1, 3], side: -1, len: [10, 7], r: 1.3, amp: 0.3, freq: 1.4, active: true },
    { kind: 'fin', name: 'anal', count: 2, seg: [2, 4], side: 1, len: [9, 6], r: 1.2, amp: 0.3, freq: 1.4, active: true },
    { kind: 'spine', name: 'pelvicspine', count: 2, seg: 3, side: 'both', len: [6, 4], r: 1, drag: 0.88, amp: 0.6, freq: 2.2, active: true, scalpel: true },
    { kind: 'fin', name: 'caudal', count: 1, seg: 'tail', side: 0, len: [8, 6], r: 1.1, amp: 0.5, freq: 1, active: true, tail: true },
  ];
}
function darterLimbs() {
  return [
    { kind: 'fin', name: 'pectoral', count: 2, seg: [2, 3], side: 'both', len: [12, 9], r: 1.1, amp: 0.62, freq: 3.4, active: true, fan: true },
    { kind: 'fin', name: 'dorsal', count: 1, seg: 4, side: -1, len: [11, 8], r: 1.2, amp: 0.34, freq: 1.6, active: true },
    { kind: 'fin', name: 'anal', count: 1, seg: 5, side: 1, len: [10, 7], r: 1.1, amp: 0.34, freq: 1.6, active: true },
    { kind: 'fin', name: 'caudal', count: 1, seg: 'tail', side: 0, len: [11, 9], r: 1.2, amp: 0.55, freq: 1, active: true, tail: true, lunate: true },
    { kind: 'mandible', name: 'jaw', count: 2, seg: 0, side: 'both', len: [5, 4], r: 1, close: 0.45 },
  ];
}

const basePhys = {
  inertia: 0.986, gravity: 0.055, buoyGain: 1, maxAccel: 480,
  groundFriction: 0.5, compressible: 1,
};

// ===========================================================================
export const SPECIES = {
  // -------------------------------------------------------------- Z1 reef --
  minnow: {
    key: 'minnow', name: 'Prism Minnow', latin: 'Clupea prismatica', zone: 0, trophic: 2,
    codex: 'Schools of the reef crest. Shelter under jellyfish bells and inside coral branches; their iridescent flank scales flash information to the whole shoal.',
    plan: {
      seg: 6, spacing: 4.4, radius: 3.1, bendStiff: 0.46, waveNumber: 1.15, waveAmp: 0.95,
      waveFreq: 17, headStiff: 0.1, turnBend: 0.6, gaitFreq: 8,
      limbs: fishLimbs({ dorsal: 1, pec: 1, pelvic: 0 }),
    },
    phys: { ...basePhys, density: 1.008, dragNormal: 0.62, dragTangent: 0.09, maxAccel: 620, cruise: 74 },
    size: 13, massScale: 1, scale: [0.75, 1.25], hp: 0.5, damage: 1.5, defense: 0.05, armor: 0,
    nutrition: 15, metabolism: 0.00799, hungerDecay: 1.15,
    senses: { mode: 'visual', range: 190, fov: 4.6, glowBoost: 1.4, motionBoost: 1.5 },
    prey: [], flora: ['plankton', 'kelp', 'biofilm'], carrion: 0.2,
    eats: ['minnow'],  // (unused for prey; kept for symmetry)
    social: { radius: 46, sep: 15, align: 1.3, coh: 1.15, n: 14, key: 'minnow' },
    shelter: { coral: 1, jelly: 1.35, cave: 0.7, kelp: 0.4 },
    fleeFrom: ['garpike', 'eel', 'darter', 'lungshark', 'crab', 'angler', 'leviathan', 'jelly'],
    nestR: 200, reproduce: { hunger: 0.60, health: 0.6, cd: 55, eggs: 3, care: 0 },
    render: { style: 'minnow', body: '#cfe9f2', flank: '#8fd7ff', accent: '#ff7ad9', eye: '#08131c', shimmer: 1 },
    bt: {
      homeZone: 0, nestR: 200, rest: [['FreezeHide', 1], ['HoldGround', 2]],
      feed: [['FilterFeed', 3], ['GrazeSurface', 2], ['PeckKelp', 2]],
      flee: [['FleeThreat', 4], ['DiveToCoral', 3], ['HideInJellyBell', 3], ['SchoolWith', 2], ['BurstEscape', 1]],
      hunt: null, temperament: { boldness: 0.2, nervousness: 0.85, aggression: 0.08, sociability: 0.95, curiosity: 0.4 },
    },
  },

  jelly: {
    key: 'jelly', name: 'Lanternbell Jelly', latin: 'Citharista lanterna', zone: 0, trophic: 3,
    codex: 'A segmented chitinous bell rimmed with stinging tendrils. Symbiotically herds minnows: its nematocyst veil deters reef predators, and in return the minnows\u2019 agitation drives plankton toward the bell.',
    plan: {
      seg: 10, spacing: 5.0, radius: 5.4, bendStiff: 0.2, waveNumber: 0.55, waveAmp: 0.5,
      waveFreq: 2.6, gaitFreq: 2.2, ring: true,
      limbs: jellyLimbs(9, 4),
    },
    phys: { ...basePhys, density: 0.988, gravity: 0.018, dragNormal: 0.8, dragTangent: 0.5, maxAccel: 190, cruise: 26, compressible: 0.3 },
    size: 26, massScale: 1.4, scale: [0.8, 1.35], hp: 0.75, damage: 6, defense: 0.55, armor: 0,
    nutrition: 18, metabolism: 0.00377, hungerDecay: 0.72,
    senses: { mode: 'vibration', range: 210, fov: TAU, motionBoost: 2.2, glowBoost: 0.8 },
    prey: ['minnow'], flora: ['plankton'], carrion: 0.1,
    social: { radius: 120, sep: 60, align: 0.2, coh: 0.25, n: 3, key: 'jelly' },
    guardians: 'minnow',
    fleeFrom: ['lungshark', 'eel', 'garpike'],
    nestR: 320, reproduce: { hunger: 0.50, health: 0.55, cd: 90, eggs: 2, care: 0 },
    render: { style: 'jelly', bell: '#f4c9ff', bellDeep: '#8f5bd6', glow: '#9ff6ff', tentacle: '#e3a9ff', sting: '#fff2a8' },
    bt: {
      homeZone: 0, nestR: 320, rest: [['Drift', 4], ['BaskLight', 2]],
      feed: [['FilterFeed', 4], ['PulseStingFeed', 2]],
      flee: [['ContractBell', 3], ['Drift', 2]],
      hunt: [['EnvenomPrey', 3], ['DriftIntoPrey', 2]],
      temperament: { boldness: 0.55, nervousness: 0.2, aggression: 0.5, sociability: 0.7, curiosity: 0.3 },
    },
  },

  garpike: {
    key: 'garpike', name: 'Coral Garpike', latin: 'Belone corallium', zone: 0, trophic: 4,
    codex: 'Needle-jawed ambush hunter of the reef flat. Jellies are the only thing it fears: a bell in the way of a strike will shut a garpike hunt down.',
    plan: {
      seg: 10, spacing: 5.4, radius: 3.6, bendStiff: 0.36, waveNumber: 0.78, waveAmp: 0.62,
      waveFreq: 12, headStiff: 0.3, gaitFreq: 7, limbs: garpikeLimbs(),
    },
    phys: { ...basePhys, density: 1.006, dragNormal: 0.55, dragTangent: 0.06, maxAccel: 900, cruise: 96 },
    size: 30, scale: [0.8, 1.3], hp: 0.8, damage: 12, defense: 0.15, armor: 0.05,
    nutrition: 26, metabolism: 0.00749, hungerDecay: 1.0,
    senses: { mode: 'visual', range: 260, fov: 3.4, motionBoost: 2.4 },
    prey: ['minnow', 'tang', 'darter', 'jelly'], flora: [], carrion: 0.35,
    fleeFrom: ['eel', 'lungshark', 'crab', 'leviathan', 'jelly'],
    social: { radius: 90, sep: 60, align: 0.1, coh: 0.05, n: 2, key: 'garpike' },
    nestR: 300, reproduce: { hunger: 0.50, health: 0.66, cd: 120, eggs: 2, care: 0 },
    render: { style: 'garpike', body: '#1f4d52', flank: '#9fe6c8', accent: '#ffd166', eye: '#ff5964', teeth: '#f4fbff' },
    bt: {
      homeZone: 0, nestR: 300, ambush: [['AmbushStalk', 3], ['LungeStrike', 3]],
      feed: [['Scavenge', 2], ['PeckKelp', 1]],
      flee: [['FleeThreat', 3], ['BurstEscape', 2], ['RetreatToShelter', 2]],
      hunt: [['HuntPrey', 4], ['LungeStrike', 3], ['ChasePrey', 2]],
      temperament: { boldness: 0.8, nervousness: 0.35, aggression: 0.85, sociability: 0.25, curiosity: 0.6 },
    },
  },

  tang: {
    key: 'tang', name: 'Velvet Tang', latin: 'Acanthurus velutinus', zone: 0, trophic: 2,
    codex: 'Grazes the coral algae film with a beaked mouth and carries a scalpel on each hip. Moves down through the zones as the kelp forest sheds.',
    plan: {
      seg: 8, spacing: 5.0, radius: 5.2, bendStiff: 0.4, waveNumber: 0.95, waveAmp: 0.66,
      waveFreq: 11, gaitFreq: 6.5, limbs: tangLimbs(),
    },
    phys: { ...basePhys, density: 1.01, dragNormal: 0.58, dragTangent: 0.08, maxAccel: 520, cruise: 66 },
    size: 24, scale: [0.8, 1.2], hp: 0.7, damage: 4, defense: 0.3, armor: 0.08,
    nutrition: 20, metabolism: 0.006, hungerDecay: 1.25,
    senses: { mode: 'visual', range: 200, fov: 4.9, motionBoost: 1.2 },
    prey: [], flora: ['coral', 'kelp', 'biofilm', 'mat'], carrion: 0.1,
    fleeFrom: ['garpike', 'eel', 'lungshark', 'crab', 'darter', 'leviathan'],
    social: { radius: 70, sep: 26, align: 0.55, coh: 0.5, n: 6, key: 'tang' },
    nestR: 240, reproduce: { hunger: 0.58, health: 0.62, cd: 80, eggs: 3, care: 0 },
    render: { style: 'tang', body: '#2b3a86', flank: '#7f9bff', accent: '#ffcf4d', eye: '#0a1020', scalpel: '#fff6d8' },
    bt: {
      homeZone: 0, nestR: 240,
      feed: [['GrazeSurface', 5], ['PeckKelp', 3], ['BiteCoral', 2]],
      flee: [['FleeThreat', 3], ['FlashScalpel', 2], ['DiveToCoral', 2], ['RetreatToShelter', 1]],
      hunt: null, temperament: { boldness: 0.4, nervousness: 0.6, aggression: 0.3, sociability: 0.6, curiosity: 0.5 },
    },
  },

  // ----------------------------------------------------- Z2 wall + kelp eel --
  eel: {
    key: 'eel', name: 'Kelp Mimic Eel', latin: 'Sargassophis mimicus', zone: 1, trophic: 4,
    codex: 'Hangs head-down among kelp fronds with leaf-shaped appendages, matching the forest\u2019s sway. It coils, waits, and unloads its whole spine in a pounce. Only invisible while still.',
    plan: {
      seg: 16, spacing: 5.2, radius: 3.4, bendStiff: 0.5, waveNumber: 0.5, waveAmp: 1.15,
      waveFreq: 7, headStiff: 0.05, gaitFreq: 4, limbs: eelLimbs(7),
    },
    phys: { ...basePhys, density: 1.004, dragNormal: 0.66, dragTangent: 0.05, maxAccel: 1100, cruise: 78 },
    size: 46, scale: [0.85, 1.35], hp: 1.05, damage: 17, defense: 0.2, armor: 0.05,
    nutrition: 34, metabolism: 0.00547, hungerDecay: 0.85,
    senses: { mode: 'vibration', range: 220, fov: TAU, motionBoost: 3.2, stillBlind: 0.35 },
    prey: ['darter', 'minnow', 'tang', 'crab', 'garpike', 'snail'], flora: [], carrion: 0.25,
    fleeFrom: ['lungshark', 'leviathan', 'crab'],
    camo: { near: 'kelp', whileStill: 0.86, moving: 0.25 },
    social: { radius: 150, sep: 110, align: 0, coh: 0, n: 1, key: 'eel' },
    nestR: 260, lair: true, reproduce: { hunger: 0.50, health: 0.6, cd: 150, eggs: 2, care: 0 },
    render: { style: 'eel', body: '#4a6b2a', flank: '#8fbf4d', accent: '#dff08a', eye: '#141a0a', frond: '#7ea83e' },
    bt: {
      homeZone: 1, nestR: 260, caveBound: true,
      ambush: [['Camouflage', 5], ['CoilAndWait', 4], ['Pounce', 5]],
      feed: [['Scavenge', 2], ['GulpCarrion', 1]],
      flee: [['FleeThreat', 3], ['RetreatToShelter', 4], ['BurstEscape', 2], ['Camouflage', 2]],
      hunt: [['Pounce', 5], ['AmbushStalk', 4], ['ChasePrey', 2], ['HuntPrey', 2]],
      temperament: { boldness: 0.72, nervousness: 0.3, aggression: 0.9, sociability: 0.1, curiosity: 0.35 },
    },
  },

  darter: {
    key: 'darter', name: 'Cobalt Darter', latin: 'Cyprium cobaltum', zone: 1, trophic: 3,
    codex: 'Flares its fan pectoral fins to hold station in front of the Wall, drifting as a shoal past the rock. Turns on anything smaller; scatters when kelp starts to move.',
    plan: {
      seg: 9, spacing: 5.0, radius: 4.1, bendStiff: 0.42, waveNumber: 0.9, waveAmp: 0.8,
      waveFreq: 13, gaitFreq: 7, limbs: darterLimbs(),
    },
    phys: { ...basePhys, density: 1.007, dragNormal: 0.6, dragTangent: 0.07, maxAccel: 780, cruise: 88 },
    size: 22, scale: [0.8, 1.2], hp: 0.7, damage: 7, defense: 0.15, armor: 0,
    nutrition: 24, metabolism: 0.00735, hungerDecay: 1.1,
    senses: { mode: 'visual', range: 240, fov: 5.2, motionBoost: 2 },
    prey: ['minnow', 'snail', 'larva', 'tang'], flora: ['plankton', 'biofilm'], carrion: 0.3,
    fleeFrom: ['eel', 'lungshark', 'crab', 'angler', 'leviathan', 'garpike'],
    social: { radius: 62, sep: 18, align: 1.5, coh: 1.3, n: 12, key: 'darter' },
    wallHug: 0.7,
    nestR: 300, reproduce: { hunger: 0.50, health: 0.6, cd: 95, eggs: 3, care: 0 },
    render: { style: 'darter', body: '#16306b', flank: '#59a5ff', accent: '#c8f2ff', eye: '#050a18', fin: '#2f6fd0' },
    bt: {
      homeZone: 1, nestR: 300, rest: [['HoldStation', 3], ['Drift', 1]],
      feed: [['FilterFeed', 3], ['PeckKelp', 2], ['GrazeSurface', 2]],
      flee: [['FleeThreat', 4], ['SchoolWith', 3], ['BurstEscape', 2], ['RetreatToShelter', 2]],
      hunt: [['HuntPrey', 3], ['ChasePrey', 2], ['SnapAt', 2]],
      temperament: { boldness: 0.5, nervousness: 0.68, aggression: 0.45, sociability: 0.88, curiosity: 0.55 },
    },
  },

  snail: {
    key: 'snail', name: 'Whorl Crawler', latin: 'Tegula trochiformis', zone: 1, trophic: 1.5,
    codex: 'Farmers the background wall: a muscular foot wave, a rasping radula over barnacle crust, and a shell it can seal. Crabs prize them.',
    plan: {
      seg: 4, spacing: 4.0, radius: 5.0, bendStiff: 0.3, waveNumber: 1.6, waveAmp: 0.3,
      waveFreq: 2.4, gaitFreq: 1.4, limbs: snailLimbs(),
    },
    phys: { ...basePhys, density: 1.06, gravity: 0.03, dragNormal: 0.9, dragTangent: 0.55, maxAccel: 90, cruise: 12, compressible: 0.1 },
    size: 12, scale: [0.7, 1.3], hp: 0.55, damage: 0.6, defense: 0.62, armor: 0.35,
    nutrition: 10, metabolism: 0.002, hungerDecay: 0.5,
    senses: { mode: 'contact', range: 74, fov: TAU, motionBoost: 0.6 },
    prey: [], flora: ['biofilm', 'barnacle', 'mat'], carrion: 0.4,
    fleeFrom: ['crab', 'darter', 'eel', 'lungshark', 'leviathan'],
    social: { radius: 40, sep: 22, align: 0.1, coh: 0.2, n: 4, key: 'snail' },
    mode0: 'cling', nestR: 140, reproduce: { hunger: 0.50, health: 0.5, cd: 140, eggs: 2, care: 0 },
    render: { style: 'snail', body: '#c98a5b', shell: '#7c4a2d', shellRim: '#e9c9a0', eye: '#20120a' },
    bt: {
      homeZone: 1, nestR: 140,
      feed: [['GrazeBiofilm', 6], ['ScrapeBarnacle', 3], ['SealShell', 1]],
      flee: [['SealShell', 5], ['ClingToRock', 4], ['FleeThreat', 1]],
      hunt: null, rest: [['SealShell', 2], ['Rest', 2]],
      temperament: { boldness: 0.1, nervousness: 0.5, aggression: 0.02, sociability: 0.2, curiosity: 0.15 },
    },
  },

  crab: {
    key: 'crab', name: 'Ramshorn Rampart Crab', latin: 'Scorpio ramus', zone: 2, trophic: 3.5,
    codex: 'Eight legs, three bones each, and a pair of chelipeds that snap with audible click. Hatches in the Z3 cave systems, scales the Wall and the background cliff to travel, and drops onto the benches to feed. A well-fed crab holds its ledge; a starving one walks into the water.',
    plan: {
      seg: 7, spacing: 6.4, radius: 7.0, bendStiff: 0.6, waveNumber: 0.35, waveAmp: 0.14,
      waveFreq: 4, gaitFreq: 6.6, limbs: crabLimbs({ legs: 8, claws: 2, antennae: 2 }),
    },
    phys: { ...basePhys, density: 1.12, gravity: 0.075, dragNormal: 0.9, dragTangent: 0.62, maxAccel: 260, cruise: 44, compressible: 0.05 },
    size: 34, scale: [0.6, 1.5], hp: 1.35, damage: 15, defense: 0.45, armor: 0.45,
    nutrition: 30, metabolism: 0.00480, hungerDecay: 0.9,
    senses: { mode: 'contact', range: 170, fov: TAU, motionBoost: 2.6, glowBoost: 1.1 },
    prey: ['snail', 'urchin', 'minnow', 'darter', 'tang', 'crawler', 'jelly'], flora: ['kelp', 'mat', 'biofilm'], carrion: 0.95,
    fleeFrom: ['lungshark', 'leviathan', 'eel', 'angler'],
    canCling: true, planes: [0, 1], mode0: 'walk', hatch: true,
    social: { radius: 66, sep: 40, align: 0.15, coh: 0.2, n: 4, key: 'crab' },
    nestR: 340, reproduce: { hunger: 0.50, health: 0.6, cd: 130, eggs: 4, care: 0.3 },
    render: { style: 'crab', shell: '#8a3b2e', shellHi: '#d4714f', leg: '#5e2a24', claw: '#c9563f', eye: '#ffe08a', spike: 1 },
    bt: {
      homeZone: 2, nestR: 340, canCling: true,
      feed: [['GrazeBiofilm', 2], ['CrushPrey', 4], ['Scavenge', 5], ['TearKelp', 2]],
      flee: [['ClingToRock', 4], ['FleeThreat', 2], ['RetreatToShelter', 4], ['Sidestep', 2], ['BurstEscape', 1]],
      hunt: [['StalkPrey', 4], ['SnapStrike', 5], ['ChasePrey', 2], ['HuntPrey', 2]],
      rest: [['ClingToRock', 3], ['Rest', 2], ['ClimbWall', 3]],
      temperament: { boldness: 0.75, nervousness: 0.35, aggression: 0.72, sociability: 0.35, curiosity: 0.7 },
    },
  },

  // ------------------------------------------------------------ Z3 kelp -----
  lungshark: {
    key: 'lungshark', name: 'Pyre Lungshark', latin: 'Odontaspis pyra', zone: 2, trophic: 4.5,
    codex: 'A stiff-bodied torpedo with a lung. Two seconds of furnace-bright acceleration, then a long vulnerable glide while it refills and cools. Must gulp air at the outcrop shelf or it slowly floods.',
    plan: {
      seg: 12, spacing: 7.4, radius: 6.4, bendStiff: 0.3, waveNumber: 0.62, waveAmp: 0.72,
      waveFreq: 9, headStiff: 0.28, gaitFreq: 8, limbs: sharkLimbs(),
    },
    phys: { ...basePhys, density: 1.022, gravity: 0.07, dragNormal: 0.44, dragTangent: 0.035, maxAccel: 1500, cruise: 118, compressible: 1.9, lung: 1 },
    size: 62, scale: [0.72, 1.3], hp: 1.6, damage: 26, defense: 0.3, armor: 0.2,
    nutrition: 46, metabolism: 0.00936, hungerDecay: 1.35,
    senses: { mode: 'vibration', range: 330, fov: TAU, motionBoost: 3.4, glowBoost: 0.7, ampullae: 1.6 },
    prey: ['darter', 'eel', 'tang', 'minnow', 'crab', 'garpike', 'crawler', 'angler', 'lungshark'],
    flora: [], carrion: 0.4,
    fleeFrom: ['leviathan'],
    burst: { cost: 0.34, recover: 0.11, dur: 1.5, mult: 3.1 },
    airAt: 2, zoneUp: 1.6,  // must reach the top of its band to inflate
    social: { radius: 190, sep: 130, align: 0.05, coh: 0.02, n: 2, key: 'lungshark' },
    nestR: 520, reproduce: { hunger: 0.50, health: 0.62, cd: 220, eggs: 2, care: 0.5 },
    render: { style: 'shark', body: '#33424f', flank: '#7f96a6', belly: '#e8f1f5', accent: '#ff7a3d', eye: '#0a0f14', gill: '#ff5470', notch: 1 },
    bt: {
      homeZone: 2, nestR: 520,
      feed: [['Scavenge', 3]],
      needsAir: true,
      flee: [['BurstEscape', 5], ['FleeThreat', 3], ['RetreatToShelter', 2]],
      hunt: [['AmbushRise', 4], ['BurstChase', 5], ['HuntPrey', 3], ['LungeStrike', 3], ['ChasePrey', 2]],
      rest: [['Glide', 4], ['GulpAir', 3], ['Drift', 2]],
      temperament: { boldness: 0.9, nervousness: 0.25, aggression: 0.95, sociability: 0.15, curiosity: 0.45 },
    },
  },

  urchin: {
    key: 'urchin', name: 'Bramble Urchin', latin: 'Echinus rubus', zone: 2, trophic: 1.5,
    codex: 'Every spine is its own articulated bone, so a grazing urchin walks itself down a kelp stipe like a slow thorny avalanche. Nothing eats it that does not mind being cut.',
    plan: {
      seg: 5, spacing: 3.6, radius: 5.6, bendStiff: 0.5, waveNumber: 1.1, waveAmp: 0.24,
      waveFreq: 3, gaitFreq: 1.7, limbs: urchinLimbs(15), ring: true,
    },
    phys: { ...basePhys, density: 1.14, gravity: 0.09, dragNormal: 0.92, dragTangent: 0.7, maxAccel: 70, cruise: 10, compressible: 0.05 },
    size: 20, scale: [0.7, 1.3], hp: 0.9, damage: 9, defense: 0.8, armor: 0.25,
    nutrition: 22, metabolism: 0.0018, hungerDecay: 0.42,
    senses: { mode: 'contact', range: 90, fov: TAU, motionBoost: 0.4 },
    prey: [], flora: ['kelp', 'coral', 'mat', 'biofilm'], carrion: 0.3,
    fleeFrom: ['crab', 'lungshark', 'leviathan'],
    spiny: 0.55, mode0: 'walk', social: { radius: 46, sep: 30, align: 0, coh: 0.3, n: 5, key: 'urchin' },
    nestR: 120, reproduce: { hunger: 0.50, health: 0.5, cd: 200, eggs: 4, care: 0 },
    render: { style: 'urchin', body: '#3a1f4d', spine: '#b06bff', spineTip: '#ffe57a', eye: '#150a1e' },
    bt: {
      homeZone: 2, nestR: 120,
      feed: [['GrazekKelp', 6], ['GrazeSurface', 3], ['AnchorFeet', 2]],
      flee: [['BristleUp', 4], ['ClingToRock', 3], ['FleeThreat', 1]],
      hunt: null, rest: [['AnchorFeet', 3], ['Rest', 2]],
      temperament: { boldness: 0.2, nervousness: 0.25, aggression: 0.15, sociability: 0.4, curiosity: 0.1 },
    },
  },

  // ------------------------------------------------------------ Z4 abyss -----
  angler: {
    key: 'angler', name: 'Gloom Lure Angler', latin: 'Lophius abyssi', zone: 3, trophic: 4,
    codex: 'Sits motionless on the basin rim with a glowing esca on an articulated illicium. Curiosity is what kills most of its prey \u2014 and most anglers, when something brighter hangs above them.',
    plan: {
      seg: 9, spacing: 5.6, radius: 6.0, bendStiff: 0.34, waveNumber: 0.75, waveAmp: 0.42,
      waveFreq: 6, gaitFreq: 5, limbs: anglerLimbs(),
    },
    phys: { ...basePhys, density: 1.03, gravity: 0.05, dragNormal: 0.75, dragTangent: 0.2, maxAccel: 420, cruise: 44, compressible: 0.6 },
    size: 34, scale: [0.8, 1.3], hp: 1.1, damage: 22, defense: 0.25, armor: 0.1,
    nutrition: 34, metabolism: 0.00350, hungerDecay: 0.7,
    senses: { mode: 'bio', range: 260, fov: TAU, motionBoost: 2.8, glowBoost: 2.6, darkOk: 1 },
    prey: ['crawler', 'minnow', 'darter', 'snail', 'urchin', 'angler'], flora: [], carrion: 0.5,
    glow: { lures: true, intensity: 0.85 },
    fleeFrom: ['leviathan', 'lungshark'],
    social: { radius: 200, sep: 150, align: 0, coh: 0, n: 1, key: 'angler' },
    nestR: 260, reproduce: { hunger: 0.50, health: 0.55, cd: 240, eggs: 5, care: 0 },
    render: { style: 'angler', body: '#141b2b', flank: '#2e3f5c', accent: '#0b1220', eye: '#bfe9ff', lure: '#7df9ff', teeth: '#e7f4ff' },
    bt: {
      homeZone: 3, nestR: 260, caveBound: true, zoneStrict: true,
      feed: [['Scavenge', 3], ['GulpCarrion', 2]],
      flee: [['DarkenGlow', 4], ['FleeThreat', 2], ['RetreatToShelter', 3]],
      hunt: [['LurePrey', 5], ['SnapStrike', 5], ['AmbushStalk', 3], ['HuntPrey', 1]],
      rest: [['SitAndLure', 4], ['Rest', 2]],
      ambush: [['SitAndLure', 5], ['LurePrey', 4]],
      temperament: { boldness: 0.6, nervousness: 0.2, aggression: 0.88, sociability: 0.05, curiosity: 0.75 },
    },
  },

  crawler: {
    key: 'crawler', name: 'Bone Crawler', latin: 'Abyssonoea ossifraga', zone: 3, trophic: 2.5,
    codex: 'Pale, six-legged and blind to anything that does not shine. Swarms a carcass in minutes, strips it to nubs, and flees into the wall warrens the moment the water starts to glow.',
    plan: {
      seg: 8, spacing: 4.6, radius: 4.0, bendStiff: 0.5, waveNumber: 1.0, waveAmp: 0.34,
      waveFreq: 6, gaitFreq: 8.6, limbs: crawlerLimbs(),
    },
    phys: { ...basePhys, density: 1.1, gravity: 0.08, dragNormal: 0.85, dragTangent: 0.45, maxAccel: 300, cruise: 50, compressible: 0.1 },
    size: 20, scale: [0.6, 1.4], hp: 0.6, damage: 5, defense: 0.2, armor: 0.12,
    nutrition: 16, metabolism: 0.0051, hungerDecay: 0.8,
    senses: { mode: 'contact', range: 210, fov: TAU, motionBoost: 1.4, chem: 2.6 },
    prey: [], flora: ['mat', 'biofilm'], carrion: 1.0,
    fleeFrom: ['leviathan', 'angler', 'lungshark', 'crab'],
    mode0: 'walk', canCling: true,
    social: { radius: 60, sep: 18, align: 0.4, coh: 0.9, n: 10, key: 'crawler' },
    nestR: 200, reproduce: { hunger: 0.50, health: 0.5, cd: 90, eggs: 6, care: 0 },
    render: { style: 'crawler', shell: '#c8c0b0', leg: '#9d9384', eye: '#ff4d6d', antenna: '#e8e2d4' },
    bt: {
      homeZone: 3, nestR: 200, zoneStrict: true,
      feed: [['Scavenge', 6], ['GulpCarrion', 4], ['GrazeSurface', 3], ['Burrow', 2]],
      flee: [['RetreatToShelter', 5], ['FleeThreat', 3], ['ClingToRock', 2], ['BurstEscape', 1]],
      hunt: null, rest: [['Burrow', 3], ['Rest', 2]],
      temperament: { boldness: 0.4, nervousness: 0.7, aggression: 0.35, sociability: 0.85, curiosity: 0.4 },
    },
  },

  leviathan: {
    key: 'leviathan', name: 'Abyssal Leviathan', latin: 'Geryon abyssorum rex', zone: 3, trophic: 5,
    codex: 'Twenty-six articulated vertebrae, three mandibles a side, and a lantern row down each flank. It does not chase: it holds the line at the bottom of Z3, lights itself to see better, and takes anything that drifts past the third zone with a precise strike.',
    plan: {
      seg: 26, spacing: 12.5, radius: 11.5, bendStiff: 0.24, waveNumber: 0.34, waveAmp: 0.8,
      waveFreq: 3.4, headStiff: 0.16, gaitFreq: 3, limbs: leviathanLimbs(),
    },
    phys: { ...basePhys, density: 1.004, gravity: 0.03, dragNormal: 0.5, dragTangent: 0.03, maxAccel: 900, cruise: 66, compressible: 0.4 },
    size: 330, massScale: 8, scale: [0.85, 1.3], hp: 6.5, damage: 78, defense: 0.72, armor: 0.5,
    zoneUp: 2.4, yCeil: LEVIATHAN_LINE - 30,   // abyssal physiology: it holds the line and strikes at whatever drifts over it
    nutrition: 0, metabolism: 0.0034, hungerDecay: 0.34,
    senses: { mode: 'bio', range: 720, fov: TAU, motionBoost: 4, glowBoost: 3, darkOk: 1, abyssNet: 1 },
    prey: ['lungshark', 'crab', 'angler', 'crawler', 'eel', 'darter', 'minnow', 'tang', 'garpike', 'jelly', 'urchin', 'leviathan', 'snail'],
    flora: [], carrion: 0.8,
    glow: { photophores: true, intensity: 1, lures: true },
    apex: true, boundary: true, fleeFrom: [],
    social: { radius: 700, sep: 520, align: 0, coh: 0, n: 1, key: 'leviathan' },
    nestR: 900, reproduce: { hunger: 0.50, health: 0.6, cd: 400, eggs: 1, care: 0.8 },
    render: { style: 'leviathan', body: '#0d1524', flank: '#16273f', accent: '#78f4ff', eye: '#e8fbff', mandible: '#cfe9ff', photophore: '#54e6ff' },
    bt: {
      homeZone: 3, nestR: 900, zoneAvoid: false, reproduce: false, zoneStrict: true,
      feed: [['Scavenge', 2], ['GulpCarrion', 2]],
      flee: [['DimAndSink', 3]],
      hunt: [['MandibleStrike', 6], ['SweepHunt', 4], ['LungeStrike', 4], ['ChasePrey', 3], ['ConsumePrey', 5]],
      rest: [['PatrolBoundary', 6], ['Drift', 2], ['LureDisplay', 2]],
      ambush: [['LureDisplay', 4], ['CoilAndWait', 3]],
      temperament: { boldness: 1, nervousness: 0.05, aggression: 1, sociability: 0.05, curiosity: 0.55 },
    },
  },
};

// ---- fixups: the grazer urchin action name + derived tables --------------
SPECIES.urchin.bt.feed = [['GrazekKelp', 6], ['GrazeSurface', 3], ['AnchorFeet', 2]];
delete SPECIES.minnow.eats;

export const SPECIES_KEYS = Object.keys(SPECIES);

/** which species prey on a given species (the food chain, derived) */
export const PREyedOn = {};
export const PREDATORS_OF = {};
for (const k of SPECIES_KEYS) {
  PREyedOn[k] = SPECIES[k].prey || [];
  PREDATORS_OF[k] = [];
}
for (const k of SPECIES_KEYS) {
  for (const p of PREyedOn[k] || []) {
    if (PREDATORS_OF[p] && !PREDATORS_OF[p].includes(k)) PREDATORS_OF[p].push(k);
  }
}
for (const k of SPECIES_KEYS) {
  for (const f of SPECIES[k].fleeFrom || []) {
    if (PREDATORS_OF[k] && !PREDATORS_OF[k].includes(f)) PREDATORS_OF[f] && PREDATORS_OF[f].push(k);
  }
}

export function speciesOf(key) { return SPECIES[key]; }
export const ANIMAL_KEYS = SPECIES_KEYS;

/** spawn budget per species (population ceilings keep the sim real-time) */
export const POPULATION = {
  minnow: 66, jelly: 13, garpike: 16, tang: 24,
  eel: 14, darter: 36, snail: 26, crab: 30,
  lungshark: 13, urchin: 26,
  angler: 12, crawler: 28, leviathan: 3,
};

export const SPAWN_ORDER = ['minnow', 'jelly', 'tang', 'garpike', 'darter', 'snail', 'urchin', 'eel', 'crab', 'lungshark', 'crawler', 'angler', 'leviathan'];

export { PI, TAU };
