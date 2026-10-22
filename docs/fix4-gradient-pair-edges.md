# Fix 4: sharper edges where two gradients meet

Branch `experiment/gradient-pair-edges`, on main (`6d3849d`, fix 3 included). **For review: not merged, not deployed.** Independent of the two-gradient prototype (`experiment/two-gradient-fit`).

## The change
Edge pixels already get a sub-pixel position where a gradient meets a flat colour. Where **two gradients** meet, they didn't, so those edges were drawn to the nearest whole pixel and looked rougher.

**With clean geometry on**, edges between two gradients now get the same treatment. Each edge pixel pairs with whichever neighbouring colour best explains it (the closest mix), and two gradients pair only where they touch. **With clean geometry off (the default), nothing changes.**

## Why only with clean geometry
The first measurement, with the change everywhere, brought the bird's dark slivers back: 15 → 100 (nearest neighbour) or 134 (best-explaining neighbour).

- **Cause:** in the ordinary stacked layout, a layer also extends under every smaller shape drawn above it. Here, the lettering's black extends under the small feathers. Exact edges between two gradients leave hairline gaps, and the black shows through. Removing the black layer took the dark pixels from 100 to 0.
- **Clean geometry** draws no layer under shapes it doesn't touch, so nothing shows: 0 dark pixels in every variant.

## Measured (clean geometry on, against main with clean geometry on)
Errors are mean colour differences from the upload, in pixels next to each kind of edge, measured separately.

| Upload | Gradient ↔ gradient | Gradient ↔ background | Gradient ↔ flat | Overall colour | Paths | Dark slivers |
|---|---|---|---|---|---|---|
| Bird | 13.04 → **10.24** (−21%) | 24.03 → **23.57** | 9.61 → **9.06** | 9.69 → **9.53** | 56 → 56 | 0 → 0 |
| Overlapping feathers PNG | 6.98 → **5.12** | 12.29 → **11.31** | 0.98 → 0.87 | 1.39 → 1.31 | 4 → 4 | – |
| Feathers JPEG 75 | 23.05 → 23.00 | 21.18 → 21.34 | 8.33 → 8.30 | 4.66 → 4.64 | 4 → 4 | – |
| Feathers JPEG 40 | 23.42 → **21.38** | 21.29 → 21.48 | 8.88 → 8.86 | 5.64 → 5.68 | 10 → 10 | – |
| Radial beside linear PNG | 21.2 → **8.44** | 3.70 → **2.97** | 1.94 → 1.94 | 0.89 → 0.80 | 3 → 3 | – |
| Radial beside linear JPEG 75 | 25.9 → **16.5** | 13.88 → 13.59 | 11.64 → 11.75 | 2.55 → 2.52 | 3 → 3 | – |
| Radial beside linear JPEG 40 | unchanged | 20.79 → 20.68 | 12.89 → 12.92 | 3.39 → 3.38 | 3 → 3 | – |

**Light or dark pixels outside the original's local range at 4× (seams):** these were measured on the bird with an earlier version (best-explaining neighbour, without the touch rule), and were +2% light and +6% dark. The 8× pictures (`13-fix4-gradient-edges-8x.png`) show cleaner, straighter edges between gradients and no new seams. The touch rule was added afterwards for the ring case; the bird's band errors and dark-sliver count were re-measured with it, but this seam count and the 8× pictures weren't redone.

**83 benchmark uploads:**
- **Default settings:** all byte-identical to main.
- **Clean geometry on:** 80 identical. The three that differ are the radial disc with a thin ring:
  - PNG: colour 1.26 → 1.32, and one more path (3 → 4). It looks identical at 6× (`14-fix4-ring.png`).
  - JPEG 75: equal.
  - JPEG 40: slightly better (4.74 → 4.69).

Gradient-pill and small-gradient-logo cases are unchanged; they have no edges between two gradients.

**Tests:** a new test with two gradient feathers and black bars checks two things. With clean geometry, the shared edge is at least 20% closer to the upload than main's, and no dark pixel appears between the feathers. It fails on main (2.17 against a limit of 1.74). Type check, all 392 tests and the build pass.

## Trade-offs
- It only helps where clean geometry is on, which is still behind a flag. If clean geometry becomes the default, this comes with it.
- On the thin-ring disc, one extra path appears with no visible difference.
- Background edges on the compressed feathers are slightly worse (+0.7% / +0.9%), within noise.
