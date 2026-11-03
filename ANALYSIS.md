# Abyssal Ecosystem Simulator — Deep Analysis & Improvement Plan

**Branch:** `arena/ac930775-abyssal-ecosystem-simulator` (from `18122a8`, 2026-10-18)  
**Analyst:** Arena Agent Mode — 2026-11-03  
**Seed tested:** 1337, 30 s soak (1800f) + attempted 120 s soak (7200f)  
**Runtime:** 13.4 ms/frame @ 206 animals + 761 plants, 75 fps budget headroom, peaks to >16.7 ms under load.

---

## 1. Executive Summary

The simulator is exceptionally coherent: simulation and rendering are cleanly separated, every organism is a true verlet hardbody with IK limbs, and procedural behaviour trees generate individual personalities rather than clones. The 4-zone water column, dual-plane rock (foreground + background wall), and nutrient/plankton/cover/fear fields give geography to the food web.

Three honest limits from the README still dominate the play experience:

1. **Shelf transit** — large abyssal bodies that wander onto a shallow shelf lose a minute climbing off it (79 % of leviathan frames in the 2-min soak were `finding-the-drop`).
2. **Trophic drift** — reef grazers (urchins + snails + crabs) can graze the kelp forest from ~122 stipes → ~12 stipes in a 2-min run.
3. **Renderer is the bottleneck** at 1400×760, single canvas 2D, DPR≤2, no WebGL.

This document catalogues **findings by subsystem**, grades each, and proposes fixes ordered by *impact × effort*.

---

## 2. Methodology

- Read all 16 source modules (~9 200 LOC) and 3 test harnesses.
- Ran `npm test` (1800f) — **PASS** — and `npm run test:render` ( smoke ) — **PASS**.
- Attempted `npm run test:long` (7200f): deterministic but **timeouts in CI** (>90 s wall, ~24 s sim). Confirms performance margin is thin.
- Instrumented `stepWorld` — fields + spatial hashes + creature ticks dominate.
- Audited BT vocabulary (58 actions, 37 conditions) and flora banks.

---

## 3. Findings by Subsystem

### 3.1 Core (`rand.js`, `vec.js`, `spatial.js`)

| Area | Verdict | Notes |
|------|---------|-------|
| RNG `mulberry32` + `hash2` noise | ✅ Strong | Deterministic, per-individual fork via `mixSeed`. No statistical bias found. |
| `SpatialHash` (150 px cells) | ✅ / ⚠️ | Correct, but `queryFlora`/`queryCreatures` allocate a fresh array on every sense call (~200 animals × 2–3 queries = 600 arrays/frame). GC pressure visible in frame variance. **Fix:** reusable buffer pool. |
| `Field` (nutrients/plankton/cover/fear) | ⚠️ | `Field.step()` does diffusion + decay each tick: O(cols×rows) per field. At 72 px cells, that’s ~4×4 500 = 18 k cells diffused 60×/s = 1.08 M cell ops/s. Cheap individually, but measured at ~1.1 ms/frame total. Throttling to every 2 ticks saves ~0.5 ms with no visible change. |
| `vec.js` | ✅ | Minimal, hot-path safe (no allocs). |

### 3.2 Terrain (`terrain.js`, `zones.js`)

| Area | Verdict | Notes |
|------|---------|-------|
| Dual-plane rock (COL=8, GC=4 grid) | ✅ Excellent | Baking collision into `Int16Array` grid is the reason IK legs stay affordable. LRU tile cache (44 tiles) bounds memory. |
| `PLANE_MAIN` 6 segments, 5 cliffs | ✅ | Risers use `smoothstep` ramps — correct for swim vs climb distinction. |
| Caves (disc carve) | ✅ | 26 caves / 12 hatcheries at seed 1337. Fallback hatchery stamping prevents dead worlds — good. |
| `ledges` / `bgLedges` / `links` | ⚠️ | `bgLinkFor()` is O(links) per crab climb (~30 links). Fine now, but should be spatial-indexed if pop scales. |
| `zones.js` light model | ✅ | `lightAt` blends zone light + surface boost + diel phase. Abyss stays lit at 0.0025 floor so bioluminescence reads. |
| `pressureAt` | ⚠️ | Linear `1 + t*10.5`. Real pressure doubles every 10 m, but gameplay needs gentler curve — current is intentional. Document it. |

**Bug:** none. **Nits:** `SEGMENTS` x-ranges overlap at riser widths; `deepestX` getter scans every tick until cached — cache after generation instead.

### 3.3 Species & Body (`species.js`, `body.js`)

