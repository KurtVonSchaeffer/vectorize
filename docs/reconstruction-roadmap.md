# Reconstruction roadmap

The goal: artwork that looks professionally recreated by a skilled vector designer, not an
automatically traced bitmap. Faithful reconstruction comes before smaller files or fewer paths.
Every change starts behind its own flag, is measured against the original uploads (never against
an earlier vector), and is a draft PR until approved; nothing is merged or deployed without
approval.

## Acceptance criteria for every reconstruction change

Edge quality is a requirement of every change, not a later phase. A change is ready for review only
when its benchmark (`bench/compare.html`, master and `knockout=1`, every audit upload plus the
relevant synthetic fixtures) shows, against production, on every image it changes:

- fidelity to the upload no worse (mean error, edge recall, lost and changed details), and better
  where the change is aimed;
- edges no rougher (turning beyond a clean outline, per 100 px) and no less accurate zoomed in (2×
  and 4×);
- no unnecessary anchors (any increase explained by shape the upload has, such as a line's ends);
- no new crossings, fragments, small holes or see-through pixels;
- circles round, straight edges straight, real corners sharp;
- print, cut, PDF, DXF and One-colour output unchanged unless the change is aimed at them;
- a side-by-side sheet (upload, production, proposed) with zoomed crops of every changed region,
  checked by eye: a number can't show a speck of the wrong colour.

Where a new method can be worse, it has a measured per-region fallback to the production result
(as fine detail does, `src/trace/finedetail.ts`).

## Done (merged, behind flags, off in production)

| PR | Flag | What |
| --- | --- | --- |
| #24 | — | Fidelity measurement against the upload, regression suite, golden byte-identity tests |
| #25 | `quality-reporting` | Honest quality reporting; "Artwork reviewed" by a person |
| #26 | `print-files` | Paper is not a white-ink plate; white-ink choices; plate preview; one physical size |
| #27 | `clean-geometry` | No shape drawn twice in the stacked master (RC8) |

## In review

| PR | Flag | What |
| --- | --- | --- |
| #28 | `fine-detail` | Thin lines keep their width and length in the master, only where measurably better; small rings and dots stay round (RC1): see docs/fine-detail.md |

## Next, in order

Each is one draft PR, measured with `bench/compare.html` (master and `knockout=1`) on the audit set
and on text-specific fixtures, with before-and-after renders.

1. **Colour accuracy for thin and small artwork** (quantiser). First round in review
   (docs/colour-accuracy.md): pale lettering gets its real colour where that traces better, with
   no new defects; on the audit set it changes Firefox only. The losses there are sub-pixel
   (Brazil's motto on the 240 px JPEG, El Salvador's 1 px hatching, Mexico's feather texture) and
   need the next item, a higher internal tracing resolution for small uploads, or the font phase.
   **Partly covered strokes**: a stroke whose pixels are all under half covered is lost by the
   tracer whatever its colour (1.2 px strokes on a band drawn as fragments or squiggles).
2. **Fine detail in print plates and cut files.** In knockout output the thin-line changes opened
   hairline gaps between plates and added crossings on the audit set, so PR 4 leaves plates alone.
   Plates must tile: any change there needs a tiling check (no new see-through pixels).
3. **Shape recognition** (RC5, RC6). Small stars lose their points or snap to a pentagon; small
   heptagons snap to circles; 3 px notches round off (RC9).
4. **Edge quality** beyond what each change already guarantees (below): straight-line and corner
   detection everywhere, node minimisation, curve fitting judged at several zoom levels.
5. **Font recognition and matching** (below): its own phase. Lettering is never "fixed" by
   smoothing traced outlines in its place.
6. **Gradients** (RC7): overlapping gradients flattened to one colour.

## Edge quality: smooth, professional edges

Requirements:

- No jagged or rough outlines from pixel tracing; no excessive anchor points or needlessly complex
  paths.
- Properly fitted Bézier curves that keep the original geometry: sharp corners stay sharp,
  circles stay circles, straight edges stay straight, geometric elements stay exact.
- No hairline gaps, overlapping seams or self-intersecting paths.
- No over-smoothing that rounds off important detail; curves stay smooth when scaled up a lot.

Measures (added to `bench/compare.ts` in PR 4, extended in this PR):

- Edge accuracy against the upload (edge recall and precision, mean error), and the same at 2× and
  4× zoom (`zoom`), so edges are judged where a designer would look, not only at upload size.
- Path complexity: anchor points per outline, and per unit of outline length.
- Roughness: turning beyond what a clean closed outline needs, in degrees per 100 px (wiggles and
  stair steps add it).
- Geometry: self-intersections, fragments under 4 px², and new see-through pixels.

Known starting points from PR #28: the curve fitter has no straight segments outside thin outlines
(a straight side is a long cubic that may bulge by the full tolerance), and a detector for straight
stretches must tell a straight edge from a gentle arc (a first attempt applied everywhere turned
smooth curves into chains of short lines: android went from 26 to 159 anchors). Corners rebuilt
closer together than about a pixel make hooks; two curves that one cubic follows can be joined
(`mergeCurves`).

## Font recognition and matching

Lettering is reconstructed by identifying and matching the original font, not by tracing it as
shapes, and never by substituting a vaguely similar font.

Requirements:

- Find text with the existing OCR (Tesseract, `src/fonts/ocr.ts`); identify likely families,
  weights, styles, spacing and proportions (`src/fonts/match.ts`, `identify.ts`, `online.ts`).
- Compare candidates against the original letterforms visually, and report each candidate's
  confidence. An OCR transcription is not evidence of a font match.
- With a reliable match: editable text objects in the SVG (with kerning, tracking, alignment,
  baseline and proportions kept), plus an optional outlined-text version for production.
- Without one: the original letterforms as accurately reconstructed outlines, flagged for review.
- No silent font substitution in PDF or CorelDRAW-bound exports: a font that isn't embedded or
  outlined is reported, not replaced.
- Font licensing and availability documented per match (embedding and outlining rights).

Measures, per benchmark image with lettering (Docker, Brazil, Mexico, El Salvador, Kubernetes,
github-mark and text fixtures):

- Text detection: words found against the words present.
- Font candidates and their confidence; whether the lettering ended up editable text or outlines.
- Edge accuracy and roughness of the lettering alone; remaining differences from the original.

Text-specific fixtures to add: lettering at several sizes (8–48 px cap height), weights, tracking,
on plain and textured backgrounds, script and display faces, and a known-font set for which the
correct answer is known.

## Acceptance report, per image with lettering or complex curves

Edge accuracy against the original; visible roughness or unwanted smoothing; anchor points and path
complexity; text detection accuracy; font candidates and confidence; editable text or outlines; any
remaining differences from the original.
