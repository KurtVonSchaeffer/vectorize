import { area, type Point } from './contours'
import { findCorners, fitLine, resample, slice } from './fit'
import { ellipsePath, moments, regularize } from './shapes'

export interface Circle {
  cx: number
  cy: number
  r: number
}

/** An outline explained as a circle and a polygon that overlap (e.g. a starburst behind a disc). */
export interface CirclePolygon {
  circle: Circle
  /** Polygon corners, including the ones hidden inside the circle. */
  polygon: Point[]
  star: boolean
}

/** Samples (0.5 px each) skipped at the ends of each run, where blur rounds the junctions. */
const TRIM = 10
const MIN_LINES = 3

/**
 * Tries to explain one traced outline as the union of a circle and a polygon, the way designers
 * build badges and seals: a starburst with a disc on top, a square with a circle overlapping a
 * corner. The outline then consists of straight edges (the polygon's visible parts) and arcs
 * of one circle. Each polygon corner hidden under the circle is where the straight edges on
 * either side of an arc would meet.
 *
 * Returns null unless every traced point lies on the circle or the polygon, the areas agree,
 * and the hidden corners really are inside the circle.
 */
export function decomposeCirclePolygon(loop: Point[]): CirclePolygon | null {
  const pts = resample(loop, 0.5)
  if (pts.length < 40) return null
  const idx = findCorners(pts, 30)
  if (idx.length < MIN_LINES + 1) return null

  // Classify each run between corners as a straight line or an arc.
  type Run = { kind: 'line'; c: Point; d: Point; pts: Point[]; chord: number } | { kind: 'arc'; pts: Point[]; chord: number }
  const runs: Run[] = []
  for (let k = 0; k < idx.length; k++) {
    const run = slice(pts, idx[k], idx[(k + 1) % idx.length])
    const trim = Math.min(TRIM, Math.floor(run.length * 0.2))
    const mid = run.slice(trim, run.length - trim)
    if (mid.length < 4) return null
    const line = fitLine(mid)
    const len = Math.hypot(run[0][0] - run[run.length - 1][0], run[0][1] - run[run.length - 1][1])
    if (maxDistToLine(mid, line.c, line.d) <= Math.max(0.45, len * 0.01)) runs.push({ kind: 'line', ...line, pts: mid, chord: len })
    else runs.push({ kind: 'arc', pts: mid, chord: len })
  }

  // Candidate circles, most reliable first; the first that explains the whole outline wins.
  const curved = runs.filter((r) => r.kind === 'arc')
  const chords = runs.map((r) => r.chord).sort((x, y) => x - y)
  const median = chords[chords.length >> 1]
  // Short arcs (e.g. the gaps between starburst spikes) bend too little to tell from lines on
  // their own, so short runs are also tried as a group.
  const short = runs.filter((r) => r.chord < median * 0.75)
  const candidates = [circleThroughCorners(idx.map((i) => pts[i]), runs), circleOfArcs(curved), short.length >= 3 ? circleOfArcs(short) : null]
  for (const c of candidates) {
    if (!c) continue
    const result = assemble(c, runs)
    if (result) return result
  }
  return null

  function assemble(circle: Circle, initial: Run[]): CirclePolygon | null {
    // Once the circle is known, any run lying on it is an arc, however short or straight-looking.
    const c = circle
    const runs = initial.map((r): Run => (r.kind === 'line' && onCircle(r.pts, c) ? { kind: 'arc', pts: r.pts, chord: r.chord } : r))
    const lineCount = runs.filter((r) => r.kind === 'line').length
    if (lineCount < MIN_LINES || lineCount === runs.length) return null
    // Every arc must lie on that circle.
    for (const r of runs) if (r.kind === 'arc' && !onCircle(r.pts, circle)) return null

    // Rotate so we start on a line, then walk: consecutive lines meet at a visible corner; a line,
    // one or more arcs, then a line meet at a hidden corner.
    const start = runs.findIndex((r) => r.kind === 'line')
    const seq = [...runs.slice(start), ...runs.slice(0, start)]
    const lines: { c: Point; d: Point; beforeArc: boolean }[] = []
    for (let i = 0; i < seq.length; i++) {
      const r = seq[i]
      if (r.kind !== 'line') continue
      lines.push({ c: r.c, d: r.d, beforeArc: seq[(i + 1) % seq.length].kind === 'arc' })
    }
    const polygon: Point[] = []
    const hidden: boolean[] = []
    for (let i = 0; i < lines.length; i++) {
      const a = lines[i]
      const b = lines[(i + 1) % lines.length]
      const p = intersect(a, b)
      if (!p) return null
      polygon.push(p)
      hidden.push(a.beforeArc)
    }

    // Hidden corners must be under the circle, visible ones outside it.
    const inside = (p: Point) => Math.hypot(p[0] - circle.cx, p[1] - circle.cy) < circle.r
    for (let i = 0; i < polygon.length; i++) if (inside(polygon[i]) !== hidden[i]) return null
    if (!hidden.some(Boolean)) return null

    // Snap to a perfect regular star or polygon when it nearly is one.
    const m = moments(polygon)
    if (!m) return null
    const regular = regularize(polygon, m)
    const poly = regular?.points ?? polygon

    // Every traced point must lie on the boundary of circle ∪ polygon.
    const slack = 0.6
    for (const p of pts) {
      const onCircle = Math.abs(Math.hypot(p[0] - circle.cx, p[1] - circle.cy) - circle.r)
      let onPoly = Infinity
      for (let i = 0; i < poly.length; i++) onPoly = Math.min(onPoly, distToSegment(p, poly[i], poly[(i + 1) % poly.length]))
      let nearCorner = Infinity
      for (const q of poly) nearCorner = Math.min(nearCorner, Math.hypot(p[0] - q[0], p[1] - q[1]))
      if (Math.min(onCircle, onPoly) > (nearCorner < 6 ? slack * 2 : slack) && !nearJunction(p, poly, circle)) return null
    }

    // And the union must cover the same area as the outline.
    const union = unionArea(circle, poly)
    if (Math.abs(union - Math.abs(area(loop))) > Math.max(6, Math.abs(area(loop)) * 0.02)) return null

    return { circle, polygon: poly, star: !!regular?.star }
  }
}

