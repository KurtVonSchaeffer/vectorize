# Design intent: redrawing an illustration object by object (prototype)

27 October 2026. Research, not in the app. The question was whether the engine can redraw a complex illustration the way a designer would: objects, silhouettes, a few tones per object, mirrored halves. Today's Simplified option instead posterises the texture by tone.

**Status: research, not shipped.** The prototype code (`src/intent/`, `bench/intent.*`, `bench/recreate.*`) is on the branch `feature/design-intent`; this document is the post-launch roadmap. Test images and labels live in `public/_tmp-check/`, which is not in the repo.

Code: [`src/intent/sam.ts`](../src/intent/sam.ts) (Segment Anything in the browser) and [`src/intent/redraw.ts`](../src/intent/redraw.ts) (the object redraw). Bench: `/bench/intent.html?file=gorilla.png` on the dev server (with the image in `public/_tmp-check/`). Redraw settings can be passed in the URL, for example `&maxRadius=6&tones=4`.

## How it works

1. **The flat layer as today** (Simplified): lettering, rings, banner and background clean, and the texture in 5 tones (`simplifyTexture`).
2. **Objects.**
   - SlimSAM (`Xenova/slimsam-77-uniform`, a pruned Segment Anything) runs in the browser through transformers.js, the library the AI sharpening already uses.
   - The image is encoded once. A grid of points every 32 px over the texture then gives SAM's three masks per point (whole, part, sub-part).
   - A mask is kept when SAM is confident (score ≥ 0.86), when it covers 0.03–20% of the image and lies 70% or more inside the texture, and when 85% or more of it is one piece. Near-duplicates (IoU ≥ 0.85) keep the best.
3. **Redraw, largest object first**, so a face is drawn over the head it sits in. Only texture pixels change, so a SAM object reaching into the lettering on the ring doesn't repaint it. Each object gets:
   - its own tones: 3, or 2 for small objects, by k-means of the source averaged over 5×5 px; a tone within 24 of an existing colour reuses it;
   - smoothing within its silhouette, with a radius of √area / 50, between 1 and 4 px;
   - its specks merged when they're under 0.6% of the object;
   - mirroring when its silhouette matches its mirror image (IoU ≥ 0.9) and it's a part (≤ 3% of the image). Heads aren't mirrored, because a whole head with its fur parting mirrors into a mask.
4. **Traced** with the flat tracer, as any flat artwork.

## Results: Gorilla Glue logo (1200×750)

| | Paths | SVG | SSIM vs upload (logo area) |
|---|---|---|---|
| Detailed shading (app) | 4,059 | 1.00 MB | 0.76 (whole logo) |
| Simplified, tones (app) | 108 | 170 KB | 0.572 |
| Objects redrawn (prototype) | 140 | 204 KB | 0.575 |

- **12 objects found:** the whole gorilla, the head, the face, the muzzle, the beard, the shoulders, the chest, a hand, and smaller parts. 3 of them were mirrored, including the face and the muzzle, with symmetry 0.91–0.94.
- **What it looks like:** the face reads as drawn. It has a brow ridge, eye sockets, nostrils and a muzzle in cream, tan and dark brown, the same on both sides. Simplified gives tone patches with no features. The fur becomes 3 browns per object.
- **SSIM barely moves,** and it isn't the right measure here. A redraw is meant to differ from the pixels. The artists' verdicts in the admin panel are what should decide.

### Iterations that failed

- **Global tones only, with strong smoothing (radius up to 8) and mirroring of every symmetric object:** 93 paths. The head was mirrored too, and the gorilla looked like a mask with no face (SSIM 0.49).
- **No restriction to the texture:** an object reaching into the "INCREDIBLY" ring painted over its letters.

## Primitives: shape-driven redraw ([`src/intent/primitives.ts`](../src/intent/primitives.ts))

The tone redraw above is still colour-driven: each object is posterised. The primitive redraw builds each object instead, the way a designer would:

