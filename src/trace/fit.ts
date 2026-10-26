import type { Point } from './contours'
import { ARC_TOLERANCE, arcCubics, arcTangent, filletBetween, findArcs, followsCircle, type Arc } from './arcs'

export interface FitOptions {
  /** Max distance (px) a fitted curve may deviate from the contour. */
  error: number
  /** Turning angle (degrees) above which a point is kept as a sharp corner. */
  cornerAngle: number
  /**
   * Straight stretches of the outline (points within STRAIGHT_TOLERANCE of one line for at least
   * STRAIGHT_MIN_LENGTH) are drawn as exact straight segments, and the curves next to them meet them
   * tangentially: straight edges stay straight, with fewer anchors, and a thin bar's sides don't bulge.
   */
  straightRuns?: boolean
  /**
   * Straight edges (behind a flag, docs/straight-edges.md): long stretches of an ordinary outline
   * that are straight well within the curve tolerance are drawn as exact lines (fitWithEdges).
   * Ignored with straightRuns, which handles thin outlines its own way.
   */
  straightEdges?: boolean
  /**
   * Exact arcs (behind a flag, docs/exact-arcs.md): stretches of an ordinary outline that are circular
   * arcs within a tight tolerance are drawn as exact arcs (one centre and radius), meeting straight
   * edges and curves tangentially (fitWithEdges). Ignored with straightRuns.
   */
  exactArcs?: boolean
}

/** A cubic Bézier: start, two controls, end. */
export type Cubic = [Point, Point, Point, Point]

/**
 * Fits a closed contour with cubic Béziers: resample evenly, split at corners, then fit each
 * smooth run with Schneider's error-bounded algorithm. Returns the curves in order.
 */
export function fitClosed(loop: Point[], opts: FitOptions): Cubic[] {
  if ((opts.straightEdges || opts.exactArcs) && !opts.straightRuns) {
    const edged = fitWithEdges(loop, opts)
    if (edged) return edged
  }
  const pts = resample(loop, 0.5)
  if (pts.length < 4) return []
  const corners = findCorners(pts, opts.cornerAngle)

  const n = pts.length
  const curves: Cubic[] = []
  if (!corners.length && opts.straightRuns) {
    // A loop with straight stretches but no corners (a thin bar with rounded ends): start it at a
    // stretch's start, so the stretches aren't cut, and fit it as one run back to that point.
    const lines = straightStretches([...pts, ...pts.slice(0, n >> 1)])
    const start = lines.find(([a]) => a < n)?.[0]
    if (start !== undefined) {
      const run = [...pts.slice(start), ...pts.slice(0, start + 1)]
      const t = norm(sub(run[1], run[0]))
      return fitWithLines(run, t, neg(t), opts.error)
    }
  }
  if (!corners.length) {
    // Fully smooth loop: fit it in two halves with matching tangents at the joins.
    const half = n >> 1
    const t0 = tangentAt(pts, 0)
    const th = tangentAt(pts, half)
    curves.push(...fitCubic(slice(pts, 0, half), t0, neg(th), opts.error))
    curves.push(...fitCubic(slice(pts, half, n), th, neg(t0), opts.error))
    return curves
  }
  // Blur and anti-aliasing round corners off; rebuild each one where its two edges meet.
  const sharp = corners.map((c) => sharpenCorner(pts, c))
  for (let k = 0; k < corners.length; k++) {
    const a = corners[k]
    const b = corners[(k + 1) % corners.length]
    const sa = sharp[k]
    const sb = sharp[(k + 1) % corners.length]
    let run = slice(pts, a, b === a ? a + n : b)
    // Replace the rounded points next to each corner with the reconstructed corner point.
    const trimA = sa ? Math.min(CORNER_TRIM, (run.length - 2) >> 2) : 0
    const trimB = sb ? Math.min(CORNER_TRIM, (run.length - 2) >> 2) : 0
    run = [sa?.point ?? run[0], ...run.slice(1 + trimA, run.length - 1 - trimB), sb?.point ?? run[run.length - 1]]
    if (run.length < 2) continue
    const t1 = sa ? sa.outDir : leftTangent(run)
    const t2 = sb ? neg(sb.inDir) : rightTangent(run)
    curves.push(...(opts.straightRuns ? fitWithLines(run, t1, t2, opts.error) : fitCubic(run, t1, t2, opts.error)))
  }
  return curves
}

/**
 * Straight edges: a stretch of the outline counts as a straight edge when its points lie within
 * EDGE_TOLERANCE of their least-squares line, it doesn't bow (a parabola fitted across it sags by
 * at most EDGE_SAGITTA) and it is at least EDGE_MIN_LENGTH long. The bow test is what keeps arcs
 * curved: points within half a pixel of a line also describe any arc of radius above ~25 px over
 * 10 px, but such an arc bows by 0.5 px there; with 0.05 px only arcs of radius above ~250 px
 * could pass over 10 px, and those short chords are then dropped by the end-turn test below. The
 * tolerance itself is loose because an edge at an angle to the pixel grid traces with small steps.
 */
const EDGE_TOLERANCE = 0.5
const EDGE_SAGITTA = 0.05
const EDGE_MIN_LENGTH = 10
/** A straight edge's end points further than this (px) from its line are where a curve starts: trimmed. */
const EDGE_END_TOLERANCE = 0.15
/** A gap (px of outline) up to this long between two straight edges, around one corner, is its blur. */
const CORNER_GAP = 10
/** Longer windows tried after one fails (straightEdge). */
const EDGE_LOOKAHEAD = 3
/** An edge at least this long (px) is kept whatever lies beyond it… */
const EDGE_SURE_LENGTH = 30
/** …a shorter one only where the outline turns at least this much (degrees) just past both ends. */
const EDGE_END_TURN = 12

interface Edge {
  /** First and last resampled point (indices into the rotated loop, b may be n). */
  a: number
  b: number
  /** Unit direction from a to b. */
  d: Point
  /** The drawn line: start and end, on the fitted line. */
  A: Point
  B: Point
}

