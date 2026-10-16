# Colour-preservation validation (PR #6 + PR #7)

This decides whether the grey-tagline fix (PR #7, stacked on PR #6) is safe to merge. It compares production `main` with the combined branch on real customer logos, each scored against its original artwork. Synthetic artwork has already been checked (`docs/defects/grey-tagline-fix.md`). **It is not a substitute for real customer logos.**

## Setup

1. Check out the combined branch: `fix/grey-tagline-blend`, or a branch built on it.
2. Create a read-only copy of the "before" version, inside `node_modules` so tests and the type checker ignore it:
   ```bash
   git worktree add --detach node_modules/.cache/compare-main origin/main
   ```
3. Run `npm run dev` and open **`/bench/compare.html`**. To compare against another version, add `?base=/node_modules/.cache/<worktree>`.

Both versions run in the same page, on the same decoded upload. Their results are drawn by the same renderer and scored against the same original, so rendering, colour handling and profiles are identical for both. Uploads are decoded once, with the browser's normal sRGB conversion, and both versions get that same decode.

## Test set: 12–15 logos with originals

| Group | Logos | Covers |
|---|---|---|
| Small lettering | 3 | A tagline in a second colour; ®/™; small text under a wordmark |
| Thin outlines | 2–3 | An outline around a fill; 1–2 px lines in their own colour |
| Similar brand colours | 2–3 | Tints side by side; two near-identical blues or greys |
| Gradients | 2 | A gradient behind text; a gradient mark |
| Low resolution | 3–4 of the above | Small PNG, JPEG 75 and JPEG 40 versions |

**Files:** name each `group__name.png` (or `.jpg`), with the original as `group__name.svg` (text converted to outlines) or `group__name.truth.png` (at least 4× the upload's size). Logos without an original are skipped, because colours can't be judged without ground truth.

## What is measured, per version

| Measure | How |
|---|---|
| Colour fidelity | Mean and maximum ΔE2000 over the original's flat colours; merged brand colours |
| Missing colours | Original colours (at least 0.1% of the artwork) with nothing within ΔE 10 in the result (`missingColours`, from PR #6) |
| **Present in the upload?** | Each missing colour is checked against the upload: at least 3 pixels, or 10% of the pixels it covers in the original, within ΔE 6 (ΔE 10 for compressed uploads). If not, it was **destroyed before Vectorize saw the file**: it's listed, but losing it isn't a regression, and it must not be invented. |
| Geometry | Detail missing + added against the original (2×, ½ px tolerance); edge agreement |
| Lettering | Merged, broken, missing and extra shapes against the original (`compareShapes`) |
| Path complexity | Paths and segments |
| Export integrity | SVG, PDF and DXF for print, web and cutting, plus PNG, all valid |
| Suggestion | What the background improver would offer, and the suggested version's error against the original. **Best available** is the better of the first result and the suggestion: what a customer can get by accepting it. |

## Improved, unchanged or regressed

Each logo is sorted by the differences that matter. Smaller ones are anti-aliasing noise:

| Change | Counts when |
|---|---|
| Detail error | more than 1 point, and more than 10% of the before value |
| Edge agreement | more than 0.01 |
| Mean colour ΔE | more than 1 |
| Merged colours | any change |
| Missing colours **present in the upload** | any colour lost or recovered |
| Shapes merged, broken, missing or extra | any change |
| Segments | more than 50% *and* more than 50 |
| Exports | valid ↔ invalid |
| Suggestion | a different (or no) suggestion that moves the best available error by a meaningful amount (as for detail error) |

The outcome is **identical** (same SVG), **unchanged** (only noise), **improved**, **regressed** or **mixed** (both better and worse). Every changed logo gets an enlarged (8×) side-by-side of the spot that changed most: upload, original, before and after. The HTML report groups logos by outcome.

## First results (synthetic and fictional artwork only)

41 uploads: 4 fictional sample logos (bloom, harbour, kestrel, summit) and the barron wordmark (origin unverified, classified as such until its source and permission are confirmed), in PNG, JPEG 75 and JPEG 40; plus the validation, similar-colour, gradient and transparency cases. **39 identical to `main`, 2 mixed, 0 regressed, 0 improved, 0 failed.** The two mixed results are the grey tagline, PNG and JPEG 75; see `docs/defects/grey-tagline-validation.md`. None of this is customer artwork.

## Release rule (proposed)

PR #6 + #7 can be merged when:
1. **No meaningful regression** on any real logo. A *mixed* result needs a reviewer's decision, with the pictures.
2. **No colour present in the upload is lost** that `main` kept.
3. **No colour is invented** that the original doesn't have. (A new colour in the result must appear in the original.)
4. **All exports stay valid.**
5. **JPEG quality 40 is reported, not decisive.** Heavy compression destroys colour information.

## Known limitations

- **JPEG quality 40:** thin coloured text loses its colour in the upload itself. Such colours are listed as "not in upload".
- **Lettering under 1 px:** its true colour is never shown at full strength, so the check can name an anti-aliased shade as the missing colour.
- **1 px outlines** that touch both colours they resemble are still folded into a neighbour (unchanged from `main`).
- **The "before" version** is whatever the worktree has checked out. Update it with `git -C node_modules/.cache/compare-main checkout --detach origin/main` when `main` moves.
