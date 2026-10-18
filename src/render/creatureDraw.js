// ---------------------------------------------------------------------------
//  CREATURE PAINTERS
//
//  Nothing here draws a sprite. Every animal is painted from its own
//  simulation state: the verlet segment chain (the hardbody), the per-point
//  radius, the limb chains that IK solved against the rock, the jaw open
//  amount, the bioluminescence level, the wound and hunger values. So the
//  silhouette you see IS the collider, and every limb you see is one the
//  physics actually moved this frame.
//
//  One painter per locomotion family, style-flagged for silhouette:
//    fish     minnow / garpike / tang / darter / eel / shark / angler
//    bell     jellyfish (ring body + tentacle curtain)
//    walker   crab / bone crawler (8 or 6 IK legs, weight through the feet)
//    test     urchin (spines are individual limbs), snail (foot wave + shell)
//    serpent  the leviathan (mandible cluster + flank photophores)
// ---------------------------------------------------------------------------

import { TAU, PI, clamp, clamp01, lerp, smoothstep } from '../core/vec.js';
import { hash2 } from '../core/rand.js';
import { lightAt, ZONES, WORLD_H, zoneIndexAt } from '../sim/zones.js';
import { SPECIES } from '../sim/species.js';

const shade = (hex, k) => {
  const n = parseInt(hex.slice(1), 16);
  const r = clamp(((n >> 16) & 255) * k, 0, 255) | 0;
  const g = clamp(((n >> 8) & 255) * k, 0, 255) | 0;
  const b = clamp((n & 255) * k, 0, 255) | 0;
  return `rgb(${r},${g},${b})`;
};
const rgba = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

/**
 * Tapered tube through the spine points — the hardbody silhouette.
 * `profile` maps normalised position to a width multiplier, so a minnow,
 * a tang and an eel are the same algorithm with different bodies.
 */
function bodyPath(ctx, pts, n, scale, profile, finFold = 0) {
  const left = [], right = [];
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const a = pts[Math.max(0, i - 1)], c = pts[Math.min(n - 1, i + 1)];
    let dx = c.x - a.x, dy = c.y - a.y;
    const L = Math.hypot(dx, dy) || 1;
    dx /= L; dy /= L;
    const t = n > 1 ? i / (n - 1) : 0;
    let w = p.r * scale * profile(t, i);
    if (finFold) w *= 1 + finFold * Math.sin(t * PI) * 0.5;
    const nx = -dy, ny = dx;
    left.push([p.x + nx * w, p.y + ny * w]);
    right.push([p.x - nx * w, p.y - ny * w]);
  }
  ctx.beginPath();
  curveThrough(ctx, left, true);
  for (let i = right.length - 1; i >= 0; i--) ctx.lineTo(right[i][0], right[i][1]);
  ctx.closePath();
  return { left, right };
}

function curveThrough(ctx, pts, start) {
  if (!pts.length) return;
  if (start) ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2;
    ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
  }
  const l = pts[pts.length - 1];
  ctx.lineTo(l[0], l[1]);
}

/** soft membrane between a spine point and a limb chain (fins, fronds, arms) */
function membrane(ctx, anchor, limb, spread, color, alpha) {
  const pts = limb.pts;
  if (!pts.length) return;
  ctx.beginPath();
  ctx.moveTo(anchor.x, anchor.y);
  const nx = -(pts[0].y - anchor.y), ny = pts[0].x - anchor.x;
  const L = Math.hypot(nx, ny) || 1;
  ctx.lineTo(pts[0].x + (nx / L) * spread, pts[0].y + (ny / L) * spread);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.lineTo(pts[pts.length - 1].x - (nx / L) * spread * 0.4, pts[pts.length - 1].y - (ny / L) * spread * 0.4);
  for (let i = pts.length - 1; i > 0; i--) ctx.lineTo(pts[i].x - (nx / L) * spread * (0.2 + i * 0.1), pts[i].y - (ny / L) * spread * (0.2 + i * 0.1));
  ctx.closePath();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.fill();
  ctx.globalAlpha = 1;
}

/** a limb chain painted as articulated bone (legs, mandibles, antennae) */
function limbBones(ctx, limb, w, color, tipColor, glow) {
  const pts = limb.pts;
  if (pts.length < 1) return;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  let px = limb.anchor ? limb.anchor.x : pts[0].x;
  let py = limb.anchor ? limb.anchor.y : pts[0].y;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const t = i / Math.max(1, pts.length - 1);
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(0.55, w * (1 - t * 0.55));
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    // joint
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, Math.max(0.5, w * 0.42 * (1 - t * 0.4)), 0, TAU);
    ctx.fill();
    px = p.x; py = p.y;
  }
  if (tipColor) {
    const p = pts[pts.length - 1];
    ctx.fillStyle = tipColor;
    ctx.beginPath();
    ctx.arc(p.x, p.y, Math.max(0.6, w * 0.5) * (glow ? 1.3 : 1), 0, TAU);
    ctx.fill();
  }
}

// ===========================================================================
//  FISH FAMILY
// ===========================================================================
const PROFILES = {
  minnow: (t) => Math.sin(clamp01(t) * PI * 0.94 + 0.2) * 1.02 + 0.06,
  garpike: (t) => (t < 0.34 ? 0.72 + t * 0.5 : 1.05 - (t - 0.34) * 0.95) * 1.05,
  tang: (t) => (0.55 + Math.sin(clamp01(t) * PI) * 1.75) * (1 - t * 0.55),
  darter: (t) => (0.5 + Math.sin(clamp01(t) * PI * 0.95) * 1.25) * (1 - t * 0.42),
  eel: (t) => 0.62 + Math.sin(clamp01(t) * PI * 0.8) * 0.36 - t * 0.28,
  shark: (t) => (0.6 + Math.sin(clamp01(t * 1.08) * PI * 0.92) * 1.28) * (1 - t * 0.34),
  angler: (t) => (0.5 + Math.sin(clamp01(t) * PI * 0.8) * 1.9) * (1 - t * 0.5),
};

