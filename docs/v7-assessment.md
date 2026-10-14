# V7 assessment: baseline and plan

This is the technical assessment for V7 and a measured baseline of the engine after V6. Nothing in the engine was changed for it.

Measurements come from:
- **`bench/assess.html`**, one experiment per V7 goal (`?exp=proxy|typo|lowres|colour|complexity`).
- **`bench/diagnose.html`**, unchanged.
- **`bench/profile.test.ts`**, a CPU profile (`PROFILE=1 npx vitest run bench/profile.test.ts`).
- **`bench/real.html`**, the new real-logo harness.

"Error" below means ink missing + ink added, in percent of the artwork's detail, against ground truth at 4× (½ px tolerance), unless stated otherwise.

## 1. Real customer logos

**Ready: `bench/real.html`.** Drop any number of logos onto the page; files stay in the browser.
- Each logo is vectorized with the app's automatic settings and scored against the upload.
- When the customer's original vector is added as an SVG with the same name, it's also scored against that.
- Results export as JSON or CSV, and can be saved as a baseline that later runs compare against, per file.

It was checked on the benchmark artwork (PNG and JPEG files with their SVG originals, plus an SVG on its own): 4/4 scored, no failures.

**Blocked on input:** I need 20–50 real logos (with permission), ideally including some original vectors. Until then, every number in this document comes from synthetic artwork.

## 2. Typography, 6–8 px lettering

Baseline at JPEG 75:

| Text | Error | Edge F1 |
|---|---|---|
| Sans 6 px | 31.4 | 0.87 |
| Sans 8 px | 18.8 | 0.91 |
| Serif 8 px | 26.4 | 0.85 |
| Serif 12 px | 9.3 | 0.95 |

Causes:
- **Too few pixels per stroke for tracing at 1×.** The same image sharpened with the app's existing AI model (2×) before tracing:

  | Text | 1× | AI 2× |
  |---|---|---|
  | Sans 6 px | 31.4 | **3.6** |
  | Sans 8 px | 18.8 | **2.2** |
  | Serif 8 px | 26.4 | **3.5** |

  That's 2× is 4–10 s per image once the model has loaded.
- **The font is misidentified at 8 px and below**, although OCR reads the words correctly at every size:

  | Text | True font | Best match | Score |
  |---|---|---|---|
  | Sans 6 px | Arial Bold | Fredoka Bold / Tajawal Black | 0.53 / 0.80 |
  | Sans 8 px | Arial Bold | Open Sauce Two Black / Tahoma Bold | 0.84 / 0.83 |
  | Serif 8 px | Georgia | Optima / Athelas | 0.79 / 0.73 |
  | Serif 12 px | Georgia | Markazi / Vollkorn | 0.80 / 0.76 |

  Arial is identified correctly from 10 px, Georgia from 16 px. Matches below 0.8 aren't rebuilt automatically.
- **Rebuilding with the closest match helps even when the font is wrong:**

  | Text | Traced | Rebuilt |
  |---|---|---|
  | Serif 8 px, JPEG | 26.4 | **9.1** |
  | Serif 12 px, JPEG | 9.3 | **4.9** |
  | Sans 8 px, PNG | 19.7 | **9.7** |

  Some words aren't placed, and OCR sometimes splits one line into two.

## 3. Low-resolution artwork

| Case | Off | AI 2× | AI 4× |
|---|---|---|---|
| Badge 120 px, PNG | 11.9 | **1.5** | 7.6 |
| Badge 120 px, JPEG 75 | 13.6 | **22.3 (worse; 638 segments vs 196)** | 4.0 |
| Badge 200 px, PNG | 7.2 | **0.9** | 1.8 |
| Badge 200 px, JPEG 75 | 9.2 | 3.3 | **1.4** |

- **AI time** (in-browser, multi-threaded WASM): 2× takes 4–10 s per image, 28 s on first use including the 8 MB download. 4× takes 25–100 s and a 55 MB download.
- **A plain high-quality resize instead of AI is unreliable.** It sometimes matches the AI (sans 8 px: 19.7 → 3.0) but failed badly in 2 of 10 cases (6 px sans and 8 px serif PNG: 62–74% missing). Smooth resampling leaves too few solid pixels of the true colour, so text is drawn in a pale blend. At 4× the badge's segments rise to 2,000–3,000.
- **Below about 150 px**, AI 2× is the most effective tool measured, but it can reproduce JPEG blocks as shapes.

## 4. Colour preservation

| Case | PNG | JPEG 75 | JPEG 40 |
|---|---|---|---|
| Tints not touching (ΔE 2.9 and 6.4) | **2 pairs merged** | 1 merged | 1 merged |
| Adjacent tints ΔE 3.4 / 4.4 | kept | kept | 1 merged (ΔE 3.4) |
| Two-tint logo with text | kept | kept | kept, plus **1 noise colour** (4 vs 3), 179 vs 96 segments |
| Flat tint beside gradient (ΔE 4.7) | kept | kept | kept, plus 1 noise colour |

Remaining weaknesses:
- Tints that don't touch merge even at ΔE 6.4, because the default merge distance is ΔE 10 and V6 needs a shared boundary.
- Heavy JPEG adds a noise colour.

## 5. SVG complexity

