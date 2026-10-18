// ---------------------------------------------------------------------------
//  FLORA PAINTER
//
//  Plants are simulated too: kelp are verlet stipes that the current bends,
//  coral is a recursive branch structure that grew over time, anemones have
//  independent tentacles, mats and biofilm are patches with a biomass value.
//  Everything drawn here reads that live state — a grazed stipe is visibly
//  shorter, a bleached coral is visibly pale.
// ---------------------------------------------------------------------------

import { TAU, PI, clamp, clamp01, lerp } from '../core/vec.js';
import { hash2 } from '../core/rand.js';
import { lightAt } from '../sim/zones.js';

function patch(ctx, p, world, colA, colB) {
  const r = p.r || 20;
  const light = lightAt(p.y, world.phase);
  const bio = clamp01(p.biomass);
  ctx.save();
  ctx.translate(p.x, p.y);
  const blobs = p.blobs;
  ctx.beginPath();
  if (blobs && blobs.length) {
    for (let k = 0; k <= blobs.length; k++) {
      const bl = blobs[k % blobs.length];
      const rr = bl.r * (0.5 + bio * 0.9);
      const x = Math.cos(bl.a) * r * bl.d * 0.8, y = Math.sin(bl.a) * r * bl.d * 0.3;
      ctx.moveTo(x + rr, y);
      ctx.arc(x, y, rr, 0, TAU);
    }
  } else {
    const segs = 14;
    for (let k = 0; k <= segs; k++) {
      const a = (k / segs) * TAU;
      const wob = 0.72 + 0.4 * hash2(Math.round(Math.cos(a) * 6) + p.id, Math.round(Math.sin(a) * 6));
      const rr = r * wob * (0.55 + bio * 0.6);
      const x = Math.cos(a) * rr, y = Math.sin(a) * rr * 0.42;
      if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
  }
  ctx.closePath();
  const g2 = ctx.createLinearGradient(0, -r * 0.4, 0, r * 0.4);
  g2.addColorStop(0, colA);
  g2.addColorStop(1, colB);
  ctx.globalAlpha = 0.5 + bio * 0.45;
  ctx.fillStyle = g2;
  ctx.fill();
  // speckled texture so a mat reads as a living skin, not a blob
  ctx.globalAlpha = 0.4 * (0.3 + light);
  for (let k = 0; k < 8; k++) {
    const a = hash2(k * 2.3, p.id) * TAU;
    const d = (hash2(p.id, k * 3.1) % 1) * r * 0.8;
    ctx.fillStyle = k % 2 ? colA : colB;
    ctx.beginPath(); ctx.arc(Math.cos(a) * d, Math.sin(a) * d * 0.4, 1.1, 0, TAU); ctx.fill();
  }
  ctx.restore();
  ctx.globalAlpha = 1;
}

export function drawFlora(ctx, p, world, opts = {}) {
  const sp = p.sp;
  const kind = p.variant || p.kind;
  const light = lightAt(p.y, world.phase);
  const bio = clamp01(p.biomass);
  const pal = sp.palette || ['#4f8a2f'];
  const main = pal[p.palIdx % pal.length];
  const bgFade = p.plane === 1 ? 0.45 : 1;

  if (kind === 'kelp' || kind === 'kelpDwarf') {
    const pts = p.pts;
    if (pts.length < 2) return;
    ctx.save();
    ctx.globalAlpha = (0.55 + bio * 0.45) * bgFade;
    // stipe: a tapered ribbon through the verlet chain
    ctx.beginPath();
    const w0 = 2.6 * p.thick;
    for (let i = 0; i < pts.length; i++) {
      const q = pts[i];
      const t = i / (pts.length - 1);
      ctx.lineTo(q.x - w0 * (1 - t * 0.6), q.y);
    }
    for (let i = pts.length - 1; i >= 0; i--) {
      const q = pts[i];
      const t = i / (pts.length - 1);
      ctx.lineTo(q.x + w0 * (1 - t * 0.6), q.y);
    }
    ctx.closePath();
    const g2 = ctx.createLinearGradient(pts[0].x, pts[0].y, pts[pts.length - 1].x, pts[pts.length - 1].y);
    g2.addColorStop(0, pal[0]);
    g2.addColorStop(0.6, pal[1] || pal[0]);
    g2.addColorStop(1, pal[2] || pal[1] || pal[0]);
    ctx.fillStyle = g2;
    ctx.fill();
    // blades
    ctx.fillStyle = pal[1] || pal[0];
    for (const bl of p.blades || []) {
      const q = pts[Math.min(bl.i, pts.length - 1)];
      if (!q) continue;
      const prev = pts[Math.max(0, Math.min(bl.i, pts.length - 1) - 1)] || q;
      const ang = Math.atan2(q.y - prev.y, q.x - prev.x) + bl.side * 0.9 + Math.sin(p.t * 0.9 + bl.ph) * 0.18;
      const len = bl.l * (0.5 + bio * 0.7) * p.thick;
      ctx.beginPath();
      ctx.moveTo(q.x, q.y);
      ctx.quadraticCurveTo(
        q.x + Math.cos(ang) * len * 0.6, q.y + Math.sin(ang) * len * 0.6 - 4,
        q.x + Math.cos(ang + bl.side * 0.5) * len, q.y + Math.sin(ang + bl.side * 0.5) * len
      );
      ctx.quadraticCurveTo(
        q.x + Math.cos(ang) * len * 0.5, q.y + Math.sin(ang) * len * 0.5 + 3,
        q.x, q.y
      );
      ctx.globalAlpha = (0.4 + bio * 0.5) * bgFade;
      ctx.fill();
    }
    // pneumatocyst float at the tip, and the holdfast
    ctx.globalAlpha = bgFade;
    const tip = pts[pts.length - 1];
    if (kind === 'kelp' && bio > 0.4) {
      ctx.fillStyle = 'rgba(180,220,120,0.55)';
      ctx.beginPath(); ctx.ellipse(tip.x, tip.y, 2.6 * p.thick, 3.6 * p.thick, 0, 0, TAU); ctx.fill();
    }
    ctx.fillStyle = 'rgba(30,44,26,0.75)';
    ctx.beginPath(); ctx.ellipse(pts[0].x, pts[0].y, 4.5 * p.thick, 2.2, 0, 0, TAU); ctx.fill();
    ctx.restore();
    return;
  }

  if (kind === 'coral') {
    ctx.save();
    ctx.globalAlpha = bgFade;
    const bleached = clamp01(p.bleached || 0);
    for (const br of p.branches || []) {
      const col = pal[(br.hue * pal.length) | 0 % pal.length] || pal[0];
      ctx.strokeStyle = mix(col, '#f2f4f0', bleached * 0.85);
      ctx.lineCap = 'round';
      const pts = br.pts;
      for (let i = 1; i < pts.length; i++) {
        ctx.lineWidth = Math.max(0.5, (pts[i].w || 3) * (0.45 + bio * 0.85) * p.thick);
        ctx.beginPath();
        ctx.moveTo(pts[i - 1].x, pts[i - 1].y);
        ctx.lineTo(pts[i].x, pts[i].y);
        ctx.stroke();
      }
      // polyps: tissue tips that extend with biomass and retract when grazed
      if (bio > 0.25) {
        const open = clamp01((p.open || 0) * (1 - p.retreat * 0.8));
        ctx.fillStyle = mix(pal[(((br.hue * pal.length) | 0) + 1) % pal.length], '#ffffff', 0.3);
        ctx.globalAlpha = (0.3 + open * 0.6) * bgFade;
        for (let i = 1; i < pts.length; i++) {
          if (!pts[i].tip) continue;
          ctx.beginPath();
          ctx.arc(pts[i].x, pts[i].y, (0.7 + open * 1.4) * (0.6 + bio * 0.6), 0, TAU);
          ctx.fill();
        }
        ctx.globalAlpha = bgFade;
      }
    }
    ctx.restore();
    return;
  }

  if (kind === 'anemone') {
    const pts = p.pts;
    ctx.save();
    ctx.globalAlpha = (0.6 + bio * 0.4) * bgFade;
    ctx.strokeStyle = pal[1] || pal[0];
    ctx.lineWidth = Math.max(1.2, 3.4 * p.thick * (0.5 + bio * 0.6));
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) { if (i === 0) ctx.moveTo(pts[i].x, pts[i].y); else ctx.lineTo(pts[i].x, pts[i].y); }
    ctx.stroke();
    const top = pts[pts.length - 1] || { x: p.x, y: p.y };
    const open = clamp01(1 - p.retreat * 0.9);
    for (const t of p.tentacles || []) {
      const a = t.a + Math.PI / 2;
      const l = t.l * (0.35 + open * 0.85) * (0.6 + bio * 0.6);
      const sway = Math.sin(p.t * 1.6 + t.ph) * 0.28;
      const mx = top.x + Math.cos(a + sway) * l * 0.55;
      const my = top.y + Math.sin(a + sway) * l * 0.55 - l * 0.2;
      const ex = top.x + Math.cos(a + sway * 1.8) * l;
      const ey = top.y + Math.sin(a + sway * 1.8) * l - l * 0.35;
      ctx.strokeStyle = pal[0];
      ctx.lineWidth = 1.15;
      ctx.beginPath();
      ctx.moveTo(top.x, top.y);
      ctx.quadraticCurveTo(mx, my, ex, ey);
      ctx.stroke();
      ctx.fillStyle = pal[2] || pal[0];
      ctx.beginPath(); ctx.arc(ex, ey, 0.9, 0, TAU); ctx.fill();
    }
    ctx.restore();
    return;
  }

  if (kind === 'worm') {
    const pts = p.pts;
    ctx.save();
    ctx.globalAlpha = bgFade;
    ctx.strokeStyle = 'rgba(200,190,170,0.55)';
    ctx.lineWidth = 2.6 * p.thick;
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) { if (i === 0) ctx.moveTo(pts[i].x, pts[i].y); else ctx.lineTo(pts[i].x, pts[i].y); }
    ctx.stroke();
    const top = pts[pts.length - 1] || { x: p.x, y: p.y };
    const open = clamp01(1 - p.retreat);
    ctx.strokeStyle = '#c46a7a';
    ctx.lineWidth = 0.9;
    for (let k = 0; k < 5; k++) {
      const a = -PI / 2 + (k - 2) * 0.38;
      const l = 4 + open * 6;
      ctx.beginPath();
      ctx.moveTo(top.x, top.y);
      ctx.lineTo(top.x + Math.cos(a) * l, top.y + Math.sin(a) * l);
      ctx.stroke();
    }
    ctx.restore();
    return;
  }

  if (kind === 'barnacle') {
    const r = (4 + (p.r || 10) * 0.18) * (0.55 + bio * 0.6);
    ctx.save();
    ctx.globalAlpha = bgFade;
    ctx.fillStyle = pal[0];
    ctx.beginPath();
    ctx.moveTo(p.x - r, p.y);
    ctx.lineTo(p.x - r * 0.45, p.y - r * 1.35);
    ctx.lineTo(p.x + r * 0.45, p.y - r * 1.35);
    ctx.lineTo(p.x + r, p.y);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = pal[2] || pal[1] || pal[0];
    ctx.lineWidth = 0.6;
    ctx.stroke();
    // operculum: opens to filter-feed, shuts when something brushes past
    const open = clamp01((p.open || 0) * (1 - p.retreat));
    ctx.fillStyle = `rgba(30,40,44,${0.35 + open * 0.5})`;
    ctx.fillRect(p.x - r * 0.4, p.y - r * 1.4, r * 0.8, Math.max(0.5, r * 0.3));
    if (open > 0.3) {
      ctx.strokeStyle = 'rgba(220,240,250,0.5)';
      ctx.lineWidth = 0.35;
      for (let k = 0; k < 3; k++) {
        ctx.beginPath();
        ctx.moveTo(p.x, p.y - r * 1.4);
        ctx.lineTo(p.x + (k - 1) * r * 0.5, p.y - r * 1.4 - open * r * 1.1);
        ctx.stroke();
      }
    }
    ctx.restore();
    return;
  }

  if (kind === 'barnacle' && p.cluster) {
    // a real colony: each individual opens and shuts on its own schedule
    for (const q of p.cluster) {
      const x = p.x + q.dx, y = p.y + q.dy;
      const r = q.r * (0.55 + bio * 0.6);
      const open = clamp01((q.open + Math.sin(p.t * 0.8 + q.dx) * 0.3) * (1 - p.retreat));
      ctx.save();
      ctx.globalAlpha = bgFade;
      ctx.fillStyle = pal[0];
      ctx.beginPath();
      ctx.moveTo(x - r, y);
      ctx.lineTo(x - r * 0.42, y - r * 1.4);
      ctx.lineTo(x + r * 0.42, y - r * 1.4);
      ctx.lineTo(x + r, y);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = pal[2] || pal[1] || pal[0];
      ctx.lineWidth = 0.5;
      ctx.stroke();
      ctx.fillStyle = `rgba(26,36,40,${0.3 + open * 0.55})`;
      ctx.fillRect(x - r * 0.4, y - r * 1.45, r * 0.8, Math.max(0.4, r * 0.26));
      if (open > 0.35) {
        ctx.strokeStyle = 'rgba(220,244,255,0.55)';
        ctx.lineWidth = 0.32;
        for (let k = 0; k < 3; k++) {
          ctx.beginPath();
          ctx.moveTo(x, y - r * 1.4);
          ctx.lineTo(x + (k - 1) * r * 0.42, y - r * 1.4 - open * r * 1.25);
          ctx.stroke();
        }
      }
      ctx.restore();
    }
    return;
  }

  // mat / biofilm — p.blobs is the patch's own footprint
  const cA = pal[0], cB = pal[1] || pal[0];
  patch(ctx, p, world, cA, cB);
  if (kind === 'mat' && bio > 0.4) {
    // sulphur filaments waving in the vent flow
    ctx.save();
    ctx.globalAlpha = 0.4 * bgFade;
    ctx.strokeStyle = '#e8d98a';
    ctx.lineWidth = 0.5;
    for (let k = 0; k < 7; k++) {
      const a = hash2(k * 3.1, p.id) * TAU;
      const d = (p.r || 12) * (0.3 + (hash2(p.id, k) % 1) * 0.6);
      const x = p.x + Math.cos(a) * d, y = p.y + Math.sin(a) * d * 0.4;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.quadraticCurveTo(x + 1.5, y - 5 - bio * 5, x + Math.sin(p.t * 2 + k) * 3, y - 9 - bio * 8);
      ctx.stroke();
    }
    ctx.restore();
  }
}

function mix(hexA, hexB, t) {
  const a = parseInt(hexA.slice(1), 16), b = parseInt(hexB.slice(1), 16);
  const r = lerp((a >> 16) & 255, (b >> 16) & 255, t) | 0;
  const g = lerp((a >> 8) & 255, (b >> 8) & 255, t) | 0;
  const bl = lerp(a & 255, b & 255, t) | 0;
  return `rgb(${r},${g},${bl})`;
}