/**
 * Straight edges, drawn exactly. Finds the outline's long straight stretches (straightEdge), draws
 * each as one line on its least-squares fit, and fits the parts between as before (split at
 * corners, error-bounded cubics) but starting and ending in the neighbouring lines' directions, so
 * a straight edge flows into a rounded corner without a kink. Where only a detected corner's
 * blurred tip lies between two straight edges, the corner is rebuilt where their lines meet.
 * Returns null when the outline has no straight edge (a circle, a letter bowl): the ordinary fit
 * then draws it, unchanged.
 *
 * Exact arcs (docs/exact-arcs.md) also look for circular arcs (findArcs) between the lines and
 * corners, and on outlines with no line at all: each is drawn on one circle, a rounded corner
 * between two lines as a fillet touching both (the lines end where it touches), an arc reaching a
 * line tangent to it, and the curves between meet the arcs tangentially. A part keeps its arcs
 * only where they do no harm (harmless); without any, the result is as without the flag.
 */
function fitWithEdges(loop: Point[], opts: FitOptions): Cubic[] | null {
  const raw = resample(loop, 0.5)
  const n = raw.length
  if (n < 4 * EDGE_MIN_LENGTH) return null
  const cornersFound = findCorners(raw, opts.cornerAngle)
  // Start the loop where no straight edge can pass (a corner, else the sharpest turn), so no edge
  // is cut in two where the loop closes.
  const s = cornersFound.length ? cornersFound[0] : sharpestTurn(raw)
  let pts = [...raw.slice(s), ...raw.slice(0, s)]
  const corners = cornersFound.map((c) => (c - s + n) % n).sort((x, y) => x - y)
  const isCorner = new Uint8Array(n + 1)
  for (const c of corners) isCorner[c] = 1
  isCorner[n] = isCorner[0]
  const at = (i: number) => pts[((i % n) + n) % n]
  let spacing = 0
  for (let i = 0; i < n; i++) spacing += dist(pts[i], pts[(i + 1) % n]) / n

  // Exact arcs find the straight edges too: an arc ends where the line it runs into begins.
  const found: Edge[] = []
  for (let i = 0; i < n && (opts.straightEdges || opts.exactArcs); ) {
    let e = straightEdge(pts, i, isCorner, spacing)
    if (!e) {
      i++
      continue
    }
    // The first point that starts an edge may still be on the curve before it, which cuts the edge
    // short: an edge starting a little later that reaches further replaces it.
    for (let k = i + 1, end = Math.min(e.b - 1, i + Math.ceil((2 * EDGE_MIN_LENGTH) / spacing)); k <= end; k++) {
      const f = straightEdge(pts, k, isCorner, spacing)
      if (f && f.b > e.b) e = f
    }
    // An edge that just continues the previous one (a step of the pixel grid broke it) joins it.
    const prev = found[found.length - 1]
    const joined = prev && e.a - prev.b <= Math.ceil(2 / spacing) ? joinEdges(pts, prev, e, isCorner) : null
    if (joined) found[found.length - 1] = joined
    else found.push(e)
    i = e.b
  }
  // A short edge is kept only where the outline clearly turns just past both its ends (a corner,
  // a rounded corner): a chord of a large gentle arc, straight within the tolerances over a short
  // stretch, has the arc bending on only slightly either side, and stays a curve.
  const reach = Math.ceil(EDGE_MIN_LENGTH / spacing)
  const turns = (p: Point, q: Point, d: Point) => Math.abs(Math.asin(Math.max(-1, Math.min(1, cross(d, norm(sub(q, p))))))) * (180 / Math.PI) >= EDGE_END_TURN || dot(d, sub(q, p)) <= 0
  const edges = found.filter((e) => dist(e.A, e.B) >= EDGE_SURE_LENGTH || (turns(at(e.a - reach + n), at(e.a - (reach >> 1) + n), e.d) && turns(at(e.b + (reach >> 1)), at(e.b + reach), e.d)))
  if (!edges.length && !opts.exactArcs) return null

  const out: Cubic[] = []
  const line = (A: Point, B: Point): Cubic => {
    const d = dist(A, B) / 3
    const u = norm(sub(B, A))
    return [A, add(A, mul(u, d)), sub(B, mul(u, d)), B]
  }
  /** Corners strictly between points g0 and g1 (g1 may run past n, round the loop), in order. */
  const cornersBetween = (g0: number, g1: number) => [...corners, ...corners.map((c) => c + n)].filter((c) => c > g0 && c < g1)
  /** The curve from `first` (direction t1) through points k0+1..k1-1 to `last` (t2, pointing back). */
  const piece = (first: Point, t1: Point | null, k0: number, k1: number, last: Point, t2: Point | null): Cubic[] => {
    const run: Point[] = [first]
    for (let j = k0 + 1; j < k1; j++) run.push(at(j))
    run.push(last)
    if (run.length < 2 || (run.length === 2 && dist(first, last) < 1e-9)) return []
    return fitCubic(run, t1 ?? leftTangent(run), t2 ?? rightTangent(run), opts.error)
  }
  /**
   * Fits the outline between stops (the part between two lines, or between two corners), its own
   * corners kept (rebuilt where possible), its ends following the given points and directions.
   * With exact arcs, each sub-run's arcs (arcs[i]) are drawn exactly, and the parts between them
   * are curves meeting them tangentially. Also returns how many cubics splitting the arcs into
   * pieces of at most 90° added.
   */
  const fitBetween = (stops: number[], sharp: (ReturnType<typeof sharpenCorner> | null)[], ends: { first?: Point; t1?: Point; last?: Point; t2?: Point }, arcs?: Arc[][]) => {
    const curves: Cubic[] = []
    let splits = 0
    for (let i = 0; i + 1 < stops.length; i++) {
      const sa = sharp[i]
      const sb = sharp[i + 1]
      const len = stops[i + 1] - stops[i] + 1
      const trimA = sa ? Math.min(CORNER_TRIM, (len - 2) >> 2) : 0
      const trimB = sb ? Math.min(CORNER_TRIM, (len - 2) >> 2) : 0
      const first = i === 0 && ends.first ? ends.first : sa?.point ?? at(stops[i])
      const last = i + 1 === stops.length - 1 && ends.last ? ends.last : sb?.point ?? at(stops[i + 1])
      const t1 = i === 0 && ends.t1 ? ends.t1 : sa ? sa.outDir : null
      const t2 = i + 1 === stops.length - 1 && ends.t2 ? ends.t2 : sb ? neg(sb.inDir) : null
      let from = first
      let dir = t1
      let k0 = stops[i] + trimA
      for (const arc of arcs?.[i] ?? []) {
        curves.push(...piece(from, dir, k0, arc.i, arc.S, neg(arcTangent(arc.c, arc.S, arc.sgn))))
        const drawn = arcCubics(arc.c, arc.r, arc.S, arc.E, arc.sgn)
        curves.push(...drawn)
        splits += drawn.length - 1
        from = arc.E
        dir = arcTangent(arc.c, arc.E, arc.sgn)
        k0 = arc.j
      }
      curves.push(...piece(from, dir, k0, stops[i + 1] - trimB, last, t2))
    }
    return { curves, splits }
  }
  /**
   * Arcs are drawn only where they do no harm to the outline between points k0 and k1: no more
   * nodes than the ordinary fit (beyond splitting an arc into 90° pieces), on average no further
   * from the traced points, and at most no further than the ordinary fit or ARC_CLOSE (an exact
   * arc keeps its true radius where a free curve bends to the tracing's small errors).
   */
  const harmless = (exact: Cubic[], splits: number, plain: Cubic[], k0: number, k1: number) => {
    if (exact.length > plain.length + splits) return false
    const off = (curves: Cubic[]) => {
      const poly = curves.flatMap((c, q) => samples(c).slice(q ? 1 : 0))
      let max = 0
      let sum = 0
      for (let k = k0 + 1; k < k1; k++) {
        const p = at(k)
        let best = Infinity
        for (let q = 1; q < poly.length; q++) best = Math.min(best, distToSegment(p, poly[q - 1], poly[q]))
        max = Math.max(max, best)
        sum += best
      }
      return { max, mean: sum / Math.max(1, k1 - k0 - 1) }
    }
    const e = off(exact)
    const p = off(plain)
    return e.max <= Math.max(ARC_CLOSE, p.max + ARC_SLACK) && e.mean <= p.mean + ARC_SLACK
  }
  /** Arcs between stops (index ranges), clear of the blurred tips of the corners among them. */
  const arcsBetween = (stops: number[], sharp: (ReturnType<typeof sharpenCorner> | null)[], cyclic = false) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const [x, y] of pts) {
      x0 = Math.min(x0, x)
      y0 = Math.min(y0, y)
      x1 = Math.max(x1, x)
      y1 = Math.max(y1, y)
    }
    const maxR = Math.max(x1 - x0, y1 - y0)
    return stops.slice(1).map((b, i) => findArcs(at, stops[i] + (sharp[i] ? CORNER_TRIM : 0), b - (sharp[i + 1] ? CORNER_TRIM : 0), spacing, maxR, cyclic))
  }

  // Exact arcs on an outline with no straight edge; without any (or where they'd do harm), the
  // ordinary fit, unchanged.
  if (!edges.length) {
    if (corners.length) {
      // Between corners (the loop starts at the first), each corner rebuilt where possible.
      const stops = [...corners, n]
      const sharp = corners.map((c) => sharpenCorner(pts, c))
      sharp.push(sharp[0])
      const arcs = arcsBetween(stops, sharp)
      if (!arcs.some((a) => a.length)) return null
      const exact = fitBetween(stops, sharp, {}, arcs)
      return harmless(exact.curves, exact.splits, fitBetween(stops, sharp, {}).curves, 0, n) ? exact.curves : null
    }
    // A smooth loop: start where it is flattest, so no arc is cut in two where it closes.
    const f = flattestPoint(pts)
    pts = [...pts.slice(f), ...pts.slice(0, f)]
    const arcs = arcsBetween([0, n], [null, null], true)
    if (!arcs[0].length) return null
    const t0 = tangentAt(pts, 0)
    const exact = fitBetween([0, n], [null, null], { t1: t0, t2: neg(t0) }, arcs)
    return harmless(exact.curves, exact.splits, fitBetween([0, n], [null, null], { t1: t0, t2: neg(t0) }).curves, 0, n) ? exact.curves : null
  }

  // Sharp joins first: a gap holding just one corner's blurred tip becomes that corner.
  const m = edges.length
  const sharpJoin: boolean[] = []
  for (let k = 0; k < m; k++) {
    const e = edges[k]
    const f = edges[(k + 1) % m]
    const g0 = e.b
    const g1 = k + 1 < m ? f.a : f.a + n
    const inside = cornersBetween(g0, g1)
    let join = false
    if (inside.length === 1 && (g1 - g0) * spacing <= CORNER_GAP && m > 1) {
      const cross = e.d[0] * f.d[1] - e.d[1] * f.d[0]
      if (Math.abs(cross) >= 0.2) {
        const d = sub(f.A, e.B)
        const t = (d[0] * f.d[1] - d[1] * f.d[0]) / cross
        const X = add(e.B, mul(e.d, t))
        // The corner must lie beyond both edges and near the traced tip.
        if (dot(sub(X, e.A), e.d) > 0 && dot(sub(f.B, X), f.d) > 0 && dist(X, at(inside[0])) <= MAX_CORNER_SHIFT) {
          e.B = X
          f.A = X
          join = true
        }
      }
    }
    sharpJoin.push(join)
  }
  const gaps = edges.map((e, k) => {
    const f = edges[(k + 1) % m]
    const g0 = e.b
    const g1 = k + 1 < m ? f.a : f.a + n
    const stops = [g0, ...cornersBetween(g0, g1), g1]
    const sharp = stops.map((c, i) => (i === 0 || i === stops.length - 1 ? null : sharpenCorner(pts, c % n)))
    return { e, f, g0, g1, stops, sharp, arcs: [] as Arc[][] }
  })
  // Exact arcs in the parts between lines. An arc reaching a line meets it tangentially: a rounded
  // corner between two lines becomes a fillet touching both, the lines ending where it touches.
  // A part keeps its arcs (and its lines their new ends) only where they do no harm.
  if (opts.exactArcs) {
    const near = Math.ceil(ARC_JOIN_GAP / spacing)
    for (let k = 0; k < m; k++) {
      if (sharpJoin[k]) continue
      const g = gaps[k]
      const { e, f } = g
      const arcs = arcsBetween(g.stops, g.sharp)
      if (!arcs.some((a) => a.length)) continue
      const was = { eB: e.B, fA: f.A }
      const firstArc = arcs[0][0] as Arc | undefined
      const lastArc = arcs[arcs.length - 1][arcs[arcs.length - 1].length - 1] as Arc | undefined
      const touchesE = !!firstArc && firstArc.i - g.g0 <= near
      const touchesF = !!lastArc && g.g1 - lastArc.j <= near
      if (!(touchesE && touchesF && firstArc === lastArc && e !== f && fillet(firstArc, e, f))) {
        if (touchesE) tangentTo(firstArc!, e, true)
        if (touchesF) tangentTo(lastArc!, f, false)
      }
      const exact = fitBetween(g.stops, g.sharp, { first: e.B, t1: e.d, last: f.A, t2: neg(f.d) }, arcs)
      const plain = fitBetween(g.stops, g.sharp, { first: was.eB, t1: e.d, last: was.fA, t2: neg(f.d) }).curves
      if (harmless([line(e.A, e.B), ...exact.curves, line(f.A, f.B)], exact.splits, [line(e.A, was.eB), ...plain, line(was.fA, f.B)], g.g0, g.g1)) g.arcs = arcs
      else {
        e.B = was.eB
        f.A = was.fA
      }
    }
  }
  /** Makes an arc the fillet between lines e and f (tangent to both, which then end where it touches), where it nearly is one. */
  function fillet(arc: Arc, e: Edge, f: Edge): boolean {
    const c = filletBetween(at, arc.i, arc.j, e.B, e.d, f.A, f.d, arc)
    if (!c || !followsCircle(at, arc.i, arc.j, spacing, c)) return false
    const T = foot(c.c, e.B, e.d)
    const U = foot(c.c, f.A, f.d)
    const shift = Math.max(ARC_JOIN_GAP, ARC_JOIN_SHIFT * c.r)
    if (dot(sub(T, e.A), e.d) < ARC_JOIN_GAP || dot(sub(f.B, U), f.d) < ARC_JOIN_GAP || dist(T, arc.S) > shift || dist(U, arc.E) > shift) return false
    if (dot(arcTangent(c.c, T, arc.sgn), e.d) <= ARC_JOIN_ALIGN || dot(arcTangent(c.c, U, arc.sgn), f.d) <= ARC_JOIN_ALIGN) return false
    Object.assign(arc, { c: c.c, r: c.r, S: T, E: U })
    e.B = T
    f.A = U
    return true
  }
  /** Makes an arc touch line e (following its end B when `afterLine`, else leading into its start A), where it nearly does. */
  function tangentTo(arc: Arc, e: Edge, afterLine: boolean) {
    const T = foot(arc.c, afterLine ? e.B : e.A, e.d)
    const r = dist(arc.c, T)
    if (Math.abs(r - arc.r) > ARC_TOLERANCE || !followsCircle(at, arc.i, arc.j, spacing, { c: arc.c, r })) return
    if (dot(arcTangent(arc.c, T, arc.sgn), e.d) <= ARC_JOIN_ALIGN) return
    if (afterLine ? dot(sub(T, e.A), e.d) < ARC_JOIN_GAP : dot(sub(e.B, T), e.d) < ARC_JOIN_GAP) return
    if (dist(T, afterLine ? arc.S : arc.E) > Math.max(ARC_JOIN_GAP, ARC_JOIN_SHIFT * r)) return
    arc.r = r
    if (afterLine) {
      arc.S = T
      arc.E = onCircle(arc.c, r, arc.E)
      e.B = T
    } else {
      arc.E = T
      arc.S = onCircle(arc.c, r, arc.S)
      e.A = T
    }
  }

  for (let k = 0; k < m; k++) {
    const { e, f, stops, sharp, arcs } = gaps[k]
    out.push(line(e.A, e.B))
    if (sharpJoin[k]) continue
    // The part between: its own corners kept (rebuilt where possible), its ends following the lines.
    out.push(...fitBetween(stops, sharp, { first: e.B, t1: e.d, last: f.A, t2: neg(f.d) }, arcs).curves)
  }
  return out
}

