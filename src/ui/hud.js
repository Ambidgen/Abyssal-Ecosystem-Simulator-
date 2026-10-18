// ---------------------------------------------------------------------------
//  HUD — the instrument panel.
//
//  Everything here is data the simulation already keeps: hunger/health/stamina
//  per animal, the live behaviour tree with the path that is currently running,
//  the aggregated food web, deaths by cause, and the population history. It is
//  DOM (crisp text at any zoom) updated on a throttled timer, never per frame.
// ---------------------------------------------------------------------------

import { clamp, clamp01, lerp } from '../core/vec.js';
import { ZONES, WORLD_H, WORLD_W, depthLabel, pressureLabel, lightAt, zoneIndexAt } from '../sim/zones.js';
import { SPECIES, SPECIES_KEYS } from '../sim/species.js';
import { label as btLabel, activePath, leafCount, fmtParams } from '../sim/bt.js';

const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
};

export class Hud {
  constructor(root, app) {
    this.app = app;
    this.root = root;
    this.acc = 0;
    this.every = 0.16;
    this.selHist = { hunger: [], health: [], speed: [] };
    this.selId = null;
    this.build();
  }

  build() {
    const r = this.root;
    r.innerHTML = '';

    // ---- top bar ---------------------------------------------------------
    const top = el('div', 'panel top');
    top.appendChild(el('div', 'brand', 'ABYSSAL<br>ECOSYSTEM'));
    this.stat = el('div', 'stats');
    top.appendChild(this.stat);
    const ctl = el('div', 'controls');
    const mk = (label, title, fn, cls) => {
      const b = el('button', 'btn' + (cls ? ' ' + cls : ''), label);
      b.title = title;
      b.onclick = fn;
      ctl.appendChild(b);
      return b;
    };
    this.btnPause = mk('❚❚', 'pause / resume (space)', () => this.app.togglePause(), 'key');
    this.btnSpeed = mk('1×', 'simulation speed (1-4)', () => this.app.cycleSpeed());
    mk('⟲', 'regenerate the world with a new seed', () => this.app.regenerate());
    this.btnFollow = mk('⊕ follow', 'keep the camera on the selected animal (f)', () => this.app.toggleFollow());
    mk('web', 'food-web overlay (w)', () => this.app.toggle('showFoodWeb', this.btnWeb = this.btnWeb || el('i')));
    mk('hit', 'physics + steering debug (b)', () => this.app.toggle('showBodies'));
    mk('field', 'plankton / nutrient field (d)', () => this.app.toggle('showField'));
    this.seedBox = el('input', 'seed');
    this.seedBox.type = 'number';
    this.seedBox.value = this.app.world.seed;
    this.seedBox.title = 'world seed — enter to regenerate';
    this.seedBox.onkeydown = (e) => { if (e.key === 'Enter') this.app.regenerate(+this.seedBox.value || 1); e.stopPropagation(); };
    ctl.appendChild(this.seedBox);
    top.appendChild(ctl);
    r.appendChild(top);

    // ---- depth ribbon ----------------------------------------------------
    const zones = el('div', 'panel zones');
    zones.appendChild(el('div', 'h', 'water column'));
    this.zoneRows = [];
    ZONES.forEach((z, i) => {
      const row = el('button', 'zone z' + i);
      row.innerHTML =
        `<b>Z${i + 1} ${z.name}</b><span class="tag">${z.tag}</span>` +
        `<span class="d">${depthLabel(z.top)} – ${depthLabel(z.bottom)}</span>` +
        `<span class="kv">light ${(z.light * 100).toFixed(0)}% · ${pressureLabel(z.top)}</span>` +
        `<span class="pop" data-z="${i}">–</span>`;
      row.onclick = () => this.app.jumpToZone(i);
      zones.appendChild(row);
      this.zoneRows.push(row);
    });
    this.zoneMark = el('div', 'mark');
    zones.appendChild(this.zoneMark);
    this.kpiv = el('div', 'kv2');
    zones.appendChild(this.kpiv);
    r.appendChild(zones);

    // ---- event log -------------------------------------------------------
    const log = el('div', 'panel log');
    log.appendChild(el('div', 'h', 'the water is talking'));
    this.logList = el('div', 'lines');
    log.appendChild(this.logList);
    r.appendChild(log);

    // ---- inspector -------------------------------------------------------
    const insp = el('div', 'panel inspect');
    this.inspHead = el('div', 'head');
    this.inspBody = el('div', 'body');
    insp.appendChild(this.inspHead);
    insp.appendChild(this.inspBody);
    this.chart = document.createElement('canvas');
    this.chart.className = 'chart';
    this.chart.width = 260; this.chart.height = 74;
    insp.appendChild(this.chart);
    r.appendChild(insp);

    // ---- population strip ------------------------------------------------
    const pops = el('div', 'panel pops');
    pops.appendChild(el('div', 'h', 'population'));
    this.popList = el('div', 'rows');
    pops.appendChild(this.popList);
    this.popRows = {};
    for (const k of SPECIES_KEYS) {
      const sp = SPECIES[k];
      const row = el('button', 'prow');
      row.innerHTML = `<i style="background:${sp.render.body || sp.render.shell || '#888'}"></i><span>${k}</span><em>0</em>`;
      row.onclick = () => this.app.selectNearestOf(k);
      this.popList.appendChild(row);
      this.popRows[k] = row;
    }
    r.appendChild(pops);

    // ---- help ------------------------------------------------------------
    r.appendChild(el('div', 'panel help',
      '<b>drag</b> pan · <b>wheel</b> zoom · <b>click</b> inspect an animal<br>' +
      '<b>space</b> pause · <b>1-4</b> speed · <b>f</b> follow · <b>r</b> new world<br>' +
      '<b>w</b> food web · <b>b</b> bodies · <b>d</b> fields · <b>esc</b> deselect'));
  }

