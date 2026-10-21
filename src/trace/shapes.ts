import { area, type Point } from './contours'
import { polygonCorners } from './fit'

export type ShapeKind = 'circle' | 'ellipse' | 'star' | 'polygon'

export interface ExactShape {
  kind: ShapeKind
  /** SVG path data for this one closed shape. */
  d: string
}

export interface ShapeOptions {
  /** Corner threshold in degrees, as used for curve fitting. */
  cornerAngle: number
  precision: number
  /** The tracer's edge smoothing; more smoothing rounds corners more, so allow for it. */
  smoothing?: number
  /** Fine detail: small circles drawn exact, and no round outline passed as a polygon (TraceOptions.roundShapes). */
  roundCheck?: boolean
}

/**
 * Recognizes outlines that are really geometric primitives (circles, ellipses, regular stars
 * and polygons, or any straight-edged polygon) and returns exact path data for them. Returns
 * null for everything else, which then gets ordinary curve fitting.
 *
 * Primitives make cleaner files: a traced circle becomes one circle with 4 nodes instead of a
 * dozen wobbly segments, and a star keeps perfectly straight edges and even points.
 */
export function detectShape(loop: Point[], opts: ShapeOptions): ExactShape | null {
  if (loop.length < 8) return null
  const m = moments(loop)
  if (!m || m.area < 12) return null
  return fitEllipse(loop, m, opts.precision) ?? fitPolygon(loop, m, opts) ?? (opts.roundCheck ? smallCircle(loop, m, opts.precision) : null)
}

/**
 * A small round outline (below MIN_RADIUS, which fitEllipse leaves alone) that is a circle within
 * a fraction of a pixel all round: drawn as an exact circle.
 */
function smallCircle(loop: Point[], m: Moments, precision: number): ExactShape | null {
  const r = roundness(loop, m)
  if (r.radius < SMALL_RADIUS || r.radius >= MIN_RADIUS) return null
  // Round, not oval: both axes within 4%.
  const tr = m.sxx + m.syy
  const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - (m.sxx * m.syy - m.sxy * m.sxy)))
  if (tr / 2 - disc <= 0 || Math.sqrt((tr / 2 + disc) / (tr / 2 - disc)) > 1.04) return null
  if (r.max > Math.max(0.3, 0.06 * r.radius) || r.rms > 0.15) return null
  return { kind: 'circle', d: ellipsePath(m.cx, m.cy, r.radius, r.radius, 0, precision) }
}
const SMALL_RADIUS = 2.5

/** Mean distance of the outline from its centre, and how far it strays from that circle. */
function roundness(loop: Point[], m: Moments): { radius: number; max: number; rms: number } {
  const d = loop.map(([x, y]) => Math.hypot(x - m.cx, y - m.cy))
  const radius = d.reduce((s, v) => s + v, 0) / d.length
  let max = 0
  let sq = 0
  for (const v of d) {
    max = Math.max(max, Math.abs(v - radius))
    sq += (v - radius) ** 2
  }
  return { radius, max, rms: Math.sqrt(sq / d.length) }
}

export interface Moments {
  area: number
  cx: number
  cy: number
  /** Normalized central second moments (per unit area). */
  sxx: number
  syy: number
  sxy: number
}

/** Area moments of a closed polygon (Green's theorem), independent of point spacing. */
export function moments(loop: Point[]): Moments | null {
  let a = 0, cx = 0, cy = 0, xx = 0, yy = 0, xy = 0
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const [x0, y0] = loop[j]
    const [x1, y1] = loop[i]
    const c = x0 * y1 - x1 * y0
    a += c
    cx += (x0 + x1) * c
    cy += (y0 + y1) * c
    xx += (x0 * x0 + x0 * x1 + x1 * x1) * c
    yy += (y0 * y0 + y0 * y1 + y1 * y1) * c
    xy += (x0 * y1 + 2 * x0 * y0 + 2 * x1 * y1 + x1 * y0) * c
  }
  a /= 2
  if (Math.abs(a) < 1e-9) return null
  cx /= 6 * a
  cy /= 6 * a
  const A = Math.abs(a)
  const s = Math.sign(a)
  return {
    area: A,
    cx,
    cy,
    sxx: (s * xx) / 12 / A - cx * cx,
    syy: (s * yy) / 12 / A - cy * cy,
    sxy: (s * xy) / 24 / A - cx * cy,
  }
}

