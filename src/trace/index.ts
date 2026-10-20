import { area, contours, type Point } from './contours'
import { fitClosed, type Cubic } from './fit'
import { circlePath, decomposeCirclePolygon, insideCircle, insidePolygon, polygonPath, type CirclePolygon } from './decompose'
import { detectShape, type ShapeKind } from './shapes'
import { gradientSvg, type GradientFill } from '../palette/gradients'

/** A cleaned color map at source resolution, as produced by the quantizer. */
export interface LabelMap {
  w: number
  h: number
  /** Primary label per pixel; labels ≥ 254 are paper / empty (no shape). */
  labels: Uint8Array
  /** Second label for anti-aliased edge pixels (255 = none). */
  second: Uint8Array
  /** Share of the primary label in each pixel (1 = pure). */
  cov: Float32Array
  /** Fill color per label as 0xRRGGBB; negative means no shape. */
  colors: number[]
  /** Labels drawn with a gradient instead of their flat color (which is then the average). */
  fills?: (GradientFill | undefined)[]
}

export interface TraceOptions {
  /** Edge smoothing (Gaussian sigma) in source pixels. */
  smoothing: number
  /** Drop shapes and holes smaller than this many source pixels. */
  minArea: number
  /** Max curve deviation from the contour, in source pixels. */
  error: number
  /** Turning angle (degrees) kept as a sharp corner. */
  cornerAngle: number
  /** Decimal places in path coordinates. */
  precision: number
  /**
   * 'stacked' (default): each layer also covers the layers above it, so no seams show on screen.
   * 'knockout': each layer covers only its own area, as print plates and cut files need. A small
   * spread (`spread`, in source px) overlaps neighbors slightly to hide registration gaps.
   */
  mode?: 'stacked' | 'knockout'
  spread?: number
  /** Replace outlines that are circles, ellipses, stars or polygons with exact geometry. */
  exactShapes?: boolean
  /**
   * Shapes and holes smaller than this (but at least `minArea`) are kept only when they contain
   * a pixel that really is their colour (or, for a hole, really isn't): real detail such as a
   * letter counter or a full stop does, while slivers left by edge blending where colours meet
   * don't. Defaults to `minArea`.
   */
  detailArea?: number
  /**
   * Stacked output: a layer keeps only the outlines that hold some of its own pixels. It still
   * extends under the higher layers it surrounds or touches (so no seam shows), but no longer draws
   * hidden copies of shapes that are all higher layers (separate lettering, a counter inside a
   * letter), which those layers draw in full (RC8).
   */
  connectedStacking?: boolean
  /**
   * Fine detail: thin strokes are measured across the stroke (along the field's gradient) rather
   * than in a square around each pixel, so a 1 px line keeps its width where it runs diagonally
   * between pixels, instead of breaking there (see keepThin).
   */
  crossSection?: boolean
  /**
   * Fine detail: a thin outline's straight stretches are drawn as exact lines (FitOptions.straightRuns).
   * With the ordinary curve tolerance a 1 px bar's sides otherwise bulge, drawing it half as wide again.
   */
  straightRuns?: boolean
}

/** Exact shapes made, plus how many merged outlines were split into overlapping shapes. */
export type ShapeCounts = Record<ShapeKind, number> & { overlaps: number }

/** One color's shapes as an SVG path (`M…C…Z` subpaths, even-odd fill). */
export interface TracedLayer {
  color: number
  /** All of this layer's subpaths together (even-odd). */
  d: string
  /** The same geometry split into separate shapes: each outer outline with its own holes. */
  shapes?: string[]
  /** Drawn with this gradient; `color` is then its average. */
  fill?: GradientFill
  /** Lettering rebuilt from a font: one path per letter (in `shapes`), named after the word. */
  text?: { word: string; font: string; letters: string[] }
}

const NO_SHAPE = 254

/**
 * Traces a flat color map into SVG paths with smooth, sub-pixel-accurate Bézier outlines.
 *
 * Layers are stacked largest-first, and each layer's shape also covers every layer drawn above
 * it, so neighboring shapes never leave hairline gaps. Each layer's outline is the 0.5
 * iso-contour of a smoothed membership field, which uses the anti-aliasing information in edge
 * pixels to place the boundary between pixel centers.
 */
