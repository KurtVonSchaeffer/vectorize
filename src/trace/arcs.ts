/**
 * Exact arcs (behind a flag, docs/exact-arcs.md): finds the stretches of a traced outline that are
 * circular arcs, fits each with one centre and radius, and writes it as standard cubic Bézier
 * approximations of the arc (at most 90° per cubic, handles 4/3·tan(θ/4)·r long), so every writer
 * reads them like any other curve.
 */
import type { Point } from './contours'

type Cubic = [Point, Point, Point, Point]

/** Points within this distance (px) of one circle form an arc… */
export const ARC_TOLERANCE = 0.3
/** …whose residual, averaged over ARC_SMOOTH px of outline, stays within this (long waves, not pixel noise)… */
const ARC_SYSTEMATIC = 0.1
const ARC_SMOOTH = 2
/** …that turns through at least this much (degrees)… */
const ARC_MIN_SWEEP = 30
/** …and is at least this long (px), with a radius of at least ARC_MIN_RADIUS px. */
const ARC_MIN_LENGTH = 4
const ARC_MIN_RADIUS = 2.5
/** An arc's end this close (px) to the end of the stretch searched (a line or a corner) is bounded there. */
const ARC_BOUND_GAP = 2
/** The outline just past an arc's free end (this share of its radius, ARC_MIN_LENGTH to ARC_BEYOND_MAX px)… */
const ARC_BEYOND = 0.4
const ARC_BEYOND_MAX = 15
/** …mustn't run on round a circle within this ratio of its radius. */
const ARC_CONTINUE_RATIO = 1.8
/** A curve beyond within this share of the radius, round a centre this share of the radius away, is a twin arc. */
const ARC_TWIN = 0.04
const ARC_TWIN_SHIFT = 0.15
/** An arc's end points further than this (px) from its circle are where the next part starts: shed. */
const ARC_END_TOLERANCE = 0.15

export interface Circle {
  c: Point
  r: number
}

/** A circular arc found on points i..j of an outline. */
export interface Arc extends Circle {
  i: number
  j: number
  /** +1 when the outline runs round the centre counter-clockwise (y down: clockwise on screen), else -1. */
  sgn: number
  /** Start and end, on the circle. */
  S: Point
  E: Point
}

/**
 * Circle through points: algebraic (Kåsa) fit, refined by Gauss–Newton on the geometric distance.
 * Null when the points are (nearly) on a line.
 */
export function fitCircle(pts: Point[]): Circle | null {
  const n = pts.length
  if (n < 3) return null
  let mx = 0, my = 0
  for (const p of pts) {
    mx += p[0] / n
    my += p[1] / n
  }
  // Kåsa: minimise Σ(x² + y² + Dx + Ey + F)² in centred coordinates.
  let sxx = 0, sxy = 0, syy = 0, sx = 0, sy = 0, sxz = 0, syz = 0, sz = 0
  for (const p of pts) {
    const x = p[0] - mx
    const y = p[1] - my
    const z = x * x + y * y
    sxx += x * x; sxy += x * y; syy += y * y; sx += x; sy += y
    sxz += x * z; syz += y * z; sz += z
  }
  const A = solve3([sxx, sxy, sx, sxy, syy, sy, sx, sy, n], [-sxz, -syz, -sz])
  if (!A) return null
  let cx = -A[0] / 2
  let cy = -A[1] / 2
  let r = Math.sqrt(Math.max(0, cx * cx + cy * cy - A[2]))
  if (!Number.isFinite(r) || r <= 0) return null
  for (let it = 0; it < 8; it++) {
    let j00 = 0, j01 = 0, j02 = 0, j11 = 0, j12 = 0, j22 = 0, g0 = 0, g1 = 0, g2 = 0
    for (const p of pts) {
      const dx = p[0] - mx - cx
      const dy = p[1] - my - cy
      const d = Math.hypot(dx, dy) || 1e-12
      const res = d - r
      const a = -dx / d
      const b = -dy / d
      j00 += a * a; j01 += a * b; j02 -= a; j11 += b * b; j12 -= b; j22 += 1
      g0 += a * res; g1 += b * res; g2 -= res
    }
    const step = solve3([j00, j01, j02, j01, j11, j12, j02, j12, j22], [-g0, -g1, -g2])
    if (!step) break
    cx += step[0]
    cy += step[1]
    r += step[2]
    if (Math.abs(step[0]) + Math.abs(step[1]) + Math.abs(step[2]) < 1e-9) break
  }
  if (!Number.isFinite(r) || r <= 0) return null
  return { c: [cx + mx, cy + my], r }
}