1. **Hierarchy.** An object's parent is the smallest larger object that holds 80% of it. Each texture pixel belongs to the smallest object holding it.
2. **One base shape per object** in the colour it's seen as. How that's found depends on the object:
   - **Masses** (over 3% of the image: head, shoulders) use the mean of their lighter half. Engraved fur averages near-black but is seen as its orange-brown strokes.
   - **Parts** (face, muzzle, hands) use the mean of the pixels near their median lightness.
3. **Features: shadows and highlights,** smoothed into solid shapes.
   - **Masses** are judged on their lightness blurred first, like squinting. Judged pixel by pixel, the hatching made the whole head one shadow. A mass keeps at most 2 features, each at least 5% of it, so there are no highlight blobs on the fur.
   - **Parts** are judged pixel by pixel, which keeps eyes and nostrils.
   - Features under 1% of their object are dropped, and at most 40 features are kept overall, ranked by area × contrast.
4. **A shared palette.** Colours within 30 merge, and a merged colour reuses the logo's own black, cream or orange when one is within 30.
5. **Symmetry.** Objects whose silhouette mirrors with IoU ≥ 0.9 get their left half copied to the right, largest object first, so the face mirrors over the head.
6. **Crumbs removed.** Any piece under 0.05% of the image joins its surroundings, unless it's mostly a kept feature (an eye stays).
7. **Boolean construction.** Shapes are traced in knockout mode, so each colour covers only its own area with holes punched for the shapes on top, with no overlaps. Each colour is then written as one compound path (`fill-rule="evenodd"`, `compoundPerColour`).

### Iterations (Gorilla Glue logo)

Scores are my judgement from looking at the output, not measurements.

| # | Change | Shapes in the art | Paths (whole logo) | What was wrong after it |
|---|---|---|---|---|
| 1 | Primitives per object, budget 40 | 74 | 19 | Fur masses covered in random highlight blobs (camouflage) |
| 2 | Masses: ≤ 2 big features | 67 | 19 | Gorilla a near-black mass: the base was the median pixel, a hatch line |
| 3 | Base = mean colour | 118 | 17 | Head still black: most pixels darker than the mean made it one huge shadow |
| 4 | Masses judged on blurred lightness; base = lighter half | 145 | 17 | Head right (brown with shadows); face washed out, features lost |
| 5 | Different rules for masses and parts | 196 | 19 | Face right again; 196 slivers; lopsided head shadow |
| 6 | Final 0.05% merge; mirror masses too | 59 | 19 | Eyes and nostrils merged away as crumbs; head mirror over the face |
| 7 | Kept features protected; mirror largest first | **76** | **19** | See below |

Iteration 7 has a brown head with one symmetric shadow, and a face made of brow, eye sockets, cheekbones, nostrils, muzzle and mouth, mirrored. It's 125 KB, against 170 KB for Simplified and 1 MB for Detailed shading.

| Score (0–10) | Print quality | Editability | SVG efficiency | Logo fidelity | Commercial readiness |
|---|---|---|---|---|---|
| Iteration 7 | 7 | 8 | 9 | 5 | 5 |

Why it isn't 9 everywhere:
- **Fidelity.** The head's shadow reads as a dark hood around the face. The beard picks up an olive tint from the yellow banner below it, because the colour average reaches across the object's edge. The gorilla is recognisable and clearly "drawn", but it's a stylised redraw, not the logo.
- **Editability.** The shapes are grouped by colour, not by object. An Illustrator file would have layers named "head", "face", "left eye". The hierarchy exists (`parents`), but it isn't written to the SVG yet.
- **Commercial readiness.** It was tried on one image. Thresholds tuned on one gorilla will not hold for a cartoon lion or a hand-drawn chef, so it needs the Layout team's real cases, and an artist's click to fix a wrong object.

Next improvements, in order of value:
1. Group the SVG by object (`<g id="face">`) using the hierarchy.
2. Average colours only inside the object, which fixes the olive beard.
3. Run the bench on 10–20 real illustration cases.
4. Click to add or remove an object.
5. Centreline strokes for eye and mouth lines.