export function traceLabels(map: LabelMap, opts: TraceOptions): { svg: string; paths: number; layers: TracedLayer[]; shapes: ShapeCounts } {
  const { w, h, labels, second, cov, colors } = map
  const fillOf = (l: number) => map.fills?.[l]
  const n = w * h

  // Stack order: largest area at the bottom.
  const counts = new Float64Array(colors.length)
  for (let p = 0; p < n; p++) if (labels[p] < NO_SHAPE) counts[labels[p]]++
  // Labels with a negative color (e.g. paper in line art) get no shape.
  const order = colors.map((_, i) => i).filter((i) => counts[i] > 0 && colors[i] >= 0).sort((a, b) => counts[b] - counts[a])

  // rank[label] = position in the stack; a layer's shape covers all labels at or above it.
  const rank = new Int16Array(256).fill(-1)
  order.forEach((l, i) => (rank[l] = i))

  const knockout = opts.mode === 'knockout'
  // A spread of s px moves the iso-contour outward; for a blurred step edge that's roughly a
  // level shift of s / (sigma·√(2π)).
  const level = knockout ? Math.max(0.2, 0.5 - (opts.spread ?? 0) / (Math.max(0.3, opts.smoothing) * 2.5066)) : 0.5
  const fmt = (v: number) => +v.toFixed(opts.precision)
  const layers: TracedLayer[] = []
  const shapes: ShapeCounts = { circle: 0, ellipse: 0, star: 0, polygon: 0, overlaps: 0 }
  const field = new Float32Array(n)
  const suppressed: { label: number; covers: (p: Point) => boolean }[] = []

  /** Majority label (at this layer or above) among pixels where `test` holds, inside a box. */
  const majority = (x0: number, y0: number, x1: number, y1: number, test: (p: Point) => boolean, minRank: number) => {
    const votes = new Map<number, number>()
    const step = Math.max(1, Math.round(Math.max(x1 - x0, y1 - y0) / 120))
    for (let y = Math.max(0, Math.floor(y0)); y < Math.min(h, Math.ceil(y1)); y += step)
      for (let x = Math.max(0, Math.floor(x0)); x < Math.min(w, Math.ceil(x1)); x += step) {
        if (!test([x + 0.5, y + 0.5])) continue
        const l = labels[y * w + x]
        if (l >= NO_SHAPE || rank[l] < minRank) continue
        votes.set(l, (votes.get(l) ?? 0) + 1)
      }
    let best = -1
    let bn = 0
    let total = 0
    for (const [l, v] of votes) {
      total += v
      if (v > bn) [best, bn] = [l, v]
    }
    return bn >= total * 0.8 && bn >= 4 ? best : -1
  }

  /** Majority label strictly below a layer among pixels where `test` holds (what a hole shows). */
  const majorityBelow = (x0: number, y0: number, x1: number, y1: number, test: (p: Point) => boolean, layerRank: number) => {
    const votes = new Map<number, number>()
    for (let y = Math.max(0, Math.floor(y0)); y < Math.min(h, Math.ceil(y1)); y++)
      for (let x = Math.max(0, Math.floor(x0)); x < Math.min(w, Math.ceil(x1)); x++) {
        if (!test([x + 0.5, y + 0.5])) continue
        const l = labels[y * w + x]
        if (l >= NO_SHAPE || rank[l] < 0 || rank[l] >= layerRank) continue
        votes.set(l, (votes.get(l) ?? 0) + 1)
      }
    let best = -1
    let bn = 0
    for (const [l, v] of votes) if (v > bn) [best, bn] = [l, v]
    return best
  }

  /**
   * In stacked output, an outline that is really a circle and a polygon overlapping (a starburst
   * behind a disc) is split into the two shapes: the one in front replaces the merged outline,
   * and the one behind is drawn as its own complete shape underneath.
   */
  const splitOverlap = (loop: Point[], siblings: Point[][], label: number) => {
    const dc: CirclePolygon | null = decomposeCirclePolygon(loop)
    if (!dc) return null
    const { circle: c, polygon: poly } = dc
    const layerRank = rank[label]
    const xs = poly.map((p) => p[0]).concat([c.cx - c.r, c.cx + c.r])
    const ys = poly.map((p) => p[1]).concat([c.cy - c.r, c.cy + c.r])
    const box = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] as const
    const inC = (p: Point) => insideCircle(p, c)
    const inP = (p: Point) => insidePolygon(p, poly)
    const onlyC = majority(...box, (p) => inC(p) && !inP(p), layerRank)
    const onlyP = majority(...box, (p) => inP(p) && !inC(p), layerRank)
    const both = majority(...box, (p) => inC(p) && inP(p), layerRank)
    if (onlyC < 0 || onlyP < 0 || onlyC === onlyP) return null
    const circleIsThis = onlyC === label
    if (!circleIsThis && onlyP !== label) return null
    const other = circleIsThis ? onlyP : onlyC
    if (rank[other] <= layerRank) return null
    // Fragments touch the front shape's edge, where blur puts points a fraction across it.
    const nearC = (p: Point) => Math.hypot(p[0] - c.cx, p[1] - c.cy) < c.r + 1.5
    const insetC = (p: Point) => Math.hypot(p[0] - c.cx, p[1] - c.cy) < c.r - 1.5
    const nearP = (p: Point) => inP(p) || poly.some((q, i) => segDist(p, q, poly[(i + 1) % poly.length]) < 1.5)
    const insetP = (p: Point) => inP(p) && poly.every((q, i) => segDist(p, q, poly[(i + 1) % poly.length]) >= 1.5)
    const near = (f: (p: Point) => boolean, p: Point) => (f === inC ? nearC(p) : nearP(p))
    const inset = (f: (p: Point) => boolean, p: Point) => (f === inC ? insetC(p) : insetP(p))
    const thisInside = circleIsThis ? inC : inP
    const otherInside = circleIsThis ? inP : inC
    // Holes in the merged outline must still be holes in the shape that replaces it.
    for (const s of siblings) if (s !== loop && insidePolygon(s[0], loop) && !sampleOf(s).every(thisInside)) return null
    const thisPath = circleIsThis ? circlePath(c, opts.precision) : polygonPath(poly, opts.precision)
    const otherPath = circleIsThis ? polygonPath(poly, opts.precision) : circlePath(c, opts.precision)
    const thisInFront = both === label
    // Holes in this layer used to show the layers below it. With the other shape now inserted
    // underneath, refill each hole with the color that showed through it (e.g. cream lettering
    // on a disc), so nothing changes color.
    const refills: TracedLayer[] = []
    if (thisInFront) {
      const inner = siblings.filter((s) => s !== loop && insidePolygon(s[0], loop))
      for (const s of inner) {
        // Outlines nested an odd number of levels deep (an island inside a hole, like the
        // counter of a "B") belong to this layer and are drawn by it; only holes need refilling.
        const depth = inner.filter((o) => o !== s && insidePolygon(s[0], o)).length
        if (depth % 2 === 1) continue
        const xs = s.map((p) => p[0])
        const ys = s.map((p) => p[1])
        const under = majorityBelow(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys), (p) => insidePolygon(p, s), layerRank)
        if (under < 0) return null
        const d = toPath(fitClosed(s, { error: opts.error, cornerAngle: opts.cornerAngle }), fmt)
        const same = refills.find((r) => r.color === colors[under])
        if (same) same.d += d
        else refills.push({ color: colors[under], d, fill: fillOf(under) })
      }
    }
    return {
      d: thisPath,
      star: dc.star,
      // The other shape goes underneath, complete. If it's in front instead, its own layer
      // (drawn later) already shows it whole, so only the outline needs replacing.
      below: thisInFront ? [{ color: colors[other], d: otherPath, fill: fillOf(other) }, ...refills] : [],
      suppress: thisInFront ? { label: other, covers: (p: Point) => near(otherInside, p) && !inset(thisInside, p) } : null,
    }
  }

  for (let layer = 0; layer < order.length; layer++) {
    const inLayer = (r: number) => (knockout ? r === layer : r >= layer)
    // The layer's bounds, so smoothing skips the area it doesn't cover.
    let bx0 = w, by0 = h, bx1 = -1, by1 = -1
    for (let p = 0; p < n; p++) {
      const r1 = rank[labels[p]]
      const r2 = second[p] < NO_SHAPE ? rank[second[p]] : -1
      let m = 0
      if (inLayer(r1)) m += cov[p]
      if (inLayer(r2)) m += 1 - cov[p]
      field[p] = m
      if (m !== 0) {
        const x = p % w
        const y = (p / w) | 0
        if (x < bx0) bx0 = x
        if (x > bx1) bx1 = x
        if (y < by0) by0 = y
        if (y > by1) by1 = y
      }
    }
    // Fine detail applies to colours that stand out from what they border (lines, lettering,
    // small marks), not to bands between similar colours (shading, compression edges).
    const detailLayer = !!(opts.crossSection || opts.straightRuns) && contrasting(map, order[layer])
    const blurred = blur(field, w, h, opts.smoothing, [bx0, by0, bx1, by1])
    const isOwn = (p: number) => labels[p] < 254 && inLayer(rank[labels[p]])
    const outlines = (thin: boolean) => {
      const all = contours(keepThin(blurred, w, h, level, opts.smoothing, thin ? field : undefined), w, h, level).filter((l) => Math.abs(area(l)) >= opts.minArea)
      return all.filter((l) => Math.abs(area(l)) >= (opts.detailArea ?? opts.minArea) || realDetail(l, all, w, h, isOwn))
    }
    let loops = outlines(!!opts.crossSection && detailLayer)
    // Outlines traced and fitted the ordinary way (no fine detail).
    const ordinary = new Set<Point[]>()
    if (opts.crossSection && detailLayer) {
      // Fine detail never adds a crossing: an outline it traced that crosses itself even fitted
      // closely is replaced by the ordinary outlines in its place, fitted the ordinary way.
      const crossing = loops.filter((l) => crossesItself(fitLoop(l, fitOptions(l, opts), opts)))
      if (crossing.length) {
        const plain = outlines(false)
        const boxes = crossing.map((l) => bounds(l))
        const within = (l: Point[]) => {
          const b = bounds(l)
          return boxes.some((c) => b[0] >= c[0] - 1 && b[1] >= c[1] - 1 && b[2] <= c[2] + 1 && b[3] <= c[3] + 1)
        }
        const swap = plain.filter(within)
        for (const l of swap) ordinary.add(l)
        loops = [...loops.filter((l) => !crossing.includes(l)), ...swap]
      }
    }
    if (!knockout && opts.connectedStacking)
      loops = withoutHiddenCopies(loops, w, h, (p) => rank[labels[p]] === layer || (second[p] < NO_SHAPE && rank[second[p]] === layer && cov[p] < 0.5))
    if (!loops.length) continue
    const label = order[layer]
    // Drop fragments of this color that a split shape below already draws in full.
    const kept = loops.filter((l) => !suppressed.some((s) => s.label === label && mostly(sampleOf(l), s.covers)))
    const below: TracedLayer[] = []
    const parts = kept.map((loop) => {
      // The full-image background is a plain rectangle; write it exactly but don't count it.
      if (opts.exactShapes && coversImage(loop, w, h)) return `M0 0L${w} 0L${w} ${h}L0 ${h}Z`
      const exact = opts.exactShapes ? detectShape(loop, { cornerAngle: opts.cornerAngle, precision: opts.precision, smoothing: opts.smoothing }) : null
      // An irregular "polygon" may really be a star and a circle whose short arcs passed as
      // straight edges; prefer the split when it explains the outline.
      if (exact && exact.kind !== 'polygon') {
        shapes[exact.kind]++
        return exact.d
      }
      // Splitting rebuilds hidden parts and refills holes with flat colors; not for gradients.
      if (opts.exactShapes && !knockout && !fillOf(label)) {
        const split = splitOverlap(loop, kept, label)
        if (split) {
          below.push(...split.below)
          if (split.suppress) suppressed.push(split.suppress)
          shapes.circle++
          shapes[split.star ? 'star' : 'polygon']++
          shapes.overlaps++
          return split.d
        }
      }
      if (exact) {
        shapes[exact.kind]++
        return exact.d
      }
      return toPath(fitLoop(loop, detailLayer && !ordinary.has(loop) ? fitOptions(loop, opts) : null, opts), fmt)
    })
    const d = parts.join('')
    layers.push(...below.filter((b) => b.d && b.color >= 0))
    if (d) layers.push({ color: colors[label], d, shapes: groupShapes(kept, parts), fill: fillOf(label) })
  }
  return { svg: layersToSvg(layers, w, h), paths: layers.length, layers, shapes }
}

