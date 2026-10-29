# Grey-tagline fix: results

Branch `fix/grey-tagline-blend`, stacked on PR #6 (`acceptance-missing-colour`), which adds the missing-colour acceptance check and the regression test. The defect, its root cause and reproduction are in `docs/defects/grey-tagline.md`.

## What changed (`src/palette/quantize.ts`)

`dropBlendClusters` still finds candidate fringe colours as before: small, thin, and a mix of two other colours. A candidate is now folded away only when its **position and shape** also say "fringe":

| Situation | Decision |
|---|---|
| Most of its pixels lie between the two colours it mixes (both within 2 px) | **Fringe**, unless it's a consistent band 2 px or wider (a real outline) |
| Elsewhere, and an exact anti-aliasing mix | **Fringe**: a thin line of one colour drawn across pixel boundaries |
| Elsewhere, and matching only the JPEG chroma test | **Artwork** if it's a distinct colour (ΔE ≥ 15 from both), forms connected strokes (with its own anti-aliased edge) and has a consistent colour. Otherwise fringe. |

When a colour is kept as artwork, the fringe pixels folded into it no longer pull its average towards the background. All other colours average exactly as before.

### How the rules were reached

Each of these steps failed a check, and was fixed before the results below:
1. **Adjacency alone** kept a 1 px line drawn across pixel boundaries as an extra light-blue colour (an existing pipeline test caught it).
2. **Leaving folded fringe out of every colour's average** caused large regressions. On 1 px strokes, missing detail rose from 2–10% to 29–35%; on 8 px serif text, from 22–29% to 31–54%.
3. **Connectivity of the colour cluster alone** didn't save the real rendered tagline: 10 px text is split across several clusters, so the core grey's pieces are small.
4. **No minimum colour distance** let a pale cyan JPEG halo through. On "similar colours" at JPEG 40, that added a sixth colour and took segments from 29 to 198.

## Before and after

| Check | Result |
|---|---|
| Identity test (12 image × setting combinations) | **Byte-identical** to `main` |
| `bench/diagnose.html` (26 cases × PNG, JPEG 75, JPEG 40: 76 results) | **All 76 identical** to `main` |
| `bench/index.html` (artwork benchmark) | **Identical** (timings excluded) |
| `bench/conditions.html` | **20/20**, with identical notes |
| `bench/parity.html` (validation group, app against harness) | **9/9** identical SVGs and suggestions |
| Unit tests | 185 pass (6 new). Type check and build pass. |

Validation cases (`VALIDATION`, traced with app defaults):

| Case | Before | After |
|---|---|---|
| Wordmark with tiny tagline, PNG | white, navy `#212c5d`; 2 paths, 256 segments; error 15.79% | white, navy `#1f2a5c`, **grey `#525965`**; 3 paths, 321 segments; **error 12.13%** |
| Same, JPEG 75 | white, navy `#292f4f`; 2 paths, 203 segments; error 15.54% | white, navy `#20274d`, **grey `#55575f`**; 3 paths, 311 segments; **error 14.40%** |
| Same, JPEG 40 | grey lost | unchanged: grey still lost |
| The other 10 validation results | — | identical |

**Additional colours and paths:** only on the tagline: one colour (the grey), one path, and 65–108 more segments, for the tagline drawn in its own colour. No other case gained a colour, a path or segments.

## Tests added (`src/palette/__tests__/quantize.test.ts`)

- The thin grey tagline keeps its grey, and nothing else is added.
- Anti-aliased edge colours (navy→white, grey→white) are still folded away.
- JPEG chroma fringes (dark like navy, tinted like orange) with noise are still folded away.
- A 2 px outline in its own colour between two colours it happens to mix is kept.
- A thin line drawn across pixel boundaries (an exact 50% mix) is not a new colour.
- A blurred two-pixel edge between two colours is still folded away.

## Limitations

- **Heavy JPEG (quality 40):** the grey tagline is still lost. Its colour is so smeared that it doesn't stand apart from the fringe.
- **Kept colour slightly off:** the kept grey is `#525965`, not the exact `#495057`, about ΔE 5 (under the acceptance check's limit of 10).
- **1 px outline touching both mixed colours:** such an outline (for example, grey around navy letters on white) is still folded, as before. Only bands 2 px or wider are kept.
- **Not yet tested on real logos.**

## Dependency on PR #6

This branch is stacked on PR #6 and depends on it: PR #6 adds the grey-tagline regression test (as `it.fails` while the defect was open) and the missing-colour acceptance check. This branch converts that test into a normal passing regression test (`quantize: thin lettering in its own colour (grey-tagline regression)`), without deleting it. Merge PR #6 first. GitHub then retargets this pull request to `main`.
