// V8 redraw proof of concept (EXPERIMENTAL; bench only, not used by the app).
//
// Redraws flat artwork as clean geometry instead of tracing each colour's pixels:
//  1. Colour regions: V7's colour map, refined at 4× resolution so edges sit to a quarter pixel.
//  2. Shared edges: every boundary between two regions is extracted once (a planar map), so
//     neighbouring regions share one edge and can't gap or overlap.
//  3. Fit: each edge is split at corners and drawn with the simplest primitive that stays within
//     tolerance: a straight line, then a circular arc, then a cubic Bézier.
//  4. Design rules: near-0/45/90° lines snapped; near-equal radii made equal; near-concentric arcs
//     given one centre; corners rebuilt where their edges meet; mirror symmetry enforced when the
//     artwork is symmetric.
//  5. Every place the rules moved the drawing further than the upload can explain is reported as
//     "interpreted", for the designer to check. Nothing is added or removed silently.
import type { LabelMap } from '../../src/trace'
import { detectShape } from '../../src/trace/shapes'

export type Pt = [number, number]

export interface RedrawOptions {
  /** Max distance (source px) a primitive may stray from the measured edge. */
  tolerance: number
  /** Work at this many times the source resolution (edges to 1/K px). */
  scale: number
  /** Regions smaller than this (source px²) merge into a neighbour. */
  minArea: number
  /** Snap a line to a multiple of 45° when within this many degrees. */
  snapDegrees: number
  /** Report a node moved further than this (source px) by the rules. */
  flagDistance: number
  symmetry: boolean
}

export const DEFAULT_REDRAW: RedrawOptions = { tolerance: 0.6, scale: 4, minArea: 4, snapDegrees: 2.5, flagDistance: 0.9, symmetry: true }

export interface Interpreted {
  x: number
  y: number
  /** Source px moved. */
  moved: number
  reason: 'corner' | 'angle' | 'radius' | 'centre' | 'symmetry' | 'fragment'
}

export interface RedrawResult {
  svg: string
  width: number
  height: number
  stats: {
    segments: { line: number; arc: number; circle: number; bezier: number }
    /** Share of the drawn edge length that is lines or arcs. */
    primitiveShare: number
    nodes: number
    edges: number
    regions: number
    symmetry: 'vertical' | 'horizontal' | 'both' | 'none'
    ms: number
  }
  interpreted: Interpreted[]
}

type Seg =
  | { t: 'line'; a: number; b: number }
  | { t: 'arc'; a: number; b: number; cx: number; cy: number; r: number; ccw: boolean }
  | { t: 'bezier'; a: number; b: number; c1: Pt; c2: Pt }
interface Circle {
  cx: number
  cy: number
  r: number
}
interface Edge {
  left: number
  right: number
  /** Measured points (source px), first and last at its end nodes. */
  pts: Pt[]
  segs: Seg[]
  /** A closed edge with no junction: a whole circle, or a loop of segments. */
  closed: boolean
  circle?: Circle
  /** A closed edge recognised as an exact shape (polygon, star, ellipse) by V7's detector. */
  exact?: { kind: string; d: string; lines: number }
}

const OUTSIDE = 256

/**
 * `image` is the upload; `map` is V7's colour map for it (same size). Regions take their colours
 * from `map.colors`; colours < 0 (paper, transparent) are left undrawn.
 */
export function redraw(image: ImageData, map: LabelMap, o: RedrawOptions = DEFAULT_REDRAW): RedrawResult {
  const t0 = performance.now()
  // Large uploads work at a lower multiple (memory grows with K²): at most about 1,600 px a side.
  const K = Math.max(1, Math.min(o.scale, Math.floor(1600 / Math.max(image.width, image.height))))
  const W = image.width * K
  const H = image.height * K
  const { labels, big } = refineLabels(image, map, K)
  resolveBlends(labels, big, W, H, map.colors, K * 2.5)
  const merged = cleanSmall(labels, W, H, o.minArea * K * K, K * 0.8)
  const { edges, nodePos } = planarMap(labels, W, H, K)
  const nodes: Pt[] = nodePos.map((p) => [p[0], p[1]])
  const observed: Pt[] = nodePos.map((p) => [p[0], p[1]])
  const interpreted: Interpreted[] = []
  // Fragments folded into a neighbour that held at least a source pixel's worth of colour.
  for (const m of merged) if (m.area >= 4 * K * K) interpreted.push({ x: +(m.x / K).toFixed(1), y: +(m.y / K).toFixed(1), moved: +(m.area / (K * K)).toFixed(1), reason: 'fragment' })

  // Fit every edge; breaks at corners become nodes of their own.
  for (const e of edges) fitEdge(e, nodes, observed, o, K)

  // Design rules.
  snapAngles(edges, nodes, o)
  equalizeArcs(edges, o)
  rebuildCorners(edges, nodes)
  const sym = o.symmetry ? findSymmetry(labels, W, H, K, map.colors) : { vertical: null as number | null, horizontal: null as number | null }
  if (sym.vertical !== null) symmetrize(edges, nodes, sym.vertical, 'x', o)
  if (sym.horizontal !== null) symmetrize(edges, nodes, sym.horizontal, 'y', o)
  conformArcs(edges, nodes)

  // What the rules moved further than the upload explains.
  for (let i = 0; i < nodes.length; i++) {
    const d = Math.hypot(nodes[i][0] - observed[i][0], nodes[i][1] - observed[i][1])
    if (d > o.flagDistance) interpreted.push({ x: +nodes[i][0].toFixed(1), y: +nodes[i][1].toFixed(1), moved: +d.toFixed(2), reason: moveReason.get(i) ?? 'corner' })
  }
  for (const e of edges) for (const s of e.segs) if (s.t === 'arc' && Math.abs(s.r - (arcFitRadius.get(s) ?? s.r)) > o.flagDistance) {
    const m = arcMid(s, nodes)
    interpreted.push({ x: +m[0].toFixed(1), y: +m[1].toFixed(1), moved: +Math.abs(s.r - arcFitRadius.get(s)!).toFixed(2), reason: 'radius' })
  }
  moveReason.clear()

  const { svg, regions } = assemble(edges, nodes, map.colors, image.width, image.height)
  const count = { line: 0, arc: 0, circle: 0, bezier: 0 }
  let primLen = 0, allLen = 0
  for (const e of edges) {
    if (e.circle) {
      count.circle++
      primLen += 2 * Math.PI * e.circle.r
      allLen += 2 * Math.PI * e.circle.r
      continue
    }
    if (e.exact) {
      if (e.exact.kind === 'circle' || e.exact.kind === 'ellipse') count.circle++
      else count.line += e.exact.lines
      const per = e.pts.reduce((sum, p, i) => sum + Math.hypot(p[0] - e.pts[(i + 1) % e.pts.length][0], p[1] - e.pts[(i + 1) % e.pts.length][1]), 0)
      primLen += per
      allLen += per
      continue
    }
    for (const s of e.segs) {
      count[s.t]++
      const len = segLength(s, nodes)
      allLen += len
      if (s.t !== 'bezier') primLen += len
    }
  }
  return {
    svg,
    width: image.width,
    height: image.height,
    stats: {
      segments: count,
      primitiveShare: allLen ? +(primLen / allLen).toFixed(3) : 0,
      nodes: nodes.length,
      edges: edges.length,
      regions,
      symmetry: sym.vertical !== null && sym.horizontal !== null ? 'both' : sym.vertical !== null ? 'vertical' : sym.horizontal !== null ? 'horizontal' : 'none',
      ms: Math.round(performance.now() - t0),
    },
    interpreted,
  }
}

