# Reconstruction root-cause investigation (main @ 4926f81, October 2026)

Evidence behind the root-cause report (defects RC1–RC11) and the regression suite in
`src/vectorize/__tests__/fidelity/`. Nothing here is built or shipped.

## Contents

- `instrumentation.patch`: no-op hooks in `palette/quantize.ts`, `palette/gradients.ts` and
  `trace/index.ts`. They call `globalThis.__audit` when it is set and do nothing otherwise. With the hooks
  applied, all 22 flat audit images reproduced the production download geometry exactly. Apply the patch only
  in a scratch worktree; it is not meant for main.
- `bench/audit-probe.*`: runs the production flat job for one upload with the hooks on. It renders each stage
  for a crop (upload, k-means, majority filter, final map, layer mask, blurred outline, shape decision, SVG,
  corners, gradient regions). With `analyse=1` it attributes every stretch of pixel outline, and every
  corner, to the stage that lost it.
- `bench/audit-stages.*`: captures input, colour map and SVG per upload and settings variant.
- `tools/`: drivers (Playwright and Chromium) and independent checkers. `probe.mjs` and `expcmp.mjs` produced
  the stage attribution and the settings experiment; `svgcheck.py` and `prodcheck.py` check SVG, PDF and DXF
  output without using Vectorize code.
- `manifest.json`: the 24 audit uploads with their public source URLs and reference renders. The images
  themselves are third-party logos and flags, so they are not committed; `tools/prep.mjs` rebuilds the set
  from the sources.
- `results/`: stage attribution per image (`attribution.json`, at 1 px and at 0.5 px), the settings
  experiment (`expcmp.json`), and quantiser and gradient-finder stats for the gradient images.

## Reproducing

1. Check out 4926f81 in a scratch worktree, apply `instrumentation.patch`, copy `bench/` into it, and put the
   uploads under `public/audit-in/`.
2. Start `npx vite` there, then run `node tools/probe.mjs <audit dir> <port> <spec.json>`, using the spec
   files in `results/` as examples.

Not covered: the AI sharpener (its model host was unreachable during the audit) and CorelDRAW import (no
CorelDRAW available).