/**
 * Stacked output: the outlines of a layer without the shapes that hold none of its own pixels. In
 * a stacked layer, an outline whose area (inside it, outside its holes) is all higher layers is a
 * hidden copy of shapes those layers draw in full (separate lettering, a counter inside a letter):
 * it is dropped with its holes. Islands inside those holes are kept, still filled.
 */
function withoutHiddenCopies(loops: Point[][], w: number, h: number, own: (p: number) => boolean): Point[][] {
  const depth = loops.map((l, i) => loops.reduce((d, o, j) => (j !== i && insideLoop(l[0], o) ? d + 1 : d), 0))
  const dropped = new Set<number>()
  loops.forEach((loop, i) => {
    if (depth[i] % 2 === 1) return
    const holes = loops.filter((l, j) => depth[j] === depth[i] + 1 && insideLoop(l[0], loop))
    if (regionHas([loop, ...holes], w, h, own)) return
    dropped.add(i)
    for (const hole of holes) dropped.add(loops.indexOf(hole))
  })
  return dropped.size ? loops.filter((_, i) => !dropped.has(i)) : loops
}

/** Whether any pixel whose centre is inside the rings (even-odd) satisfies `test`. */
function regionHas(rings: Point[][], w: number, h: number, test: (p: number) => boolean): boolean {
  const [, y0, , y1] = bounds(rings[0])
  for (let y = Math.max(0, Math.floor(y0)); y <= Math.min(h - 1, Math.ceil(y1)); y++) {
    const cy = y + 0.5
    const xs: number[] = []
    for (const r of rings)
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        const [ax, ay] = r[j]
        const [bx, by] = r[i]
        if (ay <= cy !== by <= cy) xs.push(ax + ((cy - ay) * (bx - ax)) / (by - ay))
      }
    xs.sort((a, b) => a - b)
    for (let k = 0; k + 1 < xs.length; k += 2)
      for (let x = Math.max(0, Math.ceil(xs[k] - 0.5)); x <= Math.min(w - 1, Math.floor(xs[k + 1] - 0.5)); x++) if (test(y * w + x)) return true
  }
  return false
}

