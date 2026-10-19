# One-colour fix, round 2: results for review (historical)

> **An earlier review round**, kept for the record. It describes the branch `one-colour` before it was committed, recovered and integrated, and its counts and bird observations are from that round. The current status, validation and pending acceptance (CorelDRAW, a RIP or a cutter, and the real bird) are in the pull request that brings one colour into `main`.

Branch `one-colour` (local, from `main`), kept separate from V8. At the time: not committed, merged or deployed. No new dependencies.

## Your eight points

| # | Point | Result |
|---|---|---|
| 1 | Why the bird's too-thin pieces rose from 22 to 33 | **Root cause found and fixed.** The cut file traced every former colour as its own piece of the same ink. A boundary that got no gap still became a cut line, and thin former-colour stripes became slivers of their own. Touching ink is now traced as **one piece**. The bird's cut file has 8 problems, against 56 before and 50 for the colour plates (table below). |
| 2 | The default gap must not make cutting worse | **Enforced by the export checker.** The cut file is traced, checked, and wherever a problem piece touches a gap, the gap is undone there and the file traced again. The default gap adds **0** cutting problems on all 11 logos. On the fine-stripes case it undid 4 gaps that had pinched into hairline slits. |
| 3 | Highlight boundaries that couldn't be separated | **Red rings on the preview**, never in a file; overlapping rings merge so the artwork stays visible. The note says why: thin detail, cutting limit, or a hairline sliver taken into a gap. |
| 4 | Distinguish master from production in the preview | **"Preview shows: Master / Print / cut file"** choice. The preview label reads "Master · one colour, no gaps" or "Print / cut file · 0.5 mm gaps". |
| 5 | The two harbour failures | **Classified:** the harbour logo is line art, already one ink on paper, and Maximum colors isn't offered for it. It is now marked not applicable and still checked: lettering 20/20 pieces and 6/6 holes kept in every file. |
| 6 | Export checker tracked properly | **Now tracked on this branch:** `src/export/validate.ts` and its 5 tests, brought over from `v8-reconstruction` and identical to the reviewed version. One option was added (more problem locations, each with its box). |
| 7 | Test gap off, default and maximum | **Done** for every logo: 0, 0.5 and 2 mm at 200 mm wide. |
| 8 | Lettering, counters, details and negative space intact | **Checked per hole and per piece:** every counter the colour version keeps stays open, and every artwork piece keeps its ink, in the master and all three files. |

![comparison](one-colour/comparison.png)

## Cutting-path integrity (export checker, 200 mm wide)

Problems = self-crossing + too thin (< 0.3 mm) + too small (< 1 mm) + open + empty outlines.

| Logo | Colour plates | Previous one-colour file (0.5 mm) | Gap off | 0.5 mm (default) | 2 mm (max) |
|---|---|---|---|---|---|
| bird | 50 (crossing 13, thin 27, small 10) | 51–56 | **8** (thin 6, small 2) | **8** | **8** |
| harbour (line art) | 11 | 11 | 11 | 11 | 11 |
| fine stripes | 0 | 2 | 0 | 0 | 0 |
| venn | 0 | 3 | 0 | 0 | 0 |
| the other 7 | 0 | 0 | 0 | 0 | 0 |

**The bird's remaining 8 problems are not from one colour.** They appear with the gap off and in the colour plates too:
- the four 1 px strips along the image's edges (V7's faint-frame seams, fixed by the Phase 1 seam filter on the V8 branch, which is not on this branch)
- one 2 px speck from the colour step

## Visual fidelity against the original

| Logo | Artwork in ink (master) | Negative space open (master) | Holes kept (all files) | Pieces kept (all files) | Old Maximum colors = 1 |
|---|---|---|---|---|---|
| venn | 99.9% | – | – | 1/1 | whole picture filled |
| star badge | 100% | 99.5% | 1/1 | 1/1 | whole picture filled |
| target | 100% | 99.1% | 2/2 | 2/2 | whole picture filled |
| lettering | 99.8% | 96% | 9/9 | 10/10 | whole picture filled |
| gradient | 99.9% | – | – | 1/1 | gradient kept in colour |
| fine stripes | 100% | – | 0/1 (also lost in colour) | 1/1 | whole picture filled |
| bird | 97.4% | 99.8% | 4/4 | 11/11 (+4 edge seams, + speck) | 6.6% of the artwork |
| leaf | 99.8% | 98.9% | 1/1 | 1/1 | same as colour |
| acme | 100% | 97.6% | 1/1 | 6/6 | whole picture filled |
| badge | 98.8% | 100% | 2/2 | 2/2 | – |
| harbour (line art) | n/a | 96% | 6/6 | 20/20 | – |

**Problems found and fixed during this round:**
- **The one-ink merge closed two counters** (the "A" and the "g") when combined with the 0.15 px registration spread that print plates get. A one-ink file has nothing to register against, so it no longer gets the spread.
- **The first merge split 1 px strokes across two labels,** because many stroke pixels are mostly ink but have paper as their primary label. Fixed by counting any ink share.

## The app

![master](one-colour/app-preview-master.png)
![cut file](one-colour/app-preview-gaps.png)

**Bird at the default gap:**
- 34 boundaries get a gap
- 25 stay joined to protect thin detail (mostly the streaks inside "LOREM IPSUM")
- 6 hairline slivers became part of a gap

All of these are ringed. One-colour **cut SVG downloads now always come from the print / cut file:** the master keeps each former colour as its own shape, which a cutter would cut apart.

## Also checked

- **Multicolour output is unchanged:** 18 outputs are byte-identical to `main`.
- **Tests:** 202 pass (18 one-colour tests, 5 checker tests); typecheck and build clean.
- **Time:** bird master 1.4 s; files 0.7–1.0 s each, including the checker pass. Small logos 12–230 ms.

## Still open

- **Venn at 0.5 mm:** the gap round the overlap is partial. The upload has a 2 px yellow sliver along part of that edge (anti-aliasing where two circle edges coincide). It is wider than the 0.75 px gap at that size, so it stays, and the gap stops there. Those spots are also not flagged, because each sliver fragment touches too little edge to count as a boundary.
- **The bird's 4 edge seams and the speck** remain in every file until the Phase 1 seam filter (on `v8-reconstruction`) is brought into the release line.
- **Gap counts in the note are before the checker's undo.** On the fine-stripes case, "gaps cut at 4" includes the 4 that were undone; the undone places are ringed.

## Files

- New: `src/vectorize/one-colour.ts` and its tests, `bench/one-colour.html` and `.ts`
- Brought over: `src/export/validate.ts` and its tests
- Changed: `pipeline.ts`, `client.ts`, `files.ts`, `App.tsx`, `MoreOptions.tsx`, `Compare.tsx`