function solve3(m: number[], b: number[]): [number, number, number] | null {
  const det = (q: number[]) => q[0] * (q[4] * q[8] - q[5] * q[7]) - q[1] * (q[3] * q[8] - q[5] * q[6]) + q[2] * (q[3] * q[7] - q[4] * q[6])
  const D = det(m)
  if (!Number.isFinite(D) || Math.abs(D) < 1e-12) return null
  const col = (k: number) => m.map((v, i) => (i % 3 === k ? b[(i / 3) | 0] : v))
  return [det(col(0)) / D, det(col(1)) / D, det(col(2)) / D]
}

/**
 * How points i..j follow a circle: null unless every point is within ARC_TOLERANCE of it, the
 * residual averaged over ARC_SMOOTH px stays within ARC_SYSTEMATIC (a circle fitted to a stretch
 * of an ellipse is off in long waves, not in pixel noise), and the points run steadily round it.
 */
function circleOn(at: (k: number) => Point, i: number, j: number, spacing: number, circle?: Circle): (Circle & { sweep: number; sgn: number }) | null {
  const run: Point[] = []
  for (let k = i; k <= j; k++) run.push(at(k))
  const c = circle ?? fitCircle(run)
  if (!c) return null
  const res = run.map((p) => Math.hypot(p[0] - c.c[0], p[1] - c.c[1]) - c.r)
  for (const v of res) if (Math.abs(v) > ARC_TOLERANCE) return null
  const w = Math.max(1, Math.round(ARC_SMOOTH / spacing / 2))
  if (run.length > 2 * w + 1) {
    let sum = 0
    for (let k = 0; k < 2 * w + 1; k++) sum += res[k]
    for (let k = w; ; k++) {
      if (Math.abs(sum / (2 * w + 1)) > ARC_SYSTEMATIC) return null
      if (k + w + 1 >= run.length) break
      sum += res[k + w + 1] - res[k - w]
    }
  }
  let sweep = 0
  let pos = 0
  let neg = 0
  for (let k = 1; k < run.length; k++) {
    const a0 = Math.atan2(run[k - 1][1] - c.c[1], run[k - 1][0] - c.c[0])
    const a1 = Math.atan2(run[k][1] - c.c[1], run[k][0] - c.c[0])
    let d = a1 - a0
    if (d > Math.PI) d -= 2 * Math.PI
    if (d < -Math.PI) d += 2 * Math.PI
    sweep += d
    if (d > 0) pos++
    else neg++
  }
  // Running steadily one way round (no doubling back).
  if (pos && neg) return null
  return { ...c, sweep, sgn: sweep >= 0 ? 1 : -1 }
}

/**
 * The circular arcs on points a..b of an outline (indices may run past its length; `at` wraps),
 * in order, not overlapping: the longest arc from each point (a window grown while the points
 * still follow one circle), an arc starting a little later kept when it reaches further, end points
 * that lean off the circle shed, and only arcs turning at least ARC_MIN_SWEEP with a radius from
 * ARC_MIN_RADIUS to maxRadius kept. An arc whose free end flows on into a curve of about the same
 * radius, or through which the curvature keeps changing one way, is a stretch of an ellipse or a
 * free curve and isn't kept. An end within ARC_BOUND_GAP of a or b (a line or a corner) is
 * bounded there, unless the stretch is a whole smooth loop (cyclic).
 */