/**
 * The circle passing through the most corners (where polygon edges meet the circle), found by
 * trying circles through corner triples, then refined on the runs between agreeing corners.
 */
function circleThroughCorners(corners: Point[], runs: { pts: Point[] }[]): Circle | null {
  const m = corners.length
  if (m < 6 || m > 64) return null
  let best: { c: Circle; n: number } | null = null
  for (let i = 0; i < m; i++)
    for (let j = i + 1; j < m; j++)
      for (let k = j + 1; k < m; k++) {
        const c = circleFrom3(corners[i], corners[j], corners[k])
        if (!c || c.r < 6) continue
        const tol = Math.max(1.5, c.r * 0.015)
        let n = 0
        for (const p of corners) if (Math.abs(Math.hypot(p[0] - c.cx, p[1] - c.cy) - c.r) < tol) n++
        if (!best || n > best.n) best = { c, n }
      }
  if (!best || best.n < 4) return null
  // Refine on the runs that lie on the rough circle.
  const rough = best.c
  const tol = Math.max(1.5, rough.r * 0.015)
  const on = runs.filter((r) => r.pts.every((p) => Math.abs(Math.hypot(p[0] - rough.cx, p[1] - rough.cy) - rough.r) < tol))
  return on.length ? (fitCircle(on.flatMap((r) => r.pts)) ?? rough) : rough
}

