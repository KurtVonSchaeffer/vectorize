import { area, type Point } from './contours'
import type { Cubic } from './fit'

/**
 * Fine detail is used only where it is measurably better. A colour's outlines are traced twice,
 * the ordinary way (as without fine detail) and with the fine-detail rule. Outlines that describe
 * the same thing are grouped, and a group's fine outlines replace its ordinary ones only when they
 * are closer to the colour's coverage of the upload and no worse as artwork: no more anchors, no
 * extra turning (wiggles), no new fragments or crossings, and no pixel left uncovered that the
 * ordinary outlines cover (where the colour below would show through).
 * Anywhere else the ordinary outlines stay, exactly as without fine detail.
 */
export interface Traced {
  loop: Point[]
  curves: Cubic[]
}

export interface Judged {
  /** Fine outlines accepted. */
  fine: Set<Point[]>
  /** Ordinary outlines kept (all ordinary outlines, less those a fine group replaced). */
  kept: Point[][]
  /** For each accepted fine outline, the ordinary outlines it replaced. */
  replaced: Map<Point[], Point[][]>
  /** Groups compared, and accepted. */
  groups: number
  accepted: number
}

/** The upload's coverage that outlines must match: per pixel 0–1, the colour's share. */
export interface Target {
  w: number
  h: number
  coverage: Float32Array
}

/** A fine group must remove at least this much coverage error (px²)… */
const MIN_GAIN = 0.5
/** …and this share of the ordinary outlines' error there. */
const GAIN_SHARE = 0.05
/** Extra turning (degrees) a group may add over its ordinary outlines (rounding at curve joins). */
const TURN_SLACK = 3
/** Outlines smaller than this (px²) are fragments… */
const FRAGMENT = 4
/** …and holes smaller than this. */
const HOLE_FRAGMENT = 8
/** A pixel at least this solid in the upload… */
const SOLID = 0.98
/** …is see-through when drawn below this coverage. */
const OPAQUE = 0.78
/** A pixel mostly this colour is uncovered when drawn this much (0–1) less than it is, and than before. */
const UNCOVERED = 0.4

