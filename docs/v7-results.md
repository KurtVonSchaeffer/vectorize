# V7 results: background improvement, typography and speed

Built on the V7 assessment (`docs/v7-assessment.md`). All numbers come from synthetic test artwork; **no real customer logos have been tested yet**, so none of this is evidence of production readiness.

## 1. Quality-checked background improvement

How it works:

1. **The first SVG appears exactly as before.** Nothing waits on the improver.
2. **The check starts once that result is final:** traced with the current settings, after the automatic lettering match has finished. It runs in its own worker (`useImprover`, `src/useImprover.ts`), so the preview never waits.
3. **It tries the alternatives** (`alternatives` in `src/vectorize/improve.ts`), using only features the app already had:
   - Detail ±0.25.
   - AI 2× sharpening, only for images ≤ 300 px or fine-stroke artwork (`worthSharpening`).
   - Lettering rebuilt from the closest font, when the best match scores 0.5–0.85.
4. **Each alternative is scored against the upload** (`scoreAgainstUpload`, `src/quality/render.ts`). It's offered only if `isImprovement` passes:
   - the score at least halves, and improves by at least 0.3 points;
   - segments at most double;
   - no extra colours;
   - edge agreement isn't worse (by more than 0.01).
5. **The best passing alternative is offered** in a result-card note: "A cleaner version is ready: … **Use it**". After switching: "Using the cleaner version … **Go back**". The customer's SVG is never replaced automatically. If nothing passes, nothing is shown.
6. **It runs once per image** and never second-guesses a setting the customer chose. A new upload cancels the background work (the worker is stopped), and a result from an older image can't reach a newer one (a run counter checks each step). Changing a setting before using an offer withdraws it.

**AI sharpening** is cached per image by the existing enhancer. When the customer uses an offer, the sharpened version appears instantly, and the model is downloaded once per browser.

### Validation of the 50% rule

89 image–format pairs: the 26 diagnostic cases, plus 5 new ones (JPEG saved as PNG, small transparent logo with text, small gradient logo, thin-line icon, wordmark with a tiny tagline), each as PNG, JPEG 75 and JPEG 40. Every option was measured against ground truth.

| Rule | Offers | Truly better | Worse | Total truth gain |
|---|---|---|---|---|
| 50%, guards on compressed files only (first version) | 23 | 20 | 1 (3 px strokes PNG: AI, 36 → 351 segments) | 214.8 of 391.3 |
| 50%, no guards | 34 | 28 | 4 (1 px strokes JPEG 7.8 → 19.0; 120 px badge JPEG 13.6 → 22.3; dots JPEG 0.4 → 3.3; 3 px strokes) | 245.7 |
| 35% / 65% ratio | 21 / 23 | 18 / 20 | 1 / 1 | 207.2 / 214.8 |
| **50%, guards on every image (shipped)** | **22** | **20** | **0** | 215.4 |

On the final code, with fonts also read from the sharpened copy:

| Measure | Result |
|---|---|
| Offers | 19 |
| Truly better | 16 |
| Worse | **0** |
| Neutral | 3 |
| Mean truth error, first results | 8.39 |
| Mean truth error, if every offer is taken | **6.12** |

Largest wins:

| Case | First → offered |
|---|---|
| Sans 6 px, PNG / JPEG 75 | 30.9 → 3.8 / 31.4 → 3.6 |
| Sans 8 px, JPEG 75 / 40 | 18.8 → 2.2 / 16.3 → 2.1 |
| Serif 8 px, PNG / 75 / 40 | 24.0 → 3.4 / 26.4 → 3.4 / 31.2 → 5.3 |
| Dots, JPEG 40 | 17.0 → 3.6 |
| Badge 120 px PNG / 200 px PNG | 11.3 → 2.1 / 7.3 → 1.2 |
| Tiny tagline, JPEG 75 / 40 (rebuilt in Arial / Helvetica Bold) | 13.7 → 6.3 / 17.3 → 7.9 |

**What the rule can't see** (about half of the possible gain): when the first result already matches the upload almost exactly but is wrong against the real artwork. For example, 1.5 px lines are drawn slightly too thick, but match the upload's own blur. A score against the upload can't recognise detail finer than the upload itself. Real logos will show whether this matters in practice.

### JPEG protection

- **Compression detector** (`compressionRipple`): it measures JPEG ringing, small ripples around edges. Measured 0–0.04 on clean flat PNGs and 0.07–0.34 on JPEG at quality 40–95, so it recognises JPEG content saved as PNG. Dithered gradients also ripple.
- **Guards:** applying the segment, colour and edge guards to every image validated better than applying them only to detected JPEGs (0 worse vs 1), so the decision no longer depends on the detector. It's kept for the benchmarks.
- **What the guards stop:** reproducing compression blocks or noise (segment growth), extra colours, and worse edges. Only those combined with a 50% better score get through.

## 2. Typography (6–8 px)