// ---------------------------------------------------------------------------------------------
// 1. Colour regions at K× resolution

/**
 * Each fine pixel takes the nearest of the colours V7 found around it (its own coarse pixel and
 * the 8 neighbours, primary and anti-aliasing labels), judged on the smoothly upscaled upload: so
 * an edge lands where the upload's colours cross over, and a mix between two colours never
 * becomes a sliver of a third.
 */
function refineLabels(image: ImageData, map: LabelMap, K: number): { labels: Uint8Array; big: Uint8ClampedArray } {
  const w = image.width, h = image.height
  const W = w * K, H = h * K
  const src = new OffscreenCanvas(w, h)
  src.getContext('2d')!.putImageData(image, 0, 0)
  const big = new OffscreenCanvas(W, H)
  const g = big.getContext('2d', { willReadFrequently: true })!
  g.imageSmoothingEnabled = true
  g.imageSmoothingQuality = 'high'
  g.drawImage(src, 0, 0, W, H)
  const d = g.getImageData(0, 0, W, H).data
  const rgb = map.colors.map((c) => (c < 0 ? null : [(c >> 16) & 255, (c >> 8) & 255, c & 255]))
  const out = new Uint8Array(W * H)
  const cand: number[] = []
  for (let Y = 0; Y < H; Y++) {
    const y = Math.min(h - 1, Math.floor(Y / K))
    for (let X = 0; X < W; X++) {
      const x = Math.min(w - 1, Math.floor(X / K))
      const i = (Y * W + X) * 4
      cand.length = 0
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue
          const p = yy * w + xx
          const l1 = map.labels[p], l2 = map.second[p]
          if (!cand.includes(l1)) cand.push(l1)
          if (l2 < 254 && !cand.includes(l2)) cand.push(l2)
        }
      // Transparent pixels belong to "no shape" when V7 has one there.
      if (d[i + 3] < 128 && cand.some((l) => l >= 254)) {
        out[Y * W + X] = 254
        continue
      }
      let best = cand[0], bestD = Infinity
      for (const l of cand) {
        const c = l < 254 ? rgb[l] : null
        if (!c) {
          // Paper / no shape: matches white or transparent.
          const dd = d[i + 3] < 128 ? 0 : (255 - d[i]) ** 2 + (255 - d[i + 1]) ** 2 + (255 - d[i + 2]) ** 2
          if (dd < bestD) [best, bestD] = [l, dd]
          continue
        }
        const dd = (c[0] - d[i]) ** 2 + (c[1] - d[i + 1]) ** 2 + (c[2] - d[i + 2]) ** 2
        if (dd < bestD) [best, bestD] = [l, dd]
      }
      out[Y * W + X] = best
    }
  }
  return { labels: out, big: d }
}

/**
 * A narrow band whose colour is a mix of the two colours on either side (JPEG and anti-aliasing
 * leave these as colours of their own) is given back to those two colours, pixel by pixel to
 * whichever the upload is closer to. A band in a colour of its own (a real outline) stays.
 */
function resolveBlends(labels: Uint8Array, big: Uint8ClampedArray, W: number, H: number, colors: number[], maxWidth: number) {
  const rgb = (l: number) => (l >= 254 || colors[l] === undefined || colors[l] < 0 ? [255, 255, 255] : [(colors[l] >> 16) & 255, (colors[l] >> 8) & 255, colors[l] & 255])
  const comp = new Int32Array(W * H).fill(-1)
  const stack: number[] = []
  for (let p0 = 0; p0 < W * H; p0++) {
    if (comp[p0] >= 0) continue
    const l = labels[p0]
    const members: number[] = []
    const border = new Map<number, number>()
    comp[p0] = p0
    stack.push(p0)
    while (stack.length) {
      const p = stack.pop()!
      members.push(p)
      const x = p % W
      for (const q of [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, p >= W ? p - W : -1, p < W * H - W ? p + W : -1]) {
        if (q < 0) continue
        if (labels[q] === l) {
          if (comp[q] < 0) {
            comp[q] = p0
            stack.push(q)
          }
        } else border.set(labels[q], (border.get(labels[q]) ?? 0) + 1)
      }
    }
    if (l >= 254 || border.size < 2) continue
    const edgeLen = [...border.values()].reduce((a, b) => a + b, 0)
    if ((2 * members.length) / edgeLen >= maxWidth) continue
    const [[A], [B]] = [...border].sort((a, b) => b[1] - a[1])
    const c = rgb(l), a = rgb(A), b = rgb(B)
    // c ≈ a + t·(b − a), 0.1 ≤ t ≤ 0.9, close to that line.
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
    const len2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2
    if (len2 < 1) continue
    const t = ((c[0] - a[0]) * ab[0] + (c[1] - a[1]) * ab[1] + (c[2] - a[2]) * ab[2]) / len2
    const off = Math.hypot(c[0] - a[0] - t * ab[0], c[1] - a[1] - t * ab[1], c[2] - a[2] - t * ab[2])
    if (t < 0.1 || t > 0.9 || off > 24) continue
    for (const p of members) {
      const i = p * 4
      const da = (big[i] - a[0]) ** 2 + (big[i + 1] - a[1]) ** 2 + (big[i + 2] - a[2]) ** 2
      const db = (big[i] - b[0]) ** 2 + (big[i + 1] - b[1]) ** 2 + (big[i + 2] - b[2]) ** 2
      labels[p] = da <= db ? A : B
    }
  }
}

/**
 * Regions smaller than `minArea` fine pixels, or thinner than `minWidth` (twice the area over the
 * border length), merge into the neighbour they share most border with: colour mixes at an edge
 * that sit closest to a third colour, not artwork. Returns what was merged (fine px).
 */