export function judge(ordinary: Traced[], fine: Traced[], target: Target, crosses: (c: Cubic[]) => boolean): Judged {
  const all = [...ordinary, ...fine]
  const boxes = all.map((t) => bounds(t.loop))
  const areas = all.map((t) => area(t.loop))
  // Group outlines of comparable size whose boxes mostly overlap: a line traced whole by one rule
  // and in pieces by the other is one group.
  const parent = all.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  for (let i = 0; i < ordinary.length; i++)
    for (let j = ordinary.length; j < all.length; j++) {
      const small = Math.min(Math.abs(areas[i]), Math.abs(areas[j]))
      const large = Math.max(Math.abs(areas[i]), Math.abs(areas[j]))
      if (small < SIZE_RATIO * large) continue
      const a = boxes[i], b = boxes[j]
      const ox = Math.min(a[2], b[2]) - Math.max(a[0], b[0])
      const oy = Math.min(a[3], b[3]) - Math.max(a[1], b[1])
      if (ox <= 0 || oy <= 0) continue
      const smallBox = Math.min(boxArea(a), boxArea(b))
      if (ox * oy >= BOX_OVERLAP * smallBox) parent[find(j)] = find(i)
    }
  const groups = new Map<number, number[]>()
  for (let i = 0; i < all.length; i++) {
    const g = find(i)
    if (!groups.has(g)) groups.set(g, [])
    groups.get(g)!.push(i)
  }

  const ordPolys = ordinary.map((t) => flatten(t.curves))
  const finePolys = fine.map((t) => flatten(t.curves))
  const polyOf = (i: number) => (i < ordinary.length ? ordPolys[i] : finePolys[i - ordinary.length])
  const out: Judged = { fine: new Set(), kept: [], replaced: new Map(), groups: 0, accepted: 0 }
  const dropped = new Set<number>()
  for (const members of groups.values()) {
    const ord = members.filter((i) => i < ordinary.length)
    const fin = members.filter((i) => i >= ordinary.length)
    if (!fin.length) continue
    // Unchanged by the fine rule, outline and curves: nothing to choose.
    if (ord.length === fin.length && ord.every((i, k) => same(all[i].loop, all[fin[k]].loop) && sameCurves(all[i].curves, all[fin[k]].curves))) continue
    out.groups++
    const box = members.reduce((b, i) => union(b, boxes[i]), [Infinity, Infinity, -Infinity, -Infinity] as Box)
    const R: Box = [Math.max(0, Math.floor(box[0]) - 2), Math.max(0, Math.floor(box[1]) - 2), Math.min(target.w, Math.ceil(box[2]) + 2), Math.min(target.h, Math.ceil(box[3]) + 2)]
    // Everything else drawn in this place: the colour's other ordinary outlines.
    const others: Point[][] = []
    for (let i = 0; i < ordinary.length; i++) if (!ord.includes(i) && intersects(boxes[i], R)) others.push(ordPolys[i])
    const covOrd = coverage([...others, ...ord.map(polyOf)], R, target.h)
    const covFine = coverage([...others, ...fin.map(polyOf)], R, target.h)
    let errOrd = 0
    let errFine = 0
    let opened = 0
    const rw = R[2] - R[0]
    for (let y = R[1]; y < R[3]; y++)
      for (let x = R[0]; x < R[2]; x++) {
        const t = target.coverage[y * target.w + x]
        const k = (y - R[1]) * rw + (x - R[0])
        errOrd += Math.abs(covOrd[k] - t)
        errFine += Math.abs(covFine[k] - t)
        // A pixel left see-through (or showing the colour below) that production covered: mostly
        // this colour in the upload, but drawn clearly less than that, and clearly less than before.
        if ((t >= SOLID && covOrd[k] >= OPAQUE && covFine[k] < OPAQUE) || (t >= 0.5 && covFine[k] < t - UNCOVERED && covOrd[k] >= covFine[k] + UNCOVERED)) opened++
      }
    // A hole: inside an odd number of the colour's other outlines.
    const isHole = (i: number) => {
      const p = all[i].loop[0]
      let n = 0
      for (let o = 0; o < ordinary.length; o++) if (!ord.includes(o) && boxes[o][0] <= p[0] && p[0] <= boxes[o][2] && boxes[o][1] <= p[1] && p[1] <= boxes[o][3] && inside(p, ordinary[o].loop)) n++
      return n % 2 === 1
    }
    const anchors = (ix: number[]) => ix.reduce((s, i) => s + all[i].curves.length, 0)
    const turning = (ix: number[]) => ix.reduce((s, i) => s + extraTurning(polyOf(i)), 0)
    // As the fidelity check counts them: drawn outlines under FRAGMENT px² that don't cross
    // themselves (a crossing one is counted as crossing instead). A small hole is a speck too, of
    // whatever colour lies below, so holes count up to HOLE_FRAGMENT px².
    const fragments = (ix: number[]) =>
      ix.filter((i) => {
        const a = area(polyOf(i))
        return !crosses(all[i].curves) && (Math.abs(a) < FRAGMENT || (Math.abs(a) < HOLE_FRAGMENT && isHole(i)))
      }).length
    const better =
      errFine <= errOrd - Math.max(MIN_GAIN, GAIN_SHARE * errOrd) &&
      opened === 0 &&
      anchors(fin) <= Math.max(anchors(ord) + MIN_ANCHORS * Math.max(0, fin.length - ord.length), MIN_ANCHORS * fin.length) &&
      turning(fin) <= turning(ord) + TURN_SLACK &&
      fragments(fin) <= fragments(ord) &&
      !fin.some((i) => crosses(all[i].curves))
    if (!better) continue
    out.accepted++
    for (const i of ord) dropped.add(i)
    for (const i of fin) {
      out.fine.add(all[i].loop)
      out.replaced.set(all[i].loop, ord.map((o) => all[o].loop))
    }
  }
  out.kept = ordinary.filter((_, i) => !dropped.has(i)).map((t) => t.loop)
  return out
}