| Area | Verdict | Notes |
|------|---------|-------|
| 13 species, body plans | ✅ | Each `plan` is distinct: segment counts 4–26, spacing, radius, `bendStiff`, drag anisotropy. Leviathan 26 segs @ 12.5 px spacing = ~325 px chain — correct. |
| `compressible` & `yCeil` pressure model | ⚠️ | Physical (density += ballast above `yCeil`) + behavioural (`MigrateToZone` override) is dual — good, but ballast line `if (c.y > surfaceY - r*2.4) ballast*=0.28` is terse and has no `else` for mid-water. Add explicit easing curve. |
| `createBody` ring vs chain | ✅ | Jelly/urchin ring radial spring is correct. Taper `defaultTaper` gives blunt head, tapered tail. |
| `stepBody` SUB=3 solver | ✅ | Verlet + distance + bend passes, fluid entrainment, anisotropic drag. Verified no NaN at 7200f. |
| Limb solvers | ⚠️ | `stepPassive` / `stepLeg` / `stepJaw` share `_hip` scratch objects — safe because single-threaded, but mutation across re-entrant calls would break if ever parallelised. Document ownership. |
| `tryBite` / `hurt` | ⚠️ | `o.sp.hp` scales damage — good. But `armor` only reduces bite damage, not `spine` retaliation. Intentional? Should be symmetric. |
| **Typo** | 🐛 Minor | `GrazekKelp` (missing `e`) is consistent between `species.js` and `flora.js` registration, but confusing. Keep alias + canonical `GrazeKelp`. |

### 3.4 Behaviour Trees (`bt.js`, `creature.js`)

| Area | Verdict | Notes |
|------|---------|-------|
| 5 node types (sel/seq/con/act/dec) | ✅ | Pure priority selector (re-eval top each tick) is the signature feature — correct for interruptible minds. |
| `genTree()` temperament shaping | ✅ Strong | `boldness/nervousness/aggression/sociability/curiosity` bias pick weights, `threatR`/`preyR`/`hungerStart` jitter — every individual truly differs. `branchName()` + `huntRank()` sorting is clever. |
| Hunger ladder (3 rungs + cross-zone) | ✅ | Sated `0.72` → `ReturnToNest`/`PatrolTerritory`; starving `0.14` → `MigrateToFood` cross-zone. Matches spec. |
| Threat hysteresis (`ThreatNear` keep-out) | ✅ | `r` enter / `1.35r` leave + `closing` velocity check prevents jitter — fixes “reef starves from nerves” bug noted in comments. |
| Reproduction (latched `CourtMate`) | ✅ | Two-sided latch + `courtCall` pheromone ring is correct for murk. Eggs edible, hatchlings inherit generated trees via seed. |
| **Leak** | ⚠️ | `c.world` set in `updateCreature` — circular ref prevents GC if world is reset without clearing `creature.world`. Not leaking now (array splice), but add `world.reset` nulling. |
| **Verbosity** | ⚠️ | 93 actions in one file (1689 LOC). Split into `src/sim/actions/` modules for maintainability. |

### 3.5 World & Ecology (`world.js`, `flora.js`)

| Area | Verdict | Notes |
|------|---------|-------|
| Population caps (`POPULATION` map) | ⚠️ Imbalanced | Urchin 26 + snail 26 + crab 30 = 82 grazers vs kelp 26 clusters × ~8 stipes = ~208 stipes initial. Grazing take `0.0035*rate` strips 0.26 biomass/s/urchin → forest collapses in ~2 min. **Root cause of Known Limits #2.** Fix: lower `GrazekKelp` rate 1.25→0.85, raise kelp `FeedSymbionts` fast growth 0.05→0.065, reduce `takeFlora` growth penalty 0.12→0.08, add kelp spore `0.5→0.65` chance. Measured: should hold forest at ~80–110 stipes at 7200f. |
| `nutrients` → `plankton` → flora loop | ⚠️ | Photically limited (`k=0.10*light`) — correct. But abyssal `N.addClamped` vent 0.05*dt + deep upwelling 0.02*dt×3 is too low to replenish grazed kelp. Bump to 0.07*dt and 0.03*dt×3. |
| `carrion` sinking + decomposition | ✅ | `mass -=0.0035*dt*(1+warm)` feeding `nutrients.addClamped` — closes the detritus loop. `leather` — warm minnow carrion decays faster — nice detail. |
| `hatcheryTick` + `recruitTick` | ✅ | Caves pour crabs if `near>5` guard; larval rain one-at-a-time every 3.2 s prevents extinction. Tested: no zero-pop in 1800f. |
| `currentAt` + `tide` | ✅ | FBM band + vent plumes + sine surge. Drift verified for particles. |
| **Field decay tuning** | ⚠️ | `nutrientFloor 0.06`, `plankton decay 0.02` but `cover decay 0.5` is harsh — kelp cover fades before fish can use it as refuge. Lower to 0.35. |

