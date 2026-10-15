# V8 redraw proof of concept: results (experimental, uncommitted)

Branch `v8-reconstruction` (local, from `main` d666303). Nothing is merged, deployed or pushed. No new dependencies.
The production app is untouched except for the Phase 1 seam filter (below), which is switchable (`cleanSeams: false` restores V7 exactly).

Test page: `bench/redraw.html` (banner: Experimental). Run `npm run dev`, open `/bench/redraw.html`, press *Run the test set* or add your own logos.

## What V8 does differently

V7 traces each colour's outline. V8 rebuilds the drawing as one shared map:

1. Colours are refined at up to 4× resolution, blend bands (anti-alias halos) are assigned to a real colour, and specks are merged.
2. Every boundary between two colours is a **single shared edge** with junctions. Neighbouring colours can't gap or overlap.
3. Each edge is fitted with the simplest primitive: line, then arc or circle, then Bézier, and splits stay tangent-continuous. Closed shapes V7 recognises exactly (polygons of 12 sides or fewer, stars, ellipses) are used as is.
4. Design rules: angles snap to 45° multiples, equal radii are equalised, centres made concentric, corners rebuilt by intersecting lines, and mirror symmetry is applied when 98% of the outline matches.
5. Every place where the redraw moves the drawing further than the upload can explain is **flagged** (pink box on the test page) for a person to check.

## Before and after

Four pictures per case: damaged upload, V7 trace, V8 redraw, clean original.

- Heavy damage (64 px, JPEG q 0.30): [`docs/v8/compare-64px.png`](v8/compare-64px.png)
- Light damage (160 px, JPEG q 0.55): [`docs/v8/compare-160px.png`](v8/compare-160px.png)

## Measurements against the clean originals

10 synthetic logos with exact originals, damaged into realistic uploads (shrunk, blurred, saved as JPEG), scored at 4× against the original.

| Damage | Mean error V7 → V8 | V8 better / same / worse | Files with problems V7 → V8 | Mean time V7 / V8 |
|---|---|---|---|---|
| 160 px, q 0.55 (light) | 0.30% → 0.33% | 1 / 7 / 2 | 0 → 0 | 1.14 s / 0.38 s |
| 96 px, q 0.35 | 0.80% → 0.39% | 1 / 9 / 0 | 0 → 0 | 0.79 s / 0.19 s |
| 64 px, q 0.30 (heavy) | 2.35% → 0.80% | 6 / 4 / 0 | 4 → 1 | 0.92 s / 0.14 s |

**Editability.**
- On geometric art, 89–100% of V8's segments are true lines, arcs or circles; V7 produces only Bézier runs.
- V8 files contain *more* path segments on simple logos (e.g. 235 → 318 at 160 px). Two reasons: each shared edge is written once per neighbouring colour, and arcs are exported as cubic curves of 90° or less.
- On complex art V8 has far fewer: the bird went from 4,081 to 1,093 segments.

**Real uploads** (no clean originals, so these are not scored):

| Logo | V7 segments | V8 segments | V8 file checks | Time V7 / V8 |
|---|---|---|---|---|
| badge 240 px | 38 | 38 (14 lines, 3 circles) | clean | 2.6 s / 1.0 s |
| acme 200×100 | 32 | 61 | clean | 1.0 s / 0.4 s |
| leaf 150 px | 27 | 27 (12 lines, 12 arcs, 4 curves) | clean | 0.9 s / 0.4 s |
| bird 740 px (gradient) | 4,081 | 1,093 | zero-area 2, self-intersection 10, sliver 12, small 5 (plate overlaps 32 → 0) | 18.3 s / 3.2 s |

The leaf was earlier drawn as 152 straight steps: its pixel staircase was being read as corners. This is fixed by requiring a corner to show at both a fine and a wide scale.

## Where reconstruction is worse

- **Shield, 160 px** (0.45% → 0.97%) and **speech bubble, 160 px** (0.55% → 1.08%). V8 looks cleaner, but it tightens the bubble's corner radii and slightly rounds the shield's point. On a nearly clean upload, V8's design rules can move the drawing further than V7's faithful trace does.
- **Heavy damage (64 px), visible artefacts the score misses:**
  - the orange chevron is warped
  - the Venn lens contains blobs
  - dark-red and lavender halo bands survive along the shield stripe and around the speech bubble
  - the ring-and-bar bar has bulges where it crosses the ring (T-junction notches)