function drawFish(ctx, c, world, style) {
  const b = c.body, pts = b.pts, n = b.n;
  const sc = c.scale * c.growth;
  const r = c.render || c.sp.render;
  const dep = 1 - clamp01(c.y / WORLD_H) * 0.72;
  const light = lightAt(c.y, world.phase);
  const dark = clamp01(1 - light * 1.6);
  const profile = PROFILES[style] || PROFILES.minnow;

  // --- caudal fin first, behind the body ---------------------------------
  const caudal = b.limbs.find((L) => L.def && L.def.tail);
  if (caudal && caudal.pts.length) {
    const t0 = caudal.pts[0], t1 = caudal.pts[caudal.pts.length - 1];
    const ang = Math.atan2(t1.y - t0.y, t1.x - t0.x);
    const flap = Math.sin(c.t * (c.sp.plan.waveFreq || 9) * 0.9 + (c.body.gait || 0)) * 0.5 + 0.5;
    const spread = c.radius * (style === 'shark' ? 1.5 : style === 'tang' ? 1.15 : 1.25) * (0.75 + flap * 0.4);
    ctx.beginPath();
    ctx.moveTo(pts[n - 2].x, pts[n - 2].y);
    if (style === 'shark') {
      // heterocercal: long upper lobe, short lower
      ctx.lineTo(t0.x + Math.cos(ang - 1.75) * spread * 1.5, t0.y + Math.sin(ang - 1.75) * spread * 1.5);
      ctx.lineTo(t1.x + Math.cos(ang - 0.3) * spread * 0.9, t1.y + Math.sin(ang - 0.3) * spread * 0.9);
      ctx.lineTo(t1.x + Math.cos(ang + 0.55) * spread * 0.5, t1.y + Math.sin(ang + 0.55) * spread * 0.5);
      ctx.lineTo(t0.x + Math.cos(ang + 1.25) * spread * 0.8, t0.y + Math.sin(ang + 1.25) * spread * 0.8);
    } else if (style === 'darter') {
      ctx.lineTo(t0.x + Math.cos(ang - 1.1) * spread * 1.5, t0.y + Math.sin(ang - 1.1) * spread * 1.5);
      ctx.lineTo(t1.x, t1.y);
      ctx.lineTo(t0.x + Math.cos(ang + 1.1) * spread * 1.5, t0.y + Math.sin(ang + 1.1) * spread * 1.5);
    } else {
      ctx.lineTo(t0.x + Math.cos(ang - 1.35) * spread, t0.y + Math.sin(ang - 1.35) * spread);
      ctx.lineTo(t1.x + Math.cos(ang) * spread * 0.5, t1.y + Math.sin(ang) * spread * 0.5);
      ctx.lineTo(t0.x + Math.cos(ang + 1.35) * spread, t0.y + Math.sin(ang + 1.35) * spread);
    }
    ctx.closePath();
    ctx.fillStyle = rgba(r.accent || r.flank, 0.55 + 0.25 * dep);
    ctx.fill();
    ctx.strokeStyle = rgba(r.flank, 0.35);
    ctx.lineWidth = 0.5;
    ctx.stroke();
  }

  // --- unpaired fins behind the body --------------------------------------
  for (const L of b.limbs) {
    if (!L.def || L.def.tail) continue;
    if (L.kind !== 'fin' || L.def.name === 'pectoral' || L.def.name === 'pelvic') continue;
    const anchor = pts[Math.min(n - 1, L.seg)];
    const spread = c.radius * 0.34 * (L.def.name === 'frond' ? 1.5 : 1);
    membrane(ctx, anchor, L, spread, L.def.name === 'frond' ? rgba(r.frond || r.flank, 0.62) : rgba(r.flank, 0.5), 0.62 * dep + 0.18);
    // fin rays
    ctx.strokeStyle = rgba(r.accent || r.flank, 0.22);
    ctx.lineWidth = 0.35;
    for (let i = 0; i < L.pts.length; i++) {
      ctx.beginPath(); ctx.moveTo(anchor.x, anchor.y); ctx.lineTo(L.pts[i].x, L.pts[i].y); ctx.stroke();
    }
  }

  // --- the body ------------------------------------------------------------
  const fold = style === 'eel' ? 0.5 : style === 'tang' ? 0.2 : 0;
  const { left } = bodyPath(ctx, pts, n, sc, profile, fold);
  const grad = ctx.createLinearGradient(pts[0].x, pts[0].y - c.radius * 1.6, pts[n - 1].x, pts[n - 1].y + c.radius * 1.6);
  grad.addColorStop(0, shade(r.flank || r.body, 1.18 * (0.4 + dep * 0.75)));
  grad.addColorStop(0.42, shade(r.body, 0.95 * (0.34 + dep * 0.8)));
  grad.addColorStop(1, shade(r.belly || r.flank || r.body, 0.6 + dep * 0.5));
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.lineWidth = Math.max(0.4, c.radius * 0.09);
  ctx.strokeStyle = rgba(r.accent || r.flank, 0.3 + dark * 0.25);
  ctx.stroke();

  // flank detail per style
  ctx.save();
  ctx.clip();
  if (style === 'minnow' && r.shimmer) {
    // iridescence: a moving band of light down the school
    const ph = Math.sin(c.t * 3.2 + c.id) * 0.5 + 0.5;
    const g2 = ctx.createLinearGradient(pts[0].x, pts[0].y, pts[n - 1].x, pts[n - 1].y);
    g2.addColorStop(clamp01(ph - 0.3), 'rgba(255,255,255,0)');
    g2.addColorStop(clamp01(ph), 'rgba(200,245,255,0.5)');
    g2.addColorStop(clamp01(ph + 0.3), 'rgba(255,255,255,0)');
    ctx.fillStyle = g2;
    ctx.fillRect(c.x - 60, c.y - 60, 120, 120);
  } else if (style === 'eel') {
    // kelp mimic: mottled blades along the flank
    for (let i = 1; i < n; i += 1) {
      const p = pts[i];
      const a = hash2(i * 1.7, c.id * 0.31);
      ctx.fillStyle = `rgba(${110 + a * 60 | 0},${170 + a * 50 | 0},${70 + a * 40 | 0},0.28)`;
      ctx.beginPath();
      ctx.ellipse(p.x, p.y - p.r * sc * 0.3, p.r * sc * 1.1, p.r * sc * 0.36, (i * 0.6) % PI, 0, TAU);
      ctx.fill();
    }
    if (c.camo > 0.05) {
      ctx.fillStyle = `rgba(150,205,110,${0.16 * c.camo})`;
      ctx.fillRect(c.x - 90, c.y - 90, 180, 180);
    }
  } else if (style === 'shark') {
    ctx.strokeStyle = rgba(r.gill || '#ff5470', 0.5);
    ctx.lineWidth = 0.8;
    for (let k = 0; k < 5; k++) {
      const i = 2 + k;
      if (i >= n - 1) break;
      const p = pts[i], q = pts[i + 1];
      const ang = Math.atan2(q.y - p.y, q.x - p.x) + PI / 2;
      ctx.beginPath();
      ctx.moveTo(p.x + Math.cos(ang) * p.r * sc * 0.5, p.y + Math.sin(ang) * p.r * sc * 0.5);
      ctx.lineTo(p.x + Math.cos(ang) * p.r * sc * 1.5, p.y + Math.sin(ang) * p.r * sc * 1.5);
      ctx.stroke();
    }
  } else if (style === 'tang' || style === 'darter') {
    // scale banding
    ctx.strokeStyle = rgba(r.accent || '#ffffff', 0.12);
    ctx.lineWidth = 0.5;
    for (let i = 1; i < n - 1; i++) {
      const p = pts[i], q = pts[Math.min(n - 1, i + 1)];
      const ang = Math.atan2(q.y - p.y, q.x - p.x) + PI / 2;
      ctx.beginPath();
      ctx.moveTo(p.x + Math.cos(ang) * p.r * sc * 1.8, p.y + Math.sin(ang) * p.r * sc * 1.8);
      ctx.lineTo(p.x - Math.cos(ang) * p.r * sc * 1.8, p.y - Math.sin(ang) * p.r * sc * 1.8);
      ctx.stroke();
    }
  }
  // wounds + hunger palor
  if (c.wound > 0.02) {
    ctx.fillStyle = `rgba(150,20,30,${0.4 * c.wound})`;
    ctx.fillRect(c.x - 80, c.y - 80, 160, 160);
  }
  if (c.hunger < 0.24) {
    ctx.fillStyle = `rgba(230,240,255,${(0.24 - c.hunger) * 0.5})`;
    ctx.fillRect(c.x - 80, c.y - 80, 160, 160);
  }
  ctx.restore();

  // --- paired fins over the body ------------------------------------------
  for (const L of b.limbs) {
    if (!L.def || (L.def.name !== 'pectoral' && L.def.name !== 'pelvic' && L.def.name !== 'fan')) continue;
    const anchor = pts[Math.min(n - 1, L.seg)];
    const spread = c.radius * (L.def.name === 'pectoral' && style === 'darter' ? 0.8 : 0.3);
    membrane(ctx, anchor, L, spread, rgba(r.fin || r.flank, 0.66), 0.75);
    if (L.def.fan) {
      ctx.strokeStyle = rgba(r.accent, 0.4);
      ctx.lineWidth = 0.4;
      for (let k = 0; k < 4; k++) {
        const p = L.pts[L.pts.length - 1];
        ctx.beginPath(); ctx.moveTo(anchor.x, anchor.y);
        ctx.lineTo(lerp(anchor.x, p.x, 1), lerp(anchor.y, p.y, 1) + (k - 1.5) * 1.6);
        ctx.stroke();
      }
    }
  }

  // --- jaw / teeth ----------------------------------------------------------
  const mouth = b.mouth || pts[0];
  const mAng = mouth.a !== undefined ? mouth.a : b.angle;
  const fangy = style === 'garpike' || style === 'angler' || style === 'shark' || style === 'darter';
  if (fangy) {
    const openA = (0.1 + (c.strikeT > 0 ? 0.5 : 0) + (c.bb && c.bb.prey ? 0.14 : 0)) * (style === 'angler' ? 1.5 : 1);
    ctx.strokeStyle = rgba(r.teeth || '#f2fbff', 0.85);
    ctx.lineWidth = Math.max(0.4, c.radius * 0.07);
    const rows = b.limbs.filter((L) => L.kind === 'mandible');
    for (const L of rows) {
      const p = L.pts[0];
      if (!p) continue;
      const base = mAng + L.side * openA * 2.4;
      for (let k = 0; k < L.pts.length; k++) {
        const q = L.pts[k];
        ctx.beginPath();
        ctx.moveTo(q.x, q.y);
        ctx.lineTo(q.x + Math.cos(base + L.side * 1.5) * c.radius * 0.22, q.y + Math.sin(base + L.side * 1.5) * c.radius * 0.22);
        ctx.stroke();
      }
    }
    if (style === 'garpike') {
      // the needle: two long beak halves
      const len = c.radius * 1.5;
      ctx.strokeStyle = rgba(r.teeth || '#eef7ff', 0.55);
      ctx.lineWidth = Math.max(0.5, c.radius * 0.1);
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(mouth.x, mouth.y);
        ctx.lineTo(mouth.x + Math.cos(mAng + s * (0.08 + openA)) * len, mouth.y + Math.sin(mAng + s * (0.08 + openA)) * len);
        ctx.stroke();
      }
    }
  }
  // lure (angler / any species with a glowing esca)
  for (const L of b.limbs) {
    if (!L.def || !L.def.glow) continue;
    const tip = L.pts[L.pts.length - 1];
    if (!tip) continue;
    const gl = 0.4 + 0.6 * Math.abs(Math.sin(c.t * 1.6 + c.id));
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const g3 = ctx.createRadialGradient(tip.x, tip.y, 0, tip.x, tip.y, c.radius * 2.6);
    g3.addColorStop(0, rgba(r.lure || '#9ff6ff', 0.85 * gl));
    g3.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g3;
    ctx.beginPath(); ctx.arc(tip.x, tip.y, c.radius * 2.6, 0, TAU); ctx.fill();
    ctx.restore();
    limbBones(ctx, L, Math.max(0.5, c.radius * 0.1), rgba(r.lure || '#9ff6ff', 0.5), rgba(r.lure || '#9ff6ff', 0.9 * gl), true);
  }
  // tang's pelvic scalpel
  if (style === 'tang') {
    for (const L of b.limbs) {
      if (!L.def || !L.def.scalpel) continue;
      const p = L.pts[L.pts.length - 1];
      if (!p) continue;
      ctx.strokeStyle = rgba(r.scalpel || '#fff6d8', 0.85);
      ctx.lineWidth = Math.max(0.5, c.radius * 0.12);
      ctx.beginPath();
      ctx.moveTo(pts[Math.min(n - 1, L.seg)].x, pts[Math.min(n - 1, L.seg)].y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    }
  }
  drawEye(ctx, c, pts[0], mAng, r, dark);
}