  update(dt, world, cam, sel, info) {
    // the depth marker follows the camera every frame (cheap: one transform)
    const h = this.zoneRows.length ? this.root.querySelector('.zones').clientHeight - 60 : 1;
    const t = clamp01((cam.y + cam.h * 0.5) / WORLD_H);
    this.zoneMark.style.transform = `translateY(${(t * h).toFixed(1)}px)`;
    this.zoneMark.style.width = `${clamp(cam.h / WORLD_H * 100, 3, 100).toFixed(1)}%`;

    this.acc += dt;
    if (this.acc < this.every) return;
    this.acc = 0;

    // ---- top stats
    const alive = world.alive();
    this.stat.innerHTML =
      `<span><b>${info.fps.toFixed(0)}</b> fps</span>` +
      `<span><b>${info.ms.toFixed(1)}</b> ms/frame</span>` +
      `<span>t <b>${world.time.toFixed(0)}</b>s</span>` +
      `<span>day <b>${(100 * world.phase).toFixed(0)}</b>%</span>` +
      `<span>animals <b>${alive}</b>/${world.cfg.maxCreatures}</span>` +
      `<span>flora <b>${world.flora.length}</b></span>` +
      `<span>bits <b>${world.eggs.length + world.carrion.length}</b></span>` +
      `<span class="seedtag">seed ${world.seed}</span>`;
    this.btnPause.textContent = info.paused ? '▶' : '❚❚';
    this.btnSpeed.textContent = (info.speedMul || 1) + '×';
    this.seedBox.value = world.seed;

    // ---- zones
    const zc = [0, 0, 0, 0];
    for (const c of world.creatures) if (c.alive) zc[c.zone]++;
    for (let i = 0; i < ZONES.length; i++) {
      const n = zc[i];
      const p = this.zoneRows[i].querySelector('.pop');
      p.innerHTML = `inhabitants <b>${n}</b>`;
      this.zoneRows[i].classList.toggle('here', zoneIndexAt(cam.y + cam.h * 0.5) === i);
    }
    const cy = cam.y + cam.h * 0.5, z = ZONES[zoneIndexAt(cy)];
    this.kpiv.innerHTML = `<span>view depth <b>${depthLabel(cy)}</b></span>` +
      `<span>pressure <b>${z.pressure.toFixed(1)} atm</b></span>` +
      `<span>irradiance <b>${(lightAt(cy, world.phase) * 100).toFixed(1)}%</b></span>` +
      `<span>tide <b>${(Math.sin(world.time / world.cfg.tidePeriod * Math.PI * 2) * 0.5 + 0.5).toFixed(2)}</b></span>`;

    // ---- log
    const ev = world.events.slice(-9).reverse();
    this.logList.innerHTML = ev.map((e) =>
      `<div class="ev ${e.kind}" data-x="${e.x | 0}" data-y="${e.y | 0}"><i>${e.t.toFixed(0)}s</i>${e.text}</div>`).join('');
    this.logList.querySelectorAll('.ev').forEach((n) => {
      n.onclick = () => this.app.lookAt(+n.dataset.x, +n.dataset.y);
    });

    // ---- inspector
    if (sel && sel.alive !== false) {
      if (this.selId !== sel.id) { this.selId = sel.id; this.selHist = { hunger: [], health: [], speed: [] }; }
      const H = this.selHist;
      H.hunger.push(sel.hunger); H.health.push(sel.health); H.speed.push(clamp((sel.speed || 0) / 200, 0, 1));
      if (H.hunger.length > 130) { H.hunger.shift(); H.health.shift(); H.speed.shift(); }
      const sp = sel.sp;
      this.inspHead.innerHTML =
        `<b>${sel.name}</b> <span class="lat">${sp.latin}</span>` +
        `<span class="row"><i class="sw" style="background:${sp.render.body || sp.render.shell || '#888'}"></i>` +
        `Z${sel.zone + 1} · ${depthLabel(sel.y)} · ${sel.mode}${sel.plane === 1 ? '/wall' : ''}</span>`;
      const bar = (name, v, col, extra) =>
        `<div class="bar"><span>${name}</span><div class="track"><i style="width:${(clamp01(v) * 100).toFixed(0)}%;background:${col}"></i></div>` +
        `<em>${extra !== undefined ? extra : (clamp01(v) * 100).toFixed(0) + '%'}</em></div>`;
      const path = activePath(sel.bt).map((n) => `<u>${btLabel(n)}</u>`).join('<s>›</s>');
      const run = activePath(sel.bt).slice(-1)[0];
      this.inspBody.innerHTML =
        bar('hunger', sel.hunger, '#ffd166', sel.hungerMode) +
        bar('health', sel.health, '#7bf0a0', (sel.health * sp.hp).toFixed(0) + ' hp') +
        bar('stamina', sel.stamina, '#7ad9ff', (sel.speed || 0).toFixed(0) + ' px/s') +
        (sp.phys.lung ? bar('air', sel.air, '#c8d8ff', '') : '') +
        `<div class="grid">` +
        `<span>intent</span><b>${sel.intent}</b>` +
        `<span>target</span><b>${sel.target ? (sel.target.sp ? sel.target.sp.key : 'plant') : '—'}</b>` +
        `<span>seen</span><b>prey ${sel.bb.prey ? sel.bb.prey.key + ' ' + sel.bb.preyD.toFixed(0) + 'px' : '—'} · threat ${sel.bb.threat ? sel.bb.threat.sp.key + ' ' + sel.bb.threatD.toFixed(0) : '—'}</b>` +
        `<span>speed</span><b>${(sel.speed || 0).toFixed(0)} / ${(sp.phys.cruise || 0)} cruise</b>` +
        `<span>kills · meals</span><b>${sel.kills} · ${sel.meals}</b>` +
        `<span>distance</span><b>${(sel.distance / 12).toFixed(1)} m</b>` +
        `<span>zone stress</span><b>${(sel.zoneStress || 0).toFixed(2)} (${sel.homeZone === sel.zone ? 'home' : 'away'})</b>` +
        `<span>growth · scale</span><b>${sel.growth.toFixed(2)} · ${sel.scale.toFixed(2)}</b>` +
        `<span>lod</span><b>${sel.lod} (bt ${(sel.lod ? 30 : 60).toFixed(0)}hz)</b>` +
        `</div>` +
        `<div class="h">behaviour tree · ${leafCount(sel.bt)} leaves</div>` +
        `<div class="path">${path}</div>` +
        `<div class="params">${run ? fmtParams(run) : ''}</div>` +
        `<details class="tree"><summary>whole tree</summary><pre>${treeDump(sel.bt)}</pre></details>`;
      this.drawChart();
    } else {
      this.inspHead.innerHTML = `<b>Nothing selected</b><span class="row">click any animal — or a name in the list — to open its mind</span>`;
      const s = world.stats;
      const deaths = Object.entries(s.deaths).sort((a, b) => b[1] - a[1]).slice(0, 6);
      const causes = Object.entries(s.byCause).sort((a, b) => b[1] - a[1]).slice(0, 5);
      this.inspBody.innerHTML =
        `<div class="h">food web · ${Object.values(s.web).reduce((a, m) => a + Object.values(m).reduce((x, y) => x + y, 0), 0)} interactions</div>` +
        webTable(s) +
        `<div class="h">mortality</div>` +
        `<div class="chips">${deaths.map(([k, v]) => `<span>${k} <b>${v}</b></span>`).join('') || '<i>none yet</i>'}</div>` +
        `<div class="chips causes">${causes.map(([k, v]) => `<span class="c-${k.replace(/ /g, '')}">${k} <b>${v}</b></span>`).join('') || ''}</div>` +
        `<div class="h">codex</div>` +
        `<div class="codex">${SPECIES_KEYS.map((k) => {
          const sp = SPECIES[k];
          return `<div class="cx"><b>${sp.name}</b><span class="lat">Z${sp.zone + 1} · trophic ${sp.trophic}</span><p>${sp.codex}</p></div>`;
        }).join('')}</div>`;
      this.drawChart();
    }

    // ---- populations
    for (const k of SPECIES_KEYS) {
      const row = this.popRows[k];
      const n = world.pop[k] || 0;
      const cap = world.cap[k] || 1;
      row.querySelector('em').textContent = n + '/' + cap;
      const hpg = meanAlive(world, k, 'health');
      row.style.setProperty('--h', (clamp01(hpg) * 100).toFixed(0) + '%');
      row.classList.toggle('zero', n === 0);
    }
  }