## Semantic layer: roles, feature classes, named SVG ([`src/intent/semantic.ts`](../src/intent/semantic.ts))

The next step was a semantic layer between objects and SVG:
- **Object roles** from a small shape grammar for mascot heads: silhouette, head, face, muzzle, beard, hands, and masses named by position (shoulders, chest, left and right arm).
- **Feature classes:** eye, nostril, mouth, brow, cheek, shadow, highlight, crease, fur.
- **Retention by class, not size:** eyes, nostrils and the mouth are never dropped, and each role has its own budget (for example face: brow 1, cheeks 2, shadows 2, highlights 2; fur masses: 2).
- **Object-local colour:** colour is sampled only inside the object, which removes the banner's yellow from the beard.
- **SVG built from named primitives** in drawing order: the silhouette first (the whole illustration, 1 px under the artwork so no seam shows), then masses, then parts, each with features on top. The output is layered `<g id="face"><path id="face-left-eye" data-class="eye">…`, as an Illustrator file is.

Result on the Gorilla Glue logo: **40 named shapes** in the illustration (target 20–60), 134 KB, no gaps, SSIM 0.52.

### What it showed: the grammar can't know which object SAM cut

SAM cuts where the *image* has edges, not where *anatomy* does:

- **"Face".** The object the grammar picked as the face is the nose-and-mouth area. The eyes sit at its top edge, outside it, so the dark pair it labelled "eyes" is most likely the nostrils.
- **"Muzzle".** What it picked as the muzzle is the chin.

Thresholds can't fix this, and neither can grammar rules: "the largest symmetric light part is the face" is true for some mascots and false for this one. That's your point that fidelity stalls on semantics, shown in practice.

### The real semantic layer: let a vision model name the parts

The missing piece is something that *knows* what an eye is. Training our own landmark model for cartoons and mascots isn't realistic. A vision-language model already knows. The proposal:

1. SAM finds objects and features in the browser, as now.
2. The image is drawn with each region numbered, and a vision model such as Claude is asked to label each number (eye, nostril, mouth, brow, beard, hand, fur, or none) and to say which regions belong together.
3. Everything after that stays as built: the labels drive the budgets (eyes never dropped), the mirroring of pairs, the colours and the named SVG layers.

Cost and constraints:
- **Cost:** one vision call per illustration, roughly a few US cents at today's prices. Only illustrations need it.
- **Server-side:** the call runs on the server (the vectoriser API), so the key never reaches the browser.
- **Privacy:** customer artwork would leave the browser for Anthropic's API. Anthropic doesn't train on API data by default, but this needs the same POPIA and legal sign-off as any outside service (see Vectorizer.AI in [admin-panel.md](admin-panel.md)). That's a decision for Barron, not a technical one.
- **Fallback:** without the call, the grammar runs as now, and the artist corrects labels with a click.

Scores for the semantic version (my judgement):

| Print quality | Editability | SVG efficiency | Logo fidelity | Commercial readiness |
|---|---|---|---|---|
| 7 | 8 (named layers by object and feature) | 9 | 5 | 5 |

Fidelity can't move much past 5 until the parts are named correctly; the VLM step above is what would move it.

## Recreation mode: the object graph ([`src/intent/graph.ts`](../src/intent/graph.ts), bench `/bench/recreate.html`)

This stops asking "what regions exist?" and asks "what objects should exist?":

1. **Inventory.** A vision step names the parts and gives each one a parent, a tone (base, dark or light), whether it mirrors another part, and where it is. "Where" can be SAM regions (big objects SAM cut well: gorilla, head, face, hands, beard), a point for SAM, or a **box**.
   - On engraved art SAM can't cut an eye or a nostril out of the hatching from a point: its smallest masks were both eyes with the brow, or the chin.
   - A box works: the part is the pixels of its tone in the box, smoothed, with its larger pieces kept.
