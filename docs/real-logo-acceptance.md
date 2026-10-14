# Real-logo acceptance test

This test decides whether V7 is safe to release. V7 has only been measured on synthetic artwork (`docs/v7-results.md`). Its improvement from 8.39 to 6.12 doesn't show that results are ready for commercial print. This test checks it on real customer logos: automatically against each logo's original, then by eye.

## 1. What to collect

Collect **10–15 logos**, at least two per category. One logo can count towards several categories, but name it under its main one.

| Prefix | Category | What it should include |
|---|---|---|
| `print__` | Print-ready branding | Typical customer logos that will be printed: business cards, signage, merchandise. Flat colours, a mix of marks and wordmarks. |
| `lettering__` | Small lettering | Taglines, legal lines, ® / ™, text 6–12 px high in the upload. Include at least one serif. |
| `colour__` | Colour fidelity | Exact brand colours (ideally with known Pantone / hex values), similar shades next to each other, and dark-on-dark or light-on-light. |
| `transparent__` | Transparency | PNGs with transparent backgrounds, holes and counters (letters such as O, A, e), soft or anti-aliased edges. |
| `gradient__` | Gradients | Linear and radial gradients, gradients behind text, and a flat logo with one gradient element. |
| `complex__` | Complex artwork | Badges, crests, illustrations, fine line work, many colours, and overlapping shapes. |

For each logo, provide:

- **The upload:** the file a customer would really send. That is often a small PNG or JPEG from a website, email signature or social profile. Don't clean it up. If you have both a small web copy and a larger one, include both (`print__acme.png` and `print__acme-web.jpg` share one original only if their names match; otherwise give each its own original).
- **The original, wherever possible:** the brand's master artwork, used to score the result.
  - SVG: use it as it is (`print__acme.svg`).
  - PDF, AI or EPS: export it to SVG from Illustrator (or Inkscape / Affinity). Use *Presentation attributes* and *Convert text to outlines*, at the same aspect ratio as the upload. If an SVG export isn't possible, export a PNG at least 4× the upload's size as `print__acme.truth.png`.
  - Make sure the original shows exactly what the upload shows: same crop, same colours, same lockup. Otherwise the scores measure the difference between the files, not the vectorizer.
- **Notes, if known:** brand colours (hex / Pantone), fonts, and how the logo will be used (print, embroidery, vinyl cutting, web).

Logos without an original are still useful: they're marked REVIEW and checked by eye only.

## 2. Naming

```
print__acme.png            upload
print__acme.svg            original (or print__acme.truth.png)
lettering__harbour.jpg
lettering__harbour.svg
transparent__leaf.png      no original: visual review only
```

The part before `__` is the category. The upload and its original share the rest of the name. An SVG with no upload is rendered and vectorized against itself, which only tests the tracer, not real uploads.

## 3. Procedure

1. Start the app (`npm run dev`) and open `/bench/real.html`. Use a desktop Chrome with nothing else heavy running. The first run downloads the AI model (about 8 MB).
   - **No saved brand colours:** the harness runs the app with its defaults. If brand colours were saved in this browser (Brand colors panel), the app would use them and the harness wouldn't, so clear them or use a fresh browser profile.
2. Drop all files at once. Each logo goes through exactly what the app does (`bench/improver-sim.ts`):
   - the first result, with web settings;
   - automatic lettering rebuilt at a font match of 0.85 or above;
   - the background improver's alternatives and its offer rule.
   
   Then the SVG, PDF and DXF downloads for print, web and cutting are generated and checked. Expect 5–60 s per logo.
3. Under each logo, the page shows four pictures side by side: the **upload**, the **first vector result**, the **suggested improvement** (if the app would offer one) and the **original** (if supplied). Enlarge them together to 4×, 8×, 16× or 32×, and click any picture to choose the spot. The upload is shown with its real pixels, and the vectors are redrawn sharp at that size. Switch the background to black to look for white boxes and halos. Areas the structural checks flag (merged, broken, missing or extra shapes) are outlined in colour; **next flag** jumps to each one.
4. Fill in the manual checklist under each logo (section 5) and answer *Would you send this to a printer?*. Answers are saved in this browser. The final verdict is **FAIL** if any automatic criterion, check or the overall answer fails, **PASS** only after a "yes" with nothing failed, and **REVIEW** otherwise.
5. Open the PDF and DXF in Illustrator / Acrobat and the cutter software for the print and cut checks (download them from the app at `/`).
6. **Download report** saves one self-contained HTML file: summary, release recommendation, and for every logo its pictures at 1× and 16×, its scores, flags and manual review. Also export JSON / CSV, then **Save as baseline**. Later engine changes are re-run against it, and the page shows the change per file.

### Structural checks (flags, shown under each logo)