function drawEye(ctx, c, head, ang, r, dark) {
  const er = Math.max(0.7, c.radius * 0.2);
  const ex = head.x + Math.cos(ang - 0.55) * er * 1.5;
  const ey = head.y + Math.sin(ang - 0.55) * er * 1.5;
  ctx.fillStyle = rgba(r.eye || '#04121a', 0.9);
  ctx.beginPath(); ctx.arc(ex, ey, er, 0, TAU); ctx.fill();
  const gl = 0.35 + dark * 0.55;
  ctx.fillStyle = `rgba(220,250,255,${gl})`;
  ctx.beginPath(); ctx.arc(ex + er * 0.28, ey - er * 0.3, er * 0.42, 0, TAU); ctx.fill();
  if (c.sp && c.sp.eyeRing) {
    ctx.strokeStyle = rgba(c.sp.eyeRing, 0.7);
    ctx.lineWidth = er * 0.3;
    ctx.beginPath(); ctx.arc(ex, ey, er * 1.3, 0, TAU); ctx.stroke();
  }
  // fear: the eye goes wide and the ring shows
  if (c.fear > 0.25) {
    ctx.strokeStyle = `rgba(255,120,120,${clamp01(c.fear) * 0.5})`;
    ctx.lineWidth = 0.6;
    ctx.beginPath(); ctx.arc(ex, ey, er * 1.9, 0, TAU); ctx.stroke();
  }
}

