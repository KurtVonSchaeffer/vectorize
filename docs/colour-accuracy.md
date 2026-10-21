# Colour accuracy for thin artwork (first round)

Behind the `colour-accuracy` flag (`src/quality/flags.ts`), off for everyone by default, in the
same three states as the other flags (docs/feature-flags.md). With the flag off, every file is made
exactly as before (`src/vectorize/__tests__/fidelity/golden.test.ts`).

It changes the **master artwork only**, and only together with `print-files` (without print files
the print and cut SVGs are the master). Print plates and cut files (so the print PDF and DXF), one
colour, spot inks, line art and photos never get it (`masterOnly` in `src/vectorize/pipeline.ts`).

## The defects

The colour reduction reads each colour as the average of its pixels and folds anti-aliased blends
into real colours. Thin artwork suffers both ways:

- **Faded:** a thin line's pixels are mostly edge blends with its background, so its colour reads
  paler than it is (1.6 px orange lettering: ΔE 5.5; 1.5 px red lines between pixel columns:
  ΔE 12.8).
- **Lost:** a thin colour whose pixels look like the blend of two other colours is folded into
  them (Brazil's motto lettering on the 240 px JPEG, El Salvador's hill hatching, Mexico's feather
  streaks).

`bench/compare.html` now measures colour against the upload (CIEDE2000): the mean over every pixel
(`colourDE`), the mean over detail pixels (`detailDE`: pixels clearly unlike the median of their
5×5 neighbourhood, so thin lines, lettering, small marks and edges), and faded pixels (`fadedPx`:
detail pixels the vector paints in the surrounding colour instead), with where they are
(`fadedWhere`).

## The change

**Proposing line colours** (`lineColours`, `src/palette/quantize.ts`): a pixel is on a thin line
when, across it in some direction, at most 3 pixels clearly unlike the background (48 sRGB) separate
two pixels of the same background colour. Connected groups of such pixels, at least 4 px long and 6
pixels in all, are lines. Each line's colour is read from its quarter of pixels that stand out most
(the rest are edge blends). A line takes a broad colour already in the artwork when one is within
48; otherwise lines of similar colour share one new colour, which needs 24 line pixels in all; a
new colour that mostly replaces one thin, pale colour of the map corrects that colour instead of
adding a second shade. Nothing is applied yet.

**Keeping only what traces better** (`judgeLines`, `src/vectorize/linecolours.ts`): the final map
is traced without the lines and with all of them. A line, or all the lines of a new or corrected
colour together (never lettering in two shades), is kept when, within 3 px of it, the traced
artwork is closer to the upload (composited colour, at least 3% less error) and has no more
crossing outlines, no more fragments (a crossing squiggle swapped for a fragment is still a
defect), at most 3° more turning and no more anchors than its new outlines need. The kept lines are
traced again on their own and judged again until nothing more fails; otherwise production's map is
used, byte for byte. A corrected colour's edge blends are measured again against the corrected
colour. Lettering rebuilt from a font is left alone.

## Results

Benchmark: `bench/compare.html?dir=/audit-in/&files=…&b=colourAccuracy` (master), `&knockout=1`
(print plates); timings from the same runs.

**Synthetic fixtures** (ground truth known):

| Case | Colour ΔE to the truth | Overlap with the true shape |
| --- | --- | --- |
| 1.6 px orange lettering on white | 5.5 → 0.7 | 0.85 → 0.90 |
| 1.6 px green lettering on a light band | 12.6 (unchanged) | 0.65 |
| 1.2 px green strokes on a light band | 5.5 (unchanged) | 0.09 |
| 1.5 px red lines between pixel columns | 12.8 (unchanged) | 0.66 |
| 1.5 px orange line between red and yellow | 26.5 (unchanged) | 0.02 |
| Red dots, small solid shapes, gradients | unchanged (byte-identical) | |

**Audit uploads** (22 traced uploads and 3 synthetic): 24 of 25 byte-identical. Firefox: mean error
5.676 → 5.669, detail ΔE 18.67 → 18.37, faded pixels 15 → 14; anchors, roughness, crossings,
fragments and colours unchanged. No image gains a crossing, fragment, colour or see-through pixel.

**Unchanged outputs:** print plates identical on all 27 benchmark images. In the app (every download
compared byte for byte on Firefox, Brazil (web), El Salvador and Linux): without print files every
download is identical; with print files only Firefox's web SVG and PNG change; One colour identical.

**Speed** (25 traced images): 4.7 s → 9.4 s with the flag (at most +1.5 s, syn-lines-large,
1200 × 720); with fine detail too, 9.8 s → 18.5 s (at most +2.7 s, Mexico). At most 200 lines per
image are judged.

## Limits

The safeguards keep production's result for the losses that matter most:

- Brazil (web): the motto's strokes are about a pixel wide in a blurred 240 px JPEG; drawn as lines
  they become slivers and specks. The motto is text: it belongs to the font phase.
- El Salvador's hatching is 1 px diagonal lines whose colour is exactly a blend of the hill's
  yellow and the emblem's green; drawing them adds crossings.
- Mexico's feathers are a dense pixel texture.
- A line with no fully covered pixel looks the same as a narrower, darker one: its colour can't be
  recovered from its pixels.
- Thin strokes whose own colour would draw them under 4 px² (1.2 px strokes on a band) stay as
  production draws them: recovering them is tracing work (partly covered strokes), not colour.
