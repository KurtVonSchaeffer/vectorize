# Fix 4: sharper edges where two gradients meet

Branch `experiment/gradient-pair-edges`, on main (`6d3849d`, fix 3 included). **Draft, for review: not merged, not deployed.** Separate from the two-gradient prototype (`experiment/two-gradient-fit`). Final commit measured: `690177d`.

## Requires clean geometry: don't enable it on its own
This change only takes effect when **clean geometry** is on (`connectedStacking`, behind the `clean-geometry` flag, off by default). With clean geometry off, the output is byte-identical to main.

- **Must not be enabled independently** under the current implementation. In the ordinary stacked layout, a layer also extends under smaller shapes drawn above it (the lettering's black under small feathers). Exact edges between two gradients leave hairlines where that layer shows through: on the bird, dark pixels went 15 → 134 when this was tried without clean geometry.
- **Flags:** clean geometry and fine detail stay off in production. The Vercel project has no environment variables, so both are off in production and preview builds. This PR doesn't change any flag or default.
- **Separate decision:** whether to make clean geometry the default is a decision of its own, on its own evidence. This PR doesn't make it.

## The change
Edge pixels already get a sub-pixel position where a gradient meets a flat colour. Where two gradients meet, they didn't. With clean geometry on:
- A **gradient** edge pixel pairs with the neighbouring colour whose mix best explains it: a flat colour, or a gradient it touches.
- A **flat** edge pixel pairs exactly as before, with the nearest gradient. The colour stage sometimes reads the blend between two gradients as a 1 px line of a flat colour; pairing those pixels any other way kept the line and doubled it (dark-purple streaks on the bird, found in the final 8× check and fixed in `690177d`).
- Two gradients pair only where they touch, so a thin line between them, such as a ring around a disc, keeps them apart.

## Final measurements (`690177d`, clean geometry on, against main with clean geometry on)
Errors are mean colour differences from the upload, in pixels next to each kind of edge, measured separately.

| Upload | Gradient ↔ gradient | Gradient ↔ background | Gradient ↔ flat | Overall colour | Paths |
|---|---|---|---|---|---|
| Bird | 13.04 → **11.28** (−13%) | 24.03 → **23.87** | 9.61 → **8.95** | 9.69 → **9.57** | 56 → **52** |
| Overlapping feathers PNG | 6.98 → **5.06** | 12.29 → **11.26** | 0.98 → 0.91 | 1.39 → 1.29 | 4 → 4 |
| Feathers JPEG 75 | 23.05 → 22.97 | 21.18 → 21.04 | 8.33 → 8.27 | 4.66 → 4.64 | 4 → 4 |
| Feathers JPEG 40 | 23.42 → **20.40** | 21.29 → 20.99 | 8.88 → 8.88 | 5.64 → 5.62 | 10 → 10 |
| Radial beside linear PNG | 21.2 → **8.44** | 3.70 → **2.97** | 1.94 → 1.94 | 0.89 → 0.80 | 3 → 3 |
| Radial beside linear JPEG 75 | 25.9 → **16.5** | 13.88 → 13.40 | 11.64 → 11.74 | 2.55 → 2.51 | 3 → 3 |
| Radial beside linear JPEG 40 | unchanged | 20.79 → 20.73 | 12.89 → 12.93 | 3.39 → 3.38 | 3 → 3 |

**Bird, artefacts (pixels at 4×, bird area):**

| | Main | Fix 4 |
|---|---|---|
| Dark slivers (near-black) | 0 | **0** |
| Lighter than anything in the original nearby | 10,648 | 10,812 (+1.5%) |
| Darker than anything in the original nearby | 5,831 | 6,252 (+7.2%) |

**8× comparisons:** `13-fix4-690177d-8x.png`, at the four spots with the most new out-of-range pixels in the earlier run. The panel is labelled "4f1dc3b", but it shows `690177d`.
- The edge between the violet and blue bands is cleaner and straighter than main's.
- The orange feather's purple fringe is smaller.
- The two bands and the dark feather are unchanged.

## Known issue, blocking before release
**A pink hairline along the blue feather's right edge** (bird, around 360, 320; row 4 of the 8× image). It's shorter than in the first version, but main doesn't have it.

- **The colour map there is correct:** only the two gradients, with proper edge shares. The hairline comes from the tracer. Where two gradient shapes now meet exactly, the anti-aliased edges let a touching pink layer underneath show through.
- **It accounts for most of the +7% darker-than-original pixels.**
- **Fixing it means changing the tracer:** at a shared edge between two gradients, the lower shape should run slightly under the upper one. That's a change to the drawing stage, not part of this PR.

## Radial disc with a thin ring
The extra path seen earlier (an additional piece of the outer gradient at the ring's inner edge) came from the flat-pixel pairing and is **gone** in `690177d`.

| Version | Result |
|---|---|
| PNG | byte-identical to main (3 paths) |
| JPEG 75 | same paths and colour (3.97); edge band 27.34 → 27.71 |
| JPEG 40 | same paths; colour 4.74 → 4.69 |

Exports, checked for main and fix 4:
- **SVG:** valid, every gradient reference resolves.
- **Print PDF:** well formed, one shading per gradient.
- **Knockout plates:** identical for the PNG; the same path counts for the JPEGs.
- **Cut DXF:** valid, the same number of outlines as main (7 and 13).

## Benchmark and tests (`690177d`)
- **83 uploads, default settings:** 83 byte-identical to main.
- **83 uploads, clean geometry on:** 81 identical. The other two are the ring JPEGs above.
- **New test** (two gradient feathers and black bars): with clean geometry the shared edge is at least 20% closer to the upload than main's, with no dark pixel between the feathers. It fails on main.
- Type check, **392 tests** and build pass.

## Before any release
1. Fix the pink hairline in the tracer (lower shape runs under the upper one at gradient-to-gradient edges), then re-run these measurements.
2. Decide on clean geometry separately; this fix rides on it.
3. Re-run the full benchmark and the 8× checks on the combined final state.
