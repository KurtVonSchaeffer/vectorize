# Improver: AI sharpening when lettering was rebuilt

With the lettering scale fix (PR #16), small lettering read from the AI-sharpened copy is rebuilt
from a font again. The first result improves on 14 of 15 affected benchmark rows, but on 5 the
best result got worse: AI sharpening with traced letters was truly better, and the background
improver no longer offered it.

## Why the upload comparison scores 0.00

`scoreAgainstUpload` compares at the upload's own size, forgives edges within 1 px and ignores
wrong areas under 4 px². On the affected uploads (420 × 52–68 px, strokes 1–2 px wide) every
difference between a rebuilt and a traced letter is within that tolerance, so the rebuilt first
result scores 0.00, and so does every alternative, including the truly better one. With the rule
"at most half the first score and at least 0.3 better", nothing can beat 0.00.

Measuring at a higher resolution doesn't fix this. With the upload smoothly upscaled 4× and a
2 px tolerance (the geometry of the ground-truth score), sans 8 px PNG scores the rebuilt result
4.81 and the sharpened trace 5.83, the wrong way round (truth 4.19 vs 2.87). The upscaled upload
is blurred, so the comparison measures the blur instead of the artwork.

## Rule

When lettering was rebuilt automatically and AI sharpening is worth trying, the improver also
traces the sharpened copy with the letters traced (`SHARPEN_TRACED`). The upload can rank one
trace against another, so this candidate is judged against the same image traced without
sharpening, letters traced too, by the usual rule (`isImprovement`). It also must not be
measurably worse than the rebuilt result: no higher score, no extra colours, and edge agreement
no more than 0.01 lower (`isImprovementOverRebuilt`).

Under the draft policy in PR #14 (lettering never rebuilt automatically) the candidate never
arises, so the rule is inert there. Rebuilds the client chooses happen after the improver's check.

## Validation (bench/assess.html?exp=improver, 89 pairs)

Before is PR #16 as it stands; after adds this rule. "Better" or "worse" means the offer's ground
truth error differs from the first result's by more than 0.1.

| | offers | truly better | worse | sum of best available (first or offer) |
|---|---|---|---|---|
| before (PR #16) | 19 | 16 | 0 | 544.5 |
| after | 23 | 20 | **0** | 540.3 |

The five rows where the best result had got worse with PR #16 (ground truth, lower is better):

| upload | before #16 | with #16 | with this rule |
|---|---|---|---|
| sans 8 px PNG | 2.87 | 4.19 | **2.87** (new offer) |
| sans 10 px PNG | 1.75 | 3.88 | **1.75** (new offer) |
| serif 12 px JPEG 75 | 3.32 | 3.62 | **3.32** (new offer) |
| badge 200 px PNG | 0.87 | 1.22 | **0.87** (now preferred over sharpened + rebuilt) |
| badge 120 px PNG | 1.53 | 2.14 | 2.14 (both pass; sharpened + rebuilt scores lower against the upload) |

Serif 12 px PNG also gets a new offer (3.65 → 3.55, within the 0.1 margin). Sans 10 px JPEG 75 is
not offered (sharpened trace 2.30 against 4.60): its traced version already scores 0.21, so the
0.3-point minimum gain isn't reached. That's a conservative miss, not a wrong offer. The sharpened
trace is also tried, and not offered, on the JPEG badges, "jpeg saved as png" and the small
gradient logo, including the cases where it is worse in truth (badge 120 px JPEG 75: 22.29
against 12.60; gradient logo JPEG 40: 2.34 against 0.62).

## Badge 120 px PNG: why the better candidate isn't picked

All candidates for this upload (first result: rebuilt lettering, proxy 6.75, truth 11.32):

| candidate | proxy score | edge F1 | segments | truth | passes the rule |
|---|---|---|---|---|---|
| traced with more detail | 6.71 | 0.920 | 269 | 10.78 | no (not half the score) |
| traced with simpler shapes | 12.50 | 0.862 | 204 | 18.62 | no |
| sharpened, lettering rebuilt | **0.36** | 0.995 | 344 | 2.14 | yes |
| sharpened, letters traced | 0.64 | 0.995 | 321 | **1.53** | yes |

Both sharpened versions pass, and the improver offers the passing candidate with the lowest
score against the upload, which is the rebuilt one (0.36 vs 0.64). Both are large gains (11.32
→ 2.14 or 1.53). The 0.28-point difference between them is below `IMPROVE_MIN_GAIN` (0.3),
the gap the rule already treats as too small to mean anything on its own.

Is this a selection defect that generalises? Only two rows in the 89 pairs have both sharpened
versions passing: badge 120 PNG (picks rebuilt, traced is better) and badge 200 PNG (picks traced,
which is better). A tie-break such as "within 0.3, prefer traced letters" would fix this row and
not change badge 200. But it rests on one row, and it is really a lettering-policy choice
(prefer traced letters), not a scoring fix. **No change proposed.** Under PR #14's policy the
first result keeps traced letters, the rebuilt variant isn't a candidate, and this row gets the
1.53 result.

## App parity (bench/parity.html)

All 60 synthetic uploads (PNG and JPEG 75) agree between the app and the simulation: same first
SVG and the same offer. The first full run matched 52 of 53 before the browser closed. The one
difference, badge 200 px PNG, came from the check itself: it stopped at the first offer shown,
while the app later replaced that offer with a better one. The check now waits until the offer
has been unchanged for 20 s. Rerunning the badge and validation groups (17 uploads, which covers
the rest of the 60) gave 17 of 17 identical, including badge 200 px PNG.

Checked in the preview (sans 10 px PNG): the first result rebuilds the lettering, then the
improver offers the sharpened version with traced letters. "Use it" switches to 2× sharpening
and removes the rebuilt lettering. "Go back" restores the rebuilt lettering and the offer.
