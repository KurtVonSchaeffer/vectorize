import { flatten, parsePath, type Pt, type Subpath } from '../export/path'
import { withLines, type LineCandidate, type LineCandidates } from '../palette/quantize'
import type { LabelMap, TracedLayer } from '../trace'
import { extraTurning } from '../trace/finedetail'

/**
 * Colour accuracy: of the thin lines the colour reduction proposes (LineCandidates), applies only
 * those that trace better. The map is traced without them and with all of them; a line (or all the
 * lines of a new or corrected colour together) is kept when, around it, the traced artwork is
 * closer to the upload (composited colour, LINE_GAIN) and has no more crossing outlines or
 * fragments. Everywhere else the colours stay as they were.
 */
export function judgeLines<T extends { layers: TracedLayer[] }>(map: LabelMap, candidates: LineCandidates, trace: (m: LabelMap) => T, upload: ImageData): { map: LabelMap; traced: T; proposed: number; kept: number } {
  if (candidates.lines.length > MAX_LINES) candidates = { ...candidates, lines: [...candidates.lines].sort((a, b) => b.pixels.length - a.pixels.length).slice(0, MAX_LINES) }
  const proposed = candidates.lines.length
  const plain = trace(map)
  if (!proposed) return { map, traced: plain, proposed, kept: 0 }
  const allMap = withLines(map, candidates, candidates.lines, upload)
  const all = trace(allMap)
  const before = drawn(plain.layers)
  const after = drawn(all.layers)
  // A new or corrected colour is taken for all its lines or none (never lettering in two shades);
  // a line taking an existing colour is judged on its own.
  const groups = new Map<string, LineCandidate[]>()
  candidates.lines.forEach((line, i) => {
    const key = line.fresh ? `new ${line.label}` : `line ${i}`
    groups.set(key, [...(groups.get(key) ?? []), line])
  })
  // Judged against the trace with every line; then the kept lines are traced on their own and
  // judged again (lines interact: a neighbour left out changes an outline), until nothing more fails.
  let kept = [...groups.values()].filter((g) => better(before, after, g, upload))
  let current = { map: allMap, traced: all }
  for (let round = 0; round < MAX_ROUNDS && kept.length; round++) {
    const keptLines = kept.flat()
    if (keptLines.length !== proposed) {
      const m = withLines(map, candidates, keptLines, upload)
      current = { map: m, traced: trace(m) }
    }
    const now = drawn(current.traced.layers)
    const still = kept.filter((g) => better(before, now, g, upload))
    if (still.length === kept.length) return { ...current, proposed, kept: keptLines.length }
    kept = still
  }
  return { map, traced: plain, proposed, kept: 0 }
}

type Box = [number, number, number, number]
interface Outline {
  /** For coverage. */
  pts: Pt[]
  anchors: number
  turning: number
  /** Finer, for crossings (as the fidelity check finds them: tiny loops included), when first needed. */
  fine?: Pt[]
  sub: Subpath
  /** Edges [x0, y0, x1, y1] of the coverage polyline. */
  edges: Float64Array
  box: Box
  area: number
}
interface Layer {
  rgb: number[]
  outlines: Outline[]
}

function drawn(layers: TracedLayer[]): Layer[] {
  return layers.map((l) => ({
    rgb: [(l.color >> 16) & 255, (l.color >> 8) & 255, l.color & 255],
    outlines: parsePath(l.d).map((sp) => {
      const pts = flatten(sp, 0.1)
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
      let a = 0
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [x, y] = pts[i]
        if (x < x0) x0 = x
        if (y < y0) y0 = y
        if (x > x1) x1 = x
        if (y > y1) y1 = y
        a += pts[j][0] * y - x * pts[j][1]
      }
      const edges = new Float64Array(pts.length * 4)
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) edges.set([pts[j][0], pts[j][1], pts[i][0], pts[i][1]], i * 4)
      return { pts, edges, sub: sp, anchors: sp.segs.length, turning: extraTurning(pts), box: [x0, y0, x1, y1] as Box, area: Math.abs(a) / 2 }
    }),
  }))
}

const meets = (a: Box, b: Box) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1]