- **The error score is not trustworthy on its own.** It scored the warped 64 px chevrons at 0.3%. The next phase needs a per-colour overlap score (IoU per colour), and a person still has to look.
- **Bird:** V8 still writes 2 zero-area pieces and 10 self-intersecting pieces (tiny bow-tie fragments). These are not ready for cutting.

## Performance and memory

- **Speed:** V8 is 3–6× faster than the V7 job on every input (bird 3.2 s vs 18.3 s). V7's time includes its improvement passes.
- **Memory:** heap growth was measured with `performance.memory`. It is noisy (garbage collection lands mid-run): the bird ranged from about 0 to +64 MB, and small logos stayed under 40 MB.
- **Refinement cost:** refinement is capped at about 1,600 px per side, so memory is bounded by that canvas: about 2.6 M labels, plus maps of the same size.

## Phase 1: path integrity (implemented, measured)

1. **Seam filter** (`src/trace/index.ts`, `MIN_OUTLINE_WIDTH = 0.5` in the pipeline).
   - Rule: an outline narrower than 0.5 px on average is dropped *only if* none of its own pixels are its colour. So a faint seam strip goes, and a 1 px rule or a faint thin stroke stays.
   - Not every small path is treated as an error: the first width-only version removed real tagline detail on the harbour logo (detail error 16.71% → 17.55%), and the own-pixel rule restored it exactly (16.71%).
   - Bird: thin pieces in the SVG went from 13 to about 2. Harbour: unchanged.
   - 3 unit tests cover a dropped strip, a kept 1 px rule, and a kept faint stroke.
2. **Export validation** (`src/export/validate.ts`, 5 tests). Checks SVG/PDF/DXF shapes as written:
   - fail: open outlines, zero-area outlines
   - warn: self-intersections; slivers under 0.3 mm and pieces under 1 mm at the chosen output width; colour plates overlapping beyond the registration spread
   - it only reports and never deletes; the bird takes 0.14–0.24 s
   - wired into the real-logo bench (`bench/real.ts`), where fail checks become blocking
3. **Findings on existing V7 output** (all pre-existing):
   - bird: 32 plate overlaps, 12 self-intersections, 22 slivers, 10 small pieces
   - harbour: 2 self-intersections, 2 slivers
   - acme and badge: clean
   - the bird's 3 DXF slivers are real thin wedges of its own colour: a matter for a cut-specific version, not errors to delete
4. **Safeguards:**
   - full test suite: 187 passed, 2 skipped; typecheck clean
   - app-vs-simulation parity: 16 of 16 files checked gave identical output (partial run: it stopped at its time limit)
   - V7 behaviour is unchanged apart from the switchable seam filter

## Proposed one-colour solution (for approval; not implemented)

**Today's defect:**
- "Maximum colors = 1" counts the background as one of the colours, so the artwork disappears.
- With 2, every colour merges into one silhouette. The bird loses its feather boundaries.

**Proposed algorithm:**
1. **Background:** decide what is paper. That is transparent pixels, or the colour connected to the image border that covers most of it. "Maximum colors" counts **artwork colours only**, so 1 can never produce an empty file.
2. **Ink or knockout per region:** each artwork region is ink, except regions whose lightness is closer to the paper than to the ink (ΔL\* threshold, default 25). Those become knockout, so negative space survives: a white star on teal, letter counters, white rings.
3. **Internal boundaries:** where two *different* ink colours share an edge in the V8 planar map, cut a knockout gap along it.
   - default 0.5 mm at the output width, adjustable from 0 to 2 mm; 0 gives a solid silhouette
   - a gap is skipped, and flagged, where it would leave ink narrower than twice the gap, so fine detail isn't destroyed
4. **Gradients:** steps within one gradient (same colour family, smooth change) are one region, with no gaps inside it.
5. **Lettering:** text is ink, with counters open. Neighbouring letters are never joined by the merge, since they touch only through paper.
6. **Ink colour:** chosen by the user (default black). The result is one plate, checked by the export validator at the cut size.

