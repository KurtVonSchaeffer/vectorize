# Engine review against the "Image Trace / Vector Magic quality" brief

October 2026. The brief asks for a ten-stage pipeline (preprocess, quantise, edges, segment, trace, fit, simplify, merge, despeckle, optimise) and three modes (logo, illustration, high fidelity). Most of those stages already exist in this engine. The gaps are narrower than the brief assumes, and they are listed at the end with priorities.

## What the engine does today

Two tracers run in the browser:

| | Flat tracer (ours) | VTracer (WASM) |
|---|---|---|
| Used for | Logos, illustrations, line art, print plates, cut files | Photos and painterly art; the shading layer of illustrations |
| Code | `src/palette/quantize.ts` → `src/trace/*` | `src/vectorize/tracer.ts`, worker |
| Output | Few colours, clean shapes, exact geometry | Thousands of small stacked shapes |

The flat pipeline, mapped to the brief's stages:

| Brief stage | Where it is | Notes |
|---|---|---|
| 1 Preprocess | `improve.ts` (JPEG ripple, AI sharpening via Swin2SR), `prepareImage` | No bilateral filter as such; AI sharpening and de-JPEG take that role for small and lossy uploads |
| 2 Quantise | `quantize()`: weighted k-means in Lab, `mergeSimilar` (ΔE2000), `dropBlendClusters`, `pureCenters` | Colour count is automatic (default up to 12, `maxColors` overrides) |
| 3 Edges | Anti-aliasing kept as coverage (`second`, `cov` in `LabelMap`) | Sub-pixel edges come from coverage, not Canny |
| 4 Segment | Connected components, `majorityFilter`, `separateRegions` (keeps same-colour regions apart) | |
| 5 Trace | `contours()`: marching squares on a smoothed coverage field | Potrace-like, sub-pixel |
| 6 Fit | `fitClosed()`: corner split + Schneider error-bounded cubics; `straightEdges`, `exactArcs`, `exactShapes` (circles, ellipses, stars, polygons) | |
| 7 Simplify | `mergeCurves`, curve tolerance from the Detail slider | Douglas–Peucker isn't needed on top of Schneider fitting |
| 8 Merge | `mergeSimilar`, `connectedStacking` (no hidden duplicates) | |
| 9 Despeckle | `removeSpecks` with `isDetail` (keeps real dots, full stops, counters) | Area threshold scales with Detail, not a fixed 0.05% |
| 10 SVG | `layersToSvg`: one group per colour, named inks, gradients as `<linearGradient>`, knockout plates for print | |
| Text | `src/fonts/*`: OCR + font matching rebuilds lettering from the real font | Beyond the brief |
| Modes | `detectArt` picks flat / photo / line art / pixel art; now also `illustration` | |

## The brief's questions

1. **Why fragmentation (fur becomes hundreds of shapes).** Hatched art went to VTracer, which traces every stroke as its own stacked shape. Or it went to the flat tracer in a few colours, which turned the strokes into blotches. Since 26 Oct, illustrations are split: the texture goes to VTracer at 2×, and everything else goes to the flat tracer. Inside the texture, the flat map is one colour, so the flat tracer no longer fragments the fur.
2. **Why path counts are high.** The Gorilla Glue SVG has about 12,600 paths, nearly all in the shading layer. That is the cost of keeping 1–2 px pen strokes. Logos traced flat have tens of paths.
3. **Why text edges were jagged.** On the Gorilla logo, the lettering was traced by VTracer (when the image was treated as a photo) or merged into blend colours. It is now on the flat tracer with blends dropped, so it's clean. On any logo, `src/fonts` can rebuild a line from the real font.
4. **Why regions didn't merge.** `mergeSimilar` merges by ΔE2000 below `colorMerge`. Near-identical regions survive only where `separateRegions` keeps them apart on purpose (two shapes of one colour that don't touch), or in VTracer output.
5. **Why outlines are lost.** Black outlines are filled regions, not strokes; the engine has no centreline tracing. Fine-detail mode (`finedetail.ts`) keeps thin lines' width and ends, but they're still fills. This is the main real gap: see roadmap item 2.
6. **Algorithms to replace.** None of the core ones. The quantiser, marching squares and Schneider fitting are the same family as Potrace, Image Trace and Vector Magic.
7. **Algorithms to add.** Centreline (stroke) extraction for outlines; radial gradient detection; texture simplification for the shading layer (see roadmap).
8. **Stages to reorder.** Texture detection now runs before the flat tracer (`fillTexture` after paper and before tracing). No other reordering is needed.
9. **Code changes made on 26 Oct.**
   - `detect.ts`: the illustration rule.
   - `illustration.ts`: new; finds the texture, fills it in the flat map, outlines it and composes the layers.
   - `pipeline.ts`: the shading job and the composition.
   - `App.tsx`: the shading settings.
   - `complexity.ts`: illustrations count as hard.