function better(before: Layer[], after: Layer[], lines: LineCandidate[], upload: ImageData): boolean {
  const { width: w, height: h } = upload
  let e0 = 0
  let e1 = 0
  for (const line of lines) {
    const R: Box = [Math.max(0, line.box[0] - MARGIN), Math.max(0, line.box[1] - MARGIN), Math.min(w, line.box[2] + MARGIN), Math.min(h, line.box[3] + MARGIN)]
    const a = edges(before, R), b = edges(after, R)
    // No new crossing, no new fragment (a crossing squiggle swapped for a fragment is still a
    // defect), no rougher edges, no more anchors than its new outlines need.
    if (b.crossing > a.crossing || b.fragments > a.fragments || b.turning > a.turning + TURN_SLACK || b.anchors > a.anchors + NEW_ANCHORS * Math.max(1, b.outlines - a.outlines)) return false
    e0 += error(before, R, upload)
    e1 += error(after, R, upload)
  }
  return e1 <= LINE_GAIN * e0
}

/**
 * The outlines that reach into R: crossing outlines and fragments (under FRAGMENT px², not
 * crossing), their turning beyond a clean outline (wiggles) and their anchors.
 */
function edges(layers: Layer[], R: Box) {
  let crossing = 0, fragments = 0, turning = 0, anchors = 0, outlines = 0
  for (const l of layers)
    for (const o of l.outlines) {
      if (!meets(o.box, R)) continue
      outlines++
      turning += o.turning
      anchors += o.anchors
      if (crossesIn((o.fine ??= fineFlatten(o.sub)), R)) crossing++
      else if (o.area < FRAGMENT) fragments++
    }
  return { crossing, fragments, turning, anchors, outlines }
}

/** Mean difference (sRGB, summed over channels) between the drawn layers and the upload in R, both over white. */
function error(layers: Layer[], R: Box, upload: ImageData): number {
  const rw = R[2] - R[0], rh = R[3] - R[1]
  const out = new Float32Array(rw * rh * 3).fill(255)
  for (const l of layers) {
    const c = rowCoverage(l.outlines.filter((o) => meets(o.box, R)), R)
    if (!c) continue
    for (let k = 0; k < rw * rh; k++) {
      const a = Math.min(1, c[k])
      if (a) for (let ch = 0; ch < 3; ch++) out[k * 3 + ch] = out[k * 3 + ch] * (1 - a) + l.rgb[ch] * a
    }
  }
  let e = 0
  for (let y = 0; y < rh; y++)
    for (let x = 0; x < rw; x++) {
      const i = ((R[1] + y) * upload.width + R[0] + x) * 4
      const a = upload.data[i + 3] / 255
      const k = y * rw + x
      for (let ch = 0; ch < 3; ch++) e += Math.abs(upload.data[i + ch] * a + 255 * (1 - a) - out[k * 3 + ch])
    }
  return e / Math.max(1, rw * rh)
}

/**
 * Even-odd coverage (0–1) of a layer's outlines over the pixels of R, as coverage() in
 * finedetail.ts, from only the edges that cross R's rows (a big outline's other edges can't).
 */
function rowCoverage(outlines: Outline[], R: Box): Float32Array | null {
  const edges: number[] = []
  for (const o of outlines)
    for (let i = 0; i < o.edges.length; i += 4) {
      const y0 = o.edges[i + 1], y1 = o.edges[i + 3]
      if (Math.max(y0, y1) >= R[1] && Math.min(y0, y1) <= R[3]) edges.push(o.edges[i], y0, o.edges[i + 2], y1)
    }
  if (!edges.length) return null
  const rw = R[2] - R[0]
  const out = new Float32Array(rw * (R[3] - R[1]))
  const xs: number[] = []
  for (let y = R[1]; y < R[3]; y++)
    for (let k = 0; k < ROWS; k++) {
      const sy = y + (k + 0.5) / ROWS
      xs.length = 0
      for (let i = 0; i < edges.length; i += 4) {
        const ay = edges[i + 1], by = edges[i + 3]
        if (ay > sy !== by > sy) xs.push(edges[i] + ((sy - ay) * (edges[i + 2] - edges[i])) / (by - ay))
      }
      xs.sort((p, q) => p - q)
      const row = (y - R[1]) * rw
      for (let s = 0; s + 1 < xs.length; s += 2) {
        const x0 = Math.max(R[0], xs[s]), x1 = Math.min(R[2], xs[s + 1])
        for (let x = Math.floor(x0); x < x1; x++) {
          const o = Math.min(x1, x + 1) - Math.max(x0, x)
          if (o > 0) out[row + x - R[0]] += o / ROWS
        }
      }
    }
  return out
}