// ---------- Circles and ellipses ----------

const KAPPA = 0.5522847498 // cubic Bézier quarter-circle constant
const POLYGON_CORNER_ANGLE = 30
const MIN_RADIUS = 6

function fitEllipse(loop: Point[], m: Moments, precision: number): ExactShape | null {
  // For a filled ellipse with semi-axes a, b the normalized second moments are a²/4 and b²/4
  // along its axes, so the axes come straight from the covariance eigen-decomposition.
  const tr = m.sxx + m.syy
  const det = m.sxx * m.syy - m.sxy * m.sxy
  const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det))
  const l1 = tr / 2 + disc
  const l2 = tr / 2 - disc
  if (l2 <= 0) return null
  let a = 2 * Math.sqrt(l1)
  let b = 2 * Math.sqrt(l2)
  // Below ~12 px across, letter counters and dots look elliptical by accident; leave them be.
  if (b < MIN_RADIUS) return null
  const theta = 0.5 * Math.atan2(2 * m.sxy, m.sxx - m.syy)
  const cos = Math.cos(theta)
  const sin = Math.sin(theta)

  // Distance of every contour point from the ellipse, approximated radially.
  let maxErr = 0
  let sumErr = 0
  for (const [x, y] of loop) {
    const dx = x - m.cx
    const dy = y - m.cy
    const u = dx * cos + dy * sin
    const v = -dx * sin + dy * cos
    const rho = Math.hypot(u / a, v / b)
    const dist = Math.hypot(u, v)
    const err = rho > 0 ? Math.abs(dist - dist / rho) : b
    maxErr = Math.max(maxErr, err)
    sumErr += err
  }
  const circle = Math.abs(a - b) / a < 0.03
  // Ellipses have more freedom to fit something by accident, so they get a tighter tolerance.
  const tol = circle ? Math.max(0.6, 0.02 * b) : Math.max(0.45, 0.012 * b)
  if (maxErr > tol || sumErr / loop.length > tol * 0.45) return null

  if (circle) a = b = (a + b) / 2
  return { kind: circle ? 'circle' : 'ellipse', d: ellipsePath(m.cx, m.cy, a, b, circle ? 0 : theta, precision) }
}

export function ellipsePath(cx: number, cy: number, a: number, b: number, theta: number, precision: number): string {
  const f = (v: number) => +v.toFixed(precision)
  const cos = Math.cos(theta)
  const sin = Math.sin(theta)
  const P = (u: number, v: number) => `${f(cx + u * cos - v * sin)} ${f(cy + u * sin + v * cos)}`
  const k = KAPPA
  return (
    `M${P(a, 0)}` +
    `C${P(a, k * b)} ${P(k * a, b)} ${P(0, b)}` +
    `C${P(-k * a, b)} ${P(-a, k * b)} ${P(-a, 0)}` +
    `C${P(-a, -k * b)} ${P(-k * a, -b)} ${P(0, -b)}` +
    `C${P(k * a, -b)} ${P(a, -k * b)} ${P(a, 0)}Z`
  )
}

// ---------- Stars and polygons ----------

function fitPolygon(loop: Point[], m: Moments, opts: ShapeOptions): ExactShape | null {
  // A fixed, fairly low threshold finds shallow corners too (a star's inner points); the
  // straight-edge test inside polygonCorners keeps curved shapes out.
  const corners = polygonCorners(loop, Math.min(opts.cornerAngle, POLYGON_CORNER_ANGLE), opts.smoothing)
  if (!corners || corners.length < 3 || corners.length > 64) return null
  // The straight-edged polygon must cover the same area as the traced outline.
  if (Math.abs(Math.abs(area(corners)) - m.area) > Math.max(4, m.area * 0.03)) return null
  // Real corners: a small round outline (a dot, a ring's hole) can pass as a polygon, so the outline
  // must follow the polygon more closely than a circle. (A small star traced as a pentagon does,
  // and keeps it: star shapes are separate work.)
  if (opts.roundCheck && roundness(loop, m).rms <= polygonRms(loop, corners)) return null

  const regular = regularize(corners, m)
  const pts = regular?.points ?? corners
  const f = (v: number) => +v.toFixed(opts.precision)
  const d = `M${pts.map((p) => `${f(p[0])} ${f(p[1])}`).join('L')}Z`
  return { kind: regular?.star ? 'star' : 'polygon', d }
}

