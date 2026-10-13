import type { Point } from './contours'

export interface FitOptions {
  /** Max distance (px) a fitted curve may deviate from the contour. */
  error: number
  /** Turning angle (degrees) above which a point is kept as a sharp corner. */
  cornerAngle: number
}

/** A cubic Bézier: start, two controls, end. */
export type Cubic = [Point, Point, Point, Point]

/**
 * Fits a closed contour with cubic Béziers: resample evenly, split at corners, then fit each
 * smooth run with Schneider's error-bounded algorithm. Returns the curves in order.
 */
export function fitClosed(loop: Point[], opts: FitOptions): Cubic[] {
  const pts = resample(loop, 0.5)
  if (pts.length < 4) return []
  const corners = findCorners(pts, opts.cornerAngle)

  const n = pts.length
  const curves: Cubic[] = []
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
    curves.push(...fitCubic(run, t1, t2, opts.error))
  }
  return curves
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
  if (alpha1 < epsilon || alpha2 < epsilon) {
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
