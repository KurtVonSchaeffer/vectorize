# Fine detail: thin lines keep their width and length

Behind the `fine-detail` flag (`src/quality/flags.ts`), off for everyone by default:

| `VITE_FINE_DETAIL` | Effect |
| --- | --- |
| unset (production today) | Off. `?fine-detail=on` in the address is ignored. |
| `preview` | Off unless the address has `?fine-detail=on`. Set it only for Vercel's Preview environment. |
| `on` | On for everyone using that build: a release decision. |

The local dev server also honours `?fine-detail=on`. With the flag off, every file is made exactly
as before (`src/vectorize/__tests__/fidelity/golden.test.ts`).

It changes the **master artwork only**. Print plates and cut files (knockout output, so the print
PDF and DXF), one colour, spot inks, line art and photos never get it (`buildTraceJob` in
`src/vectorize/pipeline.ts`): in knockout output the same changes opened hairline gaps between
plates and added crossings on the audit set, and plates must tile.

## The defect (RC1)

A thin line traced with the ordinary rule came out the wrong size. The tracer blurs each colour's
area and cuts it at half height; across a 1 px line the blurred profile never reaches full height,
so the cut lands too wide in the middle (1.17 px for a 1 px line, 2.3 px for 2 px), and too short at
the ends (a 20 px line drawn 14 px long). Thinner or fainter lines (hairlines, lettering strokes,
the thin edges of emblems) shrank to slivers or vanished, and the curve fitter, which has no
straight segments, let a long bar's sides bulge by its whole tolerance.

## The correction

- **Width measured across the line** (`acrossStroke`, `hump` in `src/trace/index.ts`). Where the
  blurred field forms a ridge, the tracer walks across it, measures the line's real width from the
  whole profile, and cuts at the level that gives that width. At a real line end (the profile along
  the line also closes) the end is kept where it is. Anything that isn't plainly a thin line on
  ground (a profile that runs into a solid area, an edge blend without a solid core) keeps the
  ordinary rule.
- **Straight stretches drawn straight** (`straightRuns`, `fitWithLines` in `src/trace/fit.ts`), on
  thin outlines only (at most 3 px thick): their straight sides are exact lines, so they don't
  bulge.
- **Solid detail kept by the clean-up filter** (`keepSolidDetail` in `src/palette/quantize.ts`):
  the majority filter no longer erases solid pixels of a contrasting colour (1 px lines were being
  eaten before tracing).
- **Only where it is detail**: a colour gets this only when at least half its border is against a
  clearly different colour (lines, lettering, small marks), not bands between similar colours
  (shading, compression noise).
- **Never worse geometry**: an outline whose fine fit crosses itself is refitted closer; if it still
  crosses, every fine outline in that place is replaced by the ordinary trace. A fine outline is
  drawn as an exact circle or polygon only when its ordinary trace is that shape too (a thin ring's
  inner edge once snapped to a hexagon).

## Results

`bench/compare.html?dir=/audit-in/&files=…&b=fineDetail` traces each upload both ways and measures
both against the upload (`assessFidelity`), and makes a PDF and DXF from each (`knockout=1` for
plates; `keep=1` keeps the SVGs).

**Synthetic tests** (`src/vectorize/__tests__/fine-detail.test.ts`):

| Case | Off | On |
| --- | --- | --- |
| 1 px bars: width / length (of 20) / overlap with the truth | 1.17 px / 14.4 / 0.57 | 0.96 px / 19.4 / 0.96 |
| 2 px bars: width / overlap | 2.3 px / — | 1.92 px / 0.95 |
| 1.2 px lettering strokes on a band: overlap / crossings | 0.09 / 12 | 0.36 / 0 |
| Solid shapes, wide shapes, gradients, noisy small art (RC10) | — | no worse, no new crossings, fragments or transparency |

**Synthetic uploads** (production path):

| Upload | Mean error | Lost details | Anchors |
| --- | --- | --- | --- |
| syn-lines-large.png (hairlines at production size) | 1.62 → 0.74 | 84 → 58 | 723 → 843 |
| syn-strokes-small.png (1 and 2 px lines, a ring) | 1.74 → 0.82 | 0 → 0 | 23 → 46 |

**Audit uploads, master SVG** (24 uploads; photos are VTracer and unaffected):

Totals over the uploads that changed: mean error 40.64 → 40.63, lost details 116 → 113, changed
small shapes 117 → 115, self-crossings 60 → 47, fragments 25 → 27, anchors 7048 → 7699 (+9%). No new
see-through pixels except world-thin (26, below). PDF and DXF build from every result.