/** How much further (px) from the outline than the ordinary fit an outline with arcs may be. */
const ARC_SLACK = 0.02
const ARC_CLOSE = 0.15
/** An arc this close (px) to a line's end is taken to meet it, and a line must keep at least this much. */
const ARC_JOIN_GAP = 2
/** How far (as a share of the radius) meeting a line tangentially may move an arc's end. */
const ARC_JOIN_SHIFT = 0.35
/** An arc meets a line tangentially only where it already runs nearly along it (cosine). */
const ARC_JOIN_ALIGN = 0.95

/** The foot of the perpendicular from c to the line through P with unit direction d. */
const foot = (c: Point, P: Point, d: Point): Point => add(P, mul(d, dot(sub(c, P), d)))
/** The point of the circle (c, r) nearest p. */
const onCircle = (c: Point, r: number, p: Point): Point => add(c, mul(norm(sub(p, c)), r))

/** Index of the point where the outline turns least (chords ~5 px each way). */
function flattestPoint(pts: Point[]): number {
  const n = pts.length
  const k = Math.min(10, Math.max(2, Math.floor(n / 8)))
  let best = 0
  let least = Infinity
  for (let i = 0; i < n; i++) {
    const p = pts[(i - k + n) % n]
    const c = pts[i]
    const q = pts[(i + k) % n]
    let d = Math.abs(Math.atan2(q[1] - c[1], q[0] - c[0]) - Math.atan2(c[1] - p[1], c[0] - p[0]))
    if (d > Math.PI) d = 2 * Math.PI - d
    if (d < least) [least, best] = [d, i]
  }
  return best
}

