# Abyssal Ecosystem Simulator

A 2D side-view marine ecosystem, in the spirit of Rain World's food webs: four
depth zones, thirteen animal species and eight sessile plants, every one of them a
segmented verlet hardbody driven by its own procedurally generated behaviour tree.
No engine, no assets, no network — plain ES modules on a 2D canvas.

Everything you see is simulated, not animated. There are no keyframes: an animal's
silhouette *is* its collider, every limb you watch walk is a limb an inverse-kinematics
solver put on the rock, and the kelp you see bending is the same chain of verlet nodes
the current is pushing.

```
npm start          # serves on :8080, then open http://localhost:8080
npm test           # headless ecosystem soak (~10 s)
npm run test:long  # 2-minute soak, the long-horizon ecology check
npm run test:render# drives the real renderer + HUD through a fake canvas
```

## The water column

| | zone | depth | light | what lives there |
|---|---|---|---|---|
| Z1 | **Candle Reef** | 0–260 m | 100 % | coral, minnow schools under jellyfish bells, urchins, snails |
| Z2 | **Kelp Wall** | 260–550 m | 34 % | a rock wall you can swim in front of, darters, lung sharks, the eel that wears kelp |
| Z3 | **Bramble Outcrop** | 550–870 m | 8.5 % | heavy kelp forest on a rocky shelf, caves that pour out crabs, grazers, crawlers |
| Z4 | **The Sump** | 870–1200 m | 0.4 % | vents, sulphur mats, anglers, and the thing that owns the line |

Zones are not paint: each band carries its own pressure, temperature, turbidity,
water colour and light field, and the terrain is a real collision heightfield with
shelves, a 275 m riser, talus slopes, a basin and a dozen-plus caves bored into the rock
(`kind: 'hatchery' | 'lair'`). The background wall is a second colliding plane, not
a parallax image — animals climb it, and it is drawn in true world coordinates so a
crab's feet stay glued to the rock it is actually touching.

**The Abyssal Leviathan** owns the Z3/Z4 line. It is a serpentine chain of 26 body
points wearing six independently articulated mandibles used for precise strikes, and
it does not negotiate with the shallows: pressure homeostasis is a physical term in
its integrator, so shallow water physically resists it. Anything that drifts below the
line is prey — including adult lung sharks, crawlers and anglers — and the deepest
animals in the world are its food, not its neighbours.

## Hardbodies

Every organism, including the urchins, jellies, snails and barnacles, is built from a
`plan` of segments (`seg`, `spacing`, `radius`, `bendStiff`) plus independently driven
limbs:

* **walkers** (the Reef Ramshorn Crab — 16 leg links, 2 claws, 2 antennae — and the
  six-legged Bone Crawler with its own 4 mandibles, in Z2/Z3) solve analytic IK against the collision grid: each foot is *cast* at the rock, planted,
  then hauled when the body outruns it, with grip damping so they can cling to a vertical
  wall instead of sliding. They scale the background rock face as well as the foreground.
* **swimmers** use anisotropic drag — `dragNormal ≫ dragTangent` — so undulation becomes
  thrust instead of wiggle. The lung shark's model is exactly the brief's: an enormous
  forward burst, then a debt. Its `compressible` lung is buoyancy, and emptying it costs
  stamina, so it hunts in bursts and rests in the water column.
* **jellies** pulse rings of bell muscle (a volumetric contraction, not a sprite) and
  trail tentacles that are separately simulated chains; the bell doubles as a shield for
  the minnows sheltering under it, and the minnows get a real `symbiont` bonus for staying.
* **the eel** is a kelp-mimic: its body is drawn with the plant palette, it holds position
  inside a kelp ribbon and only commits when prey enters a short, violent cone.
* **the leviathan's mandibles** are limbs too: they open for a strike, and `mouthOf()`
  measures reach from the jaw, not from the centroid, which is why a 40 m animal can pick
  a 1 m fish off a ledge without crushing the ledge.

## Hunger, and what it does to a mind

Each animal carries a `hunger` bar that decays with a metabolic rate scaled by activity,
temperature and pressure, plus a `health` bar. Damage comes from exactly three sources —
starvation, being outside your home zone, and being eaten or fought — as specified:

* `hunger > 0.72` — sated. Stable, non-aggressive, holds territory near the nest. A
  well-fed predator will take what wanders into reach but will not pursue it.
* `hunger` falling — the tree's foraging ladder *descends*: search radii widen from
  `preyR * 1.15` to `preyR * 3.2` and the hunger gates unlock riskier and more distant
  branches, so a hungry animal pathfinds across zones for food it would ignore when full.