function cleanSmall(labels: Uint8Array, W: number, H: number, minArea: number, minWidth: number): { x: number; y: number; area: number }[] {
  const out: { x: number; y: number; area: number }[] = []
  const comp = new Int32Array(W * H).fill(-1)
  const stack: number[] = []
  let id = 0
  for (let p0 = 0; p0 < W * H; p0++) {
    if (comp[p0] >= 0) continue
    const l = labels[p0]
    const members: number[] = []
    const border = new Map<number, number>()
    comp[p0] = id
    stack.push(p0)
    while (stack.length) {
      const p = stack.pop()!
      members.push(p)
      const x = p % W
      for (const q of [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, p >= W ? p - W : -1, p < W * H - W ? p + W : -1]) {
        if (q < 0) continue
        if (labels[q] === l) {
          if (comp[q] < 0) {
            comp[q] = id
            stack.push(q)
          }
        } else border.set(labels[q], (border.get(labels[q]) ?? 0) + 1)
      }
    }
    const edgeLen = [...border.values()].reduce((a, b) => a + b, 0)
    if (border.size && (members.length < minArea || (2 * members.length) / Math.max(1, edgeLen) < minWidth)) {
      const to = [...border].sort((a, b) => b[1] - a[1])[0][0]
      let sx = 0, sy = 0
      for (const p of members) {
        labels[p] = to
        sx += p % W
        sy += Math.floor(p / W)
      }
      out.push({ x: sx / members.length, y: sy / members.length, area: members.length })
    }
    id++
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// 2. Shared edges (planar map of crack edges)

/**
 * Boundaries between differently labelled fine pixels, as chains of grid vertices between
 * junctions (where 3+ regions meet, or 2 meet diagonally). Each chain has one region on its left
 * and one on its right, so it is drawn once and used by both.
 */
function planarMap(labels: Uint8Array, W: number, H: number, K: number): { edges: Edge[]; nodePos: Pt[] } {
  const lab = (x: number, y: number) => (x < 0 || y < 0 || x >= W || y >= H ? OUTSIDE : labels[y * W + x])
  const V = (W + 1) * (H + 1)
  // Edge existence: h[x,y] is the edge from vertex (x,y) to (x+1,y); v[x,y] from (x,y) to (x,y+1).
  const hE = new Uint8Array(V)
  const vE = new Uint8Array(V)
  for (let y = 0; y <= H; y++) for (let x = 0; x < W; x++) if (lab(x, y - 1) !== lab(x, y)) hE[y * (W + 1) + x] = 1
  for (let y = 0; y < H; y++) for (let x = 0; x <= W; x++) if (lab(x - 1, y) !== lab(x, y)) vE[y * (W + 1) + x] = 1
  const vid = (x: number, y: number) => y * (W + 1) + x
  const degree = (x: number, y: number) => (x < W && hE[vid(x, y)] ? 1 : 0) + (x > 0 && hE[vid(x - 1, y)] ? 1 : 0) + (y < H && vE[vid(x, y)] ? 1 : 0) + (y > 0 && vE[vid(x, y - 1)] ? 1 : 0)
  const isJunction = (x: number, y: number) => {
    const dg = degree(x, y)
    if (dg !== 2) return dg > 0
    // Two edges meeting straight or at a corner with only two regions around: not a junction.
    const a = lab(x - 1, y - 1), b = lab(x, y - 1), c = lab(x - 1, y), d = lab(x, y)
    return new Set([a, b, c, d]).size > 2
  }
  const usedH = new Uint8Array(V)
  const usedV = new Uint8Array(V)
  const nodeOf = new Map<number, number>()
  const nodePos: Pt[] = []
  const node = (x: number, y: number) => {
    const k = vid(x, y)
    let n = nodeOf.get(k)
    if (n === undefined) {
      n = nodePos.length
      nodePos.push([x / K, y / K])
      nodeOf.set(k, n)
    }
    return n
  }
  const edges: Edge[] = []
  // Walk from vertex (x,y) leaving in direction (dx,dy) until a junction (or back to the start).
  const walk = (x: number, y: number, dx: number, dy: number) => {
    const pts: Pt[] = [[x, y]]
    // Left / right regions of the first step (y grows downward).
    const sides = (px: number, py: number, ddx: number, ddy: number): [number, number] => {
      if (ddx === 1) return [lab(px, py - 1), lab(px, py)]
      if (ddx === -1) return [lab(px - 1, py), lab(px - 1, py - 1)]
      if (ddy === 1) return [lab(px, py), lab(px - 1, py)]
      return [lab(px - 1, py - 1), lab(px, py - 1)]
    }
    const [left, right] = sides(x, y, dx, dy)
    let cx = x, cy = y, ddx = dx, ddy = dy
    const sx = x, sy = y
    for (;;) {
      if (ddx === 1) usedH[vid(cx, cy)] = 1
      else if (ddx === -1) usedH[vid(cx - 1, cy)] = 1
      else if (ddy === 1) usedV[vid(cx, cy)] = 1
      else usedV[vid(cx, cy - 1)] = 1
      cx += ddx
      cy += ddy
      pts.push([cx, cy])
      if ((cx === sx && cy === sy) || isJunction(cx, cy)) break
      // Continue along the one other unused edge at this degree-2 vertex.
      const opts: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]]
      let moved = false
      for (const [ex, ey] of opts) {
        if (ex === -ddx && ey === -ddy) continue
        const has = ex === 1 ? cx < W && hE[vid(cx, cy)] && !usedH[vid(cx, cy)] : ex === -1 ? cx > 0 && hE[vid(cx - 1, cy)] && !usedH[vid(cx - 1, cy)] : ey === 1 ? cy < H && vE[vid(cx, cy)] && !usedV[vid(cx, cy)] : cy > 0 && vE[vid(cx, cy - 1)] && !usedV[vid(cx, cy - 1)]
        if (has) {
          ddx = ex
          ddy = ey
          moved = true
          break
        }
      }
      if (!moved) break
    }
    const closed = cx === sx && cy === sy
    // Staircase → smooth points (source px): midpoints of unit steps, lightly smoothed, ends kept.
    const mids: Pt[] = []
    for (let i = 0; i + 1 < pts.length; i++) mids.push([(pts[i][0] + pts[i + 1][0]) / 2 / K, (pts[i][1] + pts[i + 1][1]) / 2 / K])
    const a = node(x, y)
    const b = node(cx, cy)
    const sm = smooth(mids, Math.max(1, Math.round(K * 0.75)), closed)
    const out: Pt[] = closed ? sm : [nodePos[a], ...sm, nodePos[b]]
    edges.push({ left, right, pts: out, segs: [], closed, ...(closed ? {} : {}) })
    ;(edges.at(-1) as Edge & { ends: [number, number] }).ends = [a, b]
  }
  for (let y = 0; y <= H; y++)
    for (let x = 0; x <= W; x++) {
      if (!isJunction(x, y)) continue
      if (x < W && hE[vid(x, y)] && !usedH[vid(x, y)]) walk(x, y, 1, 0)
      if (x > 0 && hE[vid(x - 1, y)] && !usedH[vid(x - 1, y)]) walk(x, y, -1, 0)
      if (y < H && vE[vid(x, y)] && !usedV[vid(x, y)]) walk(x, y, 0, 1)
      if (y > 0 && vE[vid(x, y - 1)] && !usedV[vid(x, y - 1)]) walk(x, y, 0, -1)
    }
  // Closed boundaries with no junction (a circle inside one region).
  for (let y = 0; y <= H; y++)
    for (let x = 0; x < W; x++) if (hE[vid(x, y)] && !usedH[vid(x, y)]) walk(x, y, 1, 0)
  return { edges, nodePos }
}

