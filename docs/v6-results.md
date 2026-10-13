# V6 results: measured quality improvements

Measured with `bench/diagnose.html` against the pre-V6 baseline (commit `6020179`). Each case is drawn from a ground-truth SVG, saved as PNG, JPEG 75 and JPEG 40, vectorized with the app's automatic settings, and compared with the truth at 4× (½ px tolerance).

- **Missing / extra**: the share of the artwork's ink the output doesn't show, or adds.
- **Edge F1**: edge agreement (1 = perfect).
- **Merged / ΔE**: colour fidelity, from the new `colourFidelity` metric.

The other benchmark suites are reported below. Reproduce with `/bench/diagnose.html`; its `__save()` and `__diff()` page functions compare runs.

## 1. Artwork classification (largest gain)

**Cause:** line art was chosen when ≥ 95% of all pixels were greyish, background included. Colour logos on light backgrounds, and dark-neutral palettes, were reduced to black ink.

**Fix (`src/vectorize/detect.ts`):** judge the ink only, meaning pixels clearly unlike the paper. Line art now requires neutral ink (Lab chroma < 10) that varies in tone like a scan, or that is already near-black (L\* ≤ 20). Flat digital art in one uniform tinted or grey colour stays flat colour, which keeps that exact colour.

| Case | Missing | Extra | ΔE |
|---|---|---|---|
| Badge, clean PNG, 600 px | 95.1% → **0.13%** | 95.7% → **0.11%** | 9.3 → 0 |
| Badge, clean PNG, 300 px | 89.1% → **0.61%** | 90.8% → 0.33% | 8.9 → 0 |
| Badge, clean PNG, 200 px | 92.3% → **6.3%** | 92.0% → 0.89% | 8.5 → 0.06 |
| 2 px strokes, PNG | 47.8% → **0.26%** | 82.3% → 0.83% | |
| 3 px strokes, PNG | 67.5% → **0.12%** | 90.7% → 0.39% | |

The pencil-sketch scan and black-ink cases are still line art (conditions suite 20/20, unit tests).

## 2. Small detail: letter counters, full stops, dots

**Cause:** regions under the speck size (16 px² at the default Detail) were merged away by size alone, in the colour map and again by the tracer.

**Fix (`src/palette/quantize.ts`, `src/trace/index.ts`, `src/vectorize/pipeline.ts`):**
- A small region is kept when it's enclosed by one colour, contrasts clearly with it, and is solid somewhere (`isDetail`). Compression smudges are half-blends sitting on boundaries, and are still removed.
- The tracer keeps small outlines only if they contain a real pixel of their colour (`realDetail`). That also stops slivers where print plates meet.

Small typography, JPEG 75 (the "before" is the original automatic result; much of it was the line-art error in finding 1):

| Text (cap height) | Missing | Extra | Edge F1 |
|---|---|---|---|
| Sans 6 px | 55.1% → **25.7%** | 64.3% → 5.8% | 0.77 → 0.87 |
| Sans 8 px | 56.3% → **13.0%** | 84.4% → 5.8% | 0.85 → 0.91 |
| Sans 10 px | 53.1% → **3.2%** | 86.3% → 2.8% | 0.89 → 0.96 |
| Sans 12 px | 50.2% → **1.9%** | 84.4% → 1.9% | 0.96 → 0.98 |
| Serif 8 px | 72.7% → **23.8%** | 39.6% → 2.7% | 0.51 → 0.85 |
| Serif 12 px | 37.2% → **7.6%** | 67.0% → 1.7% | 0.92 → 0.95 |

Against the forced-flat baseline (which isolates fixes 2–4 from fix 1): sans 10 px 18.3% → 3.2%, sans 12 px 12.3% → 1.9%, serif 8 px 71.9% → 23.8%, serif 12 px 31.7% → 7.6%.

| Dots, r 1–5 px | Missing | Extra |
|---|---|---|
| PNG | 18.4% → **3.5%** | 6.9% → 0.7% |
| JPEG 75 | 17.9% → **0.4%** | 6.7% → 0% |
| JPEG 40 | 18.7% → 12.1% | 7.9% → 4.9% |

At JPEG 40 the two smallest dots are destroyed by the compression, and they aren't invented.

No added noise at JPEG 40: the gradient pill stays at 2 colours and 82 segments, and the scene at 8 colours and 1,062 segments.

## 3. Thin strokes

**Cause:** the tracer blurs each colour (σ 0.7) and outlines it at 0.5. A stroke of 1 px or less peaks below 0.5 after blurring and vanished.

**Fix (`keepThin` in `src/trace/index.ts`):** a blurred stroke of width *a* peaks at height *P*, and the outline level that redraws it at width *a* is ½·erf(2·erfinv(*P*)), whatever the blur. Near thin ridges (and, mirrored, thin gaps) the field is shifted to that level. Wide shapes (P ≈ 1) are unchanged. Very faint ridges, and ridges without clean surroundings (JPEG plateaus), are left alone.

| Strokes | Missing | Extra | Edge F1 |
|---|---|---|---|
| 1 px, PNG | 89.1% → **9.5%** | 0.1% → 18.7% | 0 → 0.95 |
| 1 px, JPEG 75 | 89.1% → **7.0%** | 0.1% → 0.7% | 0 → 0.96 |
| 1 px, JPEG 40 | 51.4% → **2.2%** | 1.6% → 0.6% | 0.55 → 0.99 |
| 0.75 px, PNG | 87.8% → 54.1% | 0% → 0.3% | 0 → 0.97 |

