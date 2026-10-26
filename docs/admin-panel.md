# Admin panel mode

The Layout team uses the vectoriser from a tab in Barron's admin panel. In that build the app records every run and the artist's verdict, so the success rate can be shown per complexity band and default settings can be learned from what the artists do. Live in the admin panel on 2 November 2026; the customer website follows once a band meets the minimum success rate.

## Switching it on

| Setting | Effect |
|---|---|
| `VITE_ADMIN_MODE=on` | Admin panel build. `preview` lets `?admin=on` switch it on for one visit; the dev server honours `?admin=on` too. |
| `VITE_RUNS_API_URL` | The vectoriser microservice. Unset, runs and reviews are kept in this browser (`localStorage`, no files), which is enough for internal testing. |
| `VITE_ENGINE_VERSION` | The build's commit, stored with every run so a change in results can be traced to a change in code. Unset: `dev`. |

In admin mode:
- **Quality reporting is always on** (`assessFidelity` checks every result against the upload).
- **Straight edges and fine detail are always on** ([straight-edges.md](straight-edges.md), [fine-detail.md](fine-detail.md)): straight runs become exact lines instead of wavy curves, and thin lines keep their width.
- **Wordmarks in two weights are rebuilt in both** (everywhere, not only in the admin panel): "barron.com" is Quicksand Bold then Quicksand Light, read as one word. The light letters used to fail the bold match and keep the whole word traced; now they're placed again in the family's other weights (`splitByWeight`, `weightSplitRange` in `src/fonts/lettering.ts`) and become a word of their own when one fits every letter.
- **AI sharpening is tried on uploads up to 600 px** (300 px on the public site; `ADMIN_SHARPEN_BELOW` in `src/vectorize/improve.ts`): logos pasted from websites and emails are often 300–600 px. The first vector still shows straight away; the sharpened version is traced in the background and offered only when the offer rule says it's clearly better. Small lettering is also read from the sharpened copy.
- **Lettering suggestions start at a 70% match** (85% on the public site): the artist chooses whether to rebuild a line from the font, so near misses cost a click, not a bad print.
- **A font the artist picks from the list counts as their choice** (the looser `MIN_OVERLAP_NAMED` fit, as for a font typed by name). If it still doesn't line up, the same family's other weights are tried, nearest first (`placeLineInFamily`), and the artist is told which weight was used. On a 560 px JPEG of the Barron logo, "com" was refused at the strict fit (48.7% overlap against 60%) and is now rebuilt in Quicksand Light, with a "check the wording" note because the "." merges into the "c" at that size.
- **Two-weight wordmarks also split at punctuation** (`weightSplitRange`): on small uploads only some of the light letters fail the bold match, so "barron.com" at 560 px flags the "c" alone; the part after the "." is tried in the family's other weights.
- **Hatched and engraved illustrations get a shading layer** (everywhere, in Automatic artwork type): the artwork is judged without its background, so a brand-guide grid or a page around it no longer hides its texture (`artTexture` in `src/vectorize/detect.ts`, `Detection.illustration`). It's traced twice ([illustration.ts](../src/vectorize/illustration.ts)):
  - the flat tracer draws lettering, banners, rings, outlines and the background with clean edges, as for any logo;
  - full colour (VTracer, at twice the size so 1–2 px pen strokes keep their shape) draws the fur, face and hands. Texture is found on the source in 8 px blocks: busy and in 20+ shades, plus darker sparse strokes next to it; holes inside it are taken in, and its edge is rounded. Everything else is made transparent before VTracer runs, so it traces the texture only, and the result needs no clip path: the SVG is plain filled paths.
  - Inside the texture the flat map is one colour (the shading covers it), which spares the flat tracer thousands of fragments.
  - The shading's path data is compacted (`compactPath`): VTracer writes straight lines as curves and every point in absolute coordinates; they become `h`/`v`/`l` and relative steps, to 0.1 px of the 2× trace. Same shapes, 60% fewer bytes.
  - Print plates and cut files keep the flat colours only (6 on the Gorilla Glue logo), which a screen printer or cutter can use.

  Gorilla Glue logo (1200×750 on a gray grid), measured with SSIM on luminance:

  | | Paths | SVG | Texture vs previous |
  |---|---|---|---|
  | Shading over the whole image, clipped | 12,616 | 6.07 MB | |
  | Shading traced from the texture only | 8,092 | 3.70 MB | 0.99 |
  | + compacted path data | 8,092 | 1.47 MB | 0.99 |
  | + specks under 3 px (2×) merged (Detail +¼ instead of +½) | 4,059 | 1.00 MB | 0.95–0.96 |

  It's rated complex (76) and traced in about 10–25 s. The automatic check takes 1.4 s on it (verdict "check": edges moved where the original's grid is left out, a few crossing outlines); it can still time out while the background improver is tracing alternatives.