2. **Graph.** Each part is the union of its regions, smoothed to a designer's outline. Every pixel belongs to the deepest part holding it.
3. **Construction.**
   - **No overlaps:** each part is traced from its own pixels, so its children are holes in it (even-odd).
   - **Mirrored pairs** are true mirror images across the nearest symmetric ancestor.
   - **Object-local colour:** a part's colour comes from its own pixels only, by tone (dark: darkest third; light: lightest half; base: the 45th–80th percentile, the tone engraved fur is seen as).
   - **The logo around it** is the flat trace. Areas no object holds (the green behind the shoulders) stay with the logo, and the root reaches 1 px under the logo so no seam shows.
4. **SVG** nested like the graph: `<g id="gorilla-group"><path id="gorilla"/><g id="head-group">…<path id="left-eye"/>…`.

**The vision step was done by hand in this prototype.** There's no API key here, and customer artwork shouldn't go to an outside API before legal signs off. So I (Claude, in the coding session) looked at the numbered regions and a pixel grid and wrote the labels a vision model would return: [`public/_tmp-check/gorilla.png.labels.json`](../public/_tmp-check/gorilla.png.labels.json), 15 parts. Everything after the labels is code. In production this is one vision API call on the server that returns the same JSON. The open risk is how accurate a model's boxes are on small parts such as nostrils; that needs testing.

### Result: Gorilla Glue logo