function circleFrom3(a: Point, b: Point, c: Point): Circle | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]))
  if (Math.abs(d) < 1e-6) return null
  const a2 = a[0] ** 2 + a[1] ** 2
  const b2 = b[0] ** 2 + b[1] ** 2
  const c2 = c[0] ** 2 + c[1] ** 2
  const cx = (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d
  const cy = (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d
  return { cx, cy, r: Math.hypot(a[0] - cx, a[1] - cy) }
}

/** One circle through all the given runs' points, if they really lie on it. */
function circleOfArcs(runs: { pts: Point[] }[]): Circle | null {
  if (!runs.length) return null
  const c = fitCircle(runs.flatMap((r) => r.pts))
  if (!c || c.r < 6) return null
  return runs.every((r) => onCircle(r.pts, c)) ? c : null
}

function onCircle(pts: Point[], c: Circle): boolean {
  const tol = Math.max(0.5, c.r * 0.008)
  return pts.every((p) => Math.abs(Math.hypot(p[0] - c.cx, p[1] - c.cy) - c.r) <= tol)
}

export function circlePath(c: Circle, precision: number): string {
  return ellipsePath(c.cx, c.cy, c.r, c.r, 0, precision)
}

export function polygonPath(pts: Point[], precision: number): string {
  const f = (v: number) => +v.toFixed(precision)
  return `M${pts.map((p) => `${f(p[0])} ${f(p[1])}`).join('L')}Z`
}

export function insideCircle(p: Point, c: Circle): boolean {
  return Math.hypot(p[0] - c.cx, p[1] - c.cy) < c.r
}

export function insidePolygon(p: Point, poly: Point[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]
    const [xj, yj] = poly[j]
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** Points where a polygon edge crosses the circle are blurred junctions; allow extra slack. */
function nearJunction(p: Point, poly: Point[], c: Circle): boolean {
  const d = Math.hypot(p[0] - c.cx, p[1] - c.cy) - c.r
  if (Math.abs(d) > 2) return false
  for (let i = 0; i < poly.length; i++) if (distToSegment(p, poly[i], poly[(i + 1) % poly.length]) < 2) return true
  return false
}

/** Area of circle ∪ polygon, by sampling the overlap on a fine grid. */
function unionArea(c: Circle, poly: Point[]): number {
  const polyArea = Math.abs(area(poly))
  const circleArea = Math.PI * c.r * c.r
  const step = Math.max(0.5, c.r / 150)
  let overlap = 0
  for (let y = c.cy - c.r; y < c.cy + c.r; y += step)
    for (let x = c.cx - c.r; x < c.cx + c.r; x += step) {
      const p: Point = [x + step / 2, y + step / 2]
      if (insideCircle(p, c) && insidePolygon(p, poly)) overlap += step * step
    }
  return polyArea + circleArea - overlap
}

/** Algebraic (Kåsa) least-squares circle fit. */
function fitCircle(pts: Point[]): Circle | null {
  let mx = 0, my = 0
  for (const [x, y] of pts) {
    mx += x
    my += y
  }
  mx /= pts.length
  my /= pts.length
  let suu = 0, svv = 0, suv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0
  for (const [x, y] of pts) {
    const u = x - mx
    const v = y - my
    suu += u * u
    svv += v * v
    suv += u * v
    suuu += u * u * u
    svvv += v * v * v
    suvv += u * v * v
    svuu += v * u * u
  }
  const det = suu * svv - suv * suv
  if (Math.abs(det) < 1e-9) return null
  const a = 0.5 * (suuu + suvv)
  const b = 0.5 * (svvv + svuu)
  const uc = (a * svv - b * suv) / det
  const vc = (b * suu - a * suv) / det
  return { cx: uc + mx, cy: vc + my, r: Math.sqrt(uc * uc + vc * vc + (suu + svv) / pts.length) }
}

function intersect(a: { c: Point; d: Point }, b: { c: Point; d: Point }): Point | null {
  const cross = a.d[0] * b.d[1] - a.d[1] * b.d[0]
  if (Math.abs(cross) < 0.05) return null
  const dx = b.c[0] - a.c[0]
  const dy = b.c[1] - a.c[1]
  const t = (dx * b.d[1] - dy * b.d[0]) / cross
  return [a.c[0] + a.d[0] * t, a.c[1] + a.d[1] * t]
}

function maxDistToLine(pts: Point[], c: Point, d: Point): number {
  let max = 0
  for (const p of pts) max = Math.max(max, Math.abs((p[0] - c[0]) * d[1] - (p[1] - c[1]) * d[0]))
  return max
}

function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len2 = dx * dx + dy * dy
  const t = len2 ? Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)
}