/**
 * The longest straight edge starting at point i (none through a corner), or null when there is none
 * at least EDGE_MIN_LENGTH long. Traced edges at an angle to the pixel grid step a little every few
 * pixels, so a short window can look bowed where a longer one plainly isn't: windows a quarter
 * longer each time are tried, past up to EDGE_LOOKAHEAD failures, and the longest that passes is
 * then extended point by point. Finally the edge sheds end points that already lean into the next
 * curve.
 */
function straightEdge(pts: Point[], i: number, isCorner: Uint8Array, spacing: number): Edge | null {
  const n = pts.length
  if (isCorner[i]) return null
  const fits = (j: number) => {
    if (j > n || isCorner[j]) return null
    for (let k = i + 1; k < j; k++) if (isCorner[k]) return null
    return straightFit(pts, i, j)
  }
  let j = -1
  let fit: { c: Point; d: Point } | null = null
  for (let len = EDGE_MIN_LENGTH, misses = 0; misses <= EDGE_LOOKAHEAD && i + len / spacing <= n; len *= 1.25) {
    const k = i + Math.ceil(len / spacing)
    const f = fits(k)
    if (f) [j, fit, misses] = [k, f, 0]
    else misses++
  }
  if (!fit) return null
  for (let step = Math.max(1, (j - i) >> 3); ; ) {
    const next = fits(j + step)
    if (next) [j, fit] = [j + step, next]
    else if (step > 1) step >>= 1
    else break
  }
  return edgeOf(pts, i, j, fit)
}