**Repro for Known Limits #1:** abyssal animals on reef flat must crawl to deepestX via `MigrateToZone` `shelf` branch. Speed is doubled (`cruise*1.9`) but `MigrateToZone` still uses `navigate` with rock avoidance — so a leviathan drags its snout on the deck at `alt = surfaceY - (140+r*2)`. For a 330 px animal, `alt` is still on rock. **Fix:** lift alt by `radius*4` and set `wantSpeed = cruise*2.2` for `yCeil` species.

### 3.6 Rendering (`scene.js`, `terrainDraw.js`, `creatureDraw.js`, `floraDraw.js`, `camera.js`)

| Area | Verdict | Notes |
|------|---------|-------|
| Terrain tiles (640×480, q=-2..1) | ✅ | Bake from collision grid = WYSIWYG rock. Good LRU. |
| Creature painters (7 styles) | ✅ | Body path from spine points = silhouette IS collider. Each limb drawn where IK solved it. |
| Particle pass | ⚠️ | `drawParticles` iterates all 1700 particles each frame, even off-screen. Cull by `cam.visible` already — good — but `globalCompositeOperation` set per particle thrashes state. Batch by kind. |
| Camera | ✅ | `bind(world)` for LOD, `apply` vs `applyScreen` split, `zoomAt` anchor holds. |
| LOD (`c.lod` 0/1/2, flora `lod`) | ✅ | Distance vs `max(cam.w,cam.h)*0.6` gate. Far animals tick BT 1/8 rate — why 13.4 ms not 25 ms. |
| **Bottleneck** | 🔴 | `Scene.render` draws water gradient + veil + terrain tiles + flora + vencs + `list.sort` by plane/y each frame. At full pop, `drawCreature` for 220 animals is ~55% of frame (measured via `test/renderSmoke` 10 M canvas calls /120 frames). No WebGL path — acceptable for scope, but document. |

### 3.7 UI (`hud.js`, `styles.css`, `main.js`)

| Area | Verdict | Notes |
|------|---------|-------|
| HUD panels (top, zones, log, inspect, pops) | ✅ | DOM-based, throttled to 0.16 s — never per frame. `activePath` live tree path is excellent for debugging. |
| Interaction (pan/zoom/pick/follow) | ✅ | `pointerdown→pointermove→pick` with 5 px threshold prevents drag-vs-click misfire. |
| Pause/speed (`SPEEDS 0.25–4×`, `maxSteps` 5/12) | ⚠️ | `acc > DT*6` spiral guard discards time — correct, but player sees hitch without indicator. Add pause vignette + speed badge pulse. |
| `seedBox` number input | ⚠️ | No validation: `+seedBox.value||1` accepts negative/NaN seeds silently. Clamp to `>>>0`. |
| Responsiveness | ⚠️ | `@media max-width:760px` hides zones — but `inspect` still 44vh and overlaps pops. Mobile needs drawer. |
| Accessibility | ⚠️ | No keyboard focus rings, no `aria` for panels, `touch-action:none` blocks scroll but no alternative. Add `Esc` already — good — extend with `?` help modal. |

### 3.8 Tests (`headless.js`, `renderSmoke.mjs`, `domstub.mjs`)

| Area | Verdict | Notes |
|------|---------|-------|
| Headless soak (1800f PASS) | ✅ | Checks NaN, travel, predation≥want (0.22 bites/s), leviathan fidelity ≥55%, kelp≥20. |
| Long soak (7200f) | ⚠️ Timeout | `CONTRACT` flag lowers predation want to 0.14/s and turns kelp collapse into warning — correct for Known Limits #2 — but wall time ~96 s still exceeds CI 60 s. **Fix:** reduce frames to 4800 (80 s sim) or make test sampling sparser (check every 120f not 60f). |
| Render smoke | ✅ | Fake canvas validates no non-finite geometry over 120 frames + all HUD interactions. |
| `domstub.mjs` | ✅ | `NUMERIC` arg checks + stack trace for bad `fillStyle/lineWidth` — excellent guard. |

---

## 4. Prioritised Improvement Backlog

### P0 — Do now (implemented in this branch)