* `hunger === 0` — health drains; at `health === 0` the animal dies and becomes carrion.
* outside its home zone — very slow health decay, scaled by `zoneStress`. For an abyssal
  specialist in the light zone this is a real death sentence, and the sim shows it.

Well-fed, healthy, adult animals breed: courtship is a two-sided, latched interaction
(the caller lights up and calls; the partner's own tree answers the call), the clutch
gestates, eggs are laid at the right structure (cavity spawners lay in the caves they
hatched in), eggs are edible, and hatchlings inherit the parents' *generated* trees —
so a population is not a clone army, it is a family with temperaments.

## Procedural behaviour trees

`src/sim/bt.js` composes a tree per individual from the species' vocabulary:
selector/sequence/condition/action/decorator (cooldown, timeout, chance, inverter), with
93 registered actions and 37 conditions, parameter jitter, branch shuffling inside a
priority band, occasional cloned "rogue" branches, and personality scalars (boldness,
nervousness, aggression, sociability, curiosity) that bias the structure itself.

The root is a **pure priority selector**: every tick re-reads the tree from the top, so a
branch that outranks the current one always takes over — a shadow interrupts a feed,
hunger interrupts a patrol, and crossing the pressure line interrupts everything. The
preempted branch is not ticked while outranked, so it resumes exactly where it stopped.
That is the whole reason the animals look like they are changing their minds for reasons.

Inspect any animal to see the path it is currently running (click it, or press a species
key). `F` shows the food web, `B` the raw bodies, `W` the nutrient/plankton field.

## Emergence you can watch

* Kelp is a resource: grazers crop stipes, stipes regrow and shed spores, and if the
  urchins win, the forest becomes an urchin barren and the crabs that shelter in it starve.
* Carrion is the real base of the deep web. Anything that dies sinks, and the Z4 fauna
  are scavengers first, hunters second — the leviathan eats more of the dead than the living.
* Plankton follows light and nutrients through a diffusion field; the sulphur mats at the
  vents are the only primary production below 870 m, which is why the abyss has any biomass at all.
* Minnows that stay under a jelly bell get stinging protection; jellies that follow the
  herd get the scraps. The mutualism is not scripted — it is two trees that happen to
  want the same water.

## Layout

```
src/core/     rand (mulberry32 + value noise/fbm), vec, spatial hash + scalar Field
src/sim/      zones  terrain  body  bt  species  creature  flora  world
src/render/   camera  terrainDraw (baked tile cache)  creatureDraw  floraDraw  scene
src/ui/       hud.js — depth ribbon, event log, inspector, live BT path, population chart
index.html    styles.css    main.js (App: fixed-step accumulator, input, camera)
test/         headless.js  renderSmoke.mjs  domstub.mjs
```

Simulation and rendering never touch: `stepWorld` writes intent into the animals, the
renderer only reads it. `world.camera` drives level-of-detail (near animals tick their tree
every frame, far ones every few), which is how 220 animals plus 800 plants tick in about 12 ms per frame — headroom
for the renderer at 60 fps.

## What the tests actually assert

`npm test` (and `test:long`) check that: every species pool *and* every generated tree
resolves to a registered node (a typo'd action name fails silently at runtime, so this
guard exists — it earned its place); the world builds; nothing is NaN; animals travel;
predation happens at a real rate; the leviathan holds its line; every animal's hunger bar
is in range; the kelp forest survives. `test:render` runs the real app — boot, loop, every
painter, the whole HUD, keys, drag, wheel, regenerate — against a fake canvas, and fails
on any exception or non-finite geometry (over 10 M canvas calls in a 120-frame run).

## Known limits

Honest list, in order of how much they bother me:

1. A long body straddling a flat shelf loses the argument with the terrain. An abyssal
   animal that gets up onto the reef has to hug the deck and crawl to the edge — it finds
   the drop-off (the bearing is latched, the speed is doubled, and it does escape), but
   the trip costs the best part of a minute of its life, and a few of them die in transit.
   In the 2-minute soak at seed 1337, 79 % of the leviathan's frames are that crawl.
2. Trophic balance at long horizons is tuned, not solved. Reef grazers (urchins, snails,
   crabs — now breeding too) can win a 2-minute run and take the forest down from 122
   stipes to a dozen. `npm test` asserts the forest survives the demo window; the long
   soak only warns. The pressure on the kelp is grazing plus the loss of the urchin
   predators that used to keep it honest, and that is where the next round of tuning goes.
3. It is 2D side-view: no thermocline, no diel vertical migration, no temperature
   preference beyond what metabolism multiplies by.
4. Single canvas, 2D context, DPR capped at 2 — no WebGL. At full population the
   renderer is the bottleneck around 1400×760.
5. Trees are generated from per-species vocabularies, not from an open grammar: no
   species will ever invent a behaviour its pool did not allow.
