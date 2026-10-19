# Lettering safeguard: text must never be silently changed

Branch `lettering-safeguard`, built on PR #6 + #7 + #8. **Not committed; for review.**

## The problem

Validation found that OCR can read "EST 1998" as "EST **1898**". A lettering rebuild would then write the wrong year, and the pixel-error score barely notices: one wrong digit is a few pixels. A professional reconstruction must never change text without evidence.

## What changed

### 1. Text evidence for every rebuilt word (`src/fonts/lettering.ts`, `src/fonts/ocr.ts`, `src/fonts/identify.ts`)
A placed word gets `doubts` when any of these say its text isn't clearly supported:

| Evidence | How | Catches |
|---|---|---|
| **Look-alike glyphs** | Each letter's real pixels are compared with the claimed character, and with its look-alikes drawn in the same font, size and place: every other digit for a digit; 0/O/Q/D, 1/I/l, 5/S, 8/B/S and so on for letters. A digit is doubtful if a rival comes within 0.03 (IoU) or better; a letter if a rival fits strictly better. | "1898" for 1998: the "8" fits 0.47, a "9" 0.68 |
| **Minimum fit** | A letter fitting the artwork below 0.4 is doubtful (correct letters measured 0.59–0.77) | text OCR "reads" into shapes that aren't text |
| **Mixed letters and digits** | A single digit among letters ("8tudio"), or a single letter among digits ("2O26") | swaps between letters and digits |
| **OCR disagreement** | OCR already reads the image several times (whole image, each colour alone) and kept only the most confident reading. The other readings of the same word are now recorded, and the original upload is read as well as the sharpened copy. Any difference marks the word as uncertain. | a pass reading "1898" or "19898" where another reads "1998" |

**Agreement is never proof.** Only the absence of any doubt lets a word through, and every rebuilt letter must still pass the glyph check.

### 2. Policy (`src/App.tsx`, `src/components/FontPanel.tsx`, `bench/improver-sim.ts`)
- **Automatic rebuild** (font match 0.85 or higher): doubtful words **stay traced**; only verified words in the line are rebuilt.
- **Background suggestions:** doubtful words are **never offered**.
- **The customer picks a font themselves:** the rebuild is applied, with a warning naming the doubtful characters, e.g. *Check the wording: "1898" ("8" could be "9", also read as "1998")*.

### 3. Multi-line lettering
When OCR splits one piece of lettering into several lines (a tagline), the lines are also tried **together** as one suggestion (`onTryLines`), in addition to each line alone. Each line is placed over its own original letters (position, letter spacing, line spacing, alignment and proportions come from the artwork). The lettering keeps the colour traced at those pixels.

### 4. Suggestion threshold for lettering
`isImprovement` takes a ratio. Lettering candidates use `LETTERING_RATIO`, which is **kept at 0.5** (unchanged) for lack of evidence (below). Doubtful text is never a candidate, whatever its score.

## Evidence

### "1998" can't silently become "1898"
- **Forged-misreading test (`bench/text-safety.html`):** real lettering read by OCR, then every digit (and common letter look-alikes) swapped in what OCR reported, with the pixels unchanged.
  - **389 of 389 forged misreadings flagged, 0 missed**, across 9 cases (the tagline in PNG and JPEG 75; sans and serif text at 10–16 px; badges). "1998" read as "1898": flagged.
  - False alarms: 2 of 31 correct readings, both genuinely uncertain (a JPEG 75 "1998" that another OCR pass read as "1898"; a "2026" whose "6" fits nearly as well as an "8").
- **The real misreading:** with the PR palette's colours, OCR reports "EST 1898". The "8" is doubtful (fits 0.47 against 0.68 for "9"), and the other passes read "1998" and "19898". It's never rebuilt or offered.
- **Unit tests (`src/fonts/ocr.test.ts`):**
  - a different reading of the same word is recorded ("1898" against "1998");
  - agreement records nothing;
  - a different word split isn't treated as a disagreement.

### Calibration on all text cases (before the minimum-fit and mixed checks)
127 words in 50 cases (sans and serif 6–24 px, badges, the validation set; PNG, JPEG 75, JPEG 40), placed as the app places them:

| | Words |
|---|---|
| Correct, not flagged | 113 |
| Correct, flagged (false alarm) | 9 (7%) |
| Misread, flagged | 3 |
| Misread, missed | 2: "BRE" (partial word on a 120 px JPEG-40 badge, so the missing letter stays traced) and "AA" (shapes in the scene read as text, fit 0.02) |