**Fitting bug found and fixed along the way (`src/trace/fit.ts`):** short runs could solve to Bézier handles over 300 px long, which drew long stray strokes. Handles are now limited to the length of the outline they describe. There's a regression test using the real outline that triggered it.

## 4. Image-specific detail settings

After fixes 1–3, a sweep showed the default Detail is close to the best setting for most images. Raising it overall hurts large artwork (600 px badge: 0.3 → 1.2 points, with 6× the segments) and adds JPEG noise colours. Two specific settings help specific images:

- **Fine-stroke artwork** (≥ 85% of the ink in strokes under 2 px): tighter curve fitting.
- **Tiny images** (≤ 160 px): a smaller speck size.

`detailBoost` (`src/vectorize/client.ts`) adds those on top of the slider. Colour merging is never changed automatically. The slider still controls every setting, and the interface is unchanged.

| Case | Missing, before → after this step |
|---|---|
| Badge 120 px, PNG | 16.1% → **10.4%** |
| Badge 120 px, JPEG 75 | 14.9% → **11.2%** |
| Badge 120 px, JPEG 40 | 22.5% → 22.5% (unchanged; the first version, which moved Detail as a whole, made this worse) |
| 1 px strokes, JPEG 75 | 9.0% → 7.0% |
| Serif 12 px, JPEG 75 | 8.5% → 7.6% |

All other cases are unchanged.

## 5. Colour fidelity (brand tints)

**New metric:** `colourFidelity` in `src/quality/compare.ts` reports ΔE2000 per reference colour, and how many noticeably different pairs were merged.

**Cause:** clusters closer than the merge threshold (ΔE 10) were always merged.

**Fix (`separateRegions` in `src/palette/quantize.ts`):** similar clusters stay apart only when all of these hold:
- They're noticeably different: ΔE ≥ 2 for exact (lossless) colours, ≥ 5 for JPEG colours, which compression shifts by up to about 3–4.
- Each forms its own solid region, not pixels mixed together by noise and not a fringe.
- They meet at a sharp edge in proportion to their difference, not a gradual shade, and with nothing else lying between them.

| Similar colours side by side | Merged pairs | ΔE | Colours |
|---|---|---|---|
| PNG | 2 → **0** | 1.27 → **0** | 4 → 6 (all) |
| JPEG 75 | 1 → **0** | 1.01 → 0.23 | 4 → 5 |
| JPEG 40 | 2 → 1 | 1.65 → 0.84 | 4 → 5 |

The conditions suite's gradient logo now keeps its white lettering separate from the cream background (error 2.0 → 1.6).

## Unchanged areas

Corners and curves (0.03% missing), gradients, transparent PNGs and the complex scene are unchanged or slightly better. For example, the radial gradient at JPEG 40 went from 1.3% to 0.4% missing.

## Other suites

- **Unit tests:** 131 → 150 passing. All 4 known-issue tests now pass as regular regression tests.
- **Production build:** passes.
- **Conditions suite** (20 inputs, every SVG/PDF/DXF download validated): 20/20.
- **Artwork benchmark** (mean error, before V6 → after):

  | Output | Mean error | Segments |
  |---|---|---|
  | Logo | 0.17 → 0.17 | |
  | Badge web | 1.25 → 1.24 | |
  | Badge print | 1.28 → 1.28 | 495 → 503 |
  | Scene web | 1.03 → 1.02 | |
  | Ink | 16.24 → 16.24 | |

  The ink case is still line art (black ink), and its error is the dropped paper colour, as before.
- **App check:** the example badge traces with 3 colours, rebuilt lettering, matched brand colours and exact shapes, with no console errors.
- **Processing time** (`runFlat`, best of 12 runs, noisy 3-colour badge):

  | Size | Before | After |
  |---|---|---|
  | 600×400 | 117 ms | 131 ms (+11%) |
  | 1200×800 | 417 ms | 511 ms (+22%) |
  | 2000×1333 | 1,125 ms | 1,414 ms (+26%) |

## Segment counts

Segment counts rise where detail is now kept:

| Case | Segments |
|---|---|
| Sans 10 px, JPEG 75 | 70 → 118 |
| Serif 12 px, JPEG 75 | 99 → 167 |
| 1 px strokes | 3 → 114 |
| Badge 120 px | 61 → 188 |
| Badge 600 px, PNG (now flat instead of line art) | 94 → 283 |
| Large JPEG artwork (badge 600 px, scene) | within ±2% |

## Remaining issues

- **Strokes under 1 px:** the geometry is recovered (F1 0.97), but in a lighter blend colour when the image has no solid pixel of the true colour. That's an information limit. PNG hairlines exactly on a half-pixel come out about 25% wider in that lighter colour.
- **The smallest text** (6 px sans 26% missing, 8 px serif 24%) is near the resolution limit. The existing font-matching lettering rebuild is the route to exact letters.
- **Tiny images saved as heavy JPEGs** (120 px at quality 40: 22.5% missing): the detail isn't in the input.
- **Similar tints:** tints that don't touch still merge, because there's no reliable way to tell them from pieces of one gradient. JPEG tints under ΔE 5 merge.
- **Speed:** processing is 11–26% slower.
- **No real customer logos tested yet.** All cases are synthetic, rendered from SVG with system Arial and Georgia.