| Upload | Mean error | Edge recall % | Lost | Changed | Anchors | Roughness | Crossings | Fragments |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| angular.png | 0.780 → 0.776 | 99.9 → 100.0 | 0 → 0 | 0 → 0 | 97 → 98 | 44.8 → 48.8 | 0 → 0 | 0 → 0 |
| docker-small.jpg | 8.637 → 8.608 | 97.3 → 97.3 | 0 → 0 | 1 → 1 | 359 → 450 | 520.5 → 552.1 | 6 → 6 | 4 → 4 |
| docker.png | 3.775 → 3.752 | 99.7 → 99.8 | 0 → 0 | 0 → 0 | 405 → 513 | 205.0 → 216.7 | 0 → 0 | 0 → 0 |
| firefox.png | 5.676 → 5.673 | 96.2 → 96.5 | 6 → 6 | 1 → 1 | 1198 → 1231 | 542.9 → 543.7 | 12 → 10 | 3 → 3 |
| flag-br-web.jpg | 5.266 → 5.284 | 92.3 → 92.7 | 8 → 8 | 0 → 0 | 194 → 172 | 419.2 → 310.9 | 15 → 10 | 8 → 10 |
| flag-br.png | 0.444 → 0.436 | 99.7 → 99.8 | 2 → 2 | 12 → 14 | 441 → 544 | 354.2 → 367.9 | 0 → 0 | 0 → 0 |
| flag-mx.png | 1.172 → 1.176 | 88.6 → 89.3 | 77 → 74 | 62 → 60 | 1192 → 1240 | 763.7 → 733.7 | 19 → 15 | 10 → 7 |
| flag-sv.png | 1.013 → 1.006 | 91.7 → 91.0 | 8 → 9 | 38 → 35 | 692 → 884 | 508.5 → 538.7 | 1 → 1 | 0 → 2 |
| fluent-parrot.png | 0.271 → 0.280 | 100 → 100 | 1 → 1 | 0 → 0 | 247 → 242 | 113.3 → 112.3 | 0 → 0 | 0 → 0 |
| github-mark.png | 0.592 → 0.582 | 99.5 → 99.5 | 0 → 0 | 0 → 0 | 140 → 138 | 160.6 → 157.9 | 0 → 0 | 0 → 0 |
| go.png | 0.352 → 0.318 | 100 → 100 | 0 → 0 | 0 → 0 | 49 → 48 | 146.1 → 143.3 | 0 → 0 | 0 → 0 |
| kubernetes.png | 0.747 → 0.747 | 100 → 100 | 0 → 0 | 0 → 0 | 144 → 144 | 166.1 → 166.1 | 0 → 0 | 0 → 0 |
| linux.png | 3.612 → 3.663 | 86.5 → 89.3 | 6 → 6 | 3 → 4 | 515 → 605 | 359.7 → 387.3 | 1 → 1 | 0 → 0 |
| ruby.png | 5.731 → 5.748 | 97.7 → 97.6 | 8 → 7 | 0 → 0 | 1167 → 1182 | 343.7 → 345.5 | 6 → 4 | 0 → 1 |
| rust.png | 1.735 → 1.737 | 100 → 100 | 0 → 0 | 0 → 0 | 156 → 156 | 371.9 → 371.9 | 0 → 0 | 0 → 0 |
| world-thin.png | 0.832 → 0.841 | 100 → 100 | 0 → 0 | 0 → 0 | 52 → 52 | 14.3 → 14.3 | 0 → 0 | 0 → 0 |

Byte-identical: android, javascript, python-tiny.jpg, python, react, vue.

**Print plates and cut files** (`knockout=1`): byte-identical on all 24 uploads and both synthetic
uploads.

Roughness is turning beyond what a clean outline needs, in degrees per 100 px; anchors and roughness
are totals per upload.

## Known regressions and limits

- **More anchors** where thin strokes are now drawn at their real shape: +20–28% on docker,
  docker-small, flag-br, flag-sv and linux; doubled on the synthetic lines (line ends and straight
  sides are separate segments). Roughness rises with them (docker-small +6%, flag-sv +6%, linux +8%;
  synthetic lines at their ends). Node minimisation is part of the edge-quality PR.
- **flag-sv**: one more lost detail (8 → 9) and two new fragments (0 → 2); **flag-br-web** 8 → 10
  fragments, **ruby** 0 → 1; **linux** mean error +0.05 (edge recall +2.8 points).
- **world-thin**: 26 pixels opaque in the upload are now see-through: the 1 px lines are drawn at
  their real width, so their anti-aliased fringe isn't covered (sub-pixel; the lines themselves are
  intact).
- **Not fixed here** (later PRs, see docs/reconstruction-roadmap.md):
  - thin lines between two other colours are three-colour blends that the quantiser loses (the thin
    yellow edges of El Salvador's triangle);
  - thin lettering's colour is read lighter than it is, so on-band strokes stay below the audit's
    0.5 overlap (0.36);
  - small stars, heptagons and notches (RC5, RC6, RC9);
  - a 1 px anti-aliased ring with no solid core keeps the ordinary rule and stays lumpy;
  - small rings can snap to polygons with the flag off too;
  - fine detail in print plates and cut files.