Across 76 outputs (10,457 segments):
- **The output itself has little redundancy.** 1.7% of segments are tiny (< 0.5 px), none are collinear lines, and 7.2% are curves that could be written as lines (saves bytes, not nodes).
- **JPEG compression drives the excess complexity, without any gain in accuracy.** Segments at JPEG 40 compared with PNG:

  | Case | PNG | JPEG 40 | Error (PNG / JPEG 40) |
  |---|---|---|---|
  | Radial disc | 19 | 149 (×7.8) | 0 / 0.6 |
  | Corners | 32 | 82 (×2.6) | |
  | Logo on white | 30 | 50 | |
  | Scene | 770 | 1,062 | |

  On the corners case, exact-shape snapping stops working under heavy compression, so edges are traced as wobbly curves.
- **Text and thin-line outputs are near-minimal:** 90–170 segments per line of small text.

## 6. Processing performance

Node, after JIT warm-up, sampling profiler (about 2% overhead):

| Image | Time per run |
|---|---|
| Badge 1200×800 | 1.6 s |
| Badge 2000×1333 | 4.0 s |
| Lettering 1200×800 | 1.7 s |

Where the time goes (self time):

| Function | Share | Note |
|---|---|---|
| `majorityFilter` (noise filter) | 14–17% | Every pixel counts its 3×3 labels, even inside uniform areas. |
| `quantize` main loops | 11–15% | |
| `blur` (edge smoothing) | 6–21% | A full-image blur per colour layer, including areas the colour doesn't touch. |
| `separateRegions` + `pair` (V6 colour rule) | 8–12% | Full-image adjacency pass whenever any pair is a merge candidate. |
| `removeSpecks` | ~5% | |
| `traceLabels`, `contours` | 11–13% | |
| `insideLoop` (V6 small-outline check) | ≤ 4% | |
| `keepThin` (V6 thin-line pass) | 2.5–4% | |
| Curve fitting | 2–16% | The higher share is on lettering. |

None of these is fundamental, so each can be made faster without changing the output. That can be verified byte for byte: SVG output identical before and after.

## 7. Automatic quality assessment and retry

Can a score computed only against the upload (no ground truth) choose between candidate results? Measured on the diagnostic cases:

- **Across all runs:** Spearman correlation with truth error is 0.58 (wrong-pixel share), 0.59 (ink missing + added vs upload) and 0.35 (edge F1).
- **Retry over Detail** (0.25 / 0.5 / 0.75, 76 image–format pairs). The best possible choice per image lowers mean truth error from 8.88 to 8.51.

  | Rule | Images better | Images worse | Mean error |
  |---|---|---|---|
  | Lowest upload score | 21 | 13 | 8.71 |
  | **Only when the upload score improves by ≥ 50%** | **13** | **0** | **8.67** (57% of the possible gain) |

- **Rebuild lettering vs keep traced letters:** the upload score agrees with truth in 12 of 14 cases (one tie; one 16 px case where it prefers a slightly worse rebuild).
- **AI 2× vs off:** agrees in 9 of 10. The miss is the JPEG case where 2× is worse: the AI sharpened the compression blocks, and the upload-based score rewards reproducing them.

**Conclusion:** a quality-gated retry is feasible and safe with a margin. It needs extra guards for JPEG uploads, such as segment growth or input quality, because judging against the upload rewards faithfulness to its defects.

## Proposed V7 plan (in order)

Every step is measured with these pages, plus the real-logo set once supplied. It ships only with no regression on any diagnostic case (PNG, JPEG 75, JPEG 40), the conditions suite at 20/20, and unchanged exports.

1. **Real-logo baseline** (needs your logos). Run `bench/real.html`, save the baseline, and re-check every step below against it.
2. **Quality-gated retry framework** (the largest measured gains). Candidates come only from features the app already has:
   - Detail ±0.25.
   - AI 2× sharpening, for images ≤ 300 px or fine-stroke artwork.
   - Lettering rebuilt with the closest font, even below the 0.8 threshold.

   A candidate replaces the default only if its upload score improves by ≥ 50%. JPEG guards (segment growth, input quality) prevent accepting compression artefacts.

   Targets: 6–8 px text error from 19–31 to under 5; 120–200 px badges from 7–14 to under 4; zero regressions on the diagnostic set.

   **Decision needed:** running AI 2× automatically adds 4–10 s, and a one-time 8 MB download, to affected images. It could run automatically, run in the background after a first result, or stay opt-in with a suggestion.
3. **Typography.** Match fonts on the sharpened (2×) text when the image is small; keep OCR's words on one line when they share a baseline; place more of the words that are currently skipped. Target: correct font family at 8 px for the Arial and Georgia cases.
4. **Complexity on compressed input.** Make exact-shape snapping and curve fitting tolerant of JPEG edge noise. Target: JPEG 40 segment counts within 1.5× of PNG (radial disc 149 → ≤ 30, corners 82 → ≤ 40) with no loss of accuracy. Optionally write near-straight curves as lines (about 7% fewer bytes).
5. **Colour.**
   - Keep tints that don't touch apart when both are solid, exact (lossless) colours at least ΔE 5 apart, with a gradient guard.
   - Suppress noise colours on heavy JPEG.

   Targets: "tints not touching" PNG merged pairs from 2 to 0; no extra colour on JPEG 40.
6. **Performance, with identical output.** Fast path in `majorityFilter` for uniform neighbourhoods; blur only around each layer's area; limit `separateRegions` to candidate colours. Target: 30% less time at 1200–2000 px, verified by byte-identical SVGs on every case.

**Not recommended:** a plain resize instead of AI (unstable), and AI 4× by default (25–100 s).