/** Two neighbouring edges as one, when together they are still one straight edge. */
function joinEdges(pts: Point[], e: Edge, f: Edge, isCorner: Uint8Array): Edge | null {
  for (let k = e.a + 1; k < f.b; k++) if (isCorner[k]) return null
  const fit = straightFit(pts, e.a, f.b)
  return fit && edgeOf(pts, e.a, f.b, fit)
}

/** The edge on points a..b, given their line: end points that lean off it (into the next curve) shed. */
function edgeOf(pts: Point[], a: number, b: number, fit: { c: Point; d: Point }): Edge | null {
  const n = pts.length
  const at = (k: number) => pts[k % n]
  for (;;) {
    const off = (k: number) => Math.abs(dot(sub(at(k), fit.c), [-fit.d[1], fit.d[0]]))
    let moved = false
    if (b - a > 4 && off(a) > EDGE_END_TOLERANCE) (a++, (moved = true))
    if (b - a > 4 && off(b) > EDGE_END_TOLERANCE) (b--, (moved = true))
    if (!moved) break
    fit = straightFit(pts, a, b) ?? fit
  }
  if (dist(at(a), at(b)) < EDGE_MIN_LENGTH) return null
  let d = fit.d
  if (dot(sub(at(b), at(a)), d) < 0) d = neg(d)
  const proj = (p: Point) => add(fit.c, mul(d, dot(sub(p, fit.c), d)))
  return { a, b, d, A: proj(at(a)), B: proj(at(b)) }
}

/**
 * Least-squares line through points i..j (wrapping) when they form a straight edge: all within
 * EDGE_TOLERANCE of it, progressing along it, and not bowing by more than EDGE_SAGITTA. Else null.
 */
function straightFit(pts: Point[], i: number, j: number): { c: Point; d: Point } | null {
  const n = pts.length
  const run: Point[] = []
  for (let k = i; k <= j; k++) run.push(pts[k % n])
  const line = fitLine(run)
  const nrm: Point = [-line.d[1], line.d[0]]
  // Coordinates along (u) and across (v) the line; a parabola v = a·u² + b·u + c fitted to them.
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0, t0 = 0, t1 = 0, t2 = 0
  let lo = Infinity, hi = -Infinity, prev = -Infinity
  const sign = dot(sub(run[run.length - 1], run[0]), line.d) < 0 ? -1 : 1
  for (const p of run) {
    const q = sub(p, line.c)
    const u = dot(q, line.d)
    const v = dot(q, nrm)
    if (Math.abs(v) > EDGE_TOLERANCE) return null
    // No doubling back along the line.
    if (sign * u < prev - EDGE_TOLERANCE) return null
    prev = Math.max(prev, sign * u)
    lo = Math.min(lo, u)
    hi = Math.max(hi, u)
    const u2 = u * u
    s0++; s1 += u; s2 += u2; s3 += u2 * u; s4 += u2 * u2
    t0 += v; t1 += u * v; t2 += u2 * v
  }
  // Solve [[s4 s3 s2] [s3 s2 s1] [s2 s1 s0]]·[a b c] = [t2 t1 t0] for a (Cramer's rule).
  const det3 = (m: number[]) => m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6])
  const D = det3([s4, s3, s2, s3, s2, s1, s2, s1, s0])
  if (Math.abs(D) < 1e-12) return null
  const a = det3([t2, s3, s2, t1, s2, s1, t0, s1, s0]) / D
  const half = (hi - lo) / 2
  if (Math.abs(a) * half * half > EDGE_SAGITTA) return null
  return line
}

/** Index of the point where the outline turns most sharply (chords ~3 px each way). */
function sharpestTurn(pts: Point[]): number {
  const n = pts.length
  const k = Math.min(6, Math.max(2, Math.floor(n / 8)))
  let best = 0
  let most = -1
  for (let i = 0; i < n; i++) {
    const p = pts[(i - k + n) % n]
    const c = pts[i]
    const q = pts[(i + k) % n]
    let d = Math.abs(Math.atan2(q[1] - c[1], q[0] - c[0]) - Math.atan2(c[1] - p[1], c[0] - p[0]))
    if (d > Math.PI) d = 2 * Math.PI - d
    if (d > most) [most, best] = [d, i]
  }
  return best
}

/** Whether a cubic is a straight line (its controls on the chord, between its ends). */
export function isLine(c: Cubic): boolean {
  const len = dist(c[0], c[3])
  if (len < 1e-9) return false
  const u = norm(sub(c[3], c[0]))
  for (const p of [c[1], c[2]]) {
    const q = sub(p, c[0])
    if (Math.abs(q[0] * u[1] - q[1] * u[0]) > 1e-7 * Math.max(1, len)) return false
    const t = dot(q, u)
    if (t < -1e-9 || t > len + 1e-9) return false
  }
  return true
}

/** Points within this distance (px) of one line form a straight stretch… */
const STRAIGHT_TOLERANCE = 0.12
/** …when it is at least this long (px). */
const STRAIGHT_MIN_LENGTH = 3

/**
 * Fits an open run: its straight stretches as exact lines, the parts between as cubics whose ends
 * follow the neighbouring lines' directions. A short part between (the end of a thin line, at most
 * CAP_LENGTH across) is one cubic: a clean rounded end, never a cluster of small wiggling curves.
 */
function fitWithLines(run: Point[], t1: Point, t2: Point, error: number): Cubic[] {
  const lines = straightStretches(run)
  if (!lines.length) return fitCubic(run, t1, t2, error)
  const between = (part: Point[], a: Point, b: Point) => fitCubic(part, a, b, dist(part[0], part[part.length - 1]) <= CAP_LENGTH ? Infinity : error)
  const out: Cubic[] = []
  let at = 0
  let tin = t1
  for (const [a, b] of lines) {
    const dir = norm(sub(run[b], run[a]))
    if (a > at) out.push(...between(run.slice(at, a + 1), tin, neg(dir)))
    const d = dist(run[a], run[b]) / 3
    out.push([run[a], add(run[a], mul(dir, d)), sub(run[b], mul(dir, d)), run[b]])
    at = b
    tin = dir
  }
  if (at < run.length - 1) out.push(...between(run.slice(at), tin, t2))
  return out
}
/** A part between straight stretches up to this far across (px) is a line end: one cubic. */
const CAP_LENGTH = 3

