# Fine detail: thin lines keep their width and length, only where it is better

Behind the `fine-detail` flag (`src/quality/flags.ts`), off for everyone by default:

| `VITE_FINE_DETAIL` | Effect |
| --- | --- |
| unset (production today) | Off. `?fine-detail=on` in the address is ignored. |
| `preview` | Off unless the address has `?fine-detail=on`. Set it only for Vercel's Preview environment. |
| `on` | On for everyone using that build: a release decision. |

The local dev server also honours `?fine-detail=on`. With the flag off, every file is made exactly
as before (`src/vectorize/__tests__/fidelity/golden.test.ts`).

It changes the **master artwork only**, and only together with the `print-files` flag: without
print files the print and cut SVGs are the master itself, so fine detail stays off there. Print
plates and cut files (knockout output, so the print PDF and DXF), one colour, spot inks, line art
and photos never get it (`buildTraceJob` in `src/vectorize/pipeline.ts`, `src/App.tsx`).

## The defect (RC1)

A thin line traced with the ordinary rule came out the wrong size. The tracer blurs each colour's
area and cuts it at half height; across a 1 px line the blurred profile never reaches full height,
so the cut lands too wide in the middle (1.17 px for a 1 px line, 2.3 px for 2 px) and too short at
the ends (a 20 px line drawn 14 px long, as a pointed lens). Thinner or fainter lines shrank to
slivers or vanished.

## The correction

**Fine-detail trace** (`src/trace/index.ts`, `fit.ts`):

- **Width measured across the line** (`acrossStroke`, `hump`): where the blurred field forms a
  ridge, the tracer measures the line's real width from its whole profile and cuts at the level
  that gives that width. Real line ends stay where they are. Anything that isn't plainly a thin
  line on ground keeps the ordinary rule.
- **Line ends kept by colour clean-up** (`keepSolidDetail`, `src/palette/quantize.ts`): noise
  clean-up keeps the solid end pixel of a line at least 3 px long, in a colour clearly unlike its
  surroundings. Only the fine-detail trace sees these pixels (`LabelMap.fine`); the map's own
  labels, and so every ordinary outline, are unchanged.
- **Clean, lean outlines**: a thin outline (at most 3 px thick) draws its straight stretches as
  exact lines, and each end as one smooth curve between them (no corners rebuilt 1 px apart, which
  made hooks). Neighbouring curves that one cubic follows within 0.1 px are joined (`mergeCurves`).

**The fallback** (`judge`, `src/trace/finedetail.ts`): each colour that contrasts with what it
borders is traced both ways. Outlines that describe the same thing are grouped, and a group's fine
outlines replace the ordinary ones only when all of these hold; otherwise the ordinary outlines
stay, byte for byte:

- closer to the upload's coverage of that colour: at least 0.5 px² and 5% less error;
- no more anchors than the ordinary outlines (a fine outline may always have four: a bar's two
  sides and two ends);
- no extra turning (wiggles, dents, hooks) beyond 3° over the ordinary outlines;
- no new fragment: no outline under 4 px², and no hole under 8 px² (a hole shows the colour below
  as a speck), that doesn't cross itself, beyond what the ordinary outlines have;
- no crossing;
- no pixel left uncovered that the ordinary outlines cover and that is mostly this colour in the
  upload (it would be see-through, or show the colour below).

**Round shapes and real corners** (`roundShapes`, `src/trace/shapes.ts`): an outline is drawn as an
exact polygon only when it follows the polygon more closely than a circle, so a ring's hole or a
dot that used to snap to a quadrilateral, pentagon or hexagon stays round; a small round outline
(2.5–6 px radius, round within 0.3 px) is drawn as an exact circle. Squares, triangles and small
stars (which trace as pentagons) are unchanged. A fine outline is drawn as an exact shape only
when the ordinary outline it replaced is that shape too.

## Results

`bench/compare.html?dir=/audit-in/&files=…&b=fineDetail` traces each upload both ways and measures
both against the upload (`assessFidelity`), makes a PDF and DXF from each, and measures anchors,
roughness (turning beyond what a clean outline needs, degrees per 100 px of outline) and error
zoomed in (2× and 4×); `knockout=1` for print plates, `keep=1` keeps the SVGs.

**Synthetic 20 px bars** (five per case; overlap is intersection over union with the true bar):

| Case | Width, off → on | Length of 20, off → on | Overlap, off → on |
| --- | --- | --- | --- |
| 1 px, on the grid | 1.17 → 0.96 | 14.4 → 19.4 | 0.57 → 0.97 |
| 1 px, 0.2 px steps off the grid | 1.48 → 1.20 | 15.8 → 18.8 | 0.57 → 0.86 |
| 2 px, on the grid | 2.30 → 1.92 | 19.4 → 19.4 | 0.85 → 0.95 |
| 2 px, 0.2 px steps off the grid | 2.42 → 1.90 | 19.3 → 19.5 | 0.80 → 0.91 |