/** Points along a subpath, curves cut into pieces at most FINE_STEP long (as in fidelity.ts). */
function fineFlatten(sp: Subpath): Pt[] {
  const pts: Pt[] = [sp.start]
  let cur = sp.start
  for (const g of sp.segs) {
    if (g.t === 'L') pts.push(g.p)
    else {
      const len = Math.hypot(g.c1[0] - cur[0], g.c1[1] - cur[1]) + Math.hypot(g.c2[0] - g.c1[0], g.c2[1] - g.c1[1]) + Math.hypot(g.p[0] - g.c2[0], g.p[1] - g.c2[1])
      const n = Math.min(1024, Math.max(2, Math.ceil(len / FINE_STEP)))
      for (let i = 1; i <= n; i++) {
        const t = i / n, u = 1 - t
        pts.push([u ** 3 * cur[0] + 3 * u * u * t * g.c1[0] + 3 * u * t * t * g.c2[0] + t ** 3 * g.p[0], u ** 3 * cur[1] + 3 * u * u * t * g.c1[1] + 3 * u * t * t * g.c2[1] + t ** 3 * g.p[1]])
      }
    }
    cur = g.p
  }
  return pts
}

/**
 * Whether the outline crosses itself within R (the rest of it is the same both ways). Segments are
 * bucketed in CELL px cells; only pairs sharing a cell are tested.
 */
function crossesIn(pts: Pt[], R: Box): boolean {
  const n = pts.length
  const cells = new Map<number, number[]>()
  const cols = Math.ceil((R[2] - R[0]) / CELL) + 3
  for (let i = 0; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n]
    const x0 = Math.min(p[0], q[0]), x1 = Math.max(p[0], q[0]), y0 = Math.min(p[1], q[1]), y1 = Math.max(p[1], q[1])
    if (x1 < R[0] || x0 > R[2] || y1 < R[1] || y0 > R[3]) continue
    for (let cy = Math.floor((Math.max(y0, R[1] - 1) - R[1]) / CELL); cy <= Math.floor((Math.min(y1, R[3] + 1) - R[1]) / CELL); cy++)
      for (let cx = Math.floor((Math.max(x0, R[0] - 1) - R[0]) / CELL); cx <= Math.floor((Math.min(x1, R[2] + 1) - R[0]) / CELL); cx++) {
        const key = (cy + 1) * cols + cx + 1
        const list = cells.get(key)
        if (list) list.push(i)
        else cells.set(key, [i])
      }
  }
  const cross = (p: Pt, q: Pt, r: Pt, s: Pt) => {
    const d = (q[0] - p[0]) * (s[1] - r[1]) - (q[1] - p[1]) * (s[0] - r[0])
    if (d === 0) return false
    const t = ((r[0] - p[0]) * (s[1] - r[1]) - (r[1] - p[1]) * (s[0] - r[0])) / d
    const u = ((r[0] - p[0]) * (q[1] - p[1]) - (r[1] - p[1]) * (q[0] - p[0])) / d
    return t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9
  }
  for (const list of cells.values())
    for (let a = 0; a < list.length; a++)
      for (let b = a + 1; b < list.length; b++) {
        const i = Math.min(list[a], list[b]), j = Math.max(list[a], list[b])
        if (j === i + 1 || (i === 0 && j === n - 1)) continue
        if (cross(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n])) return true
      }
  return false
}
/** Cell size (px) for finding crossings. */
const CELL = 2

/** Rounds of judging the kept lines again before giving up on them all. */
const MAX_ROUNDS = 2
/** At most this many lines are judged (the largest), to keep tracing time bounded. */
const MAX_LINES = 200
/** Sample rows per pixel for coverage. */
const ROWS = 4
/** The area judged round a line (px). */
const MARGIN = 3
/** A line is kept when the error round it falls to this share of what it was. */
const LINE_GAIN = 0.97
/** Extra turning (degrees) the outlines round a line may gain. */
const TURN_SLACK = 3
/** Anchors a line may add per new outline (a stroke's two sides and two ends). */
const NEW_ANCHORS = 4
/** Outlines under this area (px²) are fragments. */
const FRAGMENT = 4
/** Crossings are looked for on curves cut this fine (px). */
const FINE_STEP = 0.1