  drawChart() {
    const cv = this.chart, g = cv.getContext('2d');
    const w = this.app.world;
    g.clearRect(0, 0, cv.width, cv.height);
    g.fillStyle = 'rgba(10,20,28,0.55)';
    g.fillRect(0, 0, cv.width, cv.height);
    const hist = w.stats.history;
    if (hist.length > 1) {
      // stacked population history
      const keys = SPECIES_KEYS.slice();
      const maxTotal = Math.max(20, ...hist.map((s) => keys.reduce((a, k) => a + (s.pop[k] || 0), 0)));
      keys.forEach((k, ki) => {
        g.beginPath();
        for (let i = 0; i < hist.length; i++) {
          let below = 0;
          for (let j = 0; j < ki; j++) below += hist[i].pop[SPECIES_KEYS[j]] || 0;
          const v = below + (hist[i].pop[k] || 0);
          const x = (i / (hist.length - 1)) * cv.width;
          const y = cv.height - (v / maxTotal) * (cv.height - 4);
          if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
        }
        for (let i = hist.length - 1; i >= 0; i--) {
          let below = 0;
          for (let j = 0; j < ki; j++) below += hist[i].pop[SPECIES_KEYS[j]] || 0;
          const x = (i / (hist.length - 1)) * cv.width;
          g.lineTo(x, cv.height - (below / maxTotal) * (cv.height - 4));
        }
        g.closePath();
        g.fillStyle = rgbaStr(SPECIES[k].render.body || SPECIES[k].render.shell || '#889', 0.5);
        g.fill();
      });
      g.fillStyle = 'rgba(200,230,245,0.5)';
      g.font = '9px ui-monospace, monospace';
      g.fillText('population history · ' + hist.length + ' samples', 5, 10);
    }
    if (this.selId !== null && this.selHist.hunger.length > 1) {
      const H = this.selHist;
      const line = (arr, col) => {
        g.beginPath();
        let open = false;
        for (let i = 0; i < arr.length; i++) {
          const v = arr[i];
          if (!Number.isFinite(v)) { open = false; continue; }   // gap, not a wild line
          const x = (i / Math.max(1, arr.length - 1)) * cv.width;
          const y = cv.height - v * (cv.height - 4) - 2;
          if (open) g.lineTo(x, y); else { g.moveTo(x, y); open = true; }
        }
        g.strokeStyle = col;
        g.lineWidth = 1.2;
        g.stroke();
      };
      line(H.hunger, '#ffd166');
      line(H.health, '#7bf0a0');
      line(H.speed, '#7ad9ff');
    }
  }
}

function treeDump(n) {
  const out = [];
  (function walk(x, d) {
    const s = ['·', '▶', '✓', '✗'][x.st ? x.st.s : 0] || '·';
    out.push('  '.repeat(d) + s + ' ' + btLabel(x));
    for (const ch of x.children || []) walk(ch, d + 1);
  })(n, 0);
  return out.join('\n');
}

function meanAlive(world, key, prop) {
  let n = 0, s = 0;
  for (const c of world.creatures) if (c.key === key && c.alive) { n++; s += c[prop] || 0; }
  return n ? s / n : 0;
}

function webTable(s) {
  const rows = [];
  for (const a in s.web) for (const b in s.web[a]) rows.push([a, b, s.web[a][b]]);
  rows.sort((x, y) => y[2] - x[2]);
  if (!rows.length) return '<div class="chips"><i>nothing has been eaten yet</i></div>';
  return `<div class="web">${rows.slice(0, 9).map(([a, b, v]) =>
    `<span><b>${a}</b>→${b}<i>${v}</i></span>`).join('')}</div>`;
}

function rgbaStr(hex, a) {
  if (hex[0] !== '#') return hex;
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