// ===========================================================================
//  JELLYFISH — a contracting ring bell with a tentacle curtain
// ===========================================================================
function drawBell(ctx, c, world) {
  const b = c.body, pts = b.pts, n = b.n;
  const r = c.render || c.sp.render;
  const sc = c.scale * c.growth;
  const light = lightAt(c.y, world.phase);
  const pulse = c.pulse || 0;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const bulge = 1 + pulse * 0.16 * Math.sin(i * 2.1 + c.t * 4);
    const px = p.x + (p.x - c.x) * (bulge - 1), py = p.y + (p.y - c.y) * (bulge - 1);
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();
  const g2 = ctx.createRadialGradient(c.x, c.y - c.radius * 0.3, c.radius * 0.1, c.x, c.y, c.radius * 1.5);
  g2.addColorStop(0, rgba(r.bell, 0.5 + 0.25 * light));
  g2.addColorStop(0.7, rgba(r.bellDeep || r.bell, 0.36));
  g2.addColorStop(1, rgba(r.bellDeep || r.bell, 0.08));
  ctx.fillStyle = g2;
  ctx.fill();
  ctx.strokeStyle = rgba(r.glow || r.bell, 0.5 + 0.4 * (1 - light) + pulse * 0.3);
  ctx.lineWidth = Math.max(0.6, c.radius * 0.13);
  ctx.stroke();
  // radial canals
  ctx.strokeStyle = rgba(r.bell, 0.3);
  ctx.lineWidth = 0.4;
  for (let i = 0; i < n; i += 2) {
    ctx.beginPath();
    ctx.moveTo(c.x, c.y - c.radius * 0.2);
    ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
  }
  // tentacles + oral arms — each one is a limb the physics is dragging
  for (const L of b.limbs) {
    const pts2 = L.pts;
    if (pts2.length < 2) continue;
    const oral = L.def && L.def.name === 'oral';
    ctx.beginPath();
    ctx.moveTo(pts2[0].x, pts2[0].y);
    for (let i = 1; i < pts2.length; i++) ctx.lineTo(pts2[i].x, pts2[i].y);
    ctx.strokeStyle = oral ? rgba(r.bellDeep || r.tentacle, 0.55) : rgba(r.tentacle || r.bell, 0.42);
    ctx.lineWidth = (oral ? 1.5 : 0.7) * sc;
    ctx.lineCap = 'round';
    ctx.stroke();
    if (c.strikeT > 0 || c.lash > 0.1) {
      const tip = pts2[pts2.length - 1];
      ctx.fillStyle = rgba(r.sting || '#fff2a8', 0.8);
      ctx.beginPath(); ctx.arc(tip.x, tip.y, 1.2 * sc, 0, TAU); ctx.fill();
    }
  }
}