**Audit uploads, master SVG** (22 traced uploads; the two photos are VTracer and unaffected).
Totals: mean error 49.53 → 49.43, lost details 116 → 116, anchors 7,596 → 7,645 (+0.6%),
crossings 63 → 58, fragments 25 → 22, new see-through pixels 0. PDF and DXF build from every
result.

| Upload | Mean error | Edge recall % | Lost | Anchors | Roughness | Zoom ×2 / ×4 | Crossings | Fragments | See-through |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| docker-small.jpg | 8.637 → 8.586 | 97.3 | 0 | 359 → 352 | 369.3 → 350.9 | 16.19 / 16.91 → 16.12 / 16.87 | 6 → 5 | 4 → 3 | 0 |
| docker.png | 3.775 → 3.757 | 99.7 | 0 | 405 → 435 | 163.9 → 163.6 | 7.14 / 7.50 → 7.12 / 7.49 | 0 | 0 | 0 |
| flag-br-web.jpg | 5.266 → 5.248 | 92.3 → 92.4 | 8 | 194 → 188 | 292.4 → 250.9 | 8.55 / 8.83 → 8.53 / 8.82 | 15 → 14 | 8 | 0 |
| flag-br.png | 0.444 → 0.443 | 99.7 | 2 | 441 → 440 | 249.5 → 249.3 | 1.17 → 1.16 | 0 | 0 | 0 |
| flag-mx.png | 1.172 → 1.170 | 88.6 | 77 | 1192 → 1190 | 697.6 → 678.6 | 1.90 → 1.90 | 19 → 16 | 10 → 8 | 0 |
| flag-sv.png | 1.013 → 1.007 | 91.7 → 91.8 | 8 | 692 → 712 | 393 → 393.2 | 1.94 → 1.93 | 1 | 0 | 0 |
| fluent-parrot.png | 0.271 → 0.271 | 100 | 1 | 247 | 101.5 → 101.6 | 0.93 → 0.93 | 0 | 0 | 0 |
| go.png | 0.352 → 0.337 | 100 | 0 | 49 | 126.5 → 126.3 | 1.20 / 1.32 → 1.19 / 1.31 | 0 | 0 | 0 |
| linux.png | 3.612 → 3.609 | 86.5 | 6 | 515 → 519 | 323.9 → 322.8 | 6.10 / 6.43 → 6.09 / 6.43 | 1 | 0 | 0 |
| python-tiny.jpg | 6.043 → 6.053 | 97.0 → 96.8 | 0 | 208 → 205 | 381.6 → 383.5 | 10.69 / 10.96 → 10.69 / 10.96 | 3 | 0 | 0 |
| python.png | 0.613 → 0.611 | 100 | 0 | 115 | 111 | 2.07 / 2.19 → 2.07 / 2.19 | 0 | 0 | 0 |
| ruby.png | 5.731 → 5.732 | 97.7 | 8 | 1167 → 1181 | 321.6 → 318.6 | 10.23 / 10.44 → 10.21 / 10.43 | 6 | 0 | 0 |
| syn-lines-large.png | 1.620 → 0.753 | 91.2 → 92.3 | 84 → 58 | 723 → 403 | 1.5 → 0.1 | n/a → n/a | 0 | 0 | 0 |
| syn-strokes-small.png | 1.741 → 0.851 | 83.1 → 100 | 0 | 23 → 31 | 25.5 → 0.6 | 3.06 / 3.35 → 2.38 / 2.75 | 0 | 0 | 0 |

Byte-identical: android, angular, firefox (its candidates were all small holes, refused), github-mark,
javascript, kubernetes, react, rust, vue, world-thin, and the synthetic band image.

**Print plates and cut files** (`knockout=1`): byte-identical on all 27 images. **In the app**
(every download compared byte for byte with and without the flag, on docker, El Salvador, Brazil,
Linux, Firefox and a synthetic hairline image): with print files, the print PDF and SVG and the cut
SVG and DXF are identical and only the web SVG and PNG change; without print files, and in One
colour, every download is identical.

## Known limits

- El Salvador's roughness figure rises 393.0 → 393.2: its changed outlines have less extra turning
  than production's (8° → 3° in total) but are shorter, so the per-length figure rises.
- python-tiny: mean error +0.010, from the logo's eye, a skewed quadrilateral in production, now
  round as in the upload. Ruby: +0.001, from three outlines smoother than production's.
- Small stars still trace as pentagons (one in Brazil, an irregular shape in production, is now an
  oval); drawing them as stars is shape work (RC5).
- Thin lettering whose colour is read lighter than it is (1.2 px strokes on a band) would be drawn
  under 4 px², so the fallback keeps production's outlines there. Colour accuracy is next.
- Thin lines between two other colours (three-colour blends) are still lost by colour reduction.
- Fine detail in print plates and cut files: unchanged on purpose; plates must tile.
- Speed: with the flag on, tracing takes about twice as long (5.1 s → 10.1 s over the 25 traced
  images; at most 1.9 s, on a 1200 × 720 image), since detail colours are traced and judged twice.
