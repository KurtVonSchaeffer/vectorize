# Exact arcs: circular stretches drawn as true arcs

Behind the `exact-arcs` flag (`src/quality/flags.ts`), off for everyone by default and always on in
the admin panel (`EXACT_ARCS = ADMIN_MODE || exactArcsOn()`):

| `VITE_EXACT_ARCS` | Effect |
| --- | --- |
| unset (production today) | Off. `?exact-arcs=on` in the address is ignored. |
| `preview` | Off unless the address has `?exact-arcs=on`. Set it only for Vercel's Preview environment. |
| `on` | On for everyone using that build: a release decision. |

The local dev server also honours `?exact-arcs=on`. With the flag off, every file is made exactly as
before (`src/vectorize/__tests__/fidelity/golden.test.ts`). With it on, it applies to every
flat-colour trace: the master, print plates and cut files, and one colour (`JobSettings.exactArcs`
→ `TraceOptions.exactArcs`, `src/vectorize/pipeline.ts`, `src/App.tsx`, `bench/improver-sim.ts`).

## The defect

Outlines that aren't replaced by an exact shape (a rounded rectangle, the bowl of a "b", a stroke's
round cap, a letter "C") were fitted with error-bounded Bézier curves. A rounded corner or a round
end came out as one or several curves that follow the tracing's small errors: slightly wobbly, with
no single radius, up to 0.45 px off the true shape on the test shapes. Straight edges
(docs/straight-edges.md) made the sides exact, but the corners between them stayed free curves.

## The correction (`src/trace/arcs.ts`, `fitWithEdges` in `src/trace/fit.ts`)

- **Find arcs.** Between the straight edges and corners of an outline (and round a smooth outline
  with neither), a stretch is a circular arc when its points lie within 0.3 px of one fitted circle
  (algebraic fit refined by Gauss–Newton), the residual averaged over 2 px stays within 0.1 px, it
  runs steadily round the circle, turns at least 30°, is at least 4 px long, and its radius is
  2.5 px to the outline's size. Windows grow from each point while they still fit; end points
  leaning off the circle are shed.
- **Keep ellipses and free curves curved.** Near its vertices an ellipse is within a few hundredths
  of a pixel of a circle over 45–70°, so closeness alone can't tell. An arc is dropped where, just
  past a free end, the outline runs on round a circle of about the same radius (within 1.8×), or
  where the curvature keeps changing one way through it. A same-radius curve round another centre
  (two rounded corners with a short flat between them) counts as a separate arc.
- **Join tangentially.** A rounded corner between two straight edges becomes a fillet: the circle
  tangent to both lines that best follows the points (searched along their bisector), and the lines
  end exactly where it touches them (line–arc–line). An arc reaching one line is made tangent to it
  the same way; curves next to an arc start and end in its direction. Detected corners stay sharp.
- **Draw.** Each arc is written as standard cubics of at most 90° each (handles
  4/3·tan(θ/4)·r long, on the circle's tangents), so the SVG, PDF and DXF writers are unchanged.
- **Do no harm.** The part of an outline between two lines (or the whole outline) keeps its arcs
  only if that doesn't add nodes (beyond splitting an arc into 90° pieces) and doesn't move it
  further from the traced points on average, nor at most beyond 0.15 px or the ordinary fit's
  distance. Otherwise it is fitted exactly as before.
- Exact arcs find the straight edges too, since an arc ends where the line it runs into begins. On
  its own the flag gives the same geometry as with straight edges, with the lines written as
  curves.

## Results

`src/vectorize/__tests__/exact-arcs.test.ts` (`REPORT=1` prints these). Shapes drawn anti-aliased at
200 × 140 with the production defaults. Before = straight edges on (the admin panel today); in
brackets, no flags. Max deviation is the drawn outline's largest distance from the true shape.

| Shape | Lines | Arcs (radius, true radius) | Radius error (px) | Max deviation (px) | Nodes | Mean error |
| --- | --- | --- | --- | --- | --- | --- |
| Rounded rectangle, r 14 | 4 → 4 | 0 → 4 × 90° (14.07) | 0.071 | 0.247 (0.436) → 0.029 | 8 (12) → 8 | 0.087 (0.349) → 0.021 |
| Rounded rectangle turned 17°, r 12 | 4 → 4 | 0 → 4 × 90° (12.08–12.11) | 0.108 | 0.182 (0.382) → 0.048 | 8 (12) → 8 | 0.059 (0.442) → 0.026 |
| Stroke with round caps turned 11°, r 15 | 2 → 2 | 0 → 2 × 180° (14.99) | 0.005 | 0.421 (0.452) → 0.025 | 7 (8) → 6 | 0.100 (0.306) → 0.015 |
| Letter "b", bowl r 38 | 4 → 4 | bowl 267° (37.99); counter stays an exact circle | 0.01 | 0.306 (0.306) → 0.117 | 16 (14) → 16 | 0.204 (0.204) → 0.023 |
| Letter "C", r 58 and 38 | | 0 → 286° (58.00), 285° (38.00) | < 0.01 | | 18 (14) → 18 | 0.542 (0.543) → 0.032 |

Curves stay curves: a full circle is byte-identical (an exact shape already); half an ellipse
(110 × 50), a letter "D" (elliptical bowl 55 × 48) and a free-form blob are byte-identical to
straight edges alone, with no arcs. The fidelity fixtures (stars, polygons, lettering, stacked,
paper, notches) are unchanged; no fixture gains nodes. One colour improves (rounded rectangle
0.062 → 0.028, round caps 0.102 → 0.018, letter "b" 0.204 → 0.025) and no export check (open,
zero-area, self-intersection, sliver, small, plate overlap) gets worse. Speed: a 1200 × 400 sheet of
rounded shapes traces in 827 ms with both flags against 800 ms with straight edges alone.

## Known limits

- **Print plates** (knockout): as with straight edges, an exact arc lies on the spread outline
  (0.15 px out, so neighbouring inks overlap) where the free curve sat partly inside it, and the
  overlap counts as error against the upload: round caps 0.373 → 0.399, letter "b" 0.772 → 0.805
  (the turned rectangle improves, 0.611 → 0.552).
- **Transparent edges** trace as a staircase offset about 0.45 px outward (docs/straight-edges.md);
  its corners don't pass the arc tests, so they stay as before (no arcs on the transparent rounded
  rectangle or on the "B"-like mark on a navy disc).
- **No extra nodes**: where the ordinary fit draws a stretch with fewer curves than exact arcs need
  (two rounded corners 4 px apart at the end of the "B" mark's bars, drawn as two loose curves),
  the curves are kept, even though the arcs would be closer.
- An ellipse stretch that is truly within 0.1 px of a circle and ends at a line or a corner (not
  flowing on into the rest of the ellipse) can still become an arc; it is then within that
  tolerance of the source.
