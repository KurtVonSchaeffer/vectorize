# Straight edges: long straight edges drawn as exact lines

Behind the `straight-edges` flag (`src/quality/flags.ts`), off for everyone by default and always on
in the admin panel (`STRAIGHT_EDGES = ADMIN_MODE || straightEdgesOn()`):

| `VITE_STRAIGHT_EDGES` | Effect |
| --- | --- |
| unset (production today) | Off. `?straight-edges=on` in the address is ignored. |
| `preview` | Off unless the address has `?straight-edges=on`. Set it only for Vercel's Preview environment. |
| `on` | On for everyone using that build: a release decision. |

The local dev server also honours `?straight-edges=on`. With the flag off, every file is made exactly
as before (`src/vectorize/__tests__/fidelity/golden.test.ts`). With it on, it applies to every
flat-colour trace: the master, print plates and cut files, and one colour (`JobSettings.straightEdges`
→ `TraceOptions.straightEdges`, `src/vectorize/pipeline.ts`, `src/App.tsx`).

## The defect

An outline that isn't replaced by an exact shape (a circle, ellipse, star or polygon; a "B", a
rounded rectangle, lettering) was drawn entirely with error-bounded Bézier curves. On a long
straight edge the curves follow the traced contour's small steps, so the edge came out slightly
wavy when zoomed in (0.4–0.6 px on the test shapes), and the curve fitted round a rounded corner
reached into the neighbouring edges and overshot them (a bump either side of the corner). On the
Barron mark (a white rounded "B" on a navy disc) both show along the stem and the bars.

## The correction (`fitWithEdges`, `src/trace/fit.ts`)

- **Find straight edges.** Along each outline, a stretch is straight when its points lie within
  0.5 px of their least-squares line, a parabola fitted across it bows by at most 0.05 px, and it is
  at least 10 px long. Windows a quarter longer each time are tried past a failure (an edge at an
  angle to the pixel grid traces with small steps, which a short window mistakes for a bow), an edge
  may start a little later if that reaches further, pieces of one edge broken by a step are joined,
  and end points already leaning into the next curve are shed.
- **Keep arcs curved.** The bow test keeps any arc tighter than ~250 px radius from passing over
  10 px. A short edge (under 30 px) is kept only where the outline turns at least 12° just past both
  its ends (a corner or rounded corner); the chord of a gentle arc has the arc bending on only
  slightly either side and is dropped. An outline with no straight edge (a circle, a letter bowl) is
  fitted exactly as before.
- **Draw.** Each edge is one line on its least-squares fit, written as `L` (`toPath`,
  `src/trace/index.ts`). The parts between are fitted as before (split at detected corners,
  Schneider cubics within the curve tolerance), but each starts and ends in its neighbouring line's
  direction: a straight edge flows into a rounded corner with no kink. Where only one detected
  corner's blurred tip lies between two edges, the corner is rebuilt where their lines meet.

## Results

`src/vectorize/__tests__/straight-edges.test.ts` (`REPORT=1` prints these). Shapes drawn
anti-aliased at 200 × 140 with the production defaults. Max deviation and waviness are measured on
the drawn outline against the true sides, away from their ends; waviness is the spread of the
signed offset along one side (a constant shift of the whole edge left out).

| Shape | Lines | Curves | Max deviation (px) | Waviness (px) | Mean error | Sharp corners (px) |
| --- | --- | --- | --- | --- | --- | --- |
| Rounded rectangle | 0 → 4 | 12 → 4 | 0.433 → 0.000 | 0.433 → 0.000 | 0.350 → 0.091 | |
| Rounded rectangle turned 17° | 0 → 4 | 16 → 4 | 0.390 → 0.006 | 0.635 → 0.001 | 0.451 → 0.068 | |
| Rectangle turned 23°, one rounded corner | 0 → 4 | 6 → 1 | 0.343 → 0.008 | 0.360 → 0.012 | 0.311 → 0.041 | 0.086 → 0.010 |
| Rounded rectangle turned 17°, transparent | 0 → 4 | 30 → 4 | 0.828 → 0.490 | 0.708 → 0.025 | 1.535 → 1.563 | |
| "B"-like mark on a navy disc (stem) | 0 → 4 | | 0.421 → 0.000 | 0.421 → 0.000 | no worse | |

Curves stay curves: a circle is byte-identical; a letter "C" gets lines only on its two cut ends; a
letter "D" only on its stem and the flat parts of its top and bottom; arcs of 150 and 300 px radius
get none (only their chords do). The fidelity fixtures (stars, polygons, lettering, stacked, paper,
notches) have the same mean error and edge recall to three decimals; the letter "D" improves
(0.304 → 0.291). One-colour files improve (turned rectangle 0.452 → 0.070) or stay the same. No
export check (open, zero-area, self-intersection, sliver, small, plate overlap) gets worse. Speed:
a 1200 × 400 mark traces in 390 ms instead of 388 ms.

## Known limits

- **Print plates** (knockout): a line lies exactly on the spread outline (0.15 px out, so
  neighbouring inks overlap), where the wavy curves sat partly inside it; the overlap counts as
  error against the upload, so the turned rectangle's plate measures 0.524 → 0.616. The overlap is
  the intended registration spread; no export check changes.
- **Transparent edges**: on a transparent background the tracer's contour is a staircase offset
  about 0.45 px outward (a colour-map issue that exists with the flag off too). The line follows its
  average, so the edge is straight but keeps that offset: max deviation 0.83 → 0.49, mean error
  +1.8% (1.535 → 1.563). Opaque edges, such as the white "B" on navy, trace accurately.
- A very large arc (radius over ~1000 px) can still pass as straight over 30 px or more, where it is
  within about 0.1 px of a line.
