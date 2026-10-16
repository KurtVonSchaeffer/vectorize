# Reconstruction benchmark (V7 against V8)

`bench/reconstruction.html` compares V7 and the experimental V8 redraw on identical damaged uploads of artwork with clean original SVGs. It judges production suitability, not pixel error alone. Assessment tooling only: it changes neither engine.

## Setup

```bash
git worktree add --detach node_modules/.cache/compare-main origin/main
git worktree add --detach node_modules/.cache/compare-v8 origin/v8-reconstruction
npm run dev
```

Open `/bench/reconstruction.html`. Add `?fast` to skip the V7 app column (no AI; about 10× quicker). The worktrees sit inside `node_modules`, so they're never committed, tested or type-checked with the app.

## What's compared (fair by construction)

| Column | What | Why |
|---|---|---|
| **V7 app** | The app's first result on production `main`: AI sharpening and lettering included (`bench/improver-sim.ts`) | What customers get |
| **V7 trace** | V7's tracer on the same colour map V8 starts from | Isolates V8's reconstruction from everything else |
| **V8** | The redraw (`bench/redraw/engine.ts` on `v8-reconstruction`) from that colour map | The reconstruction under test |

**Artwork:** 21 pieces, each uploaded three ways: clean (240 px PNG), light damage (160 px, blur 0.6 px, JPEG 0.55) and heavy damage (64 px, JPEG 0.30).
- V8's 10 geometric and symmetrical test logos;
- 3 fictional sample logos (only if present locally in `node_modules/.cache/samples.json`; never committed);
- complex multicolour scenes, similar colours, gradients, lettering and a tagline, and two bird-style illustrations.

No third-party vectorizer output is used.

## Measures

| Measure | How |
|---|---|
| Evaluator pass and defects | V8's `evaluate.ts`: per-colour region overlap, edge position, corners, halos, shades, bulges and notches, topology (flat-fill originals only) |
| Valid geometry | `validateShapes` on the drawing: no open, zero-area or self-intersecting outlines |
| Cut-ready | `validateShapes` at 200 mm on the cut geometry (V7: its non-overlapping plates; V8: its planar output): no open, zero-area, self-intersecting, overlapping or sliver pieces |
| Exports valid | SVG (web, print, cut), print PDF and cut DXF as the app makes them, each parsed and checked |
| Lettering | OCR on each result rendered at 4× against the original's words (and OCR on the original, as the ceiling) |
| Colour | Mean ΔE2000 over the original's flat colours |
| Curve quality | Share of curve-to-curve joins with a 15–60° bend; segment count; V8's primitive share |
| Pixel error | Detail missing + added against the original at 4× (2 px tolerance), as one measure among many |
| Time | Per column; V7 app includes AI and the background improver, so it isn't comparable with the others |

## Reproducibility

- **Fingerprints:** each upload's SHA-256 and each engine source file's SHA-256 (`main` pipeline, quantize and trace; V8 engine, pipeline, trace and evaluate) are recorded.
- **JSON export:** **Export JSON** saves every measure and every SVG, so results can be checked independently.
- **Determinism:** uploads are generated deterministically; V7 trace and V8 are deterministic. V7 app's AI sharpening and OCR can vary slightly between runs.
- **Checked:** two runs gave identical upload fingerprints and byte-identical V7-trace and V8 SVGs on every run (see results).

## First results (16 October 2026)

Engines: `main` d666303, V8 `d0c3242`. 66 runs; 59 with results from all columns. The other 7 were classified as pixel art or photos and declined by every column (see findings).

| Group | Evaluator pass (V7 app / V7 trace / V8) | Defects per logo | Corner defects | Cut-ready | Kinked joins % | Segments |
|---|---|---|---|---|---|---|
| All (59) | 7 / 7 / 10 of 51 | 18.2 / 18.0 / 16.1 | 8.9 / 8.9 / 8.7 | 46 / 46 / 47 | 2.4 / 2.3 / 16.9 | 62 / 59 / 70 |
| Clean | 4 / 4 / 4 of 16 | 11.9 / 11.9 / 11.5 | 2.5 / 2.5 / 2.8 | 15 / 15 / 15 | 2.2 / 2.1 / 15.1 | 66 / 66 / 98 |
| Light | 3 / 3 / 4 of 19 | 27.1 / 26.5 / 25.5 | 15.2 / 15.2 / 16.5 | 16 / 16 / 17 | 2.2 / 2.0 / 12.1 | 80 / 75 / 74 |
| Heavy | 0 / 0 / 2 of 16 | 14.0 / 13.9 / 9.5 | 7.9 / 7.9 / 5.4 | 15 / 15 / 15 | 3.0 / 2.9 / 24.6 | 35 / 34 / 35 |

- **Every export** from every column is valid (59/59).
- **Lettering:** OCR finds 37 of 40 words in the originals; 4 in V7 app and V7 trace (6 wrong words); 7 in V8 (1 wrong word).

## Findings

1. **Corners** are about half of all defects in every column. V8 reduces them on heavy damage and slightly increases them on clean and light uploads.
2. **V8's curves are lumpy:** 12–25% kinked joins against V7's 2–3%.
3. **V7 app ≈ V7 trace on this set:** AI sharpening and lettering change little in the first result.
4. **Clean flat logos classified as pixel art:** the shield, the speech bubble and the similar-colours logo at 240 px clean are detected as pixel art, so they aren't traced as flat artwork at all. A production V7 defect, independent of V8.
5. **Small lettering is lost** by every column.