export function findArcs(at: (k: number) => Point, a: number, b: number, spacing: number, maxRadius: number, cyclic = false): Arc[] {
  const minPts = Math.max(6, Math.ceil(ARC_MIN_LENGTH / spacing))
  const longest = (i: number): Arc | null => {
    let j = i + minPts
    if (j > b) return null
    let fit = circleOn(at, i, j, spacing)
    if (!fit) return null
    for (let step = Math.max(1, minPts >> 1); ; ) {
      const next = j + step <= b ? circleOn(at, i, j + step, spacing) : null
      if (next) {
        ;[j, fit] = [j + step, next]
        step *= 2
      } else if (step > 1) step >>= 1
      else break
    }
    // Shed end points leaning off the circle (into a line or the next curve).
    let s = i
    for (;;) {
      const off = (k: number) => Math.abs(Math.hypot(at(k)[0] - fit!.c[0], at(k)[1] - fit!.c[1]) - fit!.r)
      let moved = false
      if (j - s > minPts && off(s) > ARC_END_TOLERANCE) (s++, (moved = true))
      if (j - s > minPts && off(j) > ARC_END_TOLERANCE) (j--, (moved = true))
      if (!moved) break
      fit = circleOn(at, s, j, spacing) ?? fit
    }
    if (Math.abs(fit.sweep) * (180 / Math.PI) < ARC_MIN_SWEEP || fit.r < ARC_MIN_RADIUS || fit.r > maxRadius) return null
    if (Math.abs(fit.sweep) * fit.r < ARC_MIN_LENGTH || Math.abs(fit.sweep) > 2 * Math.PI - 0.2) return null
    // An end that flows on into a curve of about the same radius (a stretch of an ellipse or a free
    // curve, whose curvature changes gradually) rules the arc out; a designed arc ends at a line, a
    // corner or a clearly different curve.
    const near = Math.ceil(ARC_BOUND_GAP / spacing)
    const beyond = Math.ceil(Math.min(ARC_BEYOND_MAX, Math.max(ARC_MIN_LENGTH, ARC_BEYOND * fit.r)) / spacing)
    /** The circle the outline follows over points k0..k1 (radius negative where it turns the other way, Infinity when straight); null when too short to tell. */
    const circleOver = (k0: number, k1: number): Circle | null => {
      if (k1 - k0 < minPts) return null
      const run: Point[] = []
      for (let k = k0; k <= k1; k++) run.push(at(k))
      const w = fitCircle(run)
      if (!w || w.r > 1e4) return { c: fit!.c, r: Infinity }
      const p = run[0]
      const q = run[run.length - 1]
      const turn = (p[0] - w.c[0]) * (q[1] - w.c[1]) - (p[1] - w.c[1]) * (q[0] - w.c[0])
      return Math.sign(turn) === fit!.sgn ? w : { c: w.c, r: -w.r }
    }
    // A curve of the same radius round another centre (two rounded corners with a short flat
    // between them, too short for a straight edge) is a separate arc, not this one flowing on.
    const flows = (w: Circle | null) =>
      !!w && w.r > fit!.r / ARC_CONTINUE_RATIO && w.r < fit!.r * ARC_CONTINUE_RATIO && !(Math.abs(w.r / fit!.r - 1) < ARC_TWIN && Math.hypot(w.c[0] - fit!.c[0], w.c[1] - fit!.c[1]) > Math.max(1, ARC_TWIN_SHIFT * fit!.r))
    const ws = cyclic || s - a > near ? circleOver(cyclic ? s - beyond : Math.max(a, s - beyond), s) : null
    const we = cyclic || b - j > near ? circleOver(j, cyclic ? j + beyond : Math.min(b, j + beyond)) : null
    // Also out: curvature changing steadily through it (less on one side, more on the other).
    const steady = !!ws && !!we && (1 / ws.r - 1 / fit.r) * (1 / we.r - 1 / fit.r) < 0
    if (flows(ws) || flows(we) || steady) return null
    const onCircle = (p: Point): Point => {
      const d = Math.hypot(p[0] - fit!.c[0], p[1] - fit!.c[1]) || 1
      return [fit!.c[0] + ((p[0] - fit!.c[0]) * fit!.r) / d, fit!.c[1] + ((p[1] - fit!.c[1]) * fit!.r) / d]
    }
    return { i: s, j, c: fit.c, r: fit.r, sgn: fit.sgn, S: onCircle(at(s)), E: onCircle(at(j)) }
  }
  const out: Arc[] = []
  for (let i = a; i < b; ) {
    let arc = longest(i)
    if (!arc) {
      i++
      continue
    }
    for (let k = i + 1, end = Math.min(arc.j - 1, i + Math.ceil(2 / spacing)); k <= end; k++) {
      const f = longest(k)
      if (f && f.j > arc.j) arc = f
    }
    out.push(arc)
    i = arc.j
  }
  return out
}

/** Whether a circle follows points i..j as an arc would (see circleOn), for a circle fitted under constraints. */
export function followsCircle(at: (k: number) => Point, i: number, j: number, spacing: number, circle: Circle): boolean {
  return !!circleOn(at, i, j, spacing, circle)
}

/** Unit tangent of a circle at point p, running round it in direction sgn. */
export function arcTangent(c: Point, p: Point, sgn: number): Point {
  const dx = p[0] - c[0]
  const dy = p[1] - c[1]
  const l = Math.hypot(dx, dy) || 1
  return [(-dy * sgn) / l, (dx * sgn) / l]
}

/**
 * Cubic Béziers for the arc of circle c from S to E running round direction sgn (S and E on the
 * circle): split into equal pieces of at most 90°, each with handles 4/3·tan(θ/4)·r long, tangent
 * to the circle. The ends are exactly S and E.
 */