/** Maximal straight stretches [start, end] of a run, in order, not overlapping. */
function straightStretches(run: Point[]): [number, number][] {
  const out: [number, number][] = []
  let i = 0
  while (i < run.length - 2) {
    let j = i + 2
    let good = -1
    while (j < run.length && straightBetween(run, i, j)) good = j++
    if (good > 0 && dist(run[i], run[good]) >= STRAIGHT_MIN_LENGTH) {
      out.push([i, good])
      i = good
    } else i++
  }
  return out
}
function straightBetween(run: Point[], i: number, j: number): boolean {
  const a = run[i]
  const b = run[j]
  const len = dist(a, b)
  if (len < 1e-6) return false
  for (let k = i + 1; k < j; k++) {
    const p = run[k]
    const off = Math.abs((b[0] - a[0]) * (a[1] - p[1]) - (a[0] - p[0]) * (b[1] - a[1])) / len
    if (off > STRAIGHT_TOLERANCE) return false
    // Points must also progress along the line (no doubling back).
    const along = ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / len
    if (along < -STRAIGHT_TOLERANCE || along > len + STRAIGHT_TOLERANCE) return false
  }
  return true
}

/**
 * Joins neighbouring curves of a closed outline wherever they meet smoothly (their directions at
 * the join within SMOOTH_JOIN) and one cubic follows both within `tolerance` px: the same shape
 * with fewer anchors. Corners are never joined.
 */
export function mergeCurves(curves: Cubic[], tolerance: number): Cubic[] {
  const out = curves.slice()
  let i = 0
  let since = 0
  while (out.length > 2 && since < out.length) {
    const j = (i + 1) % out.length
    const a = out[i]
    const b = out[j]
    const tIn = endDir(a)
    const tOut = startDir(b)
    let joined: Cubic | null = null
    if (tIn && tOut && dot(tIn, tOut) >= Math.cos((SMOOTH_JOIN * Math.PI) / 180)) {
      const pts = [...samples(a), ...samples(b).slice(1)]
      const t1 = startDir(a)
      const t2 = endDir(b)
      if (t1 && t2) {
        // One cubic through both, judged by distance from it (not by parameter, which differs
        // between two pieces of different lengths).
        const one = fitCubic(pts, t1, neg(t2), Infinity)[0]
        if (pts.every((p) => nearCurve(p, one, tolerance)) && samples(one).every((p) => nearPoints(p, pts, tolerance))) joined = one
      }
    }
    if (joined) {
      if (j === 0) {
        out.splice(i, 1)
        out[0] = joined
        i = 0
      } else out.splice(i, 2, joined)
      since = 0
    } else {
      i = (i + 1) % out.length
      since++
    }
  }
  return out
}
/** Directions (degrees) at a join closer than this count as smooth. */
const SMOOTH_JOIN = 8

function startDir(c: Cubic): Point | null {
  for (const p of [c[1], c[2], c[3]]) if (dist(p, c[0]) > 1e-6) return norm(sub(p, c[0]))
  return null
}
function endDir(c: Cubic): Point | null {
  for (const p of [c[2], c[1], c[0]]) if (dist(c[3], p) > 1e-6) return norm(sub(c[3], p))
  return null
}
function samples(c: Cubic): Point[] {
  const out: Point[] = []
  for (let i = 0; i <= 10; i++) out.push(bezierAt(c, i / 10))
  return out
}
/** Whether p lies within `tolerance` of the polyline through pts. */
function nearPoints(p: Point, pts: Point[], tolerance: number): boolean {
  for (let i = 1; i < pts.length; i++) if (distToSegment(p, pts[i - 1], pts[i]) <= tolerance) return true
  return false
}
function nearCurve(p: Point, c: Cubic, tolerance: number): boolean {
  let prev = c[0]
  for (let i = 1; i <= 40; i++) {
    const q = bezierAt(c, i / 40)
    if (distToSegment(p, prev, q) <= tolerance) return true
    prev = q
  }
  return false
}

/**
 * If a closed contour is made only of straight edges between corners, returns the corner
 * points; otherwise null. Used to recognize polygons and stars.
 *
 * Each edge gets a least-squares line through its middle (the ends are skipped, since blur and
 * JPEG compression round corners off and blunt sharp tips), and each corner is rebuilt as the
 * intersection of its two neighbouring edge lines, so even very sharp star points come out
 * exact.
 */
export function polygonCorners(loop: Point[], cornerAngle: number, smoothing = 0.8): Point[] | null {
  const pts = resample(loop, 0.5)
  const n = pts.length
  if (n < 12) return null
  const idx = findCorners(pts, cornerAngle)
  const m = idx.length
  if (m < 3) return null

  const lines: { c: Point; d: Point }[] = []
  for (let k = 0; k < m; k++) {
    const run = slice(pts, idx[k], idx[(k + 1) % m])
    const trim = Math.min(EDGE_TRIM, Math.floor(run.length * 0.2))
    const mid = run.slice(trim, run.length - trim)
    if (mid.length < 4) return null
    const line = fitLine(mid)
    const len = dist(run[0], run[run.length - 1])
    const tol = Math.max(0.45, len * 0.01)
    for (const p of mid) if (distToLine(p, line.c, add(line.c, line.d)) > tol) return null
    lines.push(line)
  }

  const corners: Point[] = []
  for (let k = 0; k < m; k++) {
    const a = lines[(k - 1 + m) % m]
    const b = lines[k]
    const cross = a.d[0] * b.d[1] - a.d[1] * b.d[0]
    if (Math.abs(cross) < 0.05) return null // nearly parallel: not a real corner
    const d = sub(b.c, a.c)
    const t = (d[0] * b.d[1] - d[1] * b.d[0]) / cross
    const p = add(a.c, mul(a.d, t))
    // A rebuilt corner may extend a blunted tip, but not wander off.
    const prevLen = dist(pts[idx[(k - 1 + m) % m]], pts[idx[k]])
    const nextLen = dist(pts[idx[k]], pts[idx[(k + 1) % m]])
    if (dist(p, pts[idx[k]]) > Math.max(3, 0.25 * Math.min(prevLen, nextLen))) return null
    corners.push(p)
  }

  // Final check over the whole outline, including the ends skipped above: every point must lie
  // on the polygon's edges. Near a corner a little more slack is allowed for blur, but a curved
  // letter bowl or a properly rounded corner sits too far off and stays a curve.
  for (const p of pts) {
    let edge = Infinity
    let vertex = Infinity
    for (let k = 0; k < m; k++) {
      edge = Math.min(edge, distToSegment(p, corners[k], corners[(k + 1) % m]))
      vertex = Math.min(vertex, dist(p, corners[k]))
    }
    if (edge > (vertex < CORNER_ZONE ? CORNER_SLACK * Math.max(1, smoothing / 0.8) : EDGE_SLACK)) return null
  }
  return corners
}