// ===========================================================================
//  WALKERS — crab + bone crawler: the carapace rides on planted IK feet
// ===========================================================================
function drawWalker(ctx, c, world, kind) {
  const b = c.body, pts = b.pts, n = b.n;
  const r = c.render || c.sp.render;
  const sc = c.scale * c.growth;
  const light = lightAt(c.y, world.phase);
  const head = pts[0];
  const ang = b.angle || head.a || 0;

  // legs first (behind the shell) — each is drawn exactly where IK put it
  for (const L of b.limbs) {
    if (L.kind !== 'leg') continue;
    const anchor = pts[Math.min(n - 1, L.seg)];
    const hip = { x: anchor.x + L.side * c.radius * 0.35 * Math.cos(ang + PI / 2), y: anchor.y + L.side * c.radius * 0.35 * Math.sin(ang + PI / 2) };
    const chain = { anchor: hip, pts: L.pts };
    limbBones(ctx, chain, Math.max(0.6, c.radius * 0.13 * sc), rgba(r.leg || r.shell, 0.92), null);
    // the foot: a claw tip that visibly grips
    const f = L.foot;
    if (f) {
      ctx.fillStyle = f.planted ? rgba(r.claw || r.leg || '#d8d0bb', 0.95) : rgba(r.leg || r.shell, 0.6);
      ctx.beginPath();
      ctx.arc(f.x, f.y, Math.max(0.5, c.radius * 0.08 * sc) * (f.planted ? 1.4 : 1), 0, TAU);
      ctx.fill();
    }
  }

  // carapace: a shell swept through the anterior points
  ctx.beginPath();
  const shellPts = [];
  const sn = Math.max(3, Math.min(n, kind === 'crab' ? 5 : 4));
  for (let i = 0; i < sn; i++) shellPts.push(pts[i]);
  const prof = kind === 'crab' ? (t) => 1.5 - Math.abs(t - 0.35) * 1.1 : (t) => 1.15 - Math.abs(t - 0.4) * 0.9;
  bodyPath(ctx, shellPts, sn, sc * (kind === 'crab' ? 1.5 : 1.25), prof);
  const g2 = ctx.createLinearGradient(head.x, head.y - c.radius, head.x, head.y + c.radius * 0.8);
  g2.addColorStop(0, shade(r.shellHi || r.shell, 1.1 * (0.4 + light * 0.8)));
  g2.addColorStop(0.55, shade(r.shell, 0.8 + light * 0.4));
  g2.addColorStop(1, shade(r.shell, 0.42));
  ctx.fillStyle = g2;
  ctx.fill();
  if (kind === 'crab') {
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 0.5;
    ctx.stroke();
    // horn-like spines on the carapace front
    if (r.spike) {
      ctx.fillStyle = rgba(r.shellHi || r.shell, 0.9);
      for (let k = -1; k <= 1; k += 2) {
        const a = ang + k * 0.5;
        ctx.beginPath();
        ctx.moveTo(head.x + Math.cos(a) * c.radius * 0.4, head.y + Math.sin(a) * c.radius * 0.4);
        ctx.lineTo(head.x + Math.cos(a) * c.radius * 1.5, head.y + Math.sin(a) * c.radius * 1.5);
        ctx.lineTo(head.x + Math.cos(a + 0.22) * c.radius * 0.5, head.y + Math.sin(a + 0.22) * c.radius * 0.5);
        ctx.closePath();
        ctx.fill();
      }
    }
  }
  // chelipeds: the claws open when striking or holding food
  for (const L of b.limbs) {
    if (L.kind !== 'claw') continue;
    const anchor = pts[Math.min(n - 1, L.seg)];
    limbBones(ctx, { anchor, pts: L.pts }, Math.max(0.8, c.radius * 0.2 * sc), rgba(r.claw || r.shell, 0.95), null);
    const tip = L.pts[L.pts.length - 1];
    if (!tip) continue;
    const open = clamp01(L.open === undefined ? 1 : L.open) * (0.5 + (c.strikeT > 0 ? 0.5 : 0));
    const dir = Math.atan2(tip.y - anchor.y, tip.x - anchor.x);
    const cl = c.radius * 0.75 * sc;
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(tip.x, tip.y);
      ctx.lineTo(tip.x + Math.cos(dir + s * (0.18 + open * 0.5)) * cl, tip.y + Math.sin(dir + s * (0.18 + open * 0.5)) * cl);
      ctx.lineTo(tip.x + Math.cos(dir + s * (0.05 + open * 0.15)) * cl * 0.55, tip.y + Math.sin(dir + s * (0.05 + open * 0.15)) * cl * 0.55);
      ctx.closePath();
      ctx.fillStyle = rgba(r.claw || r.shellHi || r.shell, 0.95);
      ctx.fill();
    }
  }
  // antennae
  for (const L of b.limbs) {
    if (L.kind !== 'antenna') continue;
    const anchor = pts[0];
    ctx.beginPath();
    ctx.moveTo(anchor.x, anchor.y);
    for (let i = 0; i < L.pts.length; i++) ctx.lineTo(L.pts[i].x, L.pts[i].y);
    ctx.strokeStyle = rgba(r.antenna || r.leg || '#e8e2d4', 0.6);
    ctx.lineWidth = Math.max(0.35, c.radius * 0.05 * sc);
    ctx.stroke();
  }
  // eyes on short stalks for a crab, glowing red dots for the crawler
  for (const s of [-1, 1]) {
    const ex = head.x + Math.cos(ang + s * 0.42) * c.radius * 0.6 * sc;
    const ey = head.y + Math.sin(ang + s * 0.42) * c.radius * 0.6 * sc - c.radius * 0.15;
    if (kind === 'crab') {
      ctx.strokeStyle = rgba(r.leg || r.shell, 0.8);
      ctx.lineWidth = Math.max(0.4, c.radius * 0.07);
      ctx.beginPath(); ctx.moveTo(head.x, head.y); ctx.lineTo(ex, ey); ctx.stroke();
      ctx.fillStyle = rgba(r.eye || '#ffe08a', 0.95);
      ctx.beginPath(); ctx.arc(ex, ey, Math.max(0.6, c.radius * 0.11 * sc), 0, TAU); ctx.fill();
      ctx.fillStyle = 'rgba(0,0,0,0.8)';
      ctx.beginPath(); ctx.arc(ex + s * 0.3, ey, Math.max(0.3, c.radius * 0.05), 0, TAU); ctx.fill();
    } else {
      ctx.fillStyle = `rgba(255,70,90,${0.55 + 0.4 * Math.abs(Math.sin(c.t * 1.3 + s))})`;
      ctx.beginPath(); ctx.arc(ex, ey, Math.max(0.5, c.radius * 0.09 * sc), 0, TAU); ctx.fill();
    }
  }
}