function smooth(pts: Pt[], r: number, closed: boolean): Pt[] {
  const n = pts.length
  if (n < 3) return pts
  const out: Pt[] = []
  for (let i = 0; i < n; i++) {
    let sx = 0, sy = 0, c = 0
    for (let k = -r; k <= r; k++) {
      let j = i + k
      if (closed) j = ((j % n) + n) % n
      else if (j < 0 || j >= n) continue
      const wgt = r + 1 - Math.abs(k)
      sx += pts[j][0] * wgt
      sy += pts[j][1] * wgt
      c += wgt
    }
    out.push([sx / c, sy / c])
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// 3. Fitting

const arcFitRadius = new WeakMap<Seg, number>()
const moveReason = new Map<number, Interpreted['reason']>()

function fitEdge(e: Edge & { ends?: [number, number] }, nodes: Pt[], observed: Pt[], o: RedrawOptions, K: number) {
  const pts = e.pts
  if (e.closed) {
    const c = fitCircle(pts)
    if (c && maxDevCircle(pts, c) <= o.tolerance && c.r > 1) {
      e.circle = c
      return
    }
    // A closed outline V7 recognises as an exact polygon, star or ellipse is drawn as that.
    const ex = pts.length >= 8 ? detectShape(pts, { cornerAngle: 60, precision: 2, smoothing: 0.8 }) : null
    const sides = ex ? (ex.d.match(/L/g) ?? []).length + 1 : 0
    // A "polygon" with many sides is a curve the detector accepted as straight pieces: not a shape.
    if (ex && (ex.kind !== 'polygon' || sides <= 12)) {
      e.exact = { kind: ex.kind, d: ex.d, lines: sides }
      return
    }
  }
  // Breaks: the ends, plus corners.
  // Points are 1/K source px apart: look across 2.5 source px, so a pixel staircase isn't a corner.
  const corners = findCornersOpen(pts, e.closed, Math.max(6, Math.round(2.5 * K)))
  let idx = e.closed ? corners : [0, ...corners.filter((i) => i > 2 && i < pts.length - 3), pts.length - 1]
  if (e.closed && idx.length < 2) {
    // A smooth closed loop that isn't a circle: split into halves at two far points.
    idx = [0, pts.length >> 1]
  }
  const ids: number[] = idx.map((i, k) => {
    if (!e.closed && k === 0) return e.ends![0]
    if (!e.closed && k === idx.length - 1) return e.ends![1]
    nodes.push([pts[i][0], pts[i][1]])
    observed.push([pts[i][0], pts[i][1]])
    return nodes.length - 1
  })
  const pieces: [number, number, number, number][] = []
  for (let k = 0; k + 1 < idx.length; k++) pieces.push([idx[k], idx[k + 1], ids[k], ids[k + 1]])
  if (e.closed) pieces.push([idx.at(-1)!, idx[0] + pts.length, ids.at(-1)!, ids[0]])
  for (const [i, j, a, b] of pieces) {
    const run: Pt[] = []
    for (let k = i; k <= j; k++) run.push(pts[k % pts.length])
    e.segs.push(...fitRun(run, a, b, nodes, observed, o, 0))
  }
}

/**
 * Simplest primitive within tolerance: line, then arc, then cubic; otherwise split where the run
 * strays furthest and fit both halves with a shared tangent, so a smooth curve stays smooth (a
 * split never leaves a corner, and short pieces of a curve are never drawn as straight facets).
 * `tA` / `tB`: tangents the ends must keep (inside a smooth run), pointing into the run.
 */
function fitRun(run: Pt[], a: number, b: number, nodes: Pt[], observed: Pt[], o: RedrawOptions, depth: number, tA?: Pt, tB?: Pt): Seg[] {
  if (run.length < 3) return [{ t: 'line', a, b }]
  const line = fitLineTls(run)
  const len = Math.hypot(run.at(-1)![0] - run[0][0], run.at(-1)![1] - run[0][1])
  // A run that bows to one side is a curve even when a line stays within tolerance. Inside a
  // smooth run (after a split) only a long, truly straight piece is a line.
  const straight = depth === 0 ? maxDevLine(run, line) <= o.tolerance : maxDevLine(run, line) <= o.tolerance * 0.3 && len >= 3
  if (straight && !bows(run, o.tolerance)) return [{ t: 'line', a, b }]
  const c = fitCircle(run)
  const chord = Math.hypot(run.at(-1)![0] - run[0][0], run.at(-1)![1] - run[0][1])
  if (c && c.r < 50 * Math.max(chord, 1) && maxDevCircle(run, c) <= o.tolerance) {
    // Direction: the way round from A to B that passes the run's middle (not a curvature vote,
    // which noise can flip on a gentle arc and send it the long way round).
    const ang = (p: Pt) => Math.atan2(p[1] - c.cy, p[0] - c.cx)
    const tau = 2 * Math.PI
    const a0 = ang(run[0]), am = ang(run[run.length >> 1]), a1 = ang(run[run.length - 1])
    const s: Seg = { t: 'arc', a, b, cx: c.cx, cy: c.cy, r: c.r, ccw: (((am - a0) % tau) + tau) % tau < (((a1 - a0) % tau) + tau) % tau }
    arcFitRadius.set(s, c.r)
    return [s]
  }
  const bz = fitBezier(run, tA, tB)
  if (bz && maxDevBezier(run, bz) <= o.tolerance) return [{ t: 'bezier', a, b, c1: bz[1], c2: bz[2] }]
  if (depth > 8 || run.length < 8) return bz ? [{ t: 'bezier', a, b, c1: bz[1], c2: bz[2] }] : [{ t: 'line', a, b }]
  // Split where the run strays furthest from its chord.
  let far = 1, farD = -1
  for (let k = 1; k < run.length - 1; k++) {
    const d = distToLine(run[k], { p: run[0], d: norm([run.at(-1)![0] - run[0][0], run.at(-1)![1] - run[0][1]]) })
    if (d > farD) [far, farD] = [k, d]
  }
  if (far < 3 || far > run.length - 4) far = run.length >> 1
  nodes.push([run[far][0], run[far][1]])
  observed.push([run[far][0], run[far][1]])
  const m = nodes.length - 1
  const k = Math.min(3, far, run.length - 1 - far)
  const tm = norm([run[far + k][0] - run[far - k][0], run[far + k][1] - run[far - k][1]])
  return [...fitRun(run.slice(0, far + 1), a, m, nodes, observed, o, depth + 1, tA, [-tm[0], -tm[1]]), ...fitRun(run.slice(far), m, b, nodes, observed, o, depth + 1, tm, tB)]
}

/** Whether the points sit consistently on one side of their chord (a curve, not a noisy line). */
function bows(run: Pt[], tolerance: number): boolean {
  const A = run[0], B = run[run.length - 1]
  const d = norm([B[0] - A[0], B[1] - A[1]])
  let pos = 0, neg = 0, sum = 0
  for (let i = 1; i < run.length - 1; i++) {
    const s = (run[i][0] - A[0]) * d[1] - (run[i][1] - A[1]) * d[0]
    if (s > 0.05) pos++
    else if (s < -0.05) neg++
    sum += s
  }
  const n = Math.max(1, run.length - 2)
  return Math.max(pos, neg) / n > 0.8 && Math.abs(sum / n) > tolerance * 0.25
}

/**
 * Corners: points where the outline turns sharply, judged at two scales. `w` points is the fine
 * scale (where the corner is placed); `wide` must agree, so a pixel staircase (which turns only
 * at the fine scale) isn't a corner, while close real corners aren't merged.
 */
function findCornersOpen(pts: Pt[], closed: boolean, wide = 6): number[] {
  const n = pts.length
  const w = 6
  if (n < 2 * w + 3) return []
  const turn = (i: number, s: number) => {
    const i0 = i - s, i1 = i + s
    if (!closed && (i0 < 0 || i1 >= n)) {
      if (s === w) return 0
      return turn(i, Math.max(w, Math.min(i, n - 1 - i)))
    }
    const p = pts[((i0 % n) + n) % n], q = pts[i], r = pts[i1 % n]
    const a1 = Math.atan2(q[1] - p[1], q[0] - p[0]), a2 = Math.atan2(r[1] - q[1], r[0] - q[0])
    let d = Math.abs(a2 - a1)
    if (d > Math.PI) d = 2 * Math.PI - d
    return (d * 180) / Math.PI
  }
  const ang: number[] = Array.from({ length: n }, (_, i) => turn(i, w))
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    if (ang[i] < 32) continue
    let isMax = true
    for (let k = -w; k <= w && isMax; k++) {
      const j = closed ? (((i + k) % n) + n) % n : i + k
      if (j < 0 || j >= n || j === i) continue
      if (ang[j] > ang[i] || (ang[j] === ang[i] && j < i)) isMax = false
    }
    if (isMax && (wide <= w || turn(i, Math.min(wide, closed ? wide : n)) >= 32)) out.push(i)
  }
  return out
}

function norm(v: Pt): Pt {
  const l = Math.hypot(v[0], v[1]) || 1
  return [v[0] / l, v[1] / l]
}

interface Line {
  p: Pt
  d: Pt
}
function fitLineTls(pts: Pt[]): Line {
  let mx = 0, my = 0
  for (const [x, y] of pts) {
    mx += x
    my += y
  }
  mx /= pts.length
  my /= pts.length
  let sxx = 0, sxy = 0, syy = 0
  for (const [x, y] of pts) {
    sxx += (x - mx) ** 2
    sxy += (x - mx) * (y - my)
    syy += (y - my) ** 2
  }
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy)
  return { p: [mx, my], d: [Math.cos(th), Math.sin(th)] }
}
const distToLine = (q: Pt, l: Line) => Math.abs((q[0] - l.p[0]) * l.d[1] - (q[1] - l.p[1]) * l.d[0])
const maxDevLine = (pts: Pt[], l: Line) => pts.reduce((m, q) => Math.max(m, distToLine(q, l)), 0)