/** Root-mean-square distance (px) of the outline's points from the polygon's edges. */
function polygonRms(loop: Point[], corners: Point[]): number {
  let sq = 0
  for (const p of loop) {
    let best = Infinity
    for (let k = 0; k < corners.length; k++) {
      const a = corners[k], b = corners[(k + 1) % corners.length]
      const dx = b[0] - a[0], dy = b[1] - a[1]
      const len2 = dx * dx + dy * dy
      const t = len2 ? Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0
      best = Math.min(best, Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy))
    }
    sq += best * best
  }
  return Math.sqrt(sq / loop.length)
}

/**
 * Snaps a polygon to a perfect regular polygon or star when its corners are already nearly
 * evenly spaced around the center at (alternating) equal distances. Returns null when it
 * isn't regular, or when snapping would move any corner noticeably.
 */
export function regularize(corners: Point[], m: Moments): { points: Point[]; star: boolean } | null {
  const n = corners.length
  const r = corners.map(([x, y]) => Math.hypot(x - m.cx, y - m.cy))
  const ang = corners.map(([x, y]) => Math.atan2(y - m.cy, x - m.cx))
  const step = (2 * Math.PI) / n
  // Corners must go round the center once, in order, at even angular steps. The winding
  // direction comes from the angles themselves.
  let turn = 0
  for (let i = 0; i < n; i++) {
    let d = ang[(i + 1) % n] - ang[i]
    if (d > Math.PI) d -= 2 * Math.PI
    if (d < -Math.PI) d += 2 * Math.PI
    turn += d
  }
  if (Math.abs(Math.abs(turn) - 2 * Math.PI) > 0.5) return null
  const dir = Math.sign(turn)
  for (let i = 0; i < n; i++) {
    let d = (ang[(i + 1) % n] - ang[i]) * dir
    while (d <= 0) d += 2 * Math.PI
    if (Math.abs(d - step) > (4 * Math.PI) / 180) return null
  }
  const mean = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / xs.length
  const even = (xs: number[]) => Math.max(...xs.map((v) => Math.abs(v - mean(xs)))) <= mean(xs) * 0.05

  let radii: number[] | null = null
  let star = false
  if (even(r)) {
    const R = mean(r)
    radii = r.map(() => R)
  } else if (n >= 6 && n % 2 === 0) {
    const a = r.filter((_, i) => i % 2 === 0)
    const b = r.filter((_, i) => i % 2 === 1)
    if (even(a) && even(b) && Math.max(mean(a), mean(b)) / Math.min(mean(a), mean(b)) > 1.15) {
      radii = r.map((_, i) => (i % 2 === 0 ? mean(a) : mean(b)))
      star = true
    }
  }
  if (!radii) return null

  // Best global rotation: circular mean of each corner's offset from its ideal angle.
  let sx = 0, sy = 0
  for (let i = 0; i < n; i++) {
    const off = ang[i] - dir * i * step
    sx += Math.cos(off)
    sy += Math.sin(off)
  }
  const rot = Math.atan2(sy, sx)
  const points: Point[] = radii.map((R, i) => [m.cx + R * Math.cos(rot + dir * i * step), m.cy + R * Math.sin(rot + dir * i * step)])
  const maxMove = Math.max(...points.map((p, i) => Math.hypot(p[0] - corners[i][0], p[1] - corners[i][1])))
  if (maxMove > Math.max(1, 0.04 * Math.max(...radii))) return null
  return { points, star }
}
