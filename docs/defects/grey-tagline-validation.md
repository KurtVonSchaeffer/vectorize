# PR #6 + #7 validation: investigation of the two findings

Case: `wordmark with tiny tagline` (`bench/cases.ts`, `VALIDATION`): navy "Harbour" (Georgia 40 px) over a grey tagline, "COFFEE · ROASTERS · EST 1998" (Arial 10 px, #495057), 360×120. Both engines were run in the same page on the same decoded upload (`bench/compare.html`, `main` from a worktree). Errors are detail missing + added against the original SVG, at 2× with ½ px tolerance.

## 1. The JPEG 75 lettering suggestion that disappears

### What triggered it on `main`
The background improver offers an alternative only if `isImprovement` passes (`src/vectorize/improve.ts`). The main condition is that the alternative's score against the upload is **at most half** the first result's.

| | First result (upload score) | Best lettering alternative | Ratio (≤ 0.5 to offer) | Offered |
|---|---|---|---|---|
| `main` | 2.84 | Arial Bold rebuild: 1.37 | **0.48** | yes |
| PR #6 + #7 | 1.63 | Helvetica Bold rebuild: 0.99 | **0.60** | no |

### Why it's no longer met
1. **The first result is much better.** The grey tagline is now traced instead of merged into navy: the upload score went from 2.84 to 1.63, and the error against the original from 17.7% to 14.9%. Halving a better result is harder.
2. **The text recognition reads the tagline differently.** OCR (`findText`) is given the result's colours, which now include the grey:

   | | OCR lines | Effect |
   |---|---|---|
   | `main` | "COFFEE ROASTERS EST", "1998" | one candidate covers most of the tagline |
   | PR | "EST 1898", "COFFEE", "ROASTERS" | three one-line candidates, each rebuilding only part of the tagline (ratios 0.83–0.93); **1998 misread as 1898** |

   The improver evaluates each line's rebuild separately, so no single candidate does enough.

### Does the reconstruction still work on the new result?
Yes, and better than `main`'s, but it isn't offered:

| Candidate, on the PR result | Error vs original | Colours | Upload-score ratio | Offered |
|---|---|---|---|---|
| First result | 12.9%* | white, navy, grey | — | — |
| **All tagline lines rebuilt together** (top match or Arial) | **4.6%** | white, navy, **grey kept** | 0.58–0.61 | no |
| One line rebuilt alone | 9.8–10.4% | white, navy, grey | 0.83–0.93 | no |
| *For reference: `main`'s offered Arial Bold rebuild* | *9.2%* | *white, navy (**grey lost**)* | *0.48* | *yes* |

\* Font matching and AI sharpening on this tiny text vary slightly between runs (first result 12.9–14.9%; `main`'s candidates Arial Bold / Mona Sans Bold in one run, Arimo / Arial in another).

### Regression or better recommendation?
**Both:**
- **Default result (what everyone gets):** better, 17.7% → 14.9%, with the correct grey.
- **Best available to a customer who accepts suggestions:** worse, 9.2% → 14.9%, because no suggestion is offered. `main`'s suggestion was geometrically better but in the wrong colour (the grey became navy).
- **The best reconstruction now exists** (4.6%, correct colour), but the per-line evaluation and the 50% rule don't surface it.
- **Wording risk:** with the new OCR reading, a rebuild would write "EST **1898**". The pixel score barely registers one wrong digit (the 4.6% includes it). Any lettering suggestion must be checked against the text, not just the pixels.

## 2. Fragmented lettering

### Which letters
The shape check flagged one letter in PNG and two in JPEG 75. Located against the original's glyph positions:

| Upload | Letter | Position (px) | Colour map before tracing | Vector outlines in the result |
|---|---|---|---|---|
| PNG | "O" of ROASTERS | x 89–96, y 83–91 | 1 connected region | 1 outline, 12 px² (expected ~22): **pinched**, wedges meeting at points |
| JPEG 75 | first "S" of ROASTERS | x 136–142 | 1 connected region | **2 separate outlines** |
| JPEG 75 | "S" of EST | x 164–170 | 1 connected region | **2 separate outlines** |

All three are deterministic: the same in every run.

### Where it happens
**In path tracing, not colour segmentation or cleanup.**
- In the final colour map, each letter is one connected grey region (8-connected).
- The traced outlines are split (S) or pinched (O). At a 10 px size, the strokes are about 1 px wide, and where they curve, their pixels connect only diagonally. Contour extraction treats diagonal-only joins as separate shapes, or pinches them to a point (the same "bow-tie" pieces noted in `docs/v8-proof-of-concept.md`).

### Separate paths, or visibly broken?
Visibly broken, at 16×:
- **`main`:** shards, letters unrecognisable;
- **PR:** the right letters in the right grey, but the O is a pinched bow-tie and the S is two pieces.

The fix makes this lettering appear; it doesn't create the breakage, which comes from tracing ~1 px strokes and also affects `main` (as shards). It still isn't acceptable for production at signage scale.

## 3. Proposed fixes, lowest risk first

| # | Fix | Risk | Expected effect |
|---|---|---|---|
| 1 | **No engine change; document.** Ship PR #7 for the better default result; note that this case loses an optional suggestion. | Lowest | Default better; suggestion lost on this case |
| 2 | **Evaluate the lettering lines of a logo together**, as one additional candidate ("all 0.5–0.85 matches"), besides per line. Bench-validate before the app. | Low–medium: improver only | Here 4.6%, but ratio 0.58, so still not offered under the 50% rule; only helps together with 3 |
| 3 | **A lettering-specific offer rule:** for lettering candidates, also accept a ratio ≤ about 0.65 when edge agreement reaches 0.99 or more. Revalidate on the 89-pair V7 set (must stay at 0 worse offers). | Medium: changes what's offered | Would offer the 4.6% rebuild here |
| 4 | **Text check before offering any lettering rebuild:** compare OCR text from two readings (with and without the result's colours, or upload vs sharpened); don't offer when they disagree ("1998" against "1898"). | Medium | Prevents wrong-wording suggestions; needed before 3 |
| 5 | **Give OCR colours from the upload, not the trace palette**, so recognition doesn't change when the palette does. | Medium–high: changes font matching broadly | Stable OCR between versions |
| 6 | **Tracing: keep diagonal-only joins in thin strokes connected** (bridge diagonal pixel pairs in a thin layer before contouring, or join them when fitting). | High: core tracer; needs the full identity and benchmark cycle | Fixes broken and pinched small letters (also on `main`) |

Recommended order: **1 now** (PRs stay open); then **4 + 2 + 3** together as one bench-validated improver change; **6** as a separate tracer project (it overlaps with V8's work on bow-tie pieces).