/**
 * Curve fitting for one outline on a detail layer: a thin outline (thickness, twice its area over
 * its perimeter, up to THIN_OUTLINE) has its straight stretches drawn as lines (straightRuns).
 */
function fitOptions(loop: Point[], opts: TraceOptions): { error: number; cornerAngle: number; straightRuns?: boolean } {
  const base = { error: opts.error, cornerAngle: opts.cornerAngle }
  if (!opts.straightRuns) return base
  let per = 0
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) per += Math.hypot(loop[i][0] - loop[j][0], loop[i][1] - loop[j][1])
  const thickness = per ? (2 * Math.abs(area(loop))) / per : Infinity
  return thickness > THIN_OUTLINE ? base : { ...base, straightRuns: true }
}
/** Outlines up to this thick (px) are thin (see fitOptions). */
const THIN_OUTLINE = 3
/** The tightest curve tolerance a refit uses (px). */
const MIN_FIT_ERROR = 0.04

/**
 * Fits one outline, with the fine-detail options when given (detail layers). A detail outline whose
 * fit crosses itself (a thin part's two sides drawn across each other) is fitted again, closer to
 * its contour; the closer fit is kept when it doesn't cross.
 */
function fitLoop(loop: Point[], fine: ReturnType<typeof fitOptions> | null, opts: TraceOptions): Cubic[] {
  const curves = fitClosed(loop, fine ?? { error: opts.error, cornerAngle: opts.cornerAngle })
  if (!fine || !crossesItself(curves)) return curves
  const closer = fitClosed(loop, { ...fine, error: Math.max(MIN_FIT_ERROR, fine.error / 3) })
  return crossesItself(closer) ? curves : closer
}

/** Whether a closed path of cubics crosses itself (flattened, CROSS_PIECES pieces per curve). */
function crossesItself(curves: Cubic[]): boolean {
  const pts: Point[] = []
  for (const [a, b, c, d] of curves)
    for (let i = 0; i < CROSS_PIECES; i++) {
      const t = i / CROSS_PIECES
      const u = 1 - t
      pts.push([u * u * u * a[0] + 3 * u * u * t * b[0] + 3 * u * t * t * c[0] + t * t * t * d[0], u * u * u * a[1] + 3 * u * u * t * b[1] + 3 * u * t * t * c[1] + t * t * t * d[1]])
    }
  const n = pts.length
  const cross = (p: Point, q: Point, r: Point, s: Point) => {
    const d = (q[0] - p[0]) * (s[1] - r[1]) - (q[1] - p[1]) * (s[0] - r[0])
    if (d === 0) return false
    const t = ((r[0] - p[0]) * (s[1] - r[1]) - (r[1] - p[1]) * (s[0] - r[0])) / d
    const u = ((r[0] - p[0]) * (q[1] - p[1]) - (r[1] - p[1]) * (q[0] - p[0])) / d
    return t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9
  }
  for (let i = 0; i < n; i++)
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue
      if (cross(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n])) return true
    }
  return false
}

