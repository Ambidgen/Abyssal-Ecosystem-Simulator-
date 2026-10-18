// ---------------------------------------------------------------------------
// The water column, sliced into four zones. Depth drives light + pressure, and
// every species has an "endemic" zone it is adapted to; being elsewhere bleeds
// health slowly. Zone ids are 0..3 top to bottom (Z1 sunlit reef .. Z4 abyss).
// ---------------------------------------------------------------------------

export const WORLD_W = 6400;
export const WORLD_H = 3600;
/** depth in metres used for display; WORLD_H maps to 1200 m */
export const METRES_PER_PX = 1200 / WORLD_H;

export const ZONES = [
  {
    id: 0,
    key: 'Z1',
    name: 'Sunlit Reef',
    tag: 'photic',
    top: 0,
    bottom: 780,
    light: 1.0,          // surface-normalised irradiance at the zone floor
    pressure: 1.0,       // atmospheres-ish, drives gas volume + metabolism
    temp: 1.0,
    turbidity: 0.35,     // how far light/visibility carries
    water: [0x2f, 0x93, 0xa8],
    deep: [0x14, 0x5d, 0x78],
    ambient: 0.55,
  },
  {
    id: 1,
    key: 'Z2',
    name: 'Twilight Wall',
    tag: 'dysphotic',
    top: 780,
    bottom: 1660,
    light: 0.34,
    pressure: 2.6,
    temp: 0.72,
    turbidity: 0.55,
    water: [0x14, 0x5d, 0x78],
    deep: [0x0a, 0x39, 0x53],
    ambient: 0.3,
  },
  {
    id: 2,
    key: 'Z3',
    name: 'Kelp Outcrop',
    tag: 'midnight shelf',
    top: 1660,
    bottom: 2620,
    light: 0.085,
    pressure: 5.1,
    temp: 0.45,
    turbidity: 0.7,
    water: [0x0a, 0x39, 0x53],
    deep: [0x05, 0x1e, 0x33],
    ambient: 0.14,
  },
  {
    id: 3,
    key: 'Z4',
    name: 'The Abyss',
    tag: 'hadal',
    top: 2620,
    bottom: WORLD_H,
    light: 0.004,
    pressure: 9.4,
    temp: 0.14,
    turbidity: 0.9,
    water: [0x05, 0x1e, 0x33],
    deep: [0x01, 0x08, 0x14],
    ambient: 0.02,
  },
];

export const ZONE_COUNT = ZONES.length;
export const LEVIATHAN_LINE = ZONES[3].top; // anything below this is prey

export function zoneIndexAt(y) {
  for (let i = ZONES.length - 1; i >= 0; i--) if (y >= ZONES[i].top) return i;
  return 0;
}

export function zoneAt(y) { return ZONES[zoneIndexAt(y)]; }

/** 0..1 within the zone */
export function zoneFrac(y, i = zoneIndexAt(y)) {
  const z = ZONES[i];
  const t = (y - z.top) / (z.bottom - z.top);
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/**
 * Continuous light field. Smoothly interpolates between zone bands so there is
 * no hard line, adds a shallow "sun shaft" band near the surface, and is scaled
 * by the global day/tide phase. Bioluminescent creatures ignore it.
 */
export function lightAt(y, phase = 0) {
  const i = zoneIndexAt(y);
  const z = ZONES[i];
  const next = ZONES[Math.min(ZONES.length - 1, i + 1)];
  const t = zoneFrac(y, i);
  // ease the falloff so the bottom of each band is darker than the top
  const base = z.light + (next.light - z.light) * Math.pow(t, 0.72);
  const surface = 1.06 - 0.30 * Math.min(1, y / 190);
  const lit = Math.max(base, surface * base * 1.35);
  const diel = 0.55 + 0.45 * (0.5 + 0.5 * Math.cos(phase * Math.PI * 2));
  return Math.max(0.0025, lit * (i === 3 ? 1 : diel) + (i === 3 ? 0.002 : 0));
}

/** 1.0 at surface, grows with depth. Compresses gas-filled organs, speeds metabolism */
export function pressureAt(y) {
  const t = Math.max(0, y) / WORLD_H;
  return 1 + t * 10.5;
}

export function depthLabel(y) {
  return '-' + Math.round(Math.max(0, y) * METRES_PER_PX) + ' m';
}

export function pressureLabel(y) {
  return pressureAt(y).toFixed(1) + ' atm';
}