/** Outlines group when the smaller is at least this share of the larger's area… */
const SIZE_RATIO = 0.25
/** …and their boxes overlap by at least this share of the smaller box. */
const BOX_OVERLAP = 0.5
/**
 * Anchors a fine outline may always have: a thin bar's two sides and two ends. Beyond that a group
 * may have no more anchors than its ordinary outlines.
 */
const MIN_ANCHORS = 4

type Box = [number, number, number, number]

function bounds(loop: Point[]): Box {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const [x, y] of loop) {
    if (x < x0) x0 = x
    if (y < y0) y0 = y
    if (x > x1) x1 = x
    if (y > y1) y1 = y
  }
  return [x0, y0, x1, y1]
}
const boxArea = (b: Box) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1])
const union = (a: Box, b: Box): Box => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]
const intersects = (a: Box, b: Box) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1]

function inside(p: Point, loop: Point[]): boolean {
  let c = false
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const a = loop[i], b = loop[j]
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) c = !c
  }
  return c
}

function same(a: Point[], b: Point[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i][0] !== b[i][0] || a[i][1] !== b[i][1]) return false
  return true
}

function sameCurves(a: Cubic[], b: Cubic[]): boolean {
  return a.length === b.length && a.every((c, i) => c.every((p, k) => p[0] === b[i][k][0] && p[1] === b[i][k][1]))
}

/** Points along a closed run of cubics, 8 per curve. */
export function flatten(curves: Cubic[]): Point[] {
  const pts: Point[] = []
  for (const [a, b, c, d] of curves)
    for (let i = 0; i < 8; i++) {
      const t = i / 8
      const u = 1 - t
      pts.push([u * u * u * a[0] + 3 * u * u * t * b[0] + 3 * u * t * t * c[0] + t * t * t * d[0], u * u * u * a[1] + 3 * u * u * t * b[1] + 3 * u * t * t * c[1] + t * t * t * d[1]])
    }
  return pts
}

/**
 * Turning (degrees) beyond the one full turn a closed outline needs: zero for a convex outline,
 * and added by every wiggle, hook or dent.
 */
export function extraTurning(pts: Point[]): number {
  const n = pts.length
  if (n < 3) return 0
  let total = 0
  let net = 0
  for (let i = 0; i < n; i++) {
    const a = pts[(i - 1 + n) % n], b = pts[i], c = pts[(i + 1) % n]
    if ((b[0] === a[0] && b[1] === a[1]) || (c[0] === b[0] && c[1] === b[1])) continue
    let d = Math.atan2(c[1] - b[1], c[0] - b[0]) - Math.atan2(b[1] - a[1], b[0] - a[0])
    while (d > Math.PI) d -= 2 * Math.PI
    while (d < -Math.PI) d += 2 * Math.PI
    total += Math.abs(d)
    net += d
  }
  return ((total - Math.abs(net)) * 180) / Math.PI
}

/**
 * Even-odd coverage (0–1) of closed polylines over the pixels of box R, from 4 sample rows per
 * pixel with exact horizontal overlap. Indexed (y - R[1]) * width + (x - R[0]).
 */
export function coverage(polys: Point[][], R: Box, h: number): Float32Array {
  const rw = R[2] - R[0]
  const out = new Float32Array(Math.max(0, rw * (R[3] - R[1])))
  const xs: number[] = []
  for (let y = R[1]; y < Math.min(R[3], h); y++)
    for (let k = 0; k < ROWS; k++) {
      const sy = y + (k + 0.5) / ROWS
      xs.length = 0
      for (const poly of polys)
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
          const a = poly[j], b = poly[i]
          if (a[1] > sy !== b[1] > sy) xs.push(a[0] + ((sy - a[1]) * (b[0] - a[0])) / (b[1] - a[1]))
        }
      xs.sort((p, q) => p - q)
      const row = (y - R[1]) * rw
      for (let s = 0; s + 1 < xs.length; s += 2) {
        const x0 = Math.max(R[0], xs[s])
        const x1 = Math.min(R[2], xs[s + 1])
        for (let x = Math.floor(x0); x < x1; x++) {
          const o = Math.min(x1, x + 1) - Math.max(x0, x)
          if (o > 0) out[row + x - R[0]] += o / ROWS
        }
      }
    }
  return out
}
const ROWS = 4
