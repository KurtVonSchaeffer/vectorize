# V6 diagnosis: where vector quality is lost

Measured with `bench/diagnose.html` (dev server), using the V5 comparison module. Each test case isolates one kind of detail and is drawn from a ground-truth SVG. The output is measured against that truth at three stages:

- **input**: the raster the tracer receives (loss from JPEG and downscaling).
- **colour map**: the cleaned map just before tracing (loss from colour segmentation).
- **vector**: the final SVG, at the working size and at 4×.

"Missing" is the share of the artwork's ink (pixels unlike the background) that the output doesn't show within ½ px at 4×. "Extra" is the share it adds.

Reproduce:

| What | URL (append to the dev server origin) |
|---|---|
| All cases, automatic settings | `/bench/diagnose.html` |
| Artwork type forced to flat colour | `/bench/diagnose.html?style=flat` |
| Detail × Corners sweep | `/bench/diagnose.html?style=flat&sweep=1&cases=text,lines,dots,lowres` |
| One setting changed at a time | `/bench/diagnose.html?style=flat&ablate=1` |
| Heavy JPEG (quality 40) | add `&q=0.4` |

Unit-level reproductions were in `src/vectorize/__tests__/known-issues.test.ts` (as `it.fails`). Each became a regular regression test when its fix landed. See [v6-results.md](v6-results.md) for what was fixed and the measured results.

## Findings, by impact

### 1. Colour artwork is misread as line art (largest single loss)

`detectArt` picks line art when ≥ 95% of sampled pixels have a channel spread under 28. The background counts toward that share, so two kinds of colour artwork qualify:

- **A light background with less than about 5% coloured ink**: navy text, thin coloured rules.
- **A dark neutral main colour**: the benchmark badge's navy `#2b2d42` has a spread of 23, and its orange covers under 5%.

Line art is reduced to black ink on paper, so accent colours vanish and navy turns black. Automatic lettering rebuild is also switched off for line art.

| Case | Auto (line art) | Forced flat |
|---|---|---|
| Badge, clean PNG, 600 px | 95% missing, 2 colours | 0.3% missing, 3 colours |
| Badge, clean PNG, 300 px | 89% missing | 1.1% missing |
| Navy text, 12 px caps | 50% missing (colour wrong) | 12% missing |

The JPEG version of the same badge was classified correctly, because compression noise pushes it just over the threshold. The result is fragile either way.

### 2. The speck filter removes real small detail

At the default Detail (0.5), regions under 16 px² are merged away, in the colour map and again in the tracer. That fills letter counters (e, a, o) and removes full stops, i-dots and small dots.

| Case (JPEG 75) | Default | Speck 1 px² only |
|---|---|---|
| Sans text, 10 px caps | 18% missing | 3.8% |
| Sans text, 12 px caps | 12% | 1.9% |
| Serif text, 8 px caps | 72% | 30% |
| Dots, r 1–5 px | 18% | 3% |
| Badge, 120 px wide | 25% | 11% |

At JPEG quality 40, removing the filter still improves accuracy, and visible artefacts don't increase. But noise then survives as extra colours and paths: the gradient pill goes from 83 to 401 segments and from 2 to 4 colours. So the filter is needed; the problem is that it judges by size alone.

### 3. Edge smoothing erases strokes of 1 px or less

The colour map is blurred (σ = 0.7 at the default Corners, 0.75) and contoured at 0.5. A 1 px line split across two pixel rows peaks below 0.5 after blurring, so it disappears. The colour map keeps 75% of such lines; the vector keeps 11–16%. No Detail setting fixes this.

| 1 px strokes | Missing |
|---|---|
| Default | 89% |
| Smoothing 0.5 | 51% |
| Smoothing 0.5 + speck 1 | 11% |
| 1.5 px strokes and wider, default | under 0.5% |

### 4. One Detail setting doesn't fit all images

Raising Detail to 0.75–1 cuts small-text and low-resolution loss three to eight times. Large, clean artwork gains nothing, and some cases get worse: 3 px strokes at Detail 1 go from 0.5% to 13% error, and the 200 px badge goes from 135 to 1,132 segments. Lowering Corners to 0.25 (more smoothing) was worse in every case.

### 5. Similar brand tints are merged

Colour merge (ΔE 10 at the default Detail) joined two blues and two reds that differ by about ΔE 3–10. Lowering the merge globally to 4 is harmful: anti-aliased edges become an extra colour, and 10 px text goes from 18% to 72% missing.

The V5 "wrong" share doesn't see this, because the tints differ by less than its threshold of 48. Only the mean error shows it (2.9). A palette-fidelity metric is needed.

### Not where quality is lost

- **Corners and curve fitting**: 0.03% missing, edge F1 0.996. Tightening curve tolerance from 0.5 to 0.1 gave no accuracy gain and 2–5× the segments. Leave the Bézier fitting alone.
- **Gradients**: 0.2–0.9% missing.
- **Transparent PNG edges**: same accuracy as on white (0% missing). The suspicion about `binarizeAlpha` was not confirmed.
- **Path count**: one path per colour already. Segment counts track detail; there's no evidence of bloat at the default settings.
- **Below about 150 px wide**: the input itself no longer holds the detail (the badge text is about 4 px tall). Tracing can't recover it. The existing lettering rebuild and AI sharpening are the right tools.

## Proposed V6 plan (in order)

Each step is measured against this baseline with `bench/diagnose.html`, `bench/index.html`, `bench/conditions.html` and the real-logo set. A step ships only if it improves its target cases without regressing the others, including segment and colour counts at JPEG quality 40.

1. **Fix line-art detection.** Judge "grey ink" on the ink pixels only, excluding the background colour. Choose line art only when the ink itself is neutral.
   - Target: the badge and navy-text cases match the forced-flat numbers, and the pencil sketch case stays line art.
   - Flips 2 known-issue tests. Small change, low risk, largest gain.
2. **Make speck removal tell detail from noise.** Keep small regions that are enclosed holes of a main colour (letter counters), or compact, high-contrast regions away from edges (dots, full stops). Keep removing low-contrast blobs and blobs on edges (JPEG ringing).
   - Target: 10–12 px text from 12–18% to under 5% missing, dots under 5%.
   - Guard: no increase in colours or segments at JPEG quality 40. Flips 1 known-issue test.
3. **Preserve thin strokes while smoothing.** Lower the blur where a colour region is under about 2 px wide, or contour such regions from the unblurred coverage.
   - Target: 1 px strokes from 89% to under 15% missing. Corners, curves and segment counts unchanged. Flips 1 known-issue test.
4. **Image-specific detail.** After steps 2–3, re-run the sweep. If the best setting still varies by image, set the effective detail from the measured smallest feature size (stroke width or text height from the colour map), and keep the slider as a relative adjustment.
5. **Keep distinct brand tints.** Merge similar clusters based on where their pixels lie: a colour that forms large solid areas stays, a colour that's mostly edge fringe merges. Don't decide on ΔE alone.
   - Add a palette-fidelity metric (ΔE between truth and output colours) to `src/quality/compare.ts` first, so this can be measured.
6. **Real-logo benchmark (in parallel; needs 20–50 customer logos).** Score each against its own raster with `compareSvg` (no ground truth needed), and against the original vector wherever the customer has one.

Not recommended: tighter curve tolerance, changes to Bézier fitting or corner handling, or path-merging work. The data shows no loss there.
