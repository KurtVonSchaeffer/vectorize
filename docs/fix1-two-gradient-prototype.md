# Fix 1 prototype: two gradients in one region

Branch `experiment/two-gradient-fit`, rebased onto main (`6d3849d`, which already includes fix 3 through #22). **A prototype for review only:** not merged, not deployed. Decision taken: **option A** (the seam check stays; strongly curved gradients aren't split).

## What it does
Two feathers whose gradients meet without a colour step join into one region. No single gradient explains that region, and colour steps can't split it, so it was traced as flat bands. For such a piece (at least 800 px, after the existing split has failed), the prototype:
1. **Fits two gradients.** It starts from three different splits, then repeatedly gives each pixel to the gradient that explains it better. The parts are smoothed so they stay whole shapes, and stray fragments flip to the other part.
2. **Keeps them only when all of these hold.** Otherwise the piece stays exactly as before.

| Check | Rule |
|---|---|
| One gradient isn't already faithful | single residual ≥ 3 (skips flat pieces and backgrounds) |
| Both parts pass the **existing** tolerances | residual ≤ 7, ≥ 85% explained, ≥ 400 px, not a staircase |
| Clearly better | combined residual ≤ 75% of the single gradient's |
| No fragments | each part's largest connected piece ≥ 90% of it |
| Seamless | along the shared edge, the jump between the two drawn gradients differs from the original's own jump by ≤ 6 (RMS over 8 px cells, unblurred) |

3. **Keeps thin tips.** A gradient also grows into the small pieces (under 400 px) that a split leaves over, ring by ring, where its colour matches within the existing edge tolerance. Without this, the new feathers lost their pointed tips. This also helps the existing one-gradient splits.

Nothing else changes: the tolerances and the 400 px minimum are untouched.

## Results against main (fix 3 included)

Re-measured after the rebase onto main: the results below are unchanged.

### Bird (stock image, investigation only)
| | Fix 3 | Prototype |
|---|---|---|
| Gradients | 9 | **11** |
| Colour error over the bird | 7.98 | **6.66** (−17%) |
| Colour error, whole logo | 9.63 | **8.45** |
| Artwork pixels lost / added | 2,203 / 198 | 2,107 / 221 |
| Dark slivers at 4× | 15 | **0** |
| Lettering tint | 0% | 0% |
| Paths | 204 | **195** |
| SVG | 116 KB | **107 KB** |
| Print PDF | valid, 9 shadings | valid, 11 shadings |
| Gradient detection time | 0.36 s | 0.40–0.46 s |
| Bird at 2× (1,480 px), full trace | 6.2 s, 940 paths | 6.5 s, **650 paths** |

With main's clean-geometry flag on (each shape drawn once), the bird goes from 56 to **43** paths and from 49.5 to **37 KB**, with the same colour gains.

The inner violet and dark-purple feathers become one radial and one linear gradient: residual 8.65 with one gradient, 1.61 with two, seam 3.5. Pictures: `10-fix1-bird.png`.

### Synthetic cases (PNG / JPEG 75 / JPEG 40)
| Artwork | Correct decision | Result | Colour error | Paths |
|---|---|---|---|---|
| Corner: two gradients meet seamlessly | split | split at all 3 | 7.9 → **0.9** / 7.7 → **1.1** / 7.7 → **1.9** | 3→3 / 4→5 / 3→6 |
| Corner: hues drift apart | split | split at all 3 | 12.4 → **0.7** / 6.6 → **0.9** / 8.9 → **1.6** | 2→3 / 6→4 / 3→3 |
| Half-ring curved gradient | keep one (already faithful) | **identical** | – | – |
| Three-quarter ring | judge | **rejected** (seam 9–12) | identical (PNG, JPEG 75); JPEG 40 10.0 → 9.7 | 29 → 42 at JPEG 40 |
| Overlapping feathers (3) | keep 3 | 3 kept; tips grown in | ink 0.05 → 0.02 at JPEG 40 | 4→3 / 4→4 / **16→4** |
| Single linear, multi-stop linear, radial disc, radial beside linear, stepped teal panels | no split | **identical, all 15** | – | – |

- All outputs that changed are valid SVG, and the print PDFs are well formed with one shading per gradient.
- Ink error rises slightly on the JPEG corner cases (0.09 → 0.19–0.21). The outer edge moves by a fraction of a pixel; it isn't visible at 2×. Pictures: `12-fix1-synthetic.png`.

### Benchmark and large images
- **83 benchmark uploads: all byte-identical** to fix 3. The only attempt (radial disc, JPEG 40) was rejected.
- **Barron, Bloom, Harbour, Kestrel, Summit at 2000 px:** identical output. Time +0–2% (Bloom 3.00 → 3.07 s).

## Curved gradients (decided: option A)
The three-quarter ring is **rejected** by the seam check. With the check off, it becomes two linear gradients:

| Three-quarter ring | Fix 3 / prototype | Two linear gradients (seam check off) |
|---|---|---|
| Colour error PNG / JPEG 75 / JPEG 40 | 9.8 / 10.0 / 9.7 | **7.6 / 7.5 / 7.2** |
| Paths | 11 / 13 / 42 | **3 / 3 / 7** |
| Look | 5–6 flat bands with visible steps | smooth, with **one faint straight seam** at the top |

It's clearly closer to the original and far simpler to edit, but it isn't seamless. Options:
- **A. Keep the check as it is: chosen.** Two gradients only where they're seamless.
- **B. Allow a visible seam when it replaces flat banding** (accept if the seam is smaller than the banding steps it removes). This is better for strongly curved gradients, but it's a judgement on taste.

## Known limitations
- At most two gradients per piece. Three feathers meeting without steps would need a third pass.
- Only linear and radial gradients. A conic (sweep) gradient would represent the ring exactly, but SVG/PDF support for conic fills is poor.
- The ring at JPEG 40: growing into leftovers adds paths (29 → 42) with slightly better colour. It's minor, but it is extra geometry.
- Prototype diagnostics remain in the code (`twoGradientLog`, a seam-check switch for pictures). They come out before any merge.