/** Algebraic (Kåsa) circle fit. */
function fitCircle(pts: Pt[]): Circle | null {
  if (pts.length < 5) return null
  let mx = 0, my = 0
  for (const [x, y] of pts) {
    mx += x
    my += y
  }
  mx /= pts.length
  my /= pts.length
  let suu = 0, suv = 0, svv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0
  for (const [x, y] of pts) {
    const u = x - mx, v = y - my
    suu += u * u
    suv += u * v
    svv += v * v
    suuu += u * u * u
    svvv += v * v * v
    suvv += u * v * v
    svuu += v * u * u
  }
  const det = suu * svv - suv * suv
  if (Math.abs(det) < 1e-9) return null
  const b1 = 0.5 * (suuu + suvv), b2 = 0.5 * (svvv + svuu)
  const uc = (b1 * svv - b2 * suv) / det, vc = (suu * b2 - suv * b1) / det
  const r = Math.sqrt(uc * uc + vc * vc + (suu + svv) / pts.length)
  return { cx: uc + mx, cy: vc + my, r }
}
const maxDevCircle = (pts: Pt[], c: Circle) => pts.reduce((m, [x, y]) => Math.max(m, Math.abs(Math.hypot(x - c.cx, y - c.cy) - c.r)), 0)

type Cubic = [Pt, Pt, Pt, Pt]
/** Least-squares cubic with fixed ends and end tangents from the data (chord-length parameters). */
function fitBezier(run: Pt[], tA?: Pt, tB?: Pt): Cubic | null {
  const n = run.length
  if (n < 4) return null
  const p0 = run[0], p3 = run[n - 1]
  const k = Math.min(4, n >> 2 || 1)
  const t1 = tA ?? norm([run[k][0] - p0[0], run[k][1] - p0[1]])
  const t2 = tB ?? norm([run[n - 1 - k][0] - p3[0], run[n - 1 - k][1] - p3[1]])
  const u: number[] = [0]
  for (let i = 1; i < n; i++) u.push(u[i - 1] + Math.hypot(run[i][0] - run[i - 1][0], run[i][1] - run[i - 1][1]))
  const L = u[n - 1] || 1
  let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0
  for (let i = 0; i < n; i++) {
    const t = u[i] / L
    const b0 = (1 - t) ** 3, b1 = 3 * t * (1 - t) ** 2, b2 = 3 * t * t * (1 - t), b3 = t ** 3
    const A1: Pt = [t1[0] * b1, t1[1] * b1], A2: Pt = [t2[0] * b2, t2[1] * b2]
    c00 += A1[0] * A1[0] + A1[1] * A1[1]
    c01 += A1[0] * A2[0] + A1[1] * A2[1]
    c11 += A2[0] * A2[0] + A2[1] * A2[1]
    const tmp: Pt = [run[i][0] - (p0[0] * (b0 + b1) + p3[0] * (b2 + b3)), run[i][1] - (p0[1] * (b0 + b1) + p3[1] * (b2 + b3))]
    x0 += A1[0] * tmp[0] + A1[1] * tmp[1]
    x1 += A2[0] * tmp[0] + A2[1] * tmp[1]
  }
  const det = c00 * c11 - c01 * c01
  let a1 = det ? (x0 * c11 - x1 * c01) / det : L / 3
  let a2 = det ? (c00 * x1 - c01 * x0) / det : L / 3
  if (!(a1 > 1e-3) || !(a2 > 1e-3)) a1 = a2 = L / 3
  return [p0, [p0[0] + t1[0] * a1, p0[1] + t1[1] * a1], [p3[0] + t2[0] * a2, p3[1] + t2[1] * a2], p3]
}
function bezAt(c: Cubic, t: number): Pt {
  const u = 1 - t
  return [u ** 3 * c[0][0] + 3 * u * u * t * c[1][0] + 3 * u * t * t * c[2][0] + t ** 3 * c[3][0], u ** 3 * c[0][1] + 3 * u * u * t * c[1][1] + 3 * u * t * t * c[2][1] + t ** 3 * c[3][1]]
}
function maxDevBezier(run: Pt[], c: Cubic): number {
  const samples: Pt[] = []
  for (let i = 0; i <= 64; i++) samples.push(bezAt(c, i / 64))
  let m = 0
  for (const q of run) {
    let best = Infinity
    for (let i = 0; i + 1 < samples.length; i++) best = Math.min(best, segDist(q, samples[i], samples[i + 1]))
    m = Math.max(m, best)
  }
  return m
}
function segDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0], dy = b[1] - a[1]
  const l2 = dx * dx + dy * dy
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)
}

