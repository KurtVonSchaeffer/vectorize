# Defect: thin lettering in its own colour is merged into a neighbouring colour

**Status:** fix in review, in the pull request stacked on this one (`fix/grey-tagline-blend`). Results: `docs/defects/grey-tagline-fix.md`.
**Severity:** a brand colour is lost silently, the affected lettering breaks up, and the logo isn't print-ready.
**Since:** before V7. The colour code is byte-identical to V6's (`bench/identity.test.ts`).

## Symptom

A navy wordmark over a 10 px grey tagline (`#495057`) comes out with only white and navy. The tagline turns navy and breaks into fragments. Against the original, 18.6% of the artwork is missing or added, and 9 letter counters are filled in. This happens at every detail setting, with or without lettering rebuilt.

## Reproduce

- **In the browser:** the `wordmark with tiny tagline` case in `VALIDATION` (`bench/cases.ts`), saved as PNG. Trace it with the defaults. The palette is `#ffffff #212c5d`.
- **In a unit test:** `src/palette/__tests__/quantize.test.ts`, "thin lettering in its own colour (known defect)". It uses an image built pixel by pixel (navy blocks, 1 px grey letter outlines with anti-aliased sides). Default palette: `#ffffff #1f2a5c`. With blend clusters kept: `#ffffff #1f2a5c #495057 …`. It was marked `it.fails` while the defect was open. The fix branch converts it to a normal passing test.

## Root cause

The grey is removed by `dropBlendClusters` (`src/palette/quantize.ts`). That step folds away small clusters that look like anti-aliasing or JPEG fringes between two other colours. The tagline's grey cluster passes all three of its tests:

| Test | Grey tagline | Why it passes |
|---|---|---|
| Small: under 6% of the inked area | Yes | A tagline is a small share of a logo. |
| Thin: under 25% "interior" pixels | Yes | Strokes of 10 px text are about 1 px wide. |
| A mix of two other colours (`blendInfo`, tolerance 14) | Yes, **through the JPEG chroma test** | See below. |

**The mix test.** As a straight anti-aliasing mix of navy and white, the grey is 29–31 sRGB units off, which is not a mix. `blendInfo` also has a second test, meant for JPEG chroma subsampling: brightness from one colour, hue partly from the other. The grey is dark, close to navy's brightness (t = 0.16–0.21), and neutral, close to white's hue (0.80–0.81). So it reads as a JPEG fringe between navy and white. **That test runs on lossless PNGs too.**

All the other stages are ruled out:

| Variation | Result |
|---|---|
| `keepBlends: true` | Grey kept |
| `mergeDelta: 0` | Still lost |
| `maxColors: 16` | Still lost |
| `minArea: 0` | Still lost |

## Proposed fix (for approval)

**Recommended: a spatial check.** A real fringe lies *between* its two colours, so its pixels touch both. Thin lettering touches only the background.

- **Measured in the tagline case:**
  - 0% of the grey's pixels are within 2 px of navy, and 100% are within 2 px of white;
  - a genuine navy→white fringe (`#7c83a0`): 94% near navy, 100% near white.
- **Change:** in `dropBlendClusters`, treat a cluster as a blend of *a* and *b* only if a clear share of its pixels (for example at least 30%) lie within 2 px of *a*, and as many within 2 px of *b*.
- **Coverage:** it keeps JPEG fringe removal working, and also fixes thin coloured text in JPEGs.

**Narrower alternative:** use the JPEG chroma test only when the upload is lossy (`isLossy` / `compressionRipple`). This fixes PNGs but not thin coloured text in JPEGs.

### What has to be checked before it ships

It changes colour output, so the byte-identical test no longer applies. Instead:
1. **Unit tests:** the tagline test passes without `it.fails`; the existing fringe tests ("keeps two adjacent colours with an anti-aliased edge as exactly two colours", "keeps the original colours, not their anti-aliased or JPEG-drifted average") still pass.
2. **Benchmarks:**
   - `bench/diagnose.html`, `bench/index.html` and `bench/conditions.html` (20/20): no case worse;
   - JPEG cases: no extra fringe colours, compared on colour count and ΔE.
3. **Parity:** `bench/parity.html` shows the app and the harness still match.
4. **Real logos:** the acceptance test with no new "colour missing" or extra-colour flags.

## Detection

The acceptance harness now reports colours lost altogether (`missingColours`, `bench/review.ts`). That's a flag against the upload, and a FAIL against an original. The existing colour comparison (`colourFidelity`) can't see this defect, because it only measures pixels whose neighbours all share their colour, and thin strokes have none.
