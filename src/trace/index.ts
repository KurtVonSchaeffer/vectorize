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
    for (let p = 0; p < n; p++) {
      const r1 = rank[labels[p]]
      const r2 = second[p] < NO_SHAPE ? rank[second[p]] : -1
      let m = 0
      if (inLayer(r1)) m += cov[p]
      if (inLayer(r2)) m += 1 - cov[p]
      field[p] = m
    }
    const smooth = keepThin(blur(field, w, h, opts.smoothing), w, h, level, opts.smoothing)
    const all = contours(smooth, w, h, level).filter((l) => Math.abs(area(l)) >= opts.minArea)
    const isOwn = (p: number) => labels[p] < 254 && inLayer(rank[labels[p]])
    const loops = all.filter((l) => Math.abs(area(l)) >= (opts.detailArea ?? opts.minArea) || realDetail(l, all, w, h, isOwn))
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
      return toPath(fitClosed(loop, { error: opts.error, cornerAngle: opts.cornerAngle }), fmt)
    })
    const d = parts.join('')
    layers.push(...below.filter((b) => b.d && b.color >= 0))
    if (d) layers.push({ color: colors[label], d, shapes: groupShapes(kept, parts), fill: fillOf(label) })
  }
  return { svg: layersToSvg(layers, w, h), paths: layers.length, layers, shapes }
}

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
  for (const other of all) if (other !== loop && insideLoop(loop[0], other)) depth++
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
function keepThin(s: Float32Array, w: number, h: number, level: number, sigma: number): Float32Array {
  const r = Math.max(2, Math.round(2 * sigma + 0.5))
  const out = new Float32Array(s)
  const scale = level / 0.5
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = y * w + x
      // Contours only pass where the field is between its extremes; elsewhere nothing changes.
      if (s[p] <= 0.02 || s[p] >= 0.98) continue
      let P = 0
      let low = 1
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

const THIN_MIN = 0.25
const THIN_MAX = 0.97
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

/** Separable Gaussian blur; edges clamp. sigma ≤ 0 returns the input. */
export function blur(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  if (sigma <= 0) return src
  const r = Math.max(1, Math.ceil(sigma * 2.5))
  const k = new Float32Array(2 * r + 1)
  let sum = 0
  for (let i = -r; i <= r; i++) sum += k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma))
  for (let i = 0; i < k.length; i++) k[i] /= sum

  const tmp = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) {
      let s = 0
      for (let i = -r; i <= r; i++) s += src[row + Math.min(w - 1, Math.max(0, x + i))] * k[i + r]
      tmp[row + x] = s
    }
  }
  const out = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0
      for (let i = -r; i <= r; i++) s += tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x] * k[i + r]
      out[y * w + x] = s
    }
  }
  return out
}