**Acceptance tests (proposed):**
- Unit: `Maximum colors = 1` never yields empty output; transparent and white backgrounds both work.
- Star-badge: the star stays knocked out. Target: the rings alternate ink and paper exactly.
- Venn: two circles, with the lens separated by gaps, and no hole where the colours overlap.
- Bird: feather and wing boundaries visible as gaps; the silhouette within 3% of the colour version's covered area; no zero-area or self-intersecting pieces.
- Lettering (harbour, acme): every counter open, no two letters merged, legible at 16×.
- Gradient logos: no gaps or banding inside a gradient.
- Detailed illustration: no gap or ink thinner than the minimum cut width without a flag; at least 95% of the colour version's ink regions survive, or are flagged.
- Regression: multi-colour V7 output and benchmarks are identical.

## Recommendation for the next phase

1. **Don't put V8 in the app yet.** It is consistently better on heavily damaged geometric uploads and much faster, but it has visible artefacts at low resolution, and it over-corrects nearly clean uploads.
2. **Next V8 work, in order:**
   - replace the error score with per-colour IoU plus edge position
   - remove the low-resolution artefacts (blobs at blend bands, surviving halo bands, T-junction notches)
   - only apply design rules (radius, symmetry) when they reduce the error against the upload
   - stop writing zero-area and bow-tie pieces
   - re-run on 10–15 real logos for which clean originals exist
3. **Then:** offer "Rebuild Artwork" as an experimental option alongside "Trace Original" (V7), with automatic fallback to V7 when V8's checks fail.
4. **Implement one-colour** (above) once approved. It builds on V8's shared edges for the internal boundary gaps.
5. **Master and production versions:** keep the V8 redraw as the master vector, and derive the production versions from it, each with its own validator settings:
   - vinyl cut: minimum width, weeding size, merged plates
   - embroidery: minimum satin width, no tiny islands
   - print: plates with spread

---

# Round 2: quality evaluator and heavy-damage fixes (uncommitted, for review)

Still experimental and bench only; nothing is wired into the app. This work sits on top of commit `4d993c4` on `v8-reconstruction`.

## 1. Quality evaluator (`bench/redraw/evaluate.ts`)

The pixel score let a visibly wrong logo pass: it gave the warped 64 px chevron 0.3%. The evaluator compares a result with the clean original by **geometry and colour independently**. Every tolerance is in upload pixels.

| Check | Fails when |
|---|---|
| Region overlap | any colour region overlaps the original by less than 90% |
| Edge position | 5% of edges are more than 1 upload px from the original's |
| Corners | a sharp corner of the original is rounded, cut or filled by more than 15% |
| Halos | a thin band of a colour the original doesn't use there, or of an off-shade |
| Shades | one flat colour is drawn as 2 or more visibly different shades (blotchy) |
| Bulges and notches | an edge is pushed out or cut in by more than 2 upload px |
| Topology | shapes are merged, split, missing or added |
| Colour accuracy | a region's colour is ΔE > 10 off; this is measured separately and doesn't count as a shape error |

**What it catches:**
- the warped 64 px chevron
- the shield's dark halos and its rounded top corners
- the Venn's two shades
- the speech bubble's lavender halo
- the ring-and-bar T-junction notches
- the 64 px leaf, whose stem became a grey teardrop while the pixel score said 0.05%

**What it gets wrong:**
- it passes the 64 px speech bubble although the white bars have rounded ends, because the bars are only 3 upload px tall and below what it can judge
- early versions counted one colour shift several times (as region, missing and halo); fixed by judging geometry against the nearest original colour

The evaluator is separate from the SVG/PDF/DXF file checks (`src/export/validate.ts`), which are unchanged.

## 2. V7 vs V8 by the evaluator (10 synthetic logos, clean originals)

| Damage | Logos passing V7 / V8 before / V8 now | Defects V7 / V8 before / V8 now | Mean pixel error V7 / V8 before / V8 now |
|---|---|---|---|
| 160 px, q 0.55 | **8** / 7 / 7 | 4 / 4 / 4 | 0.30% / 0.33% / 0.33% |
| 96 px, q 0.35 | **7** / 5 / 5 | 16 / 17 / 17 | 0.80% / 0.39% / 0.39% |
| 64 px, q 0.30 | 2 / 2 / **3** | 71 / 39 / **24** | 2.35% / 0.80% / **0.58%** |

**On light and medium damage, V8 is worse than V7 by this measure, even where its pixel error is lower.** V8's failures there are mostly corners:
- 160 px: the shield's stripe ends, the leaf's tip and the speech bubble's tail
- 96 px: the shield's six corners, the arc's square end and the speech bubble's tail