export function arcCubics(c: Point, r: number, S: Point, E: Point, sgn: number): Cubic[] {
  const a0 = Math.atan2(S[1] - c[1], S[0] - c[0])
  const a1 = Math.atan2(E[1] - c[1], E[0] - c[0])
  let sweep = (a1 - a0) * sgn
  while (sweep <= 0) sweep += 2 * Math.PI
  while (sweep > 2 * Math.PI) sweep -= 2 * Math.PI
  // At most 90° each (a hair over, from rounding, still counts as 90°).
  const k = Math.max(1, Math.ceil(sweep / (Math.PI / 2) - 0.01))
  const th = sweep / k
  const h = (4 / 3) * Math.tan(th / 4) * r
  const out: Cubic[] = []
  let p0 = S
  for (let s = 0; s < k; s++) {
    const a = a0 + sgn * th * (s + 1)
    const p3: Point = s === k - 1 ? E : [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]
    const t0 = arcTangent(c, p0, sgn)
    const t3 = arcTangent(c, p3, sgn)
    out.push([p0, [p0[0] + t0[0] * h, p0[1] + t0[1] * h], [p3[0] - t3[0] * h, p3[1] - t3[1] * h], p3])
    p0 = p3
  }
  return out
}

/** Signed angle (radians) the arc from S to E turns through, running round direction sgn. */
export function arcSweep(c: Point, S: Point, E: Point, sgn: number): number {
  let sweep = (Math.atan2(E[1] - c[1], E[0] - c[0]) - Math.atan2(S[1] - c[1], S[0] - c[0])) * sgn
  while (sweep <= 0) sweep += 2 * Math.PI
  while (sweep > 2 * Math.PI) sweep -= 2 * Math.PI
  return sweep
}

/**
 * The circle tangent to two lines (each a point and unit direction, both running along the
 * outline) that best follows points i..j between them: its centre lies on the lines' bisector, its
 * radius is its distance from each. Found by golden-section search along the bisector from the
 * centre of `free`, the unconstrained fit. Null when the lines are parallel and face the same way.
 */
export function filletBetween(at: (k: number) => Point, i: number, j: number, P: Point, d: Point, Q: Point, e: Point, free: Circle): Circle | null {
  // Normals pointing to the side the circle's centre is on.
  const side = (p: Point, u: Point): Point => {
    const nrm: Point = [-u[1], u[0]]
    return (free.c[0] - p[0]) * nrm[0] + (free.c[1] - p[1]) * nrm[1] >= 0 ? nrm : [-nrm[0], -nrm[1]]
  }
  const ne = side(P, d)
  const nf = side(Q, e)
  const w: Point = [ne[0] - nf[0], ne[1] - nf[1]]
  const wl = Math.hypot(w[0], w[1])
  if (wl < 1e-6) return null
  // Bisector: points c with (c - P)·ne = (c - Q)·nf, i.e. c·w = P·ne - Q·nf.
  const h = P[0] * ne[0] + P[1] * ne[1] - (Q[0] * nf[0] + Q[1] * nf[1])
  const c0: Point = [(w[0] * h) / (wl * wl), (w[1] * h) / (wl * wl)]
  const b: Point = [-w[1] / wl, w[0] / wl]
  const centre = (t: number): Point => [c0[0] + b[0] * t, c0[1] + b[1] * t]
  const radius = (c: Point) => (c[0] - P[0]) * ne[0] + (c[1] - P[1]) * ne[1]
  const cost = (t: number) => {
    const c = centre(t)
    const r = radius(c)
    if (r <= 0) return Infinity
    let s = 0
    for (let k = i; k <= j; k++) {
      const p = at(k)
      const v = Math.hypot(p[0] - c[0], p[1] - c[1]) - r
      s += v * v
    }
    return s
  }
  const t0 = (free.c[0] - c0[0]) * b[0] + (free.c[1] - c0[1]) * b[1]
  let lo = t0 - free.r
  let hi = t0 + free.r
  const g = (Math.sqrt(5) - 1) / 2
  let x1 = hi - g * (hi - lo)
  let x2 = lo + g * (hi - lo)
  let f1 = cost(x1)
  let f2 = cost(x2)
  for (let it = 0; it < 60; it++) {
    if (f1 < f2) {
      hi = x2
      x2 = x1
      f2 = f1
      x1 = hi - g * (hi - lo)
      f1 = cost(x1)
    } else {
      lo = x1
      x1 = x2
      f1 = f2
      x2 = lo + g * (hi - lo)
      f2 = cost(x2)
    }
  }
  const c = centre((lo + hi) / 2)
  const r = radius(c)
  return r > 0 && Number.isFinite(r) ? { c, r } : null
}
