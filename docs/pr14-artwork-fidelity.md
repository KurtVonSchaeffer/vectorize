# PR #14: artwork fidelity (next release candidate)

Branch `investigate/colour-typography-fidelity`, built on RC2 (`5e58038`). **Not merged; not deployed.** RC2 stays frozen for the 19 October demonstration. Print export (process vs spot colour) is a separate PR.

## What's included

| Area | Change | Commits |
|---|---|---|
| Colour mode | A **Color mode** control on the result: **Full color** for every new upload, **One color** (one ink, white stays paper), **Custom** (opens the limits under Fine-tune). Print inks no longer carry over to the next upload. "Inks to print" wording only outside full colour. | a02761e, 5ab3150 |
| Lettering | Traced lettering is never replaced automatically. Matches of 85%+ are suggested by name ("“LOREM” looks like REM Medium (85% match) · Try REM Medium"), shown with **Back to traced letters** when tried; lower matches are offered only if they score better. | a02761e, 5ab3150 |
| Neutral lettering edges | The grey edges of black lettering were assigned to unrelated colours (dark purple, magenta) in two places: each pixel's colour and each edge pixel's partner colour. Both now go to the two colours the pixel actually blends. | 908d0ab, 5ab3150, c45acd1 |
| Gradients | Overlapping gradient shapes (feathers) joined into one region that no gradient explains, so they were traced as flat bands. Such regions are split with tighter colour steps and the pieces fitted on their own. Not split: flat regions, the background (along the image border), and pieces that are flat colours in steps. | 7bd6cda, 810e32b |

## Measured

**Colourful bird logo** (stock image, investigation only, not committed):

| | RC2 / production | PR #14 |
|---|---|---|
| Colours (default settings) | 12 | 12 (7 flat + 9 gradients) |
| Purple/magenta inside the black lettering | 23% of the lettering ink | 0.2% |
| "LOREM" | replaced by REM Medium automatically | traced; REM Medium offered |
| Gradients kept | 1 (5% of the artwork smooth) | 9 (63%) |
| Colour error over the artwork | 16.5 | 9.7 |
| SVG size | 199 KB | 138 KB |

**83 benchmark uploads** (fictional logos and synthetic cases, PNG / JPEG 75 / JPEG 40), scored against the original artwork:
- **Against production, after the colour fixes:** 61 identical, 14 better, 7 equal, 1 slightly worse (gradient pill JPEG 75: 1.52 → 1.62; its text on the gradient is blobby in both). Colour counts and mean ΔE unchanged on every upload.
- **The gradient commits:** all 83 byte-identical.

**New gradient test set** (made for this; PNG / JPEG 75 / JPEG 40):

| Artwork | Gradients | Colour error |
|---|---|---|
| Overlapping feathers | 0 → 3 | 6.8 / 6.6 / 7.8 → 1.4 / 1.6 / 2.1 |
| Feathers on transparent | 0 → 3 | 6.9 → 0.65 |
| Radial + linear, JPEG 75 | 0 → 2 | 3.8 → 1.7 |
| Gradient beside flats, lettering on gradient, flat tints | unchanged | unchanged |

- **Large images:** Kestrel, Harbour, Summit and Barron at 2000 px have unchanged results and timing.
- **Bloom at 2000 px:** no gradient, 1.8 s of gradient detection, the same as before the split. (It briefly took 6.2 s and showed a false gradient; fixed in 810e32b.)

**End-to-end** on the dev build: 15 artwork types; upload, preview, compare, and Print, Website and Cutting with both downloads (90 files), all valid. Every flat upload starts in Full color.

**Automated:** type check, **202 tests**, production build: pass.

## Investigation 1: gradient editability (proposal, not implemented)

The bird's 9 gradients are drawn by **144 path pieces**. Measured:
- **134 of the 144 are entirely hidden**; removing any one changes no pixel.
- The shapes are stacked largest-first, and each layer also extends under every smaller shape drawn above it. That prevents hairline seams, but it also fills areas under unrelated shapes (a gradient-filled "O" under the lettering).
- Flat colours have the same pattern: 52 of 108 pieces hidden.
- **Removing all hidden pieces at once:** 252 → 66 paths, 134 → 59 KB, and 4 pixels change at 2× (anti-aliasing hairlines along a few edges).

**Proposed, in order of risk:**
1. **One compound path per gradient** (and per flat colour). Merging each gradient's pieces into one path rendered **pixel-identically** (0 pixels different at 2×), giving one editable object per gradient. Low risk; can be tested on the 83 uploads by byte comparison of the rendering.
2. **Don't create hidden islands.** In the stacked layout, a layer extends under smaller shapes only where it surrounds or touches them, not under shapes that are entirely elsewhere. This removes most hidden pieces. The seam rule needs care: the 4 changed pixels show where under-coverage was preventing hairlines. Medium risk; needs zoomed seam checks and the full benchmark.
3. **Later (V8 territory):** rebuild partly hidden shapes whole (a feather behind another), so a designer can move shapes apart. That's a real geometry change, not proposed now.