// ---------------------------------------------------------------------------------------------
// 4. Design rules

function setNode(nodes: Pt[], i: number, p: Pt, why: Interpreted['reason']) {
  nodes[i] = p
  moveReason.set(i, why)
}

/** Lines within a few degrees of a multiple of 45° are made exact (both ends moved about the middle). */
function snapAngles(edges: Edge[], nodes: Pt[], o: RedrawOptions) {
  for (const e of edges)
    for (const s of e.segs) {
      if (s.t !== 'line') continue
      const A = nodes[s.a], B = nodes[s.b]
      const len = Math.hypot(B[0] - A[0], B[1] - A[1])
      if (len < 3) continue
      const ang = (Math.atan2(B[1] - A[1], B[0] - A[0]) * 180) / Math.PI
      const target = Math.round(ang / 45) * 45
      const off = Math.abs(ang - target)
      if (off < 1e-6 || off > o.snapDegrees) continue
      const m: Pt = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2]
      const t = (target * Math.PI) / 180
      const h = len / 2
      setNode(nodes, s.a, [m[0] - Math.cos(t) * h, m[1] - Math.sin(t) * h], 'angle')
      setNode(nodes, s.b, [m[0] + Math.cos(t) * h, m[1] + Math.sin(t) * h], 'angle')
    }
}

/** Near-equal radii become equal; near-coincident centres become one (concentric). */
function equalizeArcs(edges: Edge[], o: RedrawOptions) {
  const arcs: (Circle & { ref: Seg | Edge })[] = []
  for (const e of edges) {
    if (e.circle) arcs.push({ ...e.circle, ref: e })
    for (const s of e.segs) if (s.t === 'arc') arcs.push({ cx: s.cx, cy: s.cy, r: s.r, ref: s })
  }
  const apply = (ref: Seg | Edge, c: Partial<Circle>) => {
    if ('segs' in ref) Object.assign(ref.circle!, c)
    else if (ref.t === 'arc') Object.assign(ref, c)
  }
  // Centres within 1 px (or the tolerance) share their mean.
  const seen = new Set<number>()
  for (let i = 0; i < arcs.length; i++) {
    if (seen.has(i)) continue
    const group = [i]
    for (let j = i + 1; j < arcs.length; j++) if (!seen.has(j) && Math.hypot(arcs[j].cx - arcs[i].cx, arcs[j].cy - arcs[i].cy) < Math.max(1, o.tolerance * 1.5)) group.push(j)
    if (group.length < 2) continue
    const cx = group.reduce((s, k) => s + arcs[k].cx, 0) / group.length
    const cy = group.reduce((s, k) => s + arcs[k].cy, 0) / group.length
    for (const k of group) {
      seen.add(k)
      arcs[k].cx = cx
      arcs[k].cy = cy
      apply(arcs[k].ref, { cx, cy })
    }
  }
  // Radii within 4% (and 1 px) share their mean.
  const byR = arcs.map((_, i) => i).sort((p, q) => arcs[p].r - arcs[q].r)
  for (let s = 0; s < byR.length; ) {
    let e = s + 1
    while (e < byR.length && arcs[byR[e]].r - arcs[byR[s]].r < Math.min(1.2, arcs[byR[s]].r * 0.04)) e++
    if (e - s > 1) {
      const r = byR.slice(s, e).reduce((t, k) => t + arcs[k].r, 0) / (e - s)
      for (const k of byR.slice(s, e)) apply(arcs[k].ref, { r })
    }
    s = e
  }
}

/** Where two fitted edges meet at a corner, the corner is put where they intersect. */
function rebuildCorners(edges: Edge[], nodes: Pt[]) {
  const at = new Map<number, Seg[]>()
  for (const e of edges) for (const s of e.segs) for (const n of [s.a, s.b]) at.set(n, [...(at.get(n) ?? []), s])
  for (const [n, segs] of at) {
    if (segs.length < 2) continue
    const cands: Pt[] = []
    for (let i = 0; i < segs.length; i++)
      for (let j = i + 1; j < segs.length; j++) {
        const p = intersect(segs[i], segs[j], nodes, nodes[n])
        if (p && Math.hypot(p[0] - nodes[n][0], p[1] - nodes[n][1]) < 2) cands.push(p)
      }
    if (cands.length) setNode(nodes, n, [cands.reduce((s, p) => s + p[0], 0) / cands.length, cands.reduce((s, p) => s + p[1], 0) / cands.length], 'corner')
  }
}