- **Illustrations can be simplified** (Fine-tune → More options → Illustration: Detailed shading / Simplified shapes): the texture is redrawn as a few solid tones instead of the shading layer (`simplifyTexture`). The fur is averaged over 3 px (black and orange hatching reads as brown, as from a distance), clustered into 5 tones taken from the fur itself (reusing a flat colour when one is within 24), and shapes under 0.05% of the image join their surroundings. On the Gorilla Glue logo: 108 paths, 174 KB, 10 colours, against 4,059 paths and 1 MB with shading. It reads as a poster of the gorilla. The face keeps its tones but not the line work of the eyes and nose (in engraving the lines are most of the texture, so keeping dark lines turned the fur black again). Print plates and cut files of an illustration always use the simplified texture, so they no longer trace every stroke of fur.
- **Rings of round badges keep their gradient** (everywhere; `findGradients` in `src/palette/gradients.ts`): a ring shaded across its width (orange at both edges, yellow in the middle) used to fail the radial fit, which looks for the centre where the colour peaks. Ring-shaped regions are now also fitted against the distance from a circle fitted to their pixels, with the centre refined by search; and regions that still fail are tried with the centres of rings already found, as a badge's rings share one. The Gorilla Glue ring is three radial gradients around one centre (its lower arc and the two upper arcs) instead of flat bands.
- **A removed white background is still checked**: the check composites over white, so taking out paper doesn't change what it compares.
- **Clean geometry and print files are always on** ([clean-geometry.md](clean-geometry.md), [print-files.md](print-files.md)): no shape is drawn twice, and a paper background is left out of print plates and cut files. On the Barron logo this cleared "10 outlines are drawn twice"; the master SVG still keeps its white background until the artist switches on Transparent background.
- **The online font search (WhatFontIs) is off**: its free tier is for personal use only. Free and installed fonts still match.
- **Each upload records one run** once its first result has been checked, so the success rate counts what the engine did on its own.
- **A Review panel** under the image asks for usable / needs touch-up / rejected, a reason (required unless usable), minutes saved, a comment, and optionally the logo ID, case and sales order it belongs to (trimmed and upper-cased, `cleanLinks`; sent with the review and kept on the run). Saving it also marks the vector as reviewed.
- **The type of artwork** (wordmark, logo, badge, mascot or illustration, line art, photo; `ASSET_TYPES`) is part of every review, pre-selected from the detection (`suggestedAssetType`: an illustration suggests a mascot) for the artist to confirm or change. Success rates can then be read per type of artwork, the way the Layout team thinks about their work, not only per complexity band. A reason, **"Character or subject not recognisable"**, records the human verdict on recognition, the ground truth for the recreation research ([design-intent.md](design-intent.md)). Each run also stores the texture measure and whether it was traced as an illustration. Each review also has an optional **confidence** (Borderline / Fairly sure / Certain), which separates borderline rejects from hard ones, and the **vector as reviewed**: its path count and how it was made (`renderModeOf`: logo, illustration-detailed, illustration-simplified, line art, photo, pixel). The run keeps the first result, but the artist may have changed settings since. That lets acceptance, touch-up time and recognition be read against path count.
- **It's labelled for the Layout team**: "Barron Vectoriser · Layout team" in the header and page title. The rest of the wording is the public app's ("your image"), which reads fine for the artist who uploaded it.
- **Learned defaults** for the upload's profile are fetched on upload and applied to the sliders when a supervisor has approved some.

## Complexity (`src/admin/complexity.ts`)

0–100 from signals the engine already measures: artwork kind (an illustration with a shading layer counts as a photo), colour count, gradients, fine strokes (`Detection.fine`), texture (`Detection.texture`: hatching and engraving, up to 20 points), JPEG ripple (`compressionRipple`), resolution and lines of lettering. Bands: simple ≤ 30, medium ≤ 60, complex above. Every run stores the points per signal, so the weights can be checked against the artists' verdicts after two weeks.