They are compared with the original, or with the upload when there's no original. They raise REVIEW, not FAIL, except for open cut outlines, which block release. Thresholds are in `bench/review.ts` (`STRUCTURE`).

| Flag | Meaning |
|---|---|
| Excessive nodes | More than 12 segments per 100 px of outline, or more than 3× the original SVG's nodes |
| Jagged edges likely when enlarged | More than 15% of segments shorter than ¾ px (stair-steps) |
| Lumpy curves likely when enlarged | More than 5% of curve-to-curve joins bend 15–60° |
| Merged / broken / missing / extra shapes | Letters or marks joined together, split apart, lost or invented, found by matching separate shapes by overlap |
| Incorrect colours | An original colour shown more than ΔE 3 off |
| Cut file | Open outlines, or pieces under 1 mm at 200 mm wide (hard to weed) |

### Does the harness match the app?

`bench/real.html` doesn't drive the app's interface: it runs the same steps through `bench/improver-sim.ts`. To check that this matches what customers get, `/bench/parity.html` opens each synthetic case in the real app (in an embedded frame) and in the simulation, and compares the results. On V7, all 60 cases (PNG and JPEG) gave identical first SVGs and identical offers, including 17 offers covering AI sharpening, detail and lettering. Re-run it after any change to the app's tracing, lettering or improver flow.

## 4. Automatic criteria (scored against the original)

| Measure | Threshold | Why |
|---|---|---|
| Detail error: missing + added ink, % of the original's ink, at 2× with ½ px tolerance | ≤ 2% (≤ 5% for `lettering__`) | Shapes, counters and thin strokes match the master artwork. |
| Edge agreement (F1) | ≥ 0.95 | Outlines sit where the original's do. |
| Mean colour difference (CIEDE2000) over the original's flat colours | ≤ 2 (≤ 3 for compressed uploads) | ΔE ≤ 2 is barely visible side by side. |
| Merged brand colours | 0 | Two distinct brand colours must not become one. |
| Transparency changes (`transparent__`) | ≤ 0.5% of pixels | The background stays transparent, holes stay open. |
| Gradients (when the original SVG has them) | Kept as gradients | Not flattened into bands. |
| Exports | All 6 files valid | SVG parses and renders; PDF is complete with filled plates; DXF has outlines; PNG is valid. |
| Improver offer | No more than 0.5 points worse than the first result | An offer must never make the logo worse. |

A logo **passes** when it meets every criterion. A logo without an original only gets the export check and is marked REVIEW.

These thresholds are a starting proposal. The first run will show whether they separate results that look right from ones that don't. Adjust them only once, before the release decision, and record why.

## 5. Visual print-readiness review

For each logo, use the enlargement viewer on the test page (1× up to 32×) and compare it with the upload and the original. The checklist is on the page:

- [ ] **Shapes:** curves are smooth, with no wobble, lumps or flat spots; corners that should be sharp are sharp; straight lines are straight.
- [ ] **Lettering:** every letter is legible and correctly spelled; counters (O, e, a) are open; spacing is even. If a font was rebuilt, it is the right one. If unsure, the rebuild should have been offered rather than applied.
- [ ] **Small detail:** taglines, ® / ™ and thin rules survive. Nothing has been invented.
- [ ] **Colour:** brand colours match the notes (hex / Pantone), and similar shades remain distinct.
- [ ] **Transparency:** no white box or halo on a dark background; holes are cut out, not filled white.
- [ ] **Gradients:** smooth, no banding, same direction and end colours.
- [ ] **Print files:** the PDF opens in Illustrator or Acrobat with one plate per colour, and plates don't overlap where they shouldn't. The DXF opens in the cutter software with closed outlines.
- [ ] **Offers:** each "cleaner version" really looks cleaner. Not offering one is fine; offering a worse one is not.
- [ ] **Verdict:** would you send this to a printer for this customer without touching it? Yes, minor fixes, or no.

## 6. Release decision

V7 is safe to release when **all** of these hold:

1. **No offer is worse than the first result** against the original (automatic gate), and none looks worse in the visual review. This is a hard requirement: V7's promise is that it only suggests improvements.
2. **No regression against V6:** V7's first result (before any offer) is never worse than V6's on the same logo. Run the same files on the `v6-quality` branch, save that as the baseline, then switch to V7 and compare. V7 differs from V6's first result only when lettering is rebuilt automatically.
3. **Exports:** every file is valid for every logo.
4. **No silent font substitution:** every automatically rebuilt font is the right family.
5. **Quality:** at least 80% of logos with an original pass the automatic criteria, and at least 80% are rated "yes" or "minor fixes" in the visual review. No category is below 50%.

If 1, 3 or 4 fails, V7 isn't released until it's fixed. If 2 or 5 fails, look at what failed: it may be a limitation V6 already had, which doesn't block V7 but should be the next phase's priority.
