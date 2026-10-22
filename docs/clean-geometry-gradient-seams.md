# Clean geometry: no layer shows between two gradients that meet exactly

Branch `experiment/clean-geometry-seams` (`257f1d5`), **stacked on fix 4** (PR #30, `experiment/gradient-pair-edges`). **Draft, for review: not merged, not deployed.**

## Dependencies
- **Needs fix 4 (PR #30).** The rule only acts at edge pixels shared by two gradients, and only fix 4 creates those (with clean geometry on). On main it changes nothing.
- **Needs clean geometry.** It only runs with `connectedStacking` (the `clean-geometry` flag, off by default; no flag changes here).
- **Neither change is meant to be enabled on its own.** Fix 4 without this leaves the pink hairline; this without fix 4 does nothing. Whether to enable clean geometry is a separate decision.

## The defect
On the bird with fix 4 and clean geometry, a thin pink line ran along the blue feather's edge with the navy band (8×, around 360, 326 and 340, 340).

**Diagnosis**, from a scan across the seam at 16× reading which paths cover each point:
1. The blue gradient shape ended at x ≈ 354.55.
2. The layers drawn *between* the navy band (bottom) and the blue feather (top) are a flat pink, a flat violet and two gradients. They reached 0.2–0.5 px further.
3. Clean geometry extends each of them under the blue feather because they touch it. Their outlines, traced and smoothed separately, ran along the feather's new exact edge. Browsers blend two anti-aliased edges in the same place, so the pink showed through.

The colour map there was correct: only the two gradients, with proper edge shares.

## The fix (`src/trace/index.ts`, layer membership)
With clean geometry, at an edge pixel shared by **two gradients, one above the layer and one below**, the layer's membership is 0. Its outline then stays inside the upper shape instead of running along the shared edge. Nothing else changes.

**Rejected along the way (measured):** pulling a layer back at *every* edge with something lower. It removed the hairline too, but:
- it reshaped boundaries (a lumpy outer edge on the violet band, a white speck, a reshaped white wedge);
- it more than doubled the bird's SVG (43.5 → 106 KB).

## Measured (clean geometry on): main / fix 4 (PR #30) / fix 4 + this

**Bird**

| | Main | Fix 4 | Fix 4 + seam rule |
|---|---|---|---|
| Gradient ↔ gradient edges | 13.04 | 11.28 | **10.02** |
| Gradient ↔ background | 24.03 | 23.87 | 24.26 |
| Gradient ↔ flat | 9.61 | 8.95 | 9.02 |
| Overall colour | 9.69 | 9.57 | 9.55 |
| Lighter than the original nearby (px at 4×) | 10,648 | 10,812 | **10,650** |
| Darker than the original nearby (px at 4×) | 5,831 | 6,252 | **5,928** |
| Dark slivers | 0 | 0 | 0 |
| Paths / SVG | 56 / 49.5 KB | 52 / 43.5 KB | 52 / 48.0 KB |
| SVG, print PDF (shadings) | valid (9) | valid (9) | valid (9) |
| Trace time | 0.99 s | 0.98 s | 0.99 s |

Pictures: `15-seam-bird-8x.png`, with the original, main, fix 4 and fix 4 plus this rule at 8× and native size.
- The pink hairline is gone at both spots.
- The violet/blue band edge, the dark feather and the orange feather are the same as fix 4.
- A very faint line at one pink/crimson junction is present in fix 4 and in this version.

**Synthetic cases** (gradient ↔ gradient / gradient ↔ background):

| Case | Main | Fix 4 | Fix 4 + this |
|---|---|---|---|
| Overlapping feathers PNG | 6.98 / 12.29 | 5.06 / 11.26 | **4.96 / 10.95** |
| Feathers JPEG 75 | 23.05 / 21.18 | 22.97 / 21.04 | 22.97 / 21.28 |
| Feathers JPEG 40 | 23.42 / 21.29 | 20.40 / 20.99 | 20.40 / **22.46** |
| Radial beside linear, all qualities | | | identical to fix 4 |
| Thin-ring disc, all qualities | | | identical to fix 4 |

**Feathers JPEG 40, gradient ↔ background +5.5%:** at 8×, at the two spots with the most changed pixels (`17-seam-feathers-q40-8x.png`), the three versions look the same. The change is sub-pixel shifts along an edge already damaged by compression. It's recorded here, not hidden.

**83 benchmark uploads:**
- **Default settings:** 83 byte-identical to main.
- **Clean geometry on:** 81 identical. The two that differ are the thin-ring JPEGs, the same as fix 4 (equal or slightly better colour, same paths).

**Tests:** a new tracer test (`gradient-seams.test.ts`). In a colour map where two gradients share an edge pixel and a flat layer is stacked between them, the flat layer's outline must stay at least 0.5 px inside the upper gradient's.
- Without the rule it sits on the edge (−0.01 px).
- With it, 0.65 px inside.
- A browser-blending check isn't possible in the test renderer, so the test checks the geometry, which is the cause.

Type check, **393 tests** and build pass. No benchmark or threshold was changed.

## Remaining
- Background edges on the feathers JPEG 40: +5.5% by the metric, not visible at 8×.
- The faint pink/crimson junction line on the bird, also present in fix 4.