The **profile** (`flat/medium/lossy`) groups runs for learning. It's worked out before tracing, without the colour count, so defaults can be fetched before the first trace.

## Microservice contract (proposal, to agree with Vernon)

| Route | Body | Answer |
|---|---|---|
| `POST /runs` | multipart: `run` (RunRecord JSON), `original` (the upload), `vector` (SVG) | 201 |
| `POST /runs/{runId}/review` | ReviewRecord JSON | 201 |
| `GET /defaults/{profileKey}` | | 200 `{ id, settings }` or 404 |

The database is `db/migrations/001_vectoriser_init.sql` (Azure SQL, schema `vec`): `vectorisation_run`, `run_review`, `review_reason` (seeded), `learned_profile` and the `v_run_results` view for the weekly Power BI report. `src/admin/__tests__/schema.test.ts` checks it against the app's reasons, outcomes, bands and limits.

### Power BI measures (on `vec.v_run_results`)

| Measure | DAX |
|---|---|
| Reviewed | `Reviewed = SUM ( v_run_results[is_reviewed] )` |
| Usable % | `Usable % = DIVIDE ( SUM ( v_run_results[is_usable] ), [Reviewed] )` |
| Touch-up % | `Touch-up % = DIVIDE ( CALCULATE ( COUNTROWS ( v_run_results ), v_run_results[outcome] = "touch-up" ), [Reviewed] )` |
| Rejected % | `Rejected % = DIVIDE ( CALCULATE ( COUNTROWS ( v_run_results ), v_run_results[outcome] = "rejected" ), [Reviewed] )` |
| Confidence gap | `Usable but borderline = CALCULATE ( COUNTROWS ( v_run_results ), v_run_results[outcome] = "usable", v_run_results[confidence] = "low" )`: recognisable but fragile, near the decision boundary |
| Not recognisable % | `Not recognisable % = DIVIDE ( CALCULATE ( COUNTROWS ( v_run_results ), v_run_results[reason_code] = "not-recognisable" ), [Reviewed] )` |
| Minutes saved | `Minutes saved = SUM ( v_run_results[minutes_saved] )` |
| Logged rate | `Logged % = DIVIDE ( [Reviewed], COUNTROWS ( v_run_results ) )` |

Path-count band, a calculated column for "outcome by path count": `Path band = SWITCH ( TRUE (), ISBLANK ( [final_paths] ), "Not reviewed", [final_paths] < 50, "Under 50", [final_paths] < 200, "50–199", [final_paths] < 1000, "200–999", "1,000+" )`.

Slice every measure by `complexity_band`, `asset_type` and `is_illustration`. The figure to watch after launch is the usable rate for mascots (`asset_type = "mascot"`).

Requests carry `Authorization: Bearer <token>` when the admin panel supplies one (`httpRunsApi`'s `token`). Types are in `src/admin/runs.ts`. The service keeps files in blob storage next to the logo (`{logoId}/processed/vectorised/`), and these tables: `vectorisation_run`, `run_review`, `review_reason` (pick list) and `learned_profile` (proposed / active / retired defaults per profile, approved by a Layout supervisor).

Only `detail`, `corners`, `maxColors`, `exactShapes` and `gradients` can come from learned defaults (`applyDefaults`); anything else in the answer, or a value out of range, is ignored.

## Hosting in the admin panel

- The page needs `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` for multi-threaded AI sharpening. If the admin panel can't send them, serve this build in an iframe that does.
- The AI model and onnxruntime files come from Hugging Face and jsDelivr on first use; host them alongside the build or allow those sites.

## A second engine: Vectorizer.AI (not built)

Considered as a fallback for logos the self-check marks "check" or "not suitable". Its API (`POST https://api.vectorizer.ai/api/v1/vectorize`, SVG/PDF/EPS/DXF out, `processing.max_colors` and `processing.palette`) costs about R2.40–R2.80 per production image, with a free test mode. Blockers before any customer logo is sent:
- its terms (23 Oct 2025) allow training on uploaded images and results, with no opt-out;
- no data-processing agreement or server location was found (POPIA section 72, cross-border transfer);
- the terms forbid exposing the API to third parties, which may rule out the website.

If legal clears it, it belongs in the microservice (the key must stay on a server), called only for low-confidence runs, with both vectors stored so the artists' verdicts compare the two engines.
