# Print and cut files: paper and size

Behind the `print-files` flag (`src/quality/flags.ts`), off for everyone by default:

| `VITE_PRINT_FILES` | Effect |
| --- | --- |
| unset (production today) | Off. `?print-files=on` in the address is ignored. |
| `preview` | Off unless the address has `?print-files=on`. Set it only for Vercel's Preview environment. |
| `on` | On for everyone using that build: a release decision. |

The local dev server also honours `?print-files=on`. With the flag off, every file is made exactly as
before (`src/vectorize/__tests__/fidelity/golden.test.ts`).

## Paper is not a white-ink plate

An opaque upload (a JPEG, a flattened PNG) brings its paper with it. Today that paper is traced as
a canvas-sized white shape and printed as a White plate and cut as a WHITE layer. With the flag on,
a **paper background** is the material, not an ink.

A background is paper only when it is light and neutral (Lab L* ≥ 92, chroma ≤ 8), the upload is
opaque, and it frames the artwork: at least 90% of the border and 75% of every side
(`src/vectorize/paper.ts`). A white stripe that touches two edges (the Mexican or El Salvador
flag's) is artwork and stays a plate; so is a coloured background, and artwork that runs off an
edge. Transparent uploads already have no background.

White ink is a production decision, so the result card asks, per upload (*White ink in print
files*):

| Choice | Print and cut files | For |
| --- | --- | --- |
| **None** (default) | Every area of the paper colour is left out: the material shows through, also in the eyes, counters and white lettering. No White plate. | White material |
| **Artwork** | The paper background is left out; white inside the artwork (white lettering on a badge, the white of an eye) prints in white ink. | Coloured material |
| **With background** | The background prints as a White plate too, as today. | A white box on coloured material |

Only print plates and cut files change. The master SVG (preview and website file) still has the
background, and one-colour files keep their own paper handling.

**Ambiguity:** white enclosed by the artwork can be an intentional white element or just paper
seen through a letter's counter (the inside of an "o"). Nothing in the image tells them apart, so
*Artwork* keeps both as white ink, and *None* keeps neither. The choice is the person's.

## One size for every print and cut file

The full-colour print PDF has always been 254 mm on its long side. With the flag, the print and cut
SVG and the DXF match it (`printWidthMm` in `src/export/files.ts`); before, the DXF was 200 mm wide
and the SVG had no units. The print and cut SVG is also the same artwork as the PDF (knockout
shapes, paper handled as above), not the master. One colour keeps its chosen output width in every
file, as before. Choosing the size is left for a later change.

## Not covered

- Photos traced by VTracer keep today's handling.
- The existing *Transparent background* switch still removes every area of the background colour,
  in every file.

## Before and after (audit set)

`bench/print-files.html?dir=…&files=…` makes each upload's print plates three ways and reports
plates, paper detection and file sizes. On the 24 audit uploads, paper is found on the two JPEGs on
paper (Python, Docker) and nowhere else. Their full-page White plate is gone with *Artwork* and
*None*, and every other upload's plates are unchanged. The DXF goes from 200 mm to the PDF's size
(254 mm long side) on all of them.