10. **Roadmap.** Below.

## Solid shapes, holes and "logo recreation"

The flat layer already builds artwork the way the brief describes for Vector Magic:
- **One shape per object, with holes.** Each colour is one compound path (`fill-rule="evenodd"`, `layersToSvg`). The banner is one yellow shape whose letter counters are holes, not four yellow pieces. Near-identical colours are merged before tracing (`mergeSimilar`, ΔE2000).
- **No hidden copies.** `connectedStacking` stacks a lower colour only under the shapes it touches, so nothing is drawn twice.
- **Punched-out print plates.** For print and cut files, `knockout` mode gives every colour only its own area, and rebuilt lettering is punched out of the shape behind it (`punchLetters`).

What the brief calls "logo recreation", a few solid layers with the texture thrown away, is now the Simplified choice for illustrations: 108 paths and 10 colours on the Gorilla Glue logo (see [admin-panel.md](admin-panel.md)). Print plates and cut files use it too.

What it can't do yet is understand objects. It simplifies by tone, so the gorilla's face is tone patches, not a redrawn face with eyes, nose and mirrored halves. That needs the engine to know which pixels are "the gorilla", "the left hand" or "an eye": object segmentation (for example Segment Anything, which runs in the browser like our AI sharpening), then a silhouette per object, tones inside it, and symmetry across it. This is the "design intent" step. A prototype ([design-intent.md](design-intent.md)) shows it can work in the browser: SAM finds the objects, and per-object tones with mirroring make the face read as drawn. It belongs after the admin-panel launch, measured against the artists' verdicts on complex logos.

## Done since (26 Oct, evening)

- Detail layer: 12,616 → 4,059 paths, 6.07 → 1.00 MB, texture 95–96% the same (SSIM). See [admin-panel.md](admin-panel.md). It's traced from the texture only, with compacted path data and larger specks merged, and has no clip path.
- Ring gradients: radial gradients across a badge's ring, centres shared between arcs (roadmap item 3).

## Roadmap

| # | Change | Why | Size |
|---|---|---|---|
| 1 | ~~Reduce the shading layer~~ (done: 4,059 paths, 1 MB). Further: merge neighbouring shading shapes under ΔE 3 | A few hundred more paths | 1–2 days |
| 2 | **Centreline outlines** (opt-in): thin dark regions of near-constant width become stroked paths (skeleton + width), as Illustrator's "Strokes" trace does | Outlines that can be edited and re-weighted; better for embroidery and engraving | 1–2 weeks |
| 3 | ~~Radial and ring gradients~~ (done for rings) | | |
| 3a | ~~"Simplified" switch for illustrations~~ (done) | | |
| 6 | **Design-intent redraw**: prototype done ([design-intent.md](design-intent.md)). SAM finds the face, muzzle, hands and chest in the browser; per-object tones and mirroring make the face read as drawn (140 paths). Next: try it on 10–20 real Layout cases, then make it an Illustration choice behind a flag | Faces and hands redrawn as a designer would | 1–2 weeks to productise |
| 4 | **Run the check in a worker with a longer limit for illustrations** | The check currently times out on the largest SVGs | 1 day |
| 5 | **Texture thresholds from real data**: after two weeks of Layout reviews, set `TEXTURE_BUSY` / `TEXTURE_SHADES` from what artists marked usable | They are tuned on one logo today | ongoing |

Not recommended: replacing the flat tracer with Potrace or a new engine. It already does what the brief's stages describe, plus exact geometry, font rebuilding and print plates. The quality gaps are in the three places above.