// ===========================================================================
//  URCHIN — every spine is its own articulated limb
// ===========================================================================
function drawTest(ctx, c, world) {
  const b = c.body, pts = b.pts, n = b.n;
  const r = c.render || c.sp.render;
  const sc = c.scale * c.growth;
  const up = clamp01(c.spineUp || 0);
  for (const L of b.limbs) {
    if (L.kind !== 'spine') continue;
    const root = pts[Math.min(n - 1, Math.max(0, L.seg))] || pts[0];
    const dir = Math.atan2(root.y - c.y, root.x - c.x) - up * 0.5;
    const len = c.radius * (1.5 + up * 0.5) * sc;
    const mid = { x: root.x + Math.cos(dir) * len * 0.55 + (L.pts[0] ? (L.pts[0].x - root.x) * 0.35 : 0), y: root.y + Math.sin(dir) * len * 0.55 + (L.pts[0] ? (L.pts[0].y - root.y) * 0.35 : 0) };
    const tip = { x: mid.x + Math.cos(dir + (L.side || 0) * 0.1) * len * 0.5, y: mid.y + Math.sin(dir + (L.side || 0) * 0.1) * len * 0.5 };
    ctx.strokeStyle = rgba(r.spine || '#b06bff', 0.85);
    ctx.lineWidth = Math.max(0.5, c.radius * 0.1 * sc);
    ctx.beginPath();
    ctx.moveTo(root.x, root.y);
    ctx.lineTo(mid.x, mid.y);
    ctx.lineTo(tip.x, tip.y);
    ctx.stroke();
    ctx.fillStyle = rgba(r.spineTip || '#ffe57a', 0.5 + up * 0.5);
    ctx.beginPath(); ctx.arc(tip.x, tip.y, Math.max(0.4, c.radius * 0.05), 0, TAU); ctx.fill();
  }
  // the test itself
  ctx.beginPath();
  ctx.arc(c.x, c.y, c.radius * 0.72 * sc, 0, TAU);
  const g2 = ctx.createRadialGradient(c.x - c.radius * 0.2, c.y - c.radius * 0.3, 0, c.x, c.y, c.radius);
  g2.addColorStop(0, shade(r.body, 1.25));
  g2.addColorStop(1, shade(r.body, 0.45));
  ctx.fillStyle = g2;
  ctx.fill();
  // tube feet gripping the rock
  for (const L of b.limbs) {
    if (L.kind !== 'leg') continue;
    const f = L.foot;
    if (!f) continue;
    ctx.strokeStyle = 'rgba(230,190,255,0.35)';
    ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(f.x, f.y); ctx.stroke();
    ctx.fillStyle = f.planted ? 'rgba(255,240,200,0.7)' : 'rgba(255,240,200,0.25)';
    ctx.beginPath(); ctx.arc(f.x, f.y, 0.7, 0, TAU); ctx.fill();
  }
}

// ===========================================================================
//  SNAIL — a foot wave under a logarithmic shell
// ===========================================================================
function drawSnail(ctx, c, world) {
  const b = c.body, pts = b.pts, n = b.n;
  const r = c.render || c.sp.render;
  const sc = c.scale * c.growth;
  const head = pts[0];
  const ang = b.angle || 0;
  // foot: a wave along the sole
  ctx.beginPath();
  ctx.moveTo(pts[n - 1].x, pts[n - 1].y);
  for (let i = n - 1; i >= 0; i--) {
    const p = pts[i];
    const w = Math.sin(c.t * 2.6 + i * 0.9) * c.radius * 0.16;
    ctx.lineTo(p.x, p.y + c.radius * 0.42 * sc + w);
  }
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    ctx.lineTo(p.x, p.y - c.radius * 0.05 * sc);
  }
  ctx.closePath();
  ctx.fillStyle = shade(r.body, 0.72 + lightAt(c.y) * 0.4);
  ctx.fill();
  // shell
  const cxp = pts[Math.min(1, n - 1)].x, cyp = pts[Math.min(1, n - 1)].y - c.radius * 0.35 * sc;
  const R = c.radius * 0.95 * sc;
  ctx.save();
  ctx.translate(cxp, cyp);
  ctx.rotate(ang * 0.25);
  ctx.beginPath();
  for (let k = 0; k < 60; k++) {
    const t = k / 60;
    const a = t * TAU * 2.1;
    const rad = R * (1 - t * 0.78);
    const px = Math.cos(a) * rad, py = Math.sin(a) * rad * 0.85 - R * 0.15;
    if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.strokeStyle = rgba(r.shellRim || r.shell, 0.85);
  ctx.lineWidth = Math.max(0.6, R * 0.22);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, -R * 0.1, R, 0, TAU);
  const g2 = ctx.createRadialGradient(-R * 0.3, -R * 0.4, 0, 0, 0, R * 1.1);
  g2.addColorStop(0, shade(r.shellRim || r.shell, 1.2));
  g2.addColorStop(1, shade(r.shell, 0.5));
  ctx.fillStyle = g2;
  ctx.fill();
  if (c.seal > 0.05) {
    ctx.fillStyle = `rgba(210,190,150,${0.4 + c.seal * 0.5})`;
    ctx.beginPath(); ctx.ellipse(R * 0.55, R * 0.2, R * 0.4, R * 0.3, 0.4, 0, TAU); ctx.fill();
  }
  ctx.restore();
  // eyestalks
  for (const L of b.limbs) {
    if (L.kind !== 'antenna') continue;
    const tip = L.pts[L.pts.length - 1];
    if (!tip) continue;
    ctx.strokeStyle = rgba(r.body, 0.9);
    ctx.lineWidth = 0.6 * sc;
    ctx.beginPath(); ctx.moveTo(head.x, head.y); ctx.lineTo(tip.x, tip.y); ctx.stroke();
    ctx.fillStyle = rgba(r.eye || '#20120a', 0.95);
    ctx.beginPath(); ctx.arc(tip.x, tip.y, 0.9 * sc, 0, TAU); ctx.fill();
  }
}