function distToSegment(p: Point, a: Point, b: Point): number {
  const ab = sub(b, a)
  const len2 = ab[0] ** 2 + ab[1] ** 2
  const t = len2 ? Math.min(1, Math.max(0, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / len2)) : 0
  return dist(p, add(a, mul(ab, t)))
}

/** How far (px) traced points may sit from a polygon's edges, away from and near its corners. */
const EDGE_SLACK = 0.4
const CORNER_SLACK = 1.2
const CORNER_ZONE = 6

/** Total-least-squares line: centroid and unit direction. */
export function fitLine(pts: Point[]): { c: Point; d: Point } {
  let cx = 0, cy = 0
  for (const p of pts) {
    cx += p[0]
    cy += p[1]
  }
  cx /= pts.length
  cy /= pts.length
  let sxx = 0, syy = 0, sxy = 0
  for (const [x, y] of pts) {
    sxx += (x - cx) ** 2
    syy += (y - cy) ** 2
    sxy += (x - cx) * (y - cy)
  }
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy)
  return { c: [cx, cy], d: [Math.cos(angle), Math.sin(angle)] }
}

function distToLine(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len = Math.hypot(dx, dy) || 1
  return Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / len
}

/** Samples (0.5 px each) skipped at each end of an edge when fitting its line. */
const EDGE_TRIM = 10

/** Samples (0.5 px each) treated as the rounded part of a corner. */
const CORNER_TRIM = 3
/** Max distance (px) a reconstructed corner may move from the traced contour. */
const MAX_CORNER_SHIFT = 2.5

/**
 * Intersects the straight edges coming into and leaving a corner (measured just outside the
 * rounded zone). Returns null when the edges are near-parallel or the intersection is
 * implausibly far from the contour, in which case the corner is kept as traced.
 */
function sharpenCorner(pts: Point[], c: number): { point: Point; inDir: Point; outDir: Point } | null {
  const n = pts.length
  const at = (i: number) => pts[((i % n) + n) % n]
  const k = CORNER_TRIM
  const a0 = at(c - 3 * k)
  const a1 = at(c - k)
  const b0 = at(c + k)
  const b1 = at(c + 3 * k)
  const inDir = norm(sub(a1, a0))
  const outDir = norm(sub(b1, b0))
  const cross = inDir[0] * outDir[1] - inDir[1] * outDir[0]
  if (Math.abs(cross) < 0.2) return null
  // Solve a1 + s*inDir = b0 + t*outDir for s.
  const d = sub(b0, a1)
  const s = (d[0] * outDir[1] - d[1] * outDir[0]) / cross
  const point = add(a1, mul(inDir, s))
  if (dist(point, pts[c]) > MAX_CORNER_SHIFT) return null
  return { point, inDir, outDir }
}

/** Points from a to b (b exclusive of wrap; inclusive end point), wrapping around the loop. */
export function slice(pts: Point[], a: number, b: number): Point[] {
  const n = pts.length
  if (b <= a) b += n
  const out: Point[] = []
  for (let i = a; i <= b; i++) out.push(pts[i % n])
  return out
}

/**
 * Resamples a closed polyline at even spacing (at most `step`) all the way round, closing edge
 * included, so there's no short gap or near-duplicate point where the loop meets itself.
 * Repeated and non-finite vertices are dropped first.
 */
export function resample(loop: Point[], step: number): Point[] {
  if (!(step > 0) || !Number.isFinite(step)) throw new RangeError('Resampling step must be a positive number')
  const v: Point[] = []
  for (const p of loop) {
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue
    const last = v[v.length - 1]
    if (!last || last[0] !== p[0] || last[1] !== p[1]) v.push(p)
  }
  while (v.length > 1 && v[0][0] === v[v.length - 1][0] && v[0][1] === v[v.length - 1][1]) v.pop()
  if (v.length < 2) return v.map((p) => [p[0], p[1]])

  const lengths = v.map((a, i) => dist(a, v[(i + 1) % v.length]))
  const perimeter = lengths.reduce((s, l) => s + l, 0)
  const count = Math.ceil(perimeter / step - 1e-9)
  const spacing = perimeter / count
  const out: Point[] = []
  let edge = 0
  let edgeStart = 0
  for (let i = 0; i < count; i++) {
    const d = i * spacing
    while (edge < v.length - 1 && d >= edgeStart + lengths[edge]) edgeStart += lengths[edge++]
    const a = v[edge]
    const b = v[(edge + 1) % v.length]
    const t = (d - edgeStart) / lengths[edge]
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])
  }
  return out
}

/**
 * Corner = local maximum of turning angle, measured between chords reaching ~3 px each way,
 * above the threshold. Far-reaching chords ignore sub-pixel jitter.
 */
export function findCorners(pts: Point[], thresholdDeg: number): number[] {
  const n = pts.length
  const k = Math.min(6, Math.max(2, Math.floor(n / 8)))
  const angle = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const p = pts[(i - k + n) % n]
    const c = pts[i]
    const q = pts[(i + k) % n]
    const a1 = Math.atan2(c[1] - p[1], c[0] - p[0])
    const a2 = Math.atan2(q[1] - c[1], q[0] - c[0])
    let d = Math.abs(a2 - a1)
    if (d > Math.PI) d = 2 * Math.PI - d
    angle[i] = (d * 180) / Math.PI
  }
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    if (angle[i] < thresholdDeg) continue
    let isMax = true
    for (let j = 1; j <= k && isMax; j++) {
      // Strictly greater ahead, greater-or-equal behind: plateaus yield their first point.
      if (angle[(i + j) % n] > angle[i] || angle[(i - j + n) % n] >= angle[i]) isMax = false
    }
    if (isMax && (!out.length || i - out[out.length - 1] > k)) out.push(i)
  }
  // The last and first corners may be too close across the wrap-around.
  if (out.length > 1 && out[0] + n - out[out.length - 1] <= k) out.pop()
  return out
}

