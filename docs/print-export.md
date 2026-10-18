# Print and cut exports: inks, white, and size

Release acceptance of PR #18 (ee025bc) found three file-level defects in the downloads. This
note records what the files now contain and why.

## 1. Which colours become spot plates

**Rule.** A print PDF names a colour as a `/Separation` (spot ink) only when the customer chose
print inks (Brand colors → print inks, `inks.enabled`): the swatch name they picked is the plate
name. Every other flat colour, white included, is written as plain `DeviceRGB`, like the
full-colour (photo) PDF. Gradients were already full-colour shadings and are unchanged.

**Before.** Every flat colour got a Separation named with its everyday name ("White",
"Navy", "Burnt orange"). Kestrel's PDF had three plates, one of them `/White`.

**Why.**
- In PDF a Separation is a request for a separate printing plate with that name; its RGB
  alternate is only the preview. Any name other than the four process colours, `All` and `None`
  is a spot plate (PDF 1.7, §8.6.6.4). A full-colour logo with five everyday names would ask for
  five spot plates rather than CMYK.
- "White" in particular is the conventional name for a white-ink plate (printing on clear,
  kraft or metallic stock), so a RIP or prepress operator may print it as opaque white ink
  instead of leaving paper.
- As RGB, white converts to CMYK 0/0/0/0: no ink on any plate, so it's bare paper.

**What stays.** With print inks on, a swatch the customer chose (including a white swatch, for
example "Opaque White" with "White is paper" turned off) is still a named spot plate: that's an
explicit choice. The download says "Each ink on its own plate" only in that case, and
"Full-color vector PDF" otherwise.

## 2. Physical size

**Rule.** One upload pixel is one CSS pixel, 1/96 inch (0.2646 mm), in every file.

| File | How the size is written | 800 × 480 px upload |
|---|---|---|
| Web SVG | `width`/`height` in unitless CSS px (unchanged) | 800 × 480 px = 211.7 × 127 mm |
| Print and cut SVG | `width`/`height` in `mm`, same `viewBox` | 211.667mm × 127mm |
| Print PDF | MediaBox in points, px × 0.75 | 600 × 360 pt = 211.7 × 127 mm |
| Cut DXF | millimetres, px × 0.2646 | 211.667 × 127 mm |

The size comes from the SVG's own `width`/`height` (set to the upload's pixel size by
`finalizeSvg`), not from the traced coordinate space, so a downscaled trace still exports at the
upload's size.

**Before.** The PDF page was always 720 pt (10 in) on its longest side, whatever the upload:
Kestrel (800 px) came out at 0.9× its SVG size and Prism (220 px) at 3.27×. The DXF was always
200 mm wide. The SVG was unitless, which apps read differently: browsers, Inkscape and Figma
use 96 px per inch, Illustrator 72 (1 px = 1 pt), and Cricut Design Space has its own rule.

**Why this rule.** 96 px per inch is what browsers and the CSS spec already give the SVG, so the
web file and on-screen size don't change; stating print and cut SVGs in millimetres makes every
app open them at that same size; and the PDF and DXF follow the same number. A vector logo is
resized for each job anyway; what matters is that every file of one result agrees and opens at a
predictable size. Large uploads produce large nominal sizes (a 2000 px logo is 529 mm), small
ones small (220 px is 58 mm).

The bench's weeding check (pieces under 1 mm) still judges cut files at a 200 mm reference width,
so its results stay comparable.

## 3. Near-white snaps to white

**Rule.** When the artwork keeps its own colours (no swatch library), a flat colour within
CIEDE2000 1.5 of white becomes exact `#FFFFFF` (`snapNearWhite` in `src/palette/color.ts`,
applied in `runFlat`). Brand-matched colours, gradients and line art keep theirs.

**Where the off-white came from.** `quantize` gives each colour cluster the average of its
pixels (`pureCenters`, then `ownSwatch`), so a white JPEG background averages to an off-white:
Harbour at JPEG quality 40 got `#FBFCFC` (ΔE 0.83 from white), which would print as a faint
tint, or with the old PDF an extra plate.

**Why in `runFlat`, not in `quantize`.** Speck cleanup (`isDetail`), gradient edges and
brand matching compare pixels against the label colours. Recolouring after those steps changes
the colour only, never the shapes, by construction, and lets a brand-matched off-white keep its
value.

**Demo-kit check.** Harbour's outlines are bit-identical before and after (same SHA-256 over
every path); only the background fill changed, `#FBFCFC` → `#FFFFFF`. Its bench detail error
still moved from 5.5 % to 6.2 % (it was already a FAIL on a damaged JPEG). Swapping just that
fill in one SVG reproduces the change exactly, so it's the metric, not the trace: the bench counts
a pixel as wrong when it's more than 48 sRGB units off, so faint anti-aliased stroke edges the
trace dropped can fall either side of that line depending on the exact background value.

**Threshold.** ΔE from white: `#FDFDFD` 0.40, `#FBFCFC` 0.83, `#FAFAFA` 1.00, `#F8F8F8` 1.40
(snap); `#F5F5F5` 2.01, warm white `#FFFDF8` 2.52, `#F4F1EA` 4.45, cream `#FFF8E7` 7.65
(kept). 1.5 is below the bench's colour-fidelity limit (mean ΔE 2), so a snap never costs a
colour-fidelity pass, and deliberate light greys and creams keep their colour. An off-white
brand colour (say `#FAFAFA`) is kept, because brand-matched colours are skipped.

## Not changed

- **Gradients as several paths.** One gradient can be several SVG paths (Prism: 7), one per
  connected piece. Joining them into compound paths was deliberately deferred; it's an
  optimisation (fewer objects to select), not a correctness issue.
- **CorelDRAW is unverified.** CorelDRAW isn't installed on the test machine. The PDF and the
  mm-sized SVG follow the PDF and SVG specifications, but how CorelDRAW imports them (and
  whether it honours SVG `mm` units and the PDF page size) hasn't been checked.
- No ICC output intent or CMYK conversion is written; full-colour print PDFs are RGB, as before.