// ===========================================================================
//  THE LEVIATHAN — serpentine, articulated mandibles, flank of photophores
// ===========================================================================
function drawSerpent(ctx, c, world) {
  const b = c.body, pts = b.pts, n = b.n;
  const r = c.render || c.sp.render;
  const sc = c.scale * c.growth;
  const light = lightAt(c.y, world.phase);
  const head = pts[0];
  const ang = head.a !== undefined ? head.a : b.angle;
  const hunting = c.strikeT > 0 || (c.bb && c.bb.prey);
  const dark = clamp01(1 - light * 2.4);

  // dorsal fin fold along the back
  ctx.beginPath();
  for (let i = 1; i < n - 1; i++) {
    const p = pts[i], q = pts[i + 1];
    const nx = -(q.y - p.y), ny = q.x - p.x;
    const L2 = Math.hypot(nx, ny) || 1;
    const h = p.r * sc * (1.6 + Math.sin(i * 0.7 + c.t * 1.4) * 0.35);
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x + (nx / L2) * h, p.y + (ny / L2) * h);
    ctx.lineTo(q.x, q.y);
  }
  ctx.fillStyle = rgba(r.flank, 0.3);
  ctx.fill();

  // the body: an almost-black silhouette that only reads through its lights
  const prof = (t) => 1.0 - Math.pow(t, 1.7) * 0.82;
  bodyPath(ctx, pts, n, sc * 1.05, prof);
  const g2 = ctx.createLinearGradient(head.x, head.y - c.radius * 2, pts[n - 1].x, pts[n - 1].y);
  g2.addColorStop(0, shade(r.body, 1.05 * (0.35 + (1 - dark) * 0.7)));
  g2.addColorStop(0.5, shade(r.flank, 0.6));
  g2.addColorStop(1, shade(r.body, 0.28));
  ctx.fillStyle = g2;
  ctx.fill();
  ctx.strokeStyle = rgba(r.accent, 0.14 + dark * 0.2);
  ctx.lineWidth = Math.max(0.5, c.radius * 0.06);
  ctx.stroke();

  // photophore rows: the animal's own light, brightening as it hunts
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const t = i / (n - 1);
    const gl = clamp01((p.glow || 0) * 0.5 + 0.25 + (hunting ? 0.4 : 0) + Math.sin(c.t * 2 + i * 0.8) * 0.12) * (0.35 + dark * 0.9);
    const rr = p.r * sc * (1.15 + gl * 0.7);
    const g3 = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, rr * 3.4);
    g3.addColorStop(0, rgba(r.photophore || r.accent, 0.85 * gl));
    g3.addColorStop(0.35, rgba(r.photophore || r.accent, 0.24 * gl));
    g3.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g3;
    ctx.beginPath(); ctx.arc(p.x, p.y, rr * 3.4, 0, TAU); ctx.fill();
    ctx.fillStyle = rgba(r.photophore || '#54e6ff', 0.9 * gl);
    ctx.beginPath(); ctx.arc(p.x, p.y - p.r * sc * 0.2, Math.max(0.4, p.r * sc * 0.3), 0, TAU); ctx.fill();
  }
  ctx.restore();

  // the mandible cluster: 6 articulated arms, 3 bones each, driven by IK
  for (const L of b.limbs) {
    if (L.kind !== 'mandible') continue;
    const anchor = pts[Math.min(n - 1, L.seg)];
    const open = clamp01(L.open === undefined ? 1 : L.open);
    const spread = (0.16 + open * 0.5 + (c.strikeT > 0 ? -0.28 : 0)) * L.side;
    const chain = { anchor, pts: L.pts };
    limbBones(ctx, chain, Math.max(1, c.radius * 0.17 * sc), rgba(r.mandible || r.accent, 0.9), rgba(r.accent, 0.6 * (0.4 + dark)), false);
    // the inner serration
    ctx.strokeStyle = rgba(r.mandible || '#cfe9ff', 0.5);
    ctx.lineWidth = 0.5;
    for (let k = 0; k < L.pts.length; k++) {
      const q = L.pts[k];
      const dir = Math.atan2(q.y - anchor.y, q.x - anchor.x) + spread + L.side * 1.9;
      ctx.beginPath();
      ctx.moveTo(q.x, q.y);
      ctx.lineTo(q.x + Math.cos(dir) * c.radius * 0.3, q.y + Math.sin(dir) * c.radius * 0.3);
      ctx.stroke();
    }
  }
  // jaws
  const mOpen = clamp01(0.18 + (c.strikeT > 0 ? 0.7 : 0) + (hunting ? 0.2 : 0));
  ctx.fillStyle = 'rgba(4,8,14,0.9)';
  ctx.beginPath();
  const mw = c.radius * 1.1 * sc, ml = c.radius * 1.5 * sc;
  ctx.moveTo(head.x, head.y);
  ctx.lineTo(head.x + Math.cos(ang - mOpen) * ml, head.y + Math.sin(ang - mOpen) * ml);
  ctx.lineTo(head.x + Math.cos(ang) * ml * 1.1, head.y + Math.sin(ang) * ml * 1.1);
  ctx.lineTo(head.x + Math.cos(ang + mOpen) * ml, head.y + Math.sin(ang + mOpen) * ml);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = rgba(r.mandible || '#cfe9ff', 0.7);
  ctx.lineWidth = Math.max(0.6, mw * 0.09);
  ctx.stroke();
  // the lure
  for (const L of b.limbs) {
    if (!L.def || !L.def.glow) continue;
    const tip = L.pts[L.pts.length - 1];
    if (!tip) continue;
    const gl = 0.55 + 0.45 * Math.sin(c.t * 2.4 + c.id);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const g3 = ctx.createRadialGradient(tip.x, tip.y, 0, tip.x, tip.y, c.radius * 4);
    g3.addColorStop(0, rgba(r.accent, 0.9 * gl));
    g3.addColorStop(0.3, rgba(r.accent, 0.3 * gl));
    g3.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g3;
    ctx.beginPath(); ctx.arc(tip.x, tip.y, c.radius * 4, 0, TAU); ctx.fill();
    ctx.restore();
    limbBones(ctx, L, Math.max(0.5, c.radius * 0.07), rgba(r.accent, 0.4), rgba(r.accent, 0.9 * gl), true);
  }
  // eyes: two small cold suns
  for (const s of [-1, 1]) {
    const ex = head.x + Math.cos(ang + s * 0.5) * c.radius * 0.72 * sc;
    const ey = head.y + Math.sin(ang + s * 0.5) * c.radius * 0.72 * sc;
    ctx.fillStyle = rgba(r.eye || '#e8fbff', 0.9);
    ctx.beginPath(); ctx.arc(ex, ey, Math.max(0.8, c.radius * 0.12 * sc), 0, TAU); ctx.fill();
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const g3 = ctx.createRadialGradient(ex, ey, 0, ex, ey, c.radius * 1.6);
    g3.addColorStop(0, rgba(r.eye || '#e8fbff', 0.35));
    g3.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g3;
    ctx.beginPath(); ctx.arc(ex, ey, c.radius * 1.6, 0, TAU); ctx.fill();
    ctx.restore();
  }
  if (c.wound > 0.03) {
    ctx.fillStyle = `rgba(190,40,60,${0.3 * c.wound})`;
    ctx.beginPath(); ctx.arc(c.x, c.y, c.radius * 2, 0, TAU); ctx.fill();
  }
}