## Investigation 2: flat colours read as a gradient (proposal, not implemented)

**Cause:** three flat teal panels about 11 units apart have soft 3 px edges after the detector's light blur. Neighbours differ by about 3.7 per pixel (under the region step of 6), so the panels join into one region. Its colour range (54) passes the gradient threshold, and the profile fit (up to 8 stops) reproduces the staircase almost exactly (error 0.8, 99% explained). The result looks right but is one gradient object instead of three flat panels. Bloom at 800 px does the same (green and blue circles).

**Telling them apart:** along the gradient, stepped flats stay flat almost everywhere, with all the change in a few narrow jumps. Real gradients change throughout.

| | Change in jumps | Length flat |
|---|---|---|
| Teal panels PNG / JPEG 75 | 0.96 / 0.78 | 0.99 / 0.93 |
| Posterised bands | 1.00 | 0.95 |
| Bird's 9 gradients | 0.21–0.43 | 0.03–0.29 |
| Gradient pill / radial disc / small gradient (all qualities) | 0.00–0.71 | 0.00–0.67 |

With gradients off, the same image traces as the three exact teal colours, so rejecting staircases gives the right result.

**Status:** the check (`isStaircase`, normalised to each gradient's own rate of change) already guards the new split pieces (810e32b). **Proposed next:** apply it to all gradient candidates.
- **Risk:** a real gradient with long flat ends (a short ramp between two flat areas) could be read as stepped and traced as flat bands. Posterised artwork drawn on purpose as steps would become flats (arguably correct).
- **Test plan:** the 83 uploads (gradient cases must keep their gradients); the synthetic gradient set; new cases (a short ramp between flats; long subtle gradients; JPEG 40); real gradient logos.

## Real-world validation checklist: 2–3 authorised gradient logos in CorelDRAW

Use logos you have permission to test, with their original vector master if available. For each one:

**In Vectorize** (PR #14 preview, Full color):
- [ ] Upload the PNG or JPEG. Note the message, the colour count and "Kept N gradients smooth".
- [ ] Compare at 4×: gradients smooth (no bands), seams between shapes clean, lettering neutral and traced.
- [ ] If a font is suggested, try it, compare, and go back to traced letters.
- [ ] Download the SVG and the print PDF.

**In CorelDRAW:**
- [ ] **Import the SVG:** no errors; gradients arrive as **editable fountain fills** (open one and check its colour stops); size matches the upload's proportions.
- [ ] **Import the PDF:** no errors or missing-font prompts; gradients are fountain fills or smooth shadings, not bitmaps. Note any colours listed as spot colours (expected today; the export PR changes this).
- [ ] **Colour accuracy:** sample 3–4 flat colours and the ends of 2 gradients; compare with the master or the upload.
- [ ] **Path structure (Object Manager):** count the objects; note hidden or tiny pieces under other shapes (see Investigation 1); check that shapes are closed curves.
- [ ] **Transparency:** for a transparent PNG, no background rectangle.
- [ ] **Dimensions:** scale to 100 mm wide; edges stay sharp; no hairline gaps at 800%.
- [ ] **Edit test:** change one gradient's colours, and move one shape. Note anything that shows underneath.
- [ ] Record per logo: pass / fail per item, and screenshots of any failure.

## Remaining limitations
- **Hidden pieces under other shapes** (Investigation 1) make SVGs heavier and editing messier. The rendering is correct.
- **Flat colours in close steps** can still become one gradient when they aren't part of a split (Investigation 2).
- **A gradient continues into a touching flat area of its own end colour.** It renders the same, but is one object.
- **Gradient feathers under 400 px** stay flat.
- **Text on gradients in compressed JPEGs** traces roughly (as in production).
- **Small lettering** (under about 12 px lines) isn't legible; the app warns.
- **Print PDFs name every colour as a spot ink** (separate export PR).
- **One colour has no knockout gaps** between touching colours (Stage B).
- **The lettering scale after AI sharpening** is wrong (separate task).
- **No real customer artwork** has been tested; no checks in CorelDRAW or cutter software yet.

## Evidence needed before merging
1. The CorelDRAW checklist above, completed on 2–3 authorised gradient logos, plus Kestrel and the bird.
2. A decision on Investigation 1 step 1 (compound paths), which could ride along in this PR because it's render-identical.
3. A Vercel preview of the final PR #14 commit checked on two browsers.
4. Re-run of the 83-upload comparison and the end-to-end export run on the final commit.