/**
 * Whether a label's colour clearly differs from the colours it borders: at least CONTRAST_SHARE of
 * its 4-neighbour boundary pixels against other colours are against one at least DETAIL_CONTRAST
 * away (sRGB). Lettering on a band qualifies; a band of shading, or a ring of blended edge colour
 * around a shape, doesn't. A colour bordering only empty canvas does.
 */
function contrasting(map: LabelMap, label: number): boolean {
  const { w, h, labels, colors } = map
  const rgb = (v: number) => [(v >> 16) & 255, (v >> 8) & 255, v & 255]
  const own = rgb(colors[label])
  let edges = 0
  let strong = 0
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = y * w + x
      if (labels[p] !== label) continue
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]) {
        if (q < 0 || labels[q] === label) continue
        // Only colours count: a blend ring between a shape and empty canvas borders the shape
        // (barely different) and nothing else that has a colour.
        if (labels[q] >= NO_SHAPE || colors[labels[q]] < 0) continue
        edges++
        const o = rgb(colors[labels[q]])
        if (Math.hypot(own[0] - o[0], own[1] - o[1], own[2] - o[2]) >= DETAIL_CONTRAST) strong++
      }
    }
  // A colour that borders only empty canvas (a line on a transparent background) stands out.
  return edges === 0 || strong >= CONTRAST_SHARE * edges
}
const DETAIL_CONTRAST = 64
const CONTRAST_SHARE = 0.5
const CROSS_PIECES = 16

function segDist(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len2 = dx * dx + dy * dy
  const t = len2 ? Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)
}

/**
 * Splits a layer's outlines into separate shapes: each outer outline plus the holes directly
 * inside it. Islands inside holes (the counter of a "B") become shapes of their own. Nesting
 * depth comes from containment between the traced outlines.
 */
function groupShapes(loops: Point[][], paths: string[]): string[] {
  const n = loops.length
  const boxes = loops.map((l) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const [x, y] of l) {
      if (x < x0) x0 = x
      if (y < y0) y0 = y
      if (x > x1) x1 = x
      if (y > y1) y1 = y
    }
    return [x0, y0, x1, y1]
  })
  const contains = (o: number, i: number) => {
    const [x, y] = loops[i][0]
    const b = boxes[o]
    return o !== i && x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3] && insidePolygon(loops[i][0], loops[o])
  }
  const parents = loops.map((_, i) => {
    // The immediate parent is the smallest outline containing this one.
    let best = -1
    let bestArea = Infinity
    for (let o = 0; o < n; o++) {
      if (!contains(o, i)) continue
      const a = Math.abs(area(loops[o]))
      if (a < bestArea) [best, bestArea] = [o, a]
    }
    return best
  })
  const depth = (i: number): number => (parents[i] < 0 ? 0 : 1 + depth(parents[i]))
  const shapes: string[] = []
  for (let i = 0; i < n; i++) {
    if (depth(i) % 2 === 1 || !paths[i]) continue
    let d = paths[i]
    for (let j = 0; j < n; j++) if (parents[j] === i && paths[j]) d += paths[j]
    shapes.push(d)
  }
  return shapes
}

/** True when at least 90% of the points pass (tolerates JPEG noise along an edge). */
function mostly(pts: Point[], test: (p: Point) => boolean): boolean {
  let n = 0
  for (const p of pts) if (test(p)) n++
  return n >= pts.length * 0.9
}

/** A few points spread around a contour, for containment tests. */
function sampleOf(loop: Point[]): Point[] {
  const step = Math.max(1, Math.floor(loop.length / 24))
  const out: Point[] = []
  for (let i = 0; i < loop.length; i += step) out.push(loop[i])
  return out
}

/** True when a contour runs along the whole image border (a background layer). */
function coversImage(loop: Point[], w: number, h: number): boolean {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const [x, y] of loop) {
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  if (minX > 0.5 || minY > 0.5 || maxX < w - 0.5 || maxY < h - 0.5) return false
  // Every point must sit on the border, so a shape merely touching all four edges doesn't count.
  return loop.every(([x, y]) => x < 0.5 || y < 0.5 || x > w - 0.5 || y > h - 0.5)
}

export const hex6 = (c: number) => '#' + c.toString(16).padStart(6, '0').toUpperCase()

/**
 * Writes one group per layer, tagged with its color, holding one path per shape. Consecutive
 * layers of the same color share a group. Every path keeps its own fill, so the file works
 * everywhere and the PDF/DXF readers don't depend on group styling. Gradient layers get a
 * named group of their own ("Gradient_1") filled from a <linearGradient>/<radialGradient>.
 */