function lineOf(s: Seg, nodes: Pt[]): Line {
  const A = nodes[s.a], B = nodes[s.b]
  return { p: A, d: norm([B[0] - A[0], B[1] - A[1]]) }
}
function intersect(s1: Seg, s2: Seg, nodes: Pt[], near: Pt): Pt | null {
  if (s1.t === 'line' && s2.t === 'line') {
    const l1 = lineOf(s1, nodes), l2 = lineOf(s2, nodes)
    const den = l1.d[0] * l2.d[1] - l1.d[1] * l2.d[0]
    // Nearly parallel: no clear corner.
    if (Math.abs(den) < Math.sin((15 * Math.PI) / 180)) return null
    const t = ((l2.p[0] - l1.p[0]) * l2.d[1] - (l2.p[1] - l1.p[1]) * l2.d[0]) / den
    return [l1.p[0] + t * l1.d[0], l1.p[1] + t * l1.d[1]]
  }
  const ln = s1.t === 'line' ? s1 : s2.t === 'line' ? s2 : null
  const arc = s1.t === 'arc' ? s1 : s2.t === 'arc' ? s2 : null
  if (ln && arc && arc.t === 'arc') {
    const l = lineOf(ln, nodes)
    const fx = l.p[0] - arc.cx, fy = l.p[1] - arc.cy
    const b = fx * l.d[0] + fy * l.d[1]
    const c = fx * fx + fy * fy - arc.r * arc.r
    const disc = b * b - c
    if (disc < 0) return null
    const ts = [-b - Math.sqrt(disc), -b + Math.sqrt(disc)]
    const pts = ts.map((t): Pt => [l.p[0] + t * l.d[0], l.p[1] + t * l.d[1]])
    return pts.sort((p, q) => Math.hypot(p[0] - near[0], p[1] - near[1]) - Math.hypot(q[0] - near[0], q[1] - near[1]))[0]
  }
  return null
}

/**
 * Mirror symmetry: the colour map compared with its mirror image about candidate axes near the
 * artwork's middle; an axis counts when at least 98% of the artwork's fine pixels match.
 */
function findSymmetry(labels: Uint8Array, W: number, H: number, K: number, colors: number[]): { vertical: number | null; horizontal: number | null } {
  let bg = 0
  const counts = new Map<number, number>()
  for (const x of [0, W - 1]) for (let y = 0; y < H; y++) counts.set(labels[y * W + x], (counts.get(labels[y * W + x]) ?? 0) + 1)
  bg = [...counts].sort((a, b) => b[1] - a[1])[0][0]
  let sx = 0, sy = 0, n = 0
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (labels[y * W + x] !== bg) {
    sx += x
    sy += y
    n++
  }
  if (!n) return { vertical: null, horizontal: null }
  const test = (axis: number, vertical: boolean) => {
    let match = 0, total = 0
    for (let y = 0; y < H; y += 2)
      for (let x = 0; x < W; x += 2) {
        const l = labels[y * W + x]
        if (l === bg) continue
        const mx = vertical ? Math.round(2 * axis - x - 1) : x
        const my = vertical ? y : Math.round(2 * axis - y - 1)
        total++
        if (mx >= 0 && my >= 0 && mx < W && my < H && labels[my * W + mx] === l) match++
      }
    return total ? match / total : 0
  }
  const best = (center: number, vertical: boolean) => {
    let b = { axis: center, score: 0 }
    for (let d = -3 * K; d <= 3 * K; d++) {
      const s = test(center + d * 0.5, vertical)
      if (s > b.score) b = { axis: center + d * 0.5, score: s }
    }
    return b
  }
  void colors
  const v = best(sx / n + 0.5, true)
  const h = best(sy / n + 0.5, false)
  return { vertical: v.score >= 0.98 ? v.axis / K : null, horizontal: h.score >= 0.98 ? h.axis / K : null }
}

/** Nodes are paired with their mirror image and averaged; nodes on the axis are put on it. */
function symmetrize(edges: Edge[], nodes: Pt[], axis: number, dim: 'x' | 'y', o: RedrawOptions) {
  const k = dim === 'x' ? 0 : 1
  const mirror = (p: Pt): Pt => (dim === 'x' ? [2 * axis - p[0], p[1]] : [p[0], 2 * axis - p[1]])
  const used = new Set<number>()
  const tol = Math.max(1.5, o.tolerance * 2.5)
  for (let i = 0; i < nodes.length; i++) {
    if (used.has(i)) continue
    if (Math.abs(nodes[i][k] - axis) < o.tolerance) {
      const p: Pt = [nodes[i][0], nodes[i][1]]
      p[k] = axis
      setNode(nodes, i, p, 'symmetry')
      used.add(i)
      continue
    }
    const m = mirror(nodes[i])
    let best = -1, bestD = tol
    for (let j = 0; j < nodes.length; j++) {
      if (j === i || used.has(j)) continue
      const d = Math.hypot(nodes[j][0] - m[0], nodes[j][1] - m[1])
      if (d < bestD) [best, bestD] = [j, d]
    }
    if (best < 0) continue
    const mj = mirror(nodes[best])
    const avg: Pt = [(nodes[i][0] + mj[0]) / 2, (nodes[i][1] + mj[1]) / 2]
    setNode(nodes, i, avg, 'symmetry')
    setNode(nodes, best, mirror(avg), 'symmetry')
    used.add(i)
    used.add(best)
  }
  // Circles and arcs: centres near the axis go on it.
  for (const e of edges) {
    if (e.circle && Math.abs((k === 0 ? e.circle.cx : e.circle.cy) - axis) < tol) {
      if (k === 0) e.circle.cx = axis
      else e.circle.cy = axis
    }
    for (const s of e.segs) if (s.t === 'arc' && Math.abs((k === 0 ? s.cx : s.cy) - axis) < tol) {
      if (k === 0) s.cx = axis
      else s.cy = axis
    }
  }
}

/** Arcs pass through their (possibly moved) end nodes, keeping their radius; Béziers follow their ends. */
function conformArcs(edges: Edge[], nodes: Pt[]) {
  for (const e of edges)
    for (const s of e.segs) {
      if (s.t !== 'arc') continue
      const A = nodes[s.a], B = nodes[s.b]
      const half = Math.hypot(B[0] - A[0], B[1] - A[1]) / 2
      if (half < 1e-6) continue
      const r = Math.max(s.r, half)
      const m: Pt = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2]
      const nrm = norm([-(B[1] - A[1]), B[0] - A[0]])
      const h = Math.sqrt(Math.max(0, r * r - half * half))
      const c1: Pt = [m[0] + nrm[0] * h, m[1] + nrm[1] * h], c2: Pt = [m[0] - nrm[0] * h, m[1] - nrm[1] * h]
      const pick = Math.hypot(c1[0] - s.cx, c1[1] - s.cy) <= Math.hypot(c2[0] - s.cx, c2[1] - s.cy) ? c1 : c2
      s.cx = pick[0]
      s.cy = pick[1]
      s.r = r
    }
}

// ---------------------------------------------------------------------------------------------
// 5. Assembly and output