// ===========================================================================
//  DISPATCH
// ===========================================================================
const PAINTERS = {
  minnow: drawFish, garpike: drawFish, tang: drawFish, darter: drawFish, eel: drawFish, shark: drawFish, angler: drawFish,
  jelly: drawBell,
  crab: drawWalker, crawler: drawWalker,
  urchin: drawTest,
  snail: drawSnail,
  leviathan: drawSerpent,
};

export function drawCreature(ctx, c, world, opts = {}) {
  if (!c.body || !c.body.n) return;
  const style = (c.sp.render && c.sp.render.style) || 'minnow';
  const fn = PAINTERS[style] || drawFish;
  ctx.save();
  if (c.lod === 2) ctx.globalAlpha = 0.55;
  else if (c.lod === 1) ctx.globalAlpha = 0.82;
  if (c.plane === 1) ctx.globalAlpha *= 0.72;                       // behind the murk
  fn(ctx, c, world, style);
  // being hit is white, brief and physical
  if (c.flash > 0.02) {
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = `rgba(255,235,235,${0.5 * c.flash})`;
    ctx.beginPath(); ctx.arc(c.x, c.y, c.radius * 2.1, 0, TAU); ctx.fill();
  }
  ctx.restore();
  if (opts.showVectors) drawDebugVectors(ctx, c, world);
  if (opts.selected) drawSelection(ctx, c, world, opts);
}

function drawSelection(ctx, c, world, opts = {}) {
  const r = c.radius * 2.4 + 8;
  ctx.save();
  ctx.strokeStyle = 'rgba(180,240,255,0.85)';
  ctx.lineWidth = 1.2 / (opts.zoom || 1);
  ctx.setLineDash([5, 4]);
  ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, TAU); ctx.stroke();
  ctx.setLineDash([]);
  // the four bars that matter
  const bars = [
    ['hunger', c.hunger, '#ffd166'],
    ['health', c.health, '#7bf0a0'],
    ['stamina', c.stamina, '#7ad9ff'],
    ['air', c.air, '#e0e7ff'],
  ];
  const bw = r * 1.8, bh = 2.6;
  for (let k = 0; k < bars.length; k++) {
    const v = clamp01(bars[k][1]);
    if (bars[k][0] === 'air' && !(c.sp.phys && c.sp.phys.lung)) continue;
    const y = c.y - r - 8 - k * (bh + 1.6);
    ctx.fillStyle = 'rgba(4,10,16,0.6)';
    ctx.fillRect(c.x - bw / 2, y, bw, bh);
    ctx.fillStyle = bars[k][2];
    ctx.fillRect(c.x - bw / 2, y, bw * v, bh);
  }
  ctx.restore();
}

function drawDebugVectors(ctx, c, world) {
  const b = c.body;
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth = 0.6;
  ctx.beginPath(); ctx.moveTo(c.x, c.y);
  ctx.lineTo(c.x + Math.cos(c.wantHeading) * 40, c.y + Math.sin(c.wantHeading) * 40);
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,90,90,0.9)';
  for (let i = 0; i < b.n; i++) { ctx.beginPath(); ctx.arc(b.pts[i].x, b.pts[i].y, 1.4, 0, TAU); ctx.fill(); }
  ctx.fillStyle = 'rgba(90,255,140,0.9)';
  for (const L of b.limbs) if (L.foot) { ctx.beginPath(); ctx.arc(L.foot.x, L.foot.y, 1.4, 0, TAU); ctx.fill(); }
  if (c.target && c.target.alive) {
    ctx.strokeStyle = 'rgba(255,200,60,0.5)';
    ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(c.target.x, c.target.y); ctx.stroke();
  }
  ctx.restore();
}

/** drifting carcass: the same body colours, collapsed to a lump that breaks up */
export function drawCarrion(ctx, k, world) {
  const f = k.mass / k.maxMass;
  const light = lightAt(k.y, world.phase);
  const sp = k.key && SPECIES[k.key];
  const col = (sp && sp.render && (sp.render.body || sp.render.shell)) || '#9fb2bd';
  ctx.save();
  ctx.translate(k.x, k.y);
  ctx.rotate(k.rot);
  ctx.globalAlpha = 0.35 + f * 0.6;
  for (const p of k.pieces) {
    const rr = k.r * p.d * (0.4 + f * 0.8);
    ctx.fillStyle = shade(col, 0.5 + light * 0.5);
    ctx.beginPath();
    ctx.ellipse(Math.cos(p.a) * k.r * 0.35, Math.sin(p.a) * k.r * 0.3, rr, rr * 0.62 * p.s, p.a, 0, TAU);
    ctx.fill();
  }
  ctx.strokeStyle = 'rgba(220,235,245,0.16)';
  ctx.lineWidth = 0.6;
  ctx.beginPath(); ctx.arc(0, 0, k.r * (0.4 + f * 0.7), 0, TAU * clamp01(f)); ctx.stroke();
  ctx.restore();
  ctx.globalAlpha = 1;
}

export function drawEgg(ctx, e, world) {
  const t = clamp01(e.t / e.hatch);
  const r = 2.6 + t * 2.4;
  ctx.save();
  ctx.globalAlpha = 0.8;
  const g2 = ctx.createRadialGradient(e.x - r * 0.3, e.y - r * 0.3, 0, e.x, e.y, r * 1.5);
  g2.addColorStop(0, 'rgba(255,255,240,0.9)');
  g2.addColorStop(0.6, 'rgba(190,225,235,0.35)');
  g2.addColorStop(1, 'rgba(120,180,200,0)');
  ctx.fillStyle = g2;
  ctx.beginPath(); ctx.arc(e.x, e.y, r * 1.5, 0, TAU); ctx.fill();
  ctx.strokeStyle = 'rgba(220,245,255,0.5)';
  ctx.lineWidth = 0.4;
  ctx.beginPath(); ctx.arc(e.x, e.y, r, 0, TAU); ctx.stroke();
  // the embryo: a knot of tissue that tightens as it matures
  ctx.fillStyle = `rgba(40,90,110,${0.35 + t * 0.5})`;
  ctx.beginPath(); ctx.arc(e.x + Math.sin(e.t * 3) * 0.6, e.y, r * (0.3 + t * 0.4), 0, TAU); ctx.fill();
  ctx.restore();
}

export { shade, rgba, bodyPath };
