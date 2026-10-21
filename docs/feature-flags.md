# Feature flags and how they depend on each other

Unfinished features are off for everyone unless a build switches them on (`src/quality/flags.ts`).
For a feature with environment variable `VITE_X` and address parameter `x`:

| `VITE_X` | Effect |
| --- | --- |
| unset (production today) | Off. `?x=on` in the address is ignored. |
| `preview` | Off unless the address has `?x=on`. Set it only for Vercel's Preview environment. |
| `on` | On for everyone using that build: a release decision. |

The local dev server (`npm run dev`) also honours `?x=on`.

## Current state (main @ 6d3849d)

| Flag | Variable | Production | What it changes | Doc |
| --- | --- | --- | --- | --- |
| `quality-reporting` | `VITE_QUALITY_REPORTING` | off | Result card: created / checked / reviewed | docs/fidelity-measurement.md |
| `print-files` | `VITE_PRINT_FILES` | off | Print and cut files traced as their own plates; paper is not a white-ink plate; one physical size | docs/print-files.md |
| `clean-geometry` | `VITE_CLEAN_GEOMETRY` | off | Master SVG: no shape drawn twice | docs/clean-geometry.md |
| `fine-detail` | `VITE_FINE_DETAIL` | off | Master SVG: thin lines at their real width and length, only where measurably better | docs/fine-detail.md |
| `colour-accuracy` | `VITE_COLOUR_ACCURACY` | off (draft) | Master SVG: thin lines and lettering keep their own colour, only where they trace better | docs/colour-accuracy.md |

Verified after merging #28: production builds of main @ 7eac2d1 and @ 6d3849d, opened with all four
parameters in the address, show no flagged interface and make byte-identical downloads (print PDF
and SVG, cut SVG and DXF, web SVG and PNG) for docker, El Salvador, Brazil, Mexico, Linux, Firefox,
python-tiny and a synthetic hairline image, in full colour, and in One colour for four of them.

## Dependencies

### `fine-detail` needs `print-files` (revisit before public release)

Fine detail changes the master artwork only. Print plates and cut files must stay exactly as they
are: in knockout output the thin-line changes opened hairline gaps between plates and added
crossings, and plates must tile.

- **With `print-files` on**, the print and cut files are traced separately as knockout plates,
  so fine detail reaches the master (web SVG and PNG) and nothing else.
- **With `print-files` off**, the app downloads the master itself as the print SVG and the cut
  SVG. Fine detail would change those files too, so `src/App.tsx` passes `fineDetail` only when
  both flags are on: `fine-detail` alone does nothing.

Before either is released, decide one of:

1. Release `print-files` first (or together with `fine-detail`). Simplest: the dependency then
   costs nothing.
2. Without `print-files`, trace the print and cut SVGs separately from the master (as
   `print-files` does) so the master can differ from them; this costs a second trace per download.
3. Accept fine detail in the master-based print and cut SVGs, after a print and cut check of its
   own (gaps, crossings, cut paths) on the audit set.

### `colour-accuracy` needs `print-files` too

For the same reason: it changes the master only, and without print files the print and cut SVGs
are the master (`src/App.tsx`). Revisit together with `fine-detail`.

### `clean-geometry` and `fine-detail`

Independent: each can be on without the other, and with both on they compose (fine detail decides
which outlines a colour has; clean geometry then drops hidden copies among them). The benchmarks in
docs/fine-detail.md were run with `clean-geometry` off.

### One colour, spot inks, photos

No reconstruction flag changes One colour, spot-ink output or photos (VTracer): their jobs never
receive the options (`buildTraceJob` in `src/vectorize/pipeline.ts`).

## Baselines

`bench/reconstruction-baseline.json`: per audit upload, production and fine-detail measurements
from `bench/compare.html` at the commit merged as #28, master and print plates. The next
reconstruction phase is measured against it: production numbers must match it exactly (anything
else is an unintended change), and a new flag's numbers are compared with both.
