/**
 * Drives the real app — boot(), the fixed-step loop, the camera, every painter
 * in src/render and the whole HUD — against a live world, through a fake
 * Canvas2D that records call counts and flags non-finite geometry.
 *   node test/renderSmoke.mjs [frames]
 */
import { install, problems, counters } from './domstub.mjs';

const W = 1366, H = 768;
install({ width: W, height: H, dpr: 2 });
const frames = +(process.argv[2] ?? 120);

const { boot, App } = await import('../src/main.js');
const { drawCreature, drawCarrion, drawEgg } = await import('../src/render/creatureDraw.js');
const { drawFlora } = await import('../src/render/floraDraw.js');
const { WORLD_W, WORLD_H } = await import('../src/sim/zones.js');

let app;
try { app = boot(); } catch (e) { console.error('BOOT FAILED\n', e.stack.split('\n').slice(0, 6).join('\n')); process.exit(1); }

const win = globalThis.__win, canvas = globalThis.__canvas, ctx = canvas.getContext('2d');
const acts = [
  () => app.toggle('showFoodWeb'),
  () => app.toggle('showBodies'),
  () => app.toggle('showField'),
  () => app.cycleSpeed(),
  () => app.jumpToZone(3),
  () => app.jumpToZone(1),
  () => app.selectNearestOf('leviathan'),
  () => app.toggleFollow(),
  () => app.pick(W * 0.5, H * 0.4),
  () => app.togglePause(),
  () => app.togglePause(),
  () => app.scene.quality = 0.55,
  () => { app.scene.quality = 1; app.scene.showField = 'nutrients'; },
  () => win.dispatch('keydown', { key: 'f', repeat: false }),
  () => win.dispatch('keydown', { key: 'b', repeat: false }),
  () => win.dispatch('keydown', { key: 'r', repeat: false }),
  () => win.dispatch('keydown', { key: ' ', repeat: false }),
  () => win.dispatch('keydown', { key: ' ', repeat: false }),
  () => canvas.dispatch('wheel', { deltaY: -240, clientX: 400, clientY: 300 }),
  () => canvas.dispatch('wheel', { deltaY: 520, clientX: 640, clientY: 380 }),
  () => canvas.dispatch('pointermove', { clientX: 700, clientY: 400, buttons: 1 }),
  () => app.lookAt(WORLD_W * 0.85, WORLD_H * 0.9, 3.4),
  () => app.lookAt(WORLD_W * 0.1, 120, 0.34),
  () => app.regenerate(4242),
];

let creaturePaints = 0;
for (let f = 0; f < frames; f++) {
  if (f % 5 === 0) { const a = acts[(f / 5) | 0 % acts.length]; try { acts[f % acts.length](); } catch (e) { problems.push(`action ${f}: ${e.message}`); } }
  app.frame(1 / 55 + (f % 7) * 0.004);
  // direct painter coverage at both LOD extremes, plus corpses, eggs and plants
  const w = app.world;
  for (let i = 0; i < w.creatures.length; i += 9) {
    const c = w.creatures[i];
    if (!c) continue;
    c.lod = i % 3 === 0 ? 2 : c.lod;
    drawCreature(ctx, c, w, { zoom: i % 2 ? 0.28 : 3.1, selected: i === 0, showVectors: i === 1 });
    creaturePaints++;
  }
  for (const k of w.carrion.slice(0, 10)) drawCarrion(ctx, k, w);
  for (const e of w.eggs.slice(0, 6)) drawEgg(ctx, e, w);
  for (let i = 0; i < w.flora.length; i += 17) { const p = w.flora[i]; if (p) drawFlora(ctx, p, w, { zoom: 1.6, light: 0.4 }); }
}
// the loader / help DOM path and a resize mid-flight
try { win.dispatch('resize', {}); app.resize(); app.frame(1 / 60); } catch (e) { problems.push('resize: ' + e.message); }

const ui = globalThis.__doc.getElementById('ui');
const nodeCount = (n) => (n.children || []).reduce((a, k) => a + (k.nodeType === 1 ? 1 + nodeCount(k) : 0), 0);
console.log(`frames ${frames} · creature paints ${creaturePaints} · ctx calls ${counters.calls} · ui nodes ${nodeCount(ui)} · ${app.world.creatures.length} animals alive`);
if (problems.length) {
  console.log(`FAIL — ${problems.length} render problems:`);
  for (const p of problems.slice(0, 14)) console.log('  · ' + p);
  process.exitCode = 1;
} else {
  console.log('✓ render smoke PASS — no crashes, no non-finite canvas geometry');
}
void App;