| | Objects | Paths in the illustration | Notes |
|---|---|---|---|
| Detailed shading | — | about 4,000 | closest to the engraving |
| Simplified (tones) | — | about 170 shapes | tone patches |
| Primitives (iteration 7) | 52 primitives | 76 shapes | drawn face, hood-like shadow |
| Semantic grammar | 12 objects | 40 named | parts mislabelled (SAM's cuts) |
| **Recreated from the object graph** | **15** | **14** | flat icon: head, ears, face, brow, eyes, muzzle, nostrils, mouth, beard, hands |

The recreated gorilla is what a designer would build as a *flat* version: solid shapes, mirrored features, holes instead of overlaps, everything named. It is not the engraved logo. The intensity of the hatching and the menace of the brow are gone, because the labels asked for flat parts. A fuller recreation would add more parts to the inventory: shadow shapes on the head, fur clumps at the shoulders, knuckle creases on the hands. Each is one more labelled part, not a new algorithm.

| Score (my judgement) | Print quality | Editability | SVG efficiency | Logo fidelity | Commercial readiness |
|---|---|---|---|---|---|
| Recreated | 8 | 9 | 10 | 6 (as a flat version: recognisable, simplified) | 6 |

### Schema v2: style regions

The flat recreation rebuilt anatomy, not style. The original isn't a photo but an artist's rendering (dark fur masses, mid fur, highlights, line engraving), and the flat version simplified that rendering a second time. So the label schema now lets each part also say *how it was drawn*:

```json
{ "name": "head", "parent": "gorilla", "regions": [5],
  "styles": [{ "kind": "shadow", "max": 3 }, { "kind": "fur", "max": 14 }, { "kind": "highlight", "max": 3 }] }
```

Style regions are found in the part's own pixels and become named child shapes (`head-fur-3`, `left-hand-engraving-2`), punched out of the part like any other child:

| Kind | How it's found |
|---|---|
| shadow | large dark masses: lightness blurred over about 4% of the part, below its base tone |
| highlight | the same, above it |
| fur | clumps: darker than their surroundings at a medium scale (2 px blur vs 8 px blur) |
| engraving | near-black line work at full detail |

Each kind keeps at most `max` pieces (largest × strongest), and pieces under 0.3% of the part are dropped.

On the Gorilla Glue logo, with styles on the gorilla, head, beard, face, eyes, muzzle and hands: **60 objects, 59 paths in the illustration**, 199 KB in all. The face gets back its intensity (the dark eye mask, the shaded brow and muzzle), and the head has fur clumps at its edges. It sits between the flat icon (14 paths) and the shading trace (about 4,000), in the 50–200 range a designer recreation would have.

Still to tune, all in the labels rather than in code:
- the eye-mask shadow is heavier than the original's (a lower `max`, or a "soft shadow" kind);
- the fur is sparse next to the engraving (a higher `max`);
- the hands' engraving lines are short pieces, where centreline strokes would draw them better.

| Score (my judgement) | Print quality | Editability | SVG efficiency | Logo fidelity | Commercial readiness |
|---|---|---|---|---|---|
| Recreated, flat (v1) | 8 | 9 | 10 | 6 | 6 |
| Recreated + styles (v2) | 8 | 9 | 9 | 7 | 6 |

The point is proven: the construction engine handles anatomy and style alike, and quality now depends on how richly the vision step describes the art. Schema v3 candidates: symmetry groups (fur clumps mirrored), z-order hints, visual importance per part, cut-line and stroke kinds (centrelines), and texture groups that repeat one clump shape with variations.

### Schema v3: recognition features, importance, a path budget, strokes

v2 added more style. v3 decides what has to *survive*:

```json
{ "budget": 60,
  "parts": [{ "name": "face", "importance": 10,
    "features": [
      { "kind": "shadow", "name": "eye-mask", "role": "identity", "max": 1 },
      { "kind": "highlight", "name": "cheek", "role": "structure", "max": 2 } ] },
    { "name": "head", "importance": 9,
      "features": [{ "kind": "fur", "role": "decorative", "max": 16, "render": "stroke" }] }] }
```

- **Roles:** identity (an eye mask, a jaw), structure (cheeks, forehead shadow), style (shading), decorative (fur, engraving). Each role has a default importance: 10, 7, 5 and 3.
- **Budget:** parts always stay, and so do identity features. Other features are taken in order of part importance × feature importance × the piece's strength while they fit; a stroked feature costs one path, however many pieces it has. At budget 30 the gorilla drops its cheek highlights and the finer shading but keeps the eye mask, brow, eyes, muzzle, nostrils and mouth.
- **Strokes:** features marked `render: "stroke"` are thinned to centrelines (Zhang–Suen), followed into polylines, simplified, and written as one `stroke` path per feature, with a width from area ÷ length (0.8–2.5 px). A piece joins the stroke only if it's line-shaped (at least 3× longer than wide). Blobs drawn as strokes became 6 px worms in the first run.

Result: at budget 60 the gorilla is 34 paths, since everything fits: 15 parts, 15 fill features and 4 stroked features (head fur, body fur, and line work on each hand). At budget 30 it's 29.

What it showed:
- **The budget behaves as designed.** Identity survives and decoration goes first. The labels decide which, not a size threshold.
- **Strokes work mechanically, but they find the wrong lines.** With "darker than its surroundings" as the fur detector, the stroked lines follow the dark gaps between fur masses and along the head's outline, not individual strands. Real strand detection needs a line detector that knows each line's direction (a ridge filter or Gabor bank, for example) and probably the vision step drawing the main fur directions. That's the next research item, not a tuning job.
- **Fidelity is about level with v2** (7, my judgement): the eye mask, brow and muzzle carry the face, as you predicted. What's missing to go further is the fur texture done as strands, the menacing brow done as a stroke, and the ring-gradient look inside the illustration.

### Schema v4 and v6: signature features, regenerated texture

- **v4, the `signature` role:** "if this disappears, it's a different character". Signature features are never dropped and rank above identity (importance 10 against 9). On the gorilla: the eye mask, plus the brow, eyes, muzzle and mouth as signature-importance parts.
- **v6, texture synthesis** (`render: "texture"`): fur isn't traced, it's regenerated, as an illustrator draws it. The artwork gives the *direction*: a structure tensor (gradients squared, averaged over about 4 px) gives the dominant stroke direction at every point, and engraved fur has a very clear one. Strands are seeded on a jittered grid where the image has a strand of that tone. Each one follows the direction field both ways for `length` px and becomes a lens-shaped tapered spike `width` px across. Its colour is the part's brightest (or darkest) 15% of strokes. All strands of a texture are **one compound path**.

```json
{ "kind": "fur", "role": "style", "render": "texture",
  "texture": { "density": 1.4, "length": 16, "width": 2.2, "tone": "light" } }
```

Result on the Gorilla Glue logo: **30 paths** for the whole gorilla (15 parts, the eye mask, shadows, cheeks, 2 fur textures and the hands' line work), 240 KB in all.
- The strands follow the real fur: the parting down the middle of the head, the fall to the sides, the sweep across the shoulders.
- At normal size it reads as the engraved Gorilla Glue gorilla, not a flat icon.
- **That fixes the failure of v3's traced strokes:** regenerating fur works where tracing it didn't.

| Score (my judgement) | Print quality | Editability | SVG efficiency | Logo fidelity | Commercial readiness |
|---|---|---|---|---|---|
| v1 flat | 8 | 9 | 10 | 6 | 6 |
| v2 styles | 8 | 9 | 9 | 7 | 6 |
| v6 signature + regenerated fur | 8 | 9 | 9 | 7.5 | 6.5 |

Still rough, all label- or region-level:
- **Beard:** no strands, because it's left with only 38 px of its own once the face is drawn over it. Its region should be drawn above the face, or reach below it.
- **Lower chest:** it has a black shadow blob, and its region (SAM's #6) reaches into the "100% TOUGH" ring.
- **Hands:** pale, with short line pieces.

### Per-part budgets and procedural generators

- **`pathBudget` per part:** the face 15, the hands 3. A part's own features stop when its budget is spent. Signature and identity features don't count against it. Geometry goes where recognition is, inside the overall budget.
- **`render: "procedural"` with a `generator`:** the fur generator so far; hair, grass, grain and feathers would be more generators on the same field-and-seed machinery. `"texture"` still works as before.

**A finding from the hands:** drawing the finger shadows as *strokes* (centrelines) made the hands worse. The fills read as fingers (cream finger shapes with dark gaps); the strokes read as one beige blob with scribbles. The original hand is *finger objects* with outlines. So the hands, like the face, need **topology** (each finger a part, or a "hand" template), not a different render. Strokes are right for true line work: engraving, wrinkles, outlines, lettering strokes.

### Where the remaining fidelity is (review, 27 Oct)

What still separates this from an illustrator's redraw, roughly 7 → 9:
- **Face topology:** the eye mask is a traced dark patch, not a socket wrapping the skull; the brow, nose bridge, muzzle and lip need constructing as shapes (v5 templates), not finding as patches.
- **Fur as anatomy:** the strands follow the drawing's measured flow. The schema should also let the vision step state the intended flow (`"flow": "radial_from_crown"`, an angle), overriding or steering the measured field.
- **Hands as fingers:** see above.
- **Required features:** `required: true` (eye mask, nostrils, brow) is the same as the signature role, never dropped.

**Summary (for the design doc):** the Gorilla benchmarks suggest that vector quality is set more by semantic reconstruction than by geometric tracing. Replacing traced detail with intent-driven features cut complexity from thousands of paths to about 30 while making the gorilla more recognisable. Signature features keep identity, procedural features regenerate texture from the artist's direction rather than the pixels, and path budgets put geometry where it adds most to recognition. The long-term architecture should preserve design intent, not raster detail. The renderer is becoming a compiler, and the intelligence lives in the design-intent graph.

### Three classes of feature

The finger experiment showed that some information isn't graphical but structural: the gaps between fingers come from the fingers, not the other way round.

| Class | Examples | How it's made | Budget |
|---|---|---|---|
| **Structural** | eye socket, muzzle, finger, ear, jaw | constructed as designed geometry (templates), never discovered as patches | always present |
| **Semantic** | eye mask, brow shadow, nasal ridge, cheek patch | recognition cues, fitted to the image | survive every budget (signature) |
| **Decorative** | fur, cross-hatching, wood grain, feathers | procedural generators, steered by flow | scale with the budget |

A fourth class, **generative**, covers rules for making features rather than features: fur, feathers, wood grain, scales, chainmail, hatching, rope twist, fabric weave. In the prototype these are already `render: "procedural"` with a `generator`. As a class, a generator scales with the budget (more or fewer strands) without the description changing.

**The metric to track: recognition retention.** Not paths, not file size, but "does it still look like my mascot?". For example: original 100%, 25 paths 82%, 50 paths 94%. Ways to measure it, cheapest first:
1. **Image-embedding similarity** (a CLIP-style model) between the original and the render at each budget. It's automatic and cheap, but it rewards texture and colour, not identity, so it needs checking against people.
2. **A vision model as judge:** "same character? rate 0–10", on test images only.
3. **The Layout team's verdicts in the admin panel** (usable / needs touch-up / rejected), collected for every run from 2 November. This is the ground truth the other two are calibrated against. Since 27 Oct each review also records the **type of artwork** (the artist confirms it; "mascot or illustration" is pre-selected for illustrations) and has a reason **"Character or subject not recognisable"**. Each run stores the texture measure and whether it was traced as an illustration. The first real dataset on illustrations starts with the launch.

**Principles for the intent graph:**
- **Meaning, not geometry.** The graph says *why* something exists (an eye mask, importance 0.95; fur, radial from the crown, density 0.6), not where pixels happened to be. Exact clump positions, hatch counts, node locations and control points are made at compile time.
- **Standing question:** "What belongs permanently in the graph, and what should be generated at compile time?". Asking it on every schema change keeps the graph from turning into a second SVG.
- **Known gap in the prototype:** its labels use pixel boxes and SAM region numbers, which are resolution-bound. The next schema should anchor parts to the object's own frame (normalised coordinates relative to the head or the silhouette) or to template landmarks.
- **More targets than SVG.** Because the graph holds meaning, the same source could compile to PDF, cut paths, **embroidery** (stitch types per feature class: satin for structure, fill for masses, run stitch for line work; directly relevant to Barron's branding), laser or CNC paths, or an animation rig.

**Template explosion is the biggest risk.** Uploads will include dragons, octopuses, motorbikes and pirate ships; a template per subject grows forever. So the split is:
- **specific templates** for the common mascot categories (gorilla, lion, eagle, bulldog, hand, skull);
- a **generic shape grammar** for everything else, built from reusable parts: head, eye, mouth, limb, wing, weapon, badge, ribbon. The grammar scales, and the template count doesn't need to.

**Metrics as predictors, verdicts as ground truth.** Embedding similarity and a vision judge *predict* recognition retention. The Layout team's accept/reject verdicts are the scoreboard, and the predictors are calibrated against them.

**In one sentence:** the vectoriser is an intent-graph compiler that reconstructs design intent from artwork and compiles it into editable vector assets within a configurable complexity budget. That's the right description for the illustration work. For flat logos, which are most of what Barron receives, the existing tracer stays the right tool.

**Freeze the architecture:** image → vision → intent graph (source) → compiler → SVG (build). The compiler's job is to keep the intent within the budget, not to keep the pixels. Until templates and vision labels are done, no new tracing modes, edge detectors, contour extraction or smoothing: the renderer has enough; the limit is what to draw, not how.

**Labels are the source; the SVG is the build.** An artist edits the intent graph and recompiles, not the SVG. Two schema additions follow from that:
- **Budgets per class:** for example `{ "budget": 100, "structural": { "min": 40, "locked": true }, "semantic": { "min": 25, "locked": true }, "decorative": { "max": 35 } }`. Exporting at 50 paths then drops decorative first, semantic only if it must, and never structural. Today the prototype has an overall budget, per-part budgets and "always kept" roles; class budgets would replace the role rules.
- **Recognition weight, separate from importance:** how much a feature contributes to recognising the character (eye mask 0.95, fur clump 0.05). Budget cuts follow recognition, which matters once exports are offered at 25, 50, 100 and 250 paths.
- **Shape, stroke and pattern as first-class primitives,** with flow on strokes too (for example an engraving stroke following the jawline).

Flow matters more than count: ten fur clumps in the right direction read better than a hundred at random. So the schema should carry flow explicitly, as `{ "type": "radial", "origin": "crown" }` or a vector field, steering the field measured from the artwork.

### Roadmap from here (post-launch)

Ranked by expected gain:
1. **Shape templates (largest fidelity gain):** identify the object class (gorilla head, hand, beak, snout), instantiate its template (skull, eye sockets, brow, muzzle, nostrils; thumb and four fingers), fit it to the image, then decorate.
2. **Vision-generated labels (largest automation gain):** importance, recognition features, flow, symmetry and hierarchy from one server-side call (after legal sign-off).
3. **An artist's editor for the labels:** the labels are becoming the product; the SVG is a compilation target.

Detailed items:

| Step | What | Why |
|---|---|---|
| v5 | **Feature templates:** construct a feature from a shape type ("organic band" for an eye mask, "crescent" for a brow shadow, "tapered spike" for a fur clump) fitted to the traced region, instead of tracing it | Intentional shapes, fewer nodes, symmetric by construction |
| v6+ | **Texture tuning:** strand density from the image, light *and* dark strand passes, textures for feathers, grass and hair | The method works; it needs range |
| v7 | **Vision-generated labels:** one server-side call that returns this JSON (inventory, boxes, tones, mirror pairs, features with role, importance and render, textures, budget) and an editor for the artist to correct it | The labels are now the quality limit. Needs the API decision (legal/POPIA) |
| — | **Recognition targets and per-target budgets:** for example "gorilla face: 20 paths, hands: 8, text: from the flat tracer" | Spends paths where recognition is |

What it would take to productise:
1. The vision call on the server: a prompt that returns this JSON (parts, boxes, tones, mirror pairs, features with role, importance, render and texture, and the budget) from the numbered image plus the original.
2. Checking box accuracy on 10–20 real mascots.
3. Letting the artist edit the inventory (rename, move a box, add a part) before construction.
4. Offering it as a third Illustration choice: Detailed shading, Simplified, Recreated.

## Cost

| | |
|---|---|
| Model download (first use, then cached by the browser) | 38 MB (vision encoder 22.2 MB, decoder 15.8 MB) |
| Encode the image | 5–8 s (49 s on the first run, including the download) |
| Find objects (about 200 decoder runs) | 25–32 s |
| Redraw and trace | about 10 s |
| Total on top of today's trace | about 45–50 s |

All on the CPU (WASM), on the same machine as the rest of this work. Object finding can be made several times faster: it scans whole-image masks where the mask's box would do, and it could prompt fewer points.

## Verdict

Worth building, but as a choice for illustrations, not the default, and only after the admin panel is live:

- **It works without training or a server.** SAM finds the objects a designer would name (face, muzzle, hands, chest) on its own, in the browser.
- **Per-object tones and mirroring are what make it look drawn.** Global tones don't.

Open questions:
- **Other illustrations.** Only the Gorilla Glue logo was tried. Mascots, animals and faces from the Layout team's real cases are needed before deciding.
- **Wrong objects.** The prompt grid can return odd parts. A Layout artist could click to add or remove an object; SAM is built for that, since one click is one prompt.
- **Speed.** About 50 s is acceptable in the admin panel as a background alternative (like AI sharpening), not as the first result.
- **Line work.** Eye outlines and nostril rims are still tones, not strokes. Centreline strokes are roadmap item 2 in [engine-review.md](engine-review.md).

Next step if pursued: run the bench on 10–20 real illustration cases from the Layout team, and add "Objects redrawn" as a third Illustration choice behind a flag, offered by the background improver.