The minimum-fit check (0.4) was added for "AA", and the mixed letters/digits check for "8tudio".

### 89-pair V7 benchmark (`bench/assess.html?exp=improver`, with `__letteringRule`)

| Lettering threshold | Offers | Truly better | No better | **Worse** | Genuine improvements (≥ 1 point) missed |
|---|---|---|---|---|---|
| **0.50 (kept)** | 22 | 20 | 2 | **0** | 23 |
| 0.55 | 22 | 20 | 2 | 0 | 23 |
| 0.60, 0.65, 0.70 | 23 | 21 | 2 | 0 | 22 |

(V7 before these changes: 19 offers, 16 better, 0 worse.)

- **A threshold of 0.6 or higher** adds exactly one correct offer: the tagline rebuilt across 2 lines, 9.3% → **3.5%**, with no wrong offer. One case isn't enough evidence to ship it.
- **Most missed improvements** are AI-sharpening options blocked by the existing guards (segments, colours, edges), unrelated to lettering.

### App-versus-harness parity
Validation group: **9 of 9** identical first SVGs and suggestions, including the new 2-line lettering suggestion in the real app.

### 41-case before/after comparison (`bench/compare.html`, `main` against this branch)
**39 identical, 2 mixed, 0 regressed, 0 failed; every export valid.** Both mixed results are the grey tagline:

| Tagline | `main` | This branch |
|---|---|---|
| PNG, first result | 17.6%, grey lost | 13.7%, grey kept |
| JPEG 75, first result | 17.7% | 14.9% |
| JPEG 75, suggestion | Arial Bold rebuild, **9.2%**, grey lost | **2 lines rebuilt together, 7.2%**, grey kept |
| JPEG 75, text written by the suggestion | Harbour, COFFEE, ROASTERS, 1998 | Harbour, COFFEE, EST, ROASTERS, 1998 (**all correct**; the doubtful "1898" reading isn't used) |

The JPEG 75 suggestion that disappeared on PR #7 is back, and better than `main`'s: the best available result went from 9.2% to 7.2%. What's still worse in both mixed cases is 1–2 broken tagline letters, from tracing 1 px strokes (deferred, Priority 5).

**Refinement for later:** the combined suggestion can use two fonts within one tagline (Helvetica Bold and Helvetica Neue Bold here), and both are bold where the original is regular Arial; `main`'s suggestion was also bold. A combined rebuild should use one font for all its lines.

## OCR input colours (Priority 4: investigation only, nothing changed)

OCR is given the traced result's colours (`findText(..., palette)`): it reads the whole image, then each colour on its own as black on white. So when the palette changes (the grey tagline fix adds a grey), OCR changes too.
- **Observed:** with `main`'s colours, "COFFEE ROASTERS EST" and "1998". With PR #7's, "EST 1898", "COFFEE", "ROASTERS" in one run, but "1998" correct in others. Readings on this 10 px text also vary between runs.
- **Using the upload's own colours** (`mainColors`, as for photos):
  - *For:* OCR stops depending on tracing changes, giving the same text whatever the palette.
  - *Against:* the upload's anti-aliased and JPEG colours give noisier colour passes, which may read worse than clean traced colours; and font matching downstream uses the same report, so its results would change broadly.
- **Recommendation:** measure first. Run the 50 text cases with traced and upload colours, comparing word accuracy, line splits and font matches, before changing anything. The safeguard already makes the outcome safe either way: an unstable reading produces disagreement, which blocks the rebuild.

## Kept separate (Priority 5)
Thin-stroke tracing defects (the pinched "O" and split "S" in the 10 px tagline: diagonal-only joins in 1 px strokes) are documented in `docs/defects/grey-tagline-validation.md`. They're not addressed here.

## Limitations
- **Glyph evidence can't overrule an image that really looks like the wrong character:** a blurred "6" that fits an "8" better. Then only OCR disagreement can catch it. In the forged test every case was caught, but heavily damaged uploads can defeat both.
- **False alarms (about 7%)** mean fewer automatic rebuilds on small or compressed text. Those words stay traced, which is the safe direction.
- **Partial rebuilds:** when one word in a line is doubtful, the others can still be rebuilt, so a line can mix rebuilt and traced words.
- **The second OCR reading** adds about 1–3 s of background time for small images (sharpened ones only).