V8 rebuilds corners from fitted lines, and on a fairly clean upload that moves them more than V7's faithful trace does. **On heavy damage V8 is much better:** 24 defects against 71, and 3 logos pass against 2.

Before and after: [`docs/v8/round2-64px.png`](v8/round2-64px.png), [`docs/v8/round2-160px.png`](v8/round2-160px.png).

## 3. Fixes made (heavy damage)

**Colour reconciliation**, for uploads of 256 px a side or less:
- **Thin JPEG ringing bands** (darker or lighter than both neighbours) join their neighbour. This removed the shield's dark bands: 64 px error 0.90% → 0.78%, with halo and shades cleared.
- **Islands of a close shade** join the shape around them. This removed the Venn's second green.
- **Blends** may sit somewhat further off the straight mix of their neighbours (JPEG colour bleed is more saturated), up to 3 source px wide. This removed the speech bubble's lavender halo: 2.8% → 0.6%, and it now passes.
- **Neighbouring shapes merge** when their inside colours are within ΔE 20 and the upload changes gradually between them. Shapes separated by a drawn edge are never merged.

**Restricted to small uploads, because it damaged real art:**
- The first version ran on every image. On the 740 px bird it merged a real coral band into the orange head, plus 17 other merges.
- Those widths are JPEG damage only on small uploads; on larger images they are design. Large images now come out **byte-identical** to the committed V8 (bird and harbour checked).

**Design-correction guard:**
- Angle snapping and symmetry may not move a node more than 0.6 source px from where the upload puts it.
- It changed no result on this set: the rules never moved a node that far.
- So the 160 px regressions are not caused by snapping or symmetry. They come from corner reconstruction and the colour map. It is kept as a safeguard.

## 4. Tried and rejected (measured)

- **Re-measuring colours from each shape's inside:** the orange dot got worse than V7's colour. V7's cluster colours are kept.
- **Corner lines measured from the middle of each edge:**
  - better: 160 px shield 0.97% → 0.70%, 96 px speech bubble now passes
  - worse: 64 px shield 0.78% → 1.64%, with a yellow strip along the top
  - still worse when limited to long lines, so reverted
- **Collapsing short bevels at corners:** no effect on any case, so removed.
- **A noise-tolerant line test for wobbly straight sides:** the chevron got worse (0.30% → 0.41%), so reverted. The chevron warp is in the colour regions, not in the line fitting.

## 5. Still wrong (confirmed by the evaluator and by eye)

- **Chevron at 64 px:** the orange chevron is warped, with 89% region overlap. V7 traces it cleanly. The cause is in V8's colour regions at 4× refinement; not fixed.
- **Ring-and-bar at 64 px:** notches where the bar meets the ring (4 corner defects), and the red region at 88% overlap.
- **Corners on light damage:** see section 2.
- **Colour drift:** on the arc-mark, target, leaf stem and ring-and-bar red, colours are ΔE 10–22 off. This comes from the colour step V7 and V8 share, not from reconstruction.
- **Topology on the bird:** V8 still writes 2 zero-area pieces and 10 self-intersecting pieces. Not addressed this round.

## 6. Performance and editability

- **Time:** V8 takes 0.14–0.6 s on the synthetic set, still 2–6× faster than the V7 job. The colour step adds about 50–250 ms. The bird takes 2.6 s, unchanged.
- **Memory:** heap growth was +10 to +60 MB, which is noisy.
- **Editability:** unchanged. 89–100% of outline length is lines, arcs and circles on geometric art. Segment counts are 360–444 at 64 px (V7: 362) and 318 at 160 px (V7: 235).

## 7. Recommendation

- **Don't offer V8 for light or medium damage yet.** By the evaluator it is worse than V7 there.
- **Next V8 work:**
  1. Make corner reconstruction evidence-based: only move a corner when the move brings the edges closer to the upload.
  2. Investigate the warped colour regions (chevron, ring-and-bar).
  3. Fix zero-area and self-intersecting output.
- **A possible product rule, once real-logo validation allows it:** run both V7 and V8, score each against the *upload* (no original is available in the app), and offer V8 only when it wins clearly. Heavy-damage uploads are where it does.
- **Real-logo validation is still needed:** the evaluator needs clean originals, and only 3 of the real logos have them (acme, harbour and leaf SVGs). It should run on 10–15 real logos with originals before any customer use.
