# Reconstruction roadmap

The goal: artwork that looks professionally recreated by a skilled vector designer, not an
automatically traced bitmap. Faithful reconstruction comes before smaller files or fewer paths.
Every change starts behind its own flag, is measured against the original uploads (never against
an earlier vector), and is a draft PR until approved; nothing is merged or deployed without
approval.

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
| 4 | `fine-detail` | Thin lines keep their width and length in the master (RC1): see docs/fine-detail.md |

## Next, in order

Each is one draft PR, measured with `bench/compare.html` (master and `knockout=1`) on the audit set
and on text-specific fixtures, with before-and-after renders.

1. **Colour accuracy for thin and small artwork** (quantiser). A thin colour's average is pulled
   towards what it blends with, so its edge pixels read as more of it (1.2 px lettering on a band
   comes out pale and thin); thin lines between two other colours are three-colour mixes the
   quantiser can't place (El Salvador's thin yellow triangle edges are lost). A first attempt that
   recomputed colours from their solid pixels fixed the synthetic cases but roughened geometry on
   real flags; it needs a geometry-aware design.
2. **Fine detail in print plates and cut files.** In knockout output the thin-line changes opened
   hairline gaps between plates and added crossings on the audit set, so PR 4 leaves plates alone.
   Plates must tile: any change there needs a tiling check (no new see-through pixels).
3. **Shape recognition** (RC5, RC6). Small stars lose their points or snap to a pentagon; small
   heptagons snap to circles; 3 px notches round off (RC9).
4. **Edge quality** (new requirement, below).
5. **Font recognition and matching** (new requirement, below).
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

Known starting points from PR 4: the curve fitter has no straight segments (a straight side is a
long cubic that may bulge by the full tolerance, which widened thin strokes by about 0.3 px), and a
detector for straight stretches must tell a straight edge from a gentle arc (a first attempt applied
everywhere turned smooth curves into chains of short lines: android went from 26 to 159 anchors).

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