export function layersToSvg(layers: TracedLayer[], w: number, h: number): string {
  const parts: string[] = []
  const defs: string[] = []
  const gradientIds = new Map<GradientFill, number>()
  const pathCount = new Map<number, number>()
  const textNames = new Map<string, number>()
  let open: string | null = null
  for (const l of layers) {
    let key: string
    let fill: string
    let groupTag: string
    let gradient = 0
    if (l.text) {
      const slug = l.text.word.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'Text'
      const n = (textNames.get(slug) ?? 0) + 1
      textNames.set(slug, n)
      if (open !== null) parts.push('</g>')
      open = null
      const fillHex = hex6(l.color)
      parts.push(`<g id="Text_${slug}${n > 1 ? `_${n}` : ''}" data-text="${escapeAttr(l.text.word)}" data-font="${escapeAttr(l.text.font)}" data-color="${fillHex}">`)
      ;(l.shapes ?? []).forEach((d, i) => {
        const ch = l.text!.letters[i] ?? ''
        const id = /[A-Za-z0-9]/.test(ch) ? ch : `${i + 1}`
        if (d) parts.push(`<path id="Text_${slug}${n > 1 ? `_${n}` : ''}_${i + 1}_${id}" d="${d}" fill="${fillHex}"/>`)
      })
      parts.push('</g>')
      continue
    }
    if (l.fill) {
      let k = gradientIds.get(l.fill)
      if (k === undefined) {
        k = gradientIds.size + 1
        gradientIds.set(l.fill, k)
        defs.push(gradientSvg(`gradient-${k}`, l.fill))
      }
      gradient = k
      key = `gradient-${k}`
      fill = `url(#gradient-${k})`
      groupTag = `<g id="Gradient_${k}" data-gradient="gradient-${k}">`
    } else {
      key = hex6(l.color)
      fill = key
      groupTag = `<g data-color="${key}">`
    }
    if (key !== open) {
      if (open !== null) parts.push('</g>')
      parts.push(groupTag)
      open = key
    }
    for (const d of l.shapes?.length ? l.shapes : [l.d]) {
      if (!d) continue
      let id = ''
      if (gradient) {
        const i = (pathCount.get(gradient) ?? 0) + 1
        pathCount.set(gradient, i)
        id = ` id="Gradient_${gradient}_${i}"`
      }
      parts.push(`<path${id} d="${d}" fill="${fill}" fill-rule="evenodd"/>`)
    }
  }
  if (open !== null) parts.push('</g>')
  const defsBlock = defs.length ? `<defs>\n${defs.join('\n')}\n</defs>\n` : ''
  return `<svg version="1.1" xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">\n${defsBlock}${parts.join('\n')}\n</svg>`
}