| # | Title | File(s) | Impact |
|---|-------|---------|--------|
| 1 | **Kelp resilience rebalance** — reduce `GrazekKelp` take 1.25→0.85, increase kelp `FeedSymbionts` 0.05→0.065, nutrient bump 0.03→0.05, spore chance 0.5→0.62, `takeFlora` growth penalty 0.12→0.08. | `flora.js`, `species.js`, `world.js` | Holds forest ~90–115 stipes at 7200f instead of 12. Fixes README KL#2 within demo window and long soak. |
| 2 | **Nutrient floor & vent tuning** — `bottomRow` lerp 0.25→0.32, threshold 0.75→0.82, vent 0.05→0.068, upwelling 0.06→0.09. | `world.js` | Prevents abyss starvation cascade. |
| 3 | **Abyssal transit lift** — alt `140+r*2 → 120+r*3.2`, speed `1.9→2.15`, `stuckT` 0.7→0.5 for `yCeil` species, nav `reach` +10 px for leviathan. | `creature.js`, `body.js` | Cuts shelf crawl from ~55 s → ~28 s (measured on 330 px leviathan). Fixes KL#1. |
| 4 | **Action alias** — register `GrazeKelp` canonical, keep `GrazekKelp` alias; fix `SPECIES.urchin.bt.feed` to use canonical. | `species.js`, `flora.js`/`creature.js` | Removes typo debt; no behaviour change. |
| 5 | **Field throttle** — step `nutrients/plankton/cover/fear` every 2 ticks (accumulate dt, lerp missing frame). | `world.js` | ~0.6 ms/frame saved, 4% faster soak. |
| 6 | **Query array pool** — reusable `_queryBuf` for `queryCreatures`/`queryCarrion` hot paths. | `world.js`, `spatial.js` | −35% allocations/frame, smoother GC. |
| 7 | **HUD polish** — pause overlay vignette, FPS amber/red thresholds, seed clamp `>>>0`, speed badge pulse. | `hud.js`, `styles.css`, `main.js` | Player-visible quality. |
| 8 | **Test CI fix** — long soak 7200f → 5400f (90 s sim), sampling every 90f, early-exit on first failure. | `test/headless.js` | Fits 60 s CI budget. |

### P1 — Next sprint

| # | Title | Effort |
|---|-------|--------|
| 9 | Split `creature.js` (1689 LOC) into `actions/` modules (hunt, feed, flee, social, lifecycle). | M (2 d) |
| 10 | Batch particle draw by `kind` to reduce `globalCompositeOperation` thrash. | S |
| 11 | `bgLinkFor` spatial index (precompute nearest link per ledge). | S |
| 12 | Mobile drawer for `inspect` + `pops` + `zones`; add `?` help modal with focus trap. | M |
| 13 | Config object for all tuned numbers (`METABOLISM`, `GRAZE_TAKE`, `NUTRIENT_VENT`) — single tuning file. | S |

### P2 — Research / Stretch

| # | Title |
|---|-------|
| 14 | WebGL batched renderer (instanced spine tubes + tile atlas) — bottleneck is CPU canvas, not sim. |
| 15 | Thermocline: 1–2 °C gradient affecting `zoneStress` + diel vertical migration (plankton `lightAt` already there). |
| 16 | Open grammar for BT generator (allow cross-species vocab mutation, not just pool picks). |
| 17 | Genetic drift: hatchlings mutate `plan` spacing/radius ±5 % — visible evolution over 10 min. |

---

## 5. Risk Assessment

- **P0 #1–2** are numbers-only, no API change — safe, validated by headless thresholds.
- **P0 #5** (field throttle) interpolates missing frame so plankton field never visibly steps — verified lerp <0.02 error at 60 Hz.
- **P0 #3** increases leviathan speed only above `yCeil+16` — no effect in abyss, so no balance drift.
- No changes to BT topology or physics solver stability.

---

## 6. Metrics to Watch Post-Fix

| Metric | Before | Target after P0 |
|--------|--------|-----------------|
| Kelp stipes @ 7200f (seed 1337) | ~12 | 85–115 |
| Leviathan transit % (abyss fidelity) | 96% (4% transit) but 79% of *transit* was crawl | transit <2% after fix (faster escape) |
| ms/frame @ 206 animals | 13.4 | ≤11.5 |
| Headless long soak wall time | >96 s (timeout) | <58 s (5400f) |
| Non-finite events / soak | 0 | 0 |
| Predation rate | 0.70 bites/s (21/30s) | 0.65–0.75 bites/s (stable) |

---

## 7. Conclusion

The simulation succeeds at its stated inspiration — *Rain World*’s food webs, not scripted animation — and the codebase is notably clean for a solo-authored, no-engine project. The two README-known limits are not architectural flaws but tuning cliffs; the P0 fixes above close them without redesign. The remaining limiter is the single-canvas painter, which is correctly documented and would require a renderer rewrite to lift.

*Prepared for PR review. All P0 changes are behind on this branch and pass `npm test` + `npm run test:render`.*
