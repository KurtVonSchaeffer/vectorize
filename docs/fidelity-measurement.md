# Reconstruction fidelity measurement

`src/quality/fidelity.ts` (`assessFidelity`) measures a vector result against the uploaded image it
came from. It is a measurement only: nothing in the app calls it yet, and it does not change how
artwork is processed (proven byte for byte in `src/vectorize/__tests__/fidelity/golden.test.ts`).
Later PRs will use it as the before-and-after yardstick and to inform the readiness message.

**It is not a production approval.** "ready" means only that none of these checks found a
problem. Known problems pass it (see Limits), so it must never mark artwork as approved for
production on its own. Three states stay separate: the vector was generated; automated checks
found no known problem; a person approved it for production.

## What it measures

Inputs: the upload, the SVG drawn at the upload's size (the browser's renderer in the app and the
bench; a supersampling stand-in in Node tests), and the SVG text.

| Measure | How | Catches |
| --- | --- | --- |
| Edge recall / precision | Sobel edges of the upload with a vector edge within 1 px, and the reverse (`compareRasters`) | outlines lost, moved or invented |
| Fine detail lost | Features: areas of one colour that differ by ΔE2000 ≥ 15 from everything they touch, with ≥ 3 solid pixels (alike along at least one line, so a 1 px stroke counts). Lost: under half of a feature's pixels show its colour within 1 px | lettering strokes, stars, thin lines, dots |
| Shapes changed | For fine features that survive: IoU of the feature with the vector's pixels of that colour around it, under 0.75 | star points cut off, small shapes redrawn |
| Flattened shading | ΔE2000 over 6 in the upload's smooth interior (`shadingLoss`) | gradients turned into flat bands |
| Raster content | SVG text: `<image>`, `data:` URIs, `foreignObject`, filters, masks, patterns, clip paths, external references | fidelity bought with embedded pixels |
| Copied outlines | A filled outline (not a hole) in two different paths: same area (±3%) and box (±1 px), and every point of each within 0.5 px of the other | hidden duplicate objects |
| Self-intersections | Each outline flattened to steps of at most 0.05 upload px, tested for crossing edges | outlines a cutter or editor trips over |
| Tiny contours | Outlines under 4 px² that don't cross themselves (a crossing outline's lobes cancel in its area) | specks too small to see or cut |
| Paper shape | Opaque upload whose SVG has a near-white shape covering ≥ 97% of the canvas | a JPEG's paper that would print as white ink |

Two verdicts, each ready / check / not suitable: **visual** (does it show what the upload shows?) and
**geometry** (is it genuine, editable vector artwork?). The overall verdict is the worse of the two.
Every issue carries plain words and locations in upload pixels.

## Baseline (main @ 4926f81, default settings)

`bench/fidelity-baseline.json`: the 24 audit uploads (sources in
`docs/audits/2026-10-reconstruction/manifest.json`), traced as the app traces them, with the SVG's
SHA-256, every metric, and the visual review from the October 2026 audit.

Agreement with the visual review:

| Review \ visual verdict | ready | check | not suitable |
| --- | --- | --- | --- |
| Production-ready (11) | 11 | 0 | 0 |
| Needs review (3) | 2 | 1 | 0 |
| Not suitable (10) | 1 | 4 | 5 |

- No false alarms on the 11 images reviewed as production-ready.
- Missed by the visual verdict: Kubernetes (heptagon drawn as a circle, under a pixel), Docker
  (lettering distortion visible only at 4×) and the 96 px Python JPEG (eye shape, under a pixel).
  The geometry verdict still flags the last two (copied outlines; paper shape), so only Kubernetes
  is called ready overall.
- Severity is under-graded on three critical images (Firefox, Mexico, El Salvador: "check", not
  "not suitable"). They are never called ready.
- The geometry verdict flags three images that look right (Python, Angular, Fluent parrot): they
  do contain hidden duplicate outlines, which the visual review could not see.
- Measurement time: up to 0.75 s for a 600 × 450 upload in Chromium (target for in-app use: 0.3 s).

## Limits

- **Tiny lettering.** Lettering is judged as coloured shapes, not as text. Strokes of about 1 px
  are measured (the 1.2 px strokes in the tests), but in a JPEG under about 5 px cap height,
  compression noise and lettering can't be told apart, so loss there may be missed or over-counted.
  A letter that keeps its pixels but loses a sub-pixel crossbar or counter passes.
- **Complex gradients.** Gradients are judged only as colour error in locally smooth areas. A
  gradient replaced by a slightly different gradient may pass. Detail inside a gradient (a feather
  line, a facet edge between two similar reds) differs from its surroundings by less than ΔE 15,
  so it is not a feature and its loss is not counted.
- **Sub-pixel shape changes.** A raster comparison at the upload's size can't see changes smaller
  than a pixel: a 16–24 px heptagon drawn as a circle, a round 6 px eye drawn as a quadrilateral.
  **Known false negative:** the Kubernetes logo in the audit set (hub heptagon drawn as a circle,
  spoke corners rounded) is called ready by both verdicts. The tracer will have to report its own
  shape substitutions (PR 5).
- **Low-contrast edges.** Edges between colours of equal brightness are invisible to the Sobel
  edge measure.
- **JPEG noise** counts as difference against a clean vector. Compare results for the same upload,
  not scores across uploads.
- **Anti-aliased colours.** Colours that are a mix of two others (edge blends) are left out of the
  feature palette. A real ink that happens to be such a mix (a mid-blue between navy and white) is
  only found when it also appears away from those edges.
- **Renderer.** Node tests use a supersampling stand-in for the browser's renderer; thresholds
  were calibrated with Chromium.
- **One colour.** One-colour results recolour on purpose and are not yet measured in an
  ink-coverage mode; their geometry checks apply as they are.

## Reproducing the baseline

1. Fetch the uploads (`docs/audits/2026-10-reconstruction/tools/prep.mjs`, using the manifest) and
   serve them from the dev server, for example by linking the folder as `public/audit-in`.
2. `npx vite`, then open
   `/bench/fidelity.html?dir=/audit-in/&files=<comma-separated upload names>` (or pick the files).
   Rows appear as `window.__fidelity` when the status reads "Done".
3. Compare with `bench/fidelity-baseline.json`. The same SVG hashes mean the processing is unchanged.