function arcMid(s: Seg & { t: 'arc' }, nodes: Pt[]): Pt {
  const A = nodes[s.a], B = nodes[s.b]
  const [a0, sweep] = arcAngles(s, A, B)
  const t = a0 + sweep / 2
  return [s.cx + s.r * Math.cos(t), s.cy + s.r * Math.sin(t)]
}
/** Start angle and signed sweep from A to B around the centre, in the arc's turning direction. */
function arcAngles(s: Seg & { t: 'arc' }, A: Pt, B: Pt): [number, number] {
  const a0 = Math.atan2(A[1] - s.cy, A[0] - s.cx)
  let a1 = Math.atan2(B[1] - s.cy, B[0] - s.cx)
  // y grows downward: a positive turn (cross product) is clockwise on screen = increasing angle.
  if (s.ccw) {
    while (a1 < a0) a1 += 2 * Math.PI
  } else {
    while (a1 > a0) a1 -= 2 * Math.PI
  }
  return [a0, a1 - a0]
}
function segLength(s: Seg, nodes: Pt[]): number {
  const A = nodes[s.a], B = nodes[s.b]
  if (s.t === 'line') return Math.hypot(B[0] - A[0], B[1] - A[1])
  if (s.t === 'arc') return Math.abs(arcAngles(s, A, B)[1]) * s.r
  const c: Cubic = [A, s.c1, s.c2, B]
  let L = 0, prev = A
  for (let i = 1; i <= 16; i++) {
    const p = bezAt(c, i / 16)
    L += Math.hypot(p[0] - prev[0], p[1] - prev[1])
    prev = p
  }
  return L
}

const f = (v: number) => +v.toFixed(2)

/** SVG path commands (from the current point at A) drawing the segment forwards or backwards. */
function segPath(s: Seg, nodes: Pt[], reverse: boolean, moved: Map<number, Pt>): string {
  const A = nodes[s.a], B = nodes[s.b]
  const [from, to] = reverse ? [B, A] : [A, B]
  if (s.t === 'line') return `L${f(to[0])} ${f(to[1])}`
  if (s.t === 'bezier') {
    // Controls follow their end nodes' moves.
    const da = moved.get(s.a) ?? [0, 0], db = moved.get(s.b) ?? [0, 0]
    const c1: Pt = [s.c1[0] + da[0], s.c1[1] + da[1]], c2: Pt = [s.c2[0] + db[0], s.c2[1] + db[1]]
    return reverse ? `C${f(c2[0])} ${f(c2[1])} ${f(c1[0])} ${f(c1[1])} ${f(to[0])} ${f(to[1])}` : `C${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(to[0])} ${f(to[1])}`
  }
  // Arcs as cubics (≤ 90° each), so print and cut exporters (which take no arc commands) can read them.
  let [a0, sweep] = arcAngles(s, A, B)
  if (reverse) {
    a0 = a0 + sweep
    sweep = -sweep
  }
  const parts = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2)))
  const step = sweep / parts
  const k = (4 / 3) * Math.tan(step / 4)
  let out = ''
  for (let i = 0; i < parts; i++) {
    const t1 = a0 + i * step, t2 = t1 + step
    const p1: Pt = [s.cx + s.r * Math.cos(t1), s.cy + s.r * Math.sin(t1)]
    const p2: Pt = i === parts - 1 ? to : [s.cx + s.r * Math.cos(t2), s.cy + s.r * Math.sin(t2)]
    const q1: Pt = [p1[0] - k * s.r * Math.sin(t1), p1[1] + k * s.r * Math.cos(t1)]
    const q2: Pt = [s.cx + s.r * Math.cos(t2) + k * s.r * Math.sin(t2), s.cy + s.r * Math.sin(t2) - k * s.r * Math.cos(t2)]
    out += `C${f(q1[0])} ${f(q1[1])} ${f(q2[0])} ${f(q2[1])} ${f(p2[0])} ${f(p2[1])}`
  }
  void from
  return out
}

function circlePathD(c: Circle): string {
  const k = 0.5523 * c.r
  const { cx, cy, r } = c
  return `M${f(cx + r)} ${f(cy)}C${f(cx + r)} ${f(cy + k)} ${f(cx + k)} ${f(cy + r)} ${f(cx)} ${f(cy + r)}C${f(cx - k)} ${f(cy + r)} ${f(cx - r)} ${f(cy + k)} ${f(cx - r)} ${f(cy)}C${f(cx - r)} ${f(cy - k)} ${f(cx - k)} ${f(cy - r)} ${f(cx)} ${f(cy - r)}C${f(cx + k)} ${f(cy - r)} ${f(cx + r)} ${f(cy - k)} ${f(cx + r)} ${f(cy)}Z`
}

/** Each region's boundary rings from the shared edges (forwards where it is on the left, backwards on the right). */
function assemble(edges: Edge[], nodes: Pt[], colors: number[], w: number, h: number): { svg: string; regions: number } {
  const moved = new Map<number, Pt>()
  const byLabel = new Map<number, { e: Edge & { ends?: [number, number] }; rev: boolean }[]>()
  for (const e of edges) {
    for (const [l, rev] of [[e.left, false], [e.right, true]] as [number, boolean][]) {
      if (l === OUTSIDE || l >= 254) continue
      byLabel.set(l, [...(byLabel.get(l) ?? []), { e, rev }])
    }
  }
  const paths: string[] = []
  for (const [l, list] of byLabel) {
    const color = colors[l]
    if (color === undefined || color < 0) continue
    let d = ''
    const open = list.filter((x) => !x.e.closed)
    for (const x of list.filter((y) => y.e.closed)) {
      if (x.e.circle) {
        d += circlePathD(x.e.circle)
        continue
      }
      if (x.e.exact) {
        d += x.e.exact.d
        continue
      }
      const segs = x.rev ? [...x.e.segs].reverse() : x.e.segs
      const first = segs[0]
      const start = nodes[x.rev ? first.b : first.a]
      d += `M${f(start[0])} ${f(start[1])}` + segs.map((s) => segPath(s, nodes, x.rev, moved)).join('') + 'Z'
    }
    // Link open edges into rings by their end nodes.
    const used = new Set<number>()
    const startAt = new Map<number, number[]>()
    open.forEach((x, i) => {
      const s = x.rev ? x.e.ends![1] : x.e.ends![0]
      startAt.set(s, [...(startAt.get(s) ?? []), i])
    })
    for (let i = 0; i < open.length; i++) {
      if (used.has(i)) continue
      const ringStart = open[i].rev ? open[i].e.ends![1] : open[i].e.ends![0]
      d += `M${f(nodes[ringStart][0])} ${f(nodes[ringStart][1])}`
      let cur = i
      for (let guard = 0; guard < open.length && cur >= 0; guard++) {
        used.add(cur)
        const x = open[cur]
        const segs = x.rev ? [...x.e.segs].reverse() : x.e.segs
        d += segs.map((s) => segPath(s, nodes, x.rev, moved)).join('')
        const end = x.rev ? x.e.ends![0] : x.e.ends![1]
        if (end === ringStart) break
        cur = (startAt.get(end) ?? []).find((k) => !used.has(k)) ?? -1
      }
      d += 'Z'
    }
    if (d) paths.push(`<path d="${d}" fill="#${color.toString(16).padStart(6, '0').toUpperCase()}" fill-rule="evenodd"/>`)
  }
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">\n${paths.join('\n')}\n</svg>`, regions: paths.length }
}