- **Fonts are read from the AI-sharpened copy for small images** (shared with the improver, so there's no extra AI run). The correct family was found in **7 of 8** small-text cases, against **0 of 8** before:

  | Text | Before | After |
  |---|---|---|
  | Sans 6–8 px | Fredoka, Tajawal, Open Sauce, Gabarito | Arial Bold |
  | Serif 8–12 px | Nobile, Optima, Vollkorn | Georgia |

  Letters are still placed in the original image's pixels, and the OCR scale accounts for the 2×.
- **Automatic rebuild only at a match of 0.85 or above** (was 0.80). Wrong fonts were measured at up to 0.84, correct ones at 0.85 and above. From 0.5 to 0.85 a rebuild is only offered, after the quality check, and never substituted silently.
- **Result:** sans 8 px PNG now gets Arial Bold rebuilt automatically, and its first result went from 19.7 to **4.2**. Georgia rebuilds are offered for serif text when they score better.
- **Wording:** OCR can misread characters (it read "2026" as "2028" on a 200 px JPEG badge). Such a line is now offered (score 0.80), not substituted, and the quality check compares it against the upload.

## 3. Performance (identical output)

Optimisations, each verified byte-for-byte with `bench/identity.test.ts` (12 image × setting combinations):
- Noise filter: stops at the second matching neighbour.
- Blur: limited to each colour layer's bounds.
- Colour separation: measures only candidate colour pairs.
- Small-outline check: bounding-box test before the point-in-loop test.

| Image (`runFlat`, best of 12) | Before | After |
|---|---|---|
| Badge 600×400 | 83 ms | 68 ms (−18%) |
| Badge 1200×800 | 327 ms | 240 ms (−27%) |
| Badge 2000×1333 | 910 ms | 639 ms (−30%) |
| Lettering 1200×800 | 422 ms | 320 ms (−24%) |

Every output is identical. This recovers V6's 11–26% slowdown.

Background improvement time, after the first result:

| Part | Time |
|---|---|
| Tracing and scoring the alternatives | median 0.6 s, 90th percentile 1.5 s, max 4.3 s per image |
| AI sharpening, only for small or fine images | 4–10 s per image |
| First use in a browser | about 20–30 s more (8 MB model download and start-up) |

All of this runs in workers, so the interface stays responsive.

## 4. Other suites (unchanged results)

- **`bench/diagnose.html`:** every case equals its final V6 value, segment counts included.
- **`bench/index.html`:**

  | Output | Mean error |
  |---|---|
  | Logo | 0.17 |
  | Badge web | 1.24 |
  | Badge print | 1.28 (503 segments) |
  | Scene | 1.02 |
  | Ink | 16.24 |

- **`bench/conditions.html`:** 20/20.
- **Unit tests:** 158 pass (2 opt-in profiling and identity tests skipped). Production build passes.

## Release checks (before recommending a merge)

| Check | Result |
|---|---|
| Unit tests and build | 158 pass; production build passes. |
| Optional tests | `IDENTITY=check`: every output byte-identical to before the performance work. `PROFILE=1`: runs; 646 ms per run at 1200×800, 1.3 s at 2000×1333 (with the profiler attached). |
| UI responsiveness | Measured from upload to offer on 8 px serif text, with a long-task observer and a 50 ms timer. Font matching (which predates V7) blocked the main thread for about 850 ms in tasks of up to 240 ms. It and lettering placement now pause regularly (`yieldToPage`, using `scheduler.yield` or a `MessageChannel`, which hidden tabs don't slow down), with identical matches. After the first result: long tasks 16 → 3, longest 501 → 151 ms, total blocked 2.4 → 0.37 s, timer lateness 1 ms at the 95th percentile. The first result itself has no long tasks. |
| Rapid uploads | Four images dropped 300 ms apart. Only the last one's check ran, and in the 80 s after, no offer from the earlier images appeared, although two of them would have produced one. |
| AI failure / offline | Sharpening forced to fail on every call. Font matching falls back to the original image; the improver skips the candidate silently; the result stays Ready and both downloads stay enabled. Choosing AI 2× manually shows "Sharpening failed, so we used the original image" and resets the setting to Off. |
| Exports | Original and AI-sharpened versions of the 200 px badge, for print, web and cutting: all 12 files valid (SVG parses and renders; PDF complete, with one page and one filled plate per ink; DXF has outlines; PNG signature correct). Generated in the page rather than downloaded through the buttons. |
| V6 benchmarks | `bench/diagnose.html`: every case equals its V6 value, segment counts included. `bench/index.html`: unchanged. `bench/conditions.html`: 20/20. |
| Memory | Main-thread heap over 8 consecutive uploads (all through font matching, AI and the check): 18 → 110 MB at peak, back to 39–53 MB. It doesn't grow image after image. Caches are bounded (AI results ≤ 12, trace results ≤ 8), and temporary bitmaps are now released. The AI worker keeps its model and WASM memory between images; the browser process peaks at about 0.5–0.8 GB while it runs. The browser's combined page-and-worker memory API isn't available in this test browser, so worker memory was read from the operating system's figures, which macOS compression makes approximate. |

## Remaining limitations

- **Synthetic artwork only.** The 50% rule, the 0.85 font threshold and the guards are tuned on generated test images. They must be re-checked on real logos (`bench/real.html`) before production.
- **Gains the upload score can't see:** about half of the measurable gain is never offered, because the upload-based score can't see it (see above).
- **AI time:** sharpening takes 4–10 s per small image, plus a one-time download. The first result isn't delayed, but the offer, and for small text the font match, arrive after it.
- **The enhancer worker isn't stopped on a new upload** (reloading the model costs more than finishing). A stale sharpening run can delay the next image's sharpening by a few seconds. Its result is never used for the new image.
- **Fonts:** at 6 px, OCR still splits or misreads words. 8 px serif matched Georgia at only 0.62–0.80, so it's offered, not rebuilt automatically.
- **AI memory:** the AI worker keeps its model (and about 0.5 GB of WASM memory at peak) for the rest of the session after the first sharpening. On low-memory devices it may be worth releasing it after a period of inactivity.
- **Mixed-content images:** where OCR mistakes shapes for text, a lettering alternative may be scored. It was rejected in every validation case, but it adds background time.