// --- vector helpers ---
const sub = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1]]
const add = (a: Point, b: Point): Point => [a[0] + b[0], a[1] + b[1]]
const mul = (a: Point, s: number): Point => [a[0] * s, a[1] * s]
const dot = (a: Point, b: Point) => a[0] * b[0] + a[1] * b[1]
const cross = (a: Point, b: Point) => a[0] * b[1] - a[1] * b[0]
const neg = (a: Point): Point => [-a[0], -a[1]]
const norm = (a: Point): Point => {
  const l = Math.hypot(a[0], a[1]) || 1
  return [a[0] / l, a[1] / l]
}
const dist = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1])

function tangentAt(pts: Point[], i: number): Point {
  const n = pts.length
  return norm(sub(pts[(i + 3) % n], pts[(i - 3 + n) % n]))
}
function leftTangent(run: Point[]): Point {
  return norm(sub(run[Math.min(3, run.length - 1)], run[0]))
}
function rightTangent(run: Point[]): Point {
  return norm(sub(run[Math.max(0, run.length - 4)], run[run.length - 1]))
}

// --- Schneider, "An Algorithm for Automatically Fitting Digitized Curves" (Graphics Gems, 1990) ---

function fitCubic(pts: Point[], tHat1: Point, tHat2: Point, error: number, depth = 0): Cubic[] {
  if (pts.length === 2) {
    const d = dist(pts[0], pts[1]) / 3
    return [[pts[0], add(pts[0], mul(tHat1, d)), add(pts[1], mul(tHat2, d)), pts[1]]]
  }
  let u = chordLengthParams(pts)
  let bez = generateBezier(pts, u, tHat1, tHat2)
  let { maxError, splitPoint } = computeMaxError(pts, bez, u)
  if (maxError < error) return [bez]
  // Close enough to try improving the parameterization before splitting.
  if (maxError < error * 4) {
    for (let i = 0; i < 6; i++) {
      u = reparameterize(bez, pts, u)
      bez = generateBezier(pts, u, tHat1, tHat2)
      ;({ maxError, splitPoint } = computeMaxError(pts, bez, u))
      if (maxError < error) return [bez]
    }
  }
  if (depth > 24 || pts.length < 4) return [bez]
  splitPoint = Math.min(pts.length - 2, Math.max(1, splitPoint))
  const center = norm(sub(pts[splitPoint - 1], pts[splitPoint + 1]))
  return [
    ...fitCubic(pts.slice(0, splitPoint + 1), tHat1, center, error, depth + 1),
    ...fitCubic(pts.slice(splitPoint), neg(center), tHat2, error, depth + 1),
  ]
}

function chordLengthParams(pts: Point[]): number[] {
  const u = [0]
  for (let i = 1; i < pts.length; i++) u.push(u[i - 1] + dist(pts[i], pts[i - 1]))
  const total = u[u.length - 1] || 1
  return u.map((v) => v / total)
}

function generateBezier(pts: Point[], u: number[], tHat1: Point, tHat2: Point): Cubic {
  const first = pts[0]
  const last = pts[pts.length - 1]
  const C = [
    [0, 0],
    [0, 0],
  ]
  const X = [0, 0]
  for (let i = 0; i < pts.length; i++) {
    const t = u[i]
    const b0 = (1 - t) ** 3
    const b1 = 3 * t * (1 - t) ** 2
    const b2 = 3 * t * t * (1 - t)
    const b3 = t ** 3
    const a1 = mul(tHat1, b1)
    const a2 = mul(tHat2, b2)
    C[0][0] += dot(a1, a1)
    C[0][1] += dot(a1, a2)
    C[1][1] += dot(a2, a2)
    const tmp = sub(pts[i], add(mul(first, b0 + b1), mul(last, b2 + b3)))
    X[0] += dot(a1, tmp)
    X[1] += dot(a2, tmp)
  }
  C[1][0] = C[0][1]
  const det = C[0][0] * C[1][1] - C[1][0] * C[0][1]
  let alpha1 = det ? (X[0] * C[1][1] - X[1] * C[0][1]) / det : 0
  let alpha2 = det ? (C[0][0] * X[1] - C[1][0] * X[0]) / det : 0
  const segLength = dist(first, last)
  const epsilon = 1e-6 * segLength
  // A handle longer than the stretch of outline it describes overshoots wildly (short runs with
  // nearly opposite tangents can solve to handles hundreds of px long).
  let arc = 0
  for (let i = 1; i < pts.length; i++) arc += dist(pts[i - 1], pts[i])
  if (alpha1 < epsilon || alpha2 < epsilon || alpha1 > arc || alpha2 > arc) {
    // Degenerate fit: fall back to the Wu/Barsky heuristic.
    alpha1 = alpha2 = segLength / 3
  }
  return [first, add(first, mul(tHat1, alpha1)), add(last, mul(tHat2, alpha2)), last]
}

function bezierAt(b: Cubic, t: number): Point {
  const mt = 1 - t
  const a = mt * mt * mt
  const c = 3 * mt * mt * t
  const d = 3 * mt * t * t
  const e = t * t * t
  return [a * b[0][0] + c * b[1][0] + d * b[2][0] + e * b[3][0], a * b[0][1] + c * b[1][1] + d * b[2][1] + e * b[3][1]]
}

function reparameterize(b: Cubic, pts: Point[], u: number[]): number[] {
  return u.map((t, i) => newtonRoot(b, pts[i], t))
}

function newtonRoot(b: Cubic, p: Point, t: number): number {
  const d = sub(bezierAt(b, t), p)
  // First and second derivatives.
  const q1: Point[] = [mul(sub(b[1], b[0]), 3), mul(sub(b[2], b[1]), 3), mul(sub(b[3], b[2]), 3)]
  const q2: Point[] = [mul(sub(q1[1], q1[0]), 2), mul(sub(q1[2], q1[1]), 2)]
  const mt = 1 - t
  const d1: Point = add(add(mul(q1[0], mt * mt), mul(q1[1], 2 * mt * t)), mul(q1[2], t * t))
  const d2: Point = add(mul(q2[0], mt), mul(q2[1], t))
  const num = dot(d, d1)
  const den = dot(d1, d1) + dot(d, d2)
  if (!den) return t
  return Math.min(1, Math.max(0, t - num / den))
}

function computeMaxError(pts: Point[], b: Cubic, u: number[]): { maxError: number; splitPoint: number } {
  let maxError = 0
  let splitPoint = pts.length >> 1
  for (let i = 1; i < pts.length - 1; i++) {
    const d = dist(bezierAt(b, u[i]), pts[i])
    if (d > maxError) {
      maxError = d
      splitPoint = i
    }
  }
  return { maxError, splitPoint }
}