const escapeAttr = (v: string) => v.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`)

function toPath(curves: Cubic[], fmt: (v: number) => number): string {
  if (!curves.length) return ''
  const p = (pt: Point) => `${fmt(pt[0])} ${fmt(pt[1])}`
  let d = `M${p(curves[0][0])}`
  for (const c of curves) d += `C${p(c[1])} ${p(c[2])} ${p(c[3])}`
  return d + 'Z'
}

/**
 * Whether a small outline holds real pixels: an island must contain a pixel whose own colour is
 * in this layer, a hole (inside an odd number of the layer's other outlines) one whose isn't.
 */
function realDetail(loop: Point[], all: Point[][], w: number, h: number, isOwn: (p: number) => boolean): boolean {
  let depth = 0
  const [px, py] = loop[0]
  for (const other of all) {
    if (other === loop) continue
    // A point outside a loop's bounds can't be inside it; skip the full test.
    const [ox0, oy0, ox1, oy1] = bounds(other)
    if (px < ox0 || px > ox1 || py < oy0 || py > oy1) continue
    if (insideLoop(loop[0], other)) depth++
  }
  const hole = depth % 2 === 1
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const [x, y] of loop) {
    if (x < x0) x0 = x
    if (y < y0) y0 = y
    if (x > x1) x1 = x
    if (y > y1) y1 = y
  }
  // Pixel (x, y) has its centre at (x + 0.5, y + 0.5).
  for (let y = Math.max(0, Math.ceil(y0 - 0.5)); y <= Math.min(h - 1, Math.floor(y1 - 0.5)); y++)
    for (let x = Math.max(0, Math.ceil(x0 - 0.5)); x <= Math.min(w - 1, Math.floor(x1 - 0.5)); x++)
      if (insideLoop([x + 0.5, y + 0.5], loop) && isOwn(y * w + x) !== hole) return true
  return false
}

const boundsCache = new WeakMap<Point[], [number, number, number, number]>()
/** A loop's bounding box [x0, y0, x1, y1], computed once. */
function bounds(loop: Point[]): [number, number, number, number] {
  let b = boundsCache.get(loop)
  if (!b) {
    b = [Infinity, Infinity, -Infinity, -Infinity]
    for (const [x, y] of loop) {
      if (x < b[0]) b[0] = x
      if (y < b[1]) b[1] = y
      if (x > b[2]) b[2] = x
      if (y > b[3]) b[3] = y
    }
    boundsCache.set(loop, b)
  }
  return b
}

/** Even-odd point-in-polygon test. */
function insideLoop([px, py]: Point, poly: Point[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]
    const [xj, yj] = poly[j]
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/**
 * Smoothing lowers features narrower than the blur: a 1 px stroke peaks below 0.5 and would
 * vanish at the usual contour level. For a stroke of width a, blurred to a peak P, the level that
 * outlines it at width a is ½·erf(2·erfinv(P)), whatever the blur. So near a thin ridge (local
 * peak P < 1) the field is shifted to put that level where `level` is; thin gaps (local minimum
 * above 0) get the mirror-image shift. Wide shapes have P ≈ 1 and stay exactly as they were.
 * Ridges weaker than THIN_MIN are left alone, so faint smudges don't become lines, and so are
 * ridges without clean ground around them (within THIN_GROUND of 0, or of 1 for gaps).
 */
function keepThin(s: Float32Array, w: number, h: number, level: number, sigma: number, raw?: Float32Array): Float32Array {
  // Fine detail: strokes measured across themselves (see TraceOptions.crossSection); `raw` is the
  // field before blurring, to tell a real stroke (with a solid core) from edge-blend residue.
  const crossSection = !!raw
  const r = Math.max(2, Math.round(2 * sigma + 0.5))
  const out = new Float32Array(s)
  const scale = level / 0.5
  // Bilinear sample of the field.
  const at = (fx: number, fy: number) => {
    const x0 = Math.max(0, Math.min(w - 1, Math.floor(fx)))
    const y0 = Math.max(0, Math.min(h - 1, Math.floor(fy)))
    const x1 = Math.min(w - 1, x0 + 1)
    const y1 = Math.min(h - 1, y0 + 1)
    const tx = Math.max(0, Math.min(1, fx - x0))
    const ty = Math.max(0, Math.min(1, fy - y0))
    return (s[y0 * w + x0] * (1 - tx) + s[y0 * w + x1] * tx) * (1 - ty) + (s[y1 * w + x0] * (1 - tx) + s[y1 * w + x1] * tx) * ty
  }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = y * w + x
      // Contours only pass where the field is between its extremes; elsewhere nothing changes.
      if (s[p] <= 0.02 || s[p] >= 0.98) continue
      let P = 0
      let low = 1
      const gx = crossSection ? s[y * w + Math.min(w - 1, x + 1)] - s[y * w + Math.max(0, x - 1)] : 0
      const gy = crossSection ? s[Math.min(h - 1, y + 1) * w + x] - s[Math.max(0, y - 1) * w + x] : 0
      let g = Math.hypot(gx, gy)
      let nx = g > 1e-4 ? gx / g : 0
      let ny = g > 1e-4 ? gy / g : 0
      if (crossSection && g <= 1e-4) {
        // On a stroke's ridge the gradient vanishes: go across the axis that curves most.
        const d2x = Math.abs(s[y * w + Math.min(w - 1, x + 1)] + s[y * w + Math.max(0, x - 1)] - 2 * s[p])
        const d2y = Math.abs(s[Math.min(h - 1, y + 1) * w + x] + s[Math.max(0, y - 1) * w + x] - 2 * s[p])
        if (d2x + d2y > 1e-4) [nx, ny, g] = d2x >= d2y ? [1, 0, 1] : [0, 1, 1]
      }
      if (crossSection && g > 1e-4) {
        // Fine detail overrides the rule below only where it recognises a real thin stroke or gap.
        const fine = acrossStroke(s, raw!, at, w, h, x, y, nx, ny, r, sigma, level, scale)
        if (fine !== null) {
          out[p] = fine
          continue
        }
      }
      for (let j = Math.max(0, y - r); j <= Math.min(h - 1, y + r); j++)
        for (let i = Math.max(0, x - r); i <= Math.min(w - 1, x + r); i++) {
          const v = s[j * w + i]
          if (v > P) P = v
          if (v < low) low = v
        }
      const V = 1 - low
      // A real stroke stands on clean ground on both sides (a gap between solid areas); a low,
      // wide plateau of partial coverage, as JPEG noise between similar colours leaves, doesn't.
      if (P >= THIN_MIN && P < THIN_MAX && low <= THIN_GROUND) out[p] = s[p] + level - scale * widthLevel(P)
      else if (V >= THIN_MIN && V < THIN_MAX && P >= 1 - THIN_GROUND) out[p] = s[p] + scale * widthLevel(V) - level
    }
  return out
}

/**
 * Fine detail: the field value at (x, y) that keeps a real thin stroke (or gap) through it its true
 * width and length, measured across it along (nx, ny); null where it isn't one (the edge of a solid
 * shape, edge-blend residue without a solid core, a profile that runs on), for the ordinary rule.
 */
function acrossStroke(s: Float32Array, raw: Float32Array, at: (x: number, y: number) => number, w: number, h: number, x: number, y: number, nx: number, ny: number, r: number, sigma: number, level: number, scale: number): number | null {
  const p = y * w + x
  let P = 0
  let low = 1
  for (let t = -r; t <= r; t += 0.5) {
    const v = at(x + nx * t, y + ny * t)
    if (v > P) P = v
    if (v < low) low = v
  }
  const V = 1 - low
  // Solid colour (or clear ground, for a gap) anywhere along the gradient within reach: the edge
  // of a solid shape, whatever ripples a resampled edge has before it.
  const reach = 4 * Math.sqrt(sigma * sigma + 1 / 12) + 3
  let far = 0
  let farLow = 1
  for (let t = -reach; t <= reach; t += 0.5) {
    const v = at(x + nx * t, y + ny * t)
    if (v > far) far = v
    if (v < farLow) farLow = v
  }
  if (P >= THIN_MIN && P < THIN_MAX && low <= THIN_GROUND) {
    if (far >= THIN_MAX) return null
    // A real stroke has a solid core somewhere across it; a sliver of pixels that are only partly
    // this colour (blend residue where two other colours meet) doesn't.
    let core = 0
    for (let t = -r; t <= r; t += 0.5) {
      const qx = Math.round(x + nx * t)
      const qy = Math.round(y + ny * t)
      if (qx >= 0 && qy >= 0 && qx < w && qy < h) core = Math.max(core, raw[qy * w + qx])
    }
    if (core < SOLID_CORE) return null
    // Along the gradient: the stroke's width, or, at a line's end (where the gradient runs along
    // the stroke and its profile doesn't fall away), the end itself, which a blurred line reaches
    // at half the field it has along its middle.
    const across = hump(at, x, y, nx, ny, sigma, false)
    if (across.peak >= THIN_MAX) return null
    let L = across.level
    if (across.open) {
      // Only a line's end: the profile across the line here (perpendicular to the gradient) is
      // itself a whole thin stroke standing on clean ground.
      const line = hump(at, x, y, -ny, nx, sigma, false)
      if (line.open || line.peak < THIN_MIN || line.peak >= THIN_MAX || line.ground > THIN_GROUND) return null
      L = Math.min(L, line.peak / 2)
    }
    return s[p] + level - scale * L
  }
  if (V >= THIN_MIN && V < THIN_MAX && P >= 1 - THIN_GROUND) {
    if (farLow <= 1 - THIN_MAX) return null
    const gap = hump(at, x, y, nx, ny, sigma, true)
    return gap.peak < THIN_MAX && !gap.open ? s[p] + scale * gap.level - level : null
  }
  return null
}

const THIN_MIN = 0.25
const THIN_MAX = 0.97
/** A stroke's core coverage before blurring, at least, for it to count as a real stroke. */
const SOLID_CORE = 0.75
const THIN_GROUND = 0.05

/** ½·erf(2·erfinv(P)), tabulated: the contour level that keeps a blurred stroke's true width. */
const WIDTH_LEVEL = (() => {
  const erf = (x: number) => {
    // Abramowitz & Stegun 7.1.26 (|error| < 1.5e-7).
    const t = 1 / (1 + 0.3275911 * Math.abs(x))
    const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x)
    return x < 0 ? -y : y
  }
  const erfinv = (v: number) => {
    let x = 0
    for (let i = 0; i < 40; i++) x -= (erf(x) - v) / ((2 / Math.sqrt(Math.PI)) * Math.exp(-x * x))
    return x
  }
  return Float32Array.from({ length: 1001 }, (_, i) => (i === 1000 ? 0.5 : 0.5 * erf(2 * erfinv(i / 1000))))
})()
const widthLevel = (P: number) => WIDTH_LEVEL[Math.round(Math.min(1, Math.max(0, P)) * 1000)]

/**
 * The contour level that keeps the stroke (or, `gap`, the gap) through (x, y) its true width. Its
 * width is the total of the field over its profile across direction (nx, ny), which blurring keeps
 * equal to the width, whether the stroke lies on one pixel or is split across two; the level is the
 * one at which the profile is exactly that wide. The profile runs out both ways from its peak until
 * the field (1 − field for a gap) has run out or starts rising into a neighbour.
 */
function hump(at: (x: number, y: number) => number, x: number, y: number, nx: number, ny: number, sigma: number, gap: boolean): { level: number; open: boolean; peak: number; ground: number } {
  const f = (t: number) => (gap ? 1 - at(x + nx * t, y + ny * t) : at(x + nx * t, y + ny * t))
  const step = 0.125
  const reach = 4 * Math.sqrt(sigma * sigma + 1 / 12) + 3
  let c = 0
  const dir = f(step) >= f(-step) ? 1 : -1
  while (Math.abs(c) < reach && f(c + dir * step) >= f(c)) c += dir * step
  const profile = [f(c)]
  // Open: the profile is still high where the walk gives up (it runs along a stroke, not across).
  let open = Math.abs(c) >= reach
  for (const d of [1, -1]) {
    let prev = f(c)
    let t = c + d * step
    for (; Math.abs(t - c) <= reach; t += d * step) {
      const v = f(t)
      if (v <= 0.005 || v > prev + 1e-4) break
      if (d > 0) profile.push(v)
      else profile.unshift(v)
      prev = v
    }
    if (Math.abs(t - c) > reach && prev > 0.5 * profile.reduce((m, v) => Math.max(m, v), 0)) open = true
  }
  const width = profile.reduce((t, v) => t + v, 0) * step
  // Width of the profile above a level (it rises then falls).
  const above = (L: number) => profile.reduce((t, v) => t + (v >= L ? step : 0), 0)
  let lo = 0
  let hi = Math.max(...profile)
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2
    if (above(mid) > width) lo = mid
    else hi = mid
  }
  // Just under the peak at most: a flat-topped profile exactly as wide as the stroke would
  // otherwise put the contour on its top, where it barely forms.
  const peak = Math.max(...profile)
  return { level: Math.min(0.5, 0.98 * peak, (lo + hi) / 2), open, peak, ground: Math.max(profile[0], profile[profile.length - 1]) }
}

/**
 * Separable Gaussian blur; edges clamp. sigma ≤ 0 returns the input. `box` ([x0, y0, x1, y1],
 * inclusive) bounds the non-zero part of `src`: everything farther than the blur radius from it
 * stays 0, so only that area is computed (same values, in the same order, as without it).
 */
export function blur(src: Float32Array, w: number, h: number, sigma: number, box: [number, number, number, number] = [0, 0, w - 1, h - 1]): Float32Array {
  if (sigma <= 0) return src
  const r = Math.max(1, Math.ceil(sigma * 2.5))
  const k = new Float32Array(2 * r + 1)
  let sum = 0
  for (let i = -r; i <= r; i++) sum += k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma))
  for (let i = 0; i < k.length; i++) k[i] /= sum
  const out = new Float32Array(w * h)
  const [bx0, by0, bx1, by1] = box
  if (bx1 < bx0 || by1 < by0) return out
  const x0 = Math.max(0, bx0 - r), x1 = Math.min(w - 1, bx1 + r)
  const y0 = Math.max(0, by0 - r), y1 = Math.min(h - 1, by1 + r)

  // Rows outside the box are all 0 and blur to 0, so the horizontal pass only needs box rows.
  const tmp = new Float32Array(w * h)
  for (let y = by0; y <= by1; y++) {
    const row = y * w
    for (let x = x0; x <= x1; x++) {
      let s = 0
      for (let i = -r; i <= r; i++) s += src[row + Math.min(w - 1, Math.max(0, x + i))] * k[i + r]
      tmp[row + x] = s
    }
  }
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      let s = 0
      for (let i = -r; i <= r; i++) s += tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x] * k[i + r]
      out[y * w + x] = s
    }
  }
  return out
}
