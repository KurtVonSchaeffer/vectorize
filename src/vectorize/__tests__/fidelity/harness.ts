/**
 * Reconstruction-fidelity harness: draws synthetic artwork with known geometry (anti-aliased, as
 * an exported logo would be), runs it through the flat pipeline with the production defaults,
 * and measures the SVG against the geometry it was drawn from, not against itself.
 *
 * The defaults mirror buildTraceJob (vectorize/pipeline.ts) for a flat image at Detail 0.5, so a
 * change there should be repeated here; `productionOptions` is checked against it in
 * fidelity.test.ts through the parameters it shares with traceParamsFor.
 */
import { DEFAULT_CLIENT, detailBoost, traceParamsFor } from '../../client'
import { detectArt } from '../../detect'
import { runFlat, type FlatOptions } from '../../pipeline'
import { flatten as flattenSubpath, shapesFromSvg } from '../../../export/path'
import { colorAt } from '../../../palette/gradients'

export type Point = [number, number]
export type RGB = [number, number, number]

class FakeImageData {
  constructor(
    public data: Uint8ClampedArray,
    public width: number,
    public height: number,
  ) {}
}
export function installImageData() {
  ;(globalThis as unknown as { ImageData: unknown }).ImageData ??= FakeImageData
}

/** A filled outline: one or more closed rings, filled with the nonzero rule (holes wind the other way). */
export interface Shape {
  rings: Point[][]
  color: RGB
}

export const regularStar = (cx: number, cy: number, r: number, points = 5, inner = 0.382, rot = -Math.PI / 2): Point[] =>
  Array.from({ length: points * 2 }, (_, i) => {
    const rr = i % 2 ? r * inner : r
    const a = rot + (i * Math.PI) / points
    return [cx + rr * Math.cos(a), cy + rr * Math.sin(a)] as Point
  })
export const regularPolygon = (cx: number, cy: number, r: number, n: number, rot = -Math.PI / 2): Point[] =>
  Array.from({ length: n }, (_, i) => [cx + r * Math.cos(rot + (2 * Math.PI * i) / n), cy + r * Math.sin(rot + (2 * Math.PI * i) / n)] as Point)
export const circle = (cx: number, cy: number, r: number, reverse = false): Point[] => {
  const pts = regularPolygon(cx, cy, r, 96, 0)
  return reverse ? pts.reverse() : pts
}
export const rect = (x0: number, y0: number, x1: number, y1: number): Point[] => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
]

function winding(rings: Point[][], x: number, y: number): number {
  let wn = 0
  for (const r of rings)
    for (let i = 0; i < r.length; i++) {
      const [x0, y0] = r[i]
      const [x1, y1] = r[(i + 1) % r.length]
      if (y0 <= y ? y1 > y && (x1 - x0) * (y - y0) - (x - x0) * (y1 - y0) > 0 : y1 <= y && (x1 - x0) * (y - y0) - (x - x0) * (y1 - y0) < 0) wn += y0 <= y ? 1 : -1
    }
  return wn
}

/**
 * Paints shapes in order over a background with 4×4 supersampling, like a browser exporting a
 * logo. `alpha` false gives an opaque image (a JPEG or a flattened PNG); `noise` adds a
 * deterministic ±noise per channel, a stand-in for compression ripple.
 */
export function paint(w: number, h: number, bg: RGB | null, shapes: Shape[], noise = 0): ImageData {
  installImageData()
  const d = new Uint8ClampedArray(w * h * 4)
  const S = 4
  let seed = 12345
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0
      for (let sy = 0; sy < S; sy++)
        for (let sx = 0; sx < S; sx++) {
          const px = x + (sx + 0.5) / S
          const py = y + (sy + 0.5) / S
          let c: RGB | null = bg
          for (const s of shapes) if (winding(s.rings, px, py) !== 0) c = s.color
          if (c) {
            r += c[0]; g += c[1]; b += c[2]; a++
          }
        }
      const p = (y * w + x) * 4
      if (a) {
        const n = noise ? rnd() * noise : 0
        d[p] = r / a + n; d[p + 1] = g / a + n; d[p + 2] = b / a + n
      }
      d[p + 3] = Math.round((255 * a) / (S * S))
    }
  return new FakeImageData(d, w, h) as unknown as ImageData
}

/** The flat job's options at the production defaults (see buildTraceJob). */
export function productionOptions(img: ImageData): FlatOptions {
  const det = detectArt(img)
  const trace = traceParamsFor(det.kind, DEFAULT_CLIENT, detailBoost(det, img.width, img.height))
  const speckArea = Math.max(1, trace.filterSpeckle ** 2)
  return {
    lineArt: false,
    removeColors: [],
    transparent: det.hasAlpha || det.kind === 'lineart',
    gradients: 'apply',
    quantize: { maxColors: trace.colors, mergeDelta: trace.colorMerge, whiteIsPaper: false, palette: null, overrides: {}, minArea: Math.round(speckArea), upscale: 1, smoothing: 0, keepBlends: false },
    trace: { smoothing: trace.smoothing, minArea: Math.min(speckArea, 2), detailArea: speckArea, error: trace.curveTolerance, cornerAngle: trace.cornerThreshold, precision: trace.pathPrecision, mode: 'stacked', spread: 0, exactShapes: true },
  }
}

export function vectorize(img: ImageData, tweak: (o: FlatOptions) => FlatOptions = (o) => o) {
  return runFlat(img, tweak(productionOptions(img)))
}

export interface SvgPath {
  fill: string
  rings: Point[][]
}

/** Paths in drawing order, curves flattened (16 steps), in the SVG's own coordinates. */
export function svgPaths(svg: string): SvgPath[] {
  const out: SvgPath[] = []
  for (const m of svg.matchAll(/<path\b([^>]*)>/g)) {
    const attrs = m[1]
    const d = /\sd="([^"]*)"/.exec(attrs)?.[1]
    const fill = /\sfill="([^"]*)"/.exec(attrs)?.[1] ?? '#000000'
    if (!d) continue
    out.push({ fill: fill.toUpperCase(), rings: flatten(d) })
  }
  return out
}

export function flatten(d: string): Point[][] {
  const rings: Point[][] = []
  const tok = d.match(/[MLCZ]|-?\d*\.?\d+(?:e-?\d+)?/gi) ?? []
  let i = 0
  let cur: Point[] = []
  let x = 0, y = 0
  const num = () => parseFloat(tok[i++])
  while (i < tok.length) {
    const c = tok[i++]
    if (c === 'M') {
      if (cur.length) rings.push(cur)
      x = num(); y = num()
      cur = [[x, y]]
    } else if (c === 'L') {
      x = num(); y = num()
      cur.push([x, y])
    } else if (c === 'C') {
      const x1 = num(), y1 = num(), x2 = num(), y2 = num(), x3 = num(), y3 = num()
      for (let k = 1; k <= 16; k++) {
        const t = k / 16, u = 1 - t
        cur.push([u * u * u * x + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3, u * u * u * y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3])
      }
      x = x3; y = y3
    } else if (c === 'Z' || c === 'z') {
      if (cur.length) rings.push(cur)
      cur = []
    } else throw new Error(`Unexpected path command ${c} (the tracer writes absolute M, L, C, Z only)`)
  }
  if (cur.length) rings.push(cur)
  return rings
}

const segDist = (x: number, y: number, a: Point, b: Point) => {
  const dx = b[0] - a[0], dy = b[1] - a[1]
  const L = dx * dx + dy * dy
  const t = L ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / L)) : 0
  return Math.hypot(a[0] + t * dx - x, a[1] + t * dy - y)
}
/** Distance from a point to the nearest outline among `rings`. */
export function distToOutline(p: Point, rings: Point[][]): number {
  let best = Infinity
  for (const r of rings) for (let i = 0; i < r.length; i++) best = Math.min(best, segDist(p[0], p[1], r[i], r[(i + 1) % r.length]))
  return best
}

/** Rings of the paths drawn in a colour (by exact fill). */
export const ringsOf = (paths: SvgPath[], fill: string) => paths.filter((p) => p.fill === fill.toUpperCase()).flatMap((p) => p.rings)

/** Even-odd inside test, as the tracer's paths are filled (fill-rule="evenodd"). */
function insideEvenOdd(rings: Point[][], x: number, y: number): boolean {
  let inside = false
  for (const r of rings)
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i]
      const [xj, yj] = r[j]
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
    }
  return inside
}

/** The colour visible at a point: the last path whose fill covers it (paths are painted in order). */
export function colourAt(paths: SvgPath[], x: number, y: number): string | null {
  let c: string | null = null
  for (const p of paths) if (insideEvenOdd(p.rings, x, y)) c = p.fill
  return c
}

/**
 * Draws an SVG written by the tracer (flat and gradient fills, even-odd) at w×h with 4×4
 * supersampling: a stand-in for the browser's renderer in Node tests. Undrawn areas stay
 * transparent. Path coordinates are scaled from the SVG's viewBox (or width) to w.
 */
export function renderSvg(svg: string, w: number, h: number): ImageData {
  installImageData()
  const vb = svg.match(/<svg\b[^>]*\sviewBox="\s*[-\d.e]+[ ,]+[-\d.e]+[ ,]+([\d.e]+)/i)
  const wAttr = svg.match(/<svg\b[^>]*\swidth="([\d.]+)/i)
  const k = w / (vb ? Number(vb[1]) : wAttr ? Number(wAttr[1]) : w)
  const S = 4
  const W = w * S, H = h * S
  const buf = new Float32Array(W * H * 4)
  for (const shape of shapesFromSvg(svg)) {
    const rings = shape.subpaths.map((sp) => flattenSubpath(sp, 0.05).map(([x, y]) => [x * k * S, y * k * S] as Point))
    for (let sy = 0; sy < H; sy++) {
      const y = sy + 0.5
      const xs: number[] = []
      for (const r of rings)
        for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
          const [xi, yi] = r[i]
          const [xj, yj] = r[j]
          if (yi > y !== yj > y) xs.push(((xj - xi) * (y - yi)) / (yj - yi) + xi)
        }
      xs.sort((a, b) => a - b)
      for (let i = 0; i + 1 < xs.length; i += 2)
        for (let sx = Math.max(0, Math.ceil(xs[i] - 0.5)); sx < Math.min(W, Math.ceil(xs[i + 1] - 0.5)); sx++) {
          const c = shape.gradient ? colorAt(shape.gradient, (sx + 0.5) / S / k, y / S / k) : [(shape.color >> 16) & 255, (shape.color >> 8) & 255, shape.color & 255]
          buf.set([c[0], c[1], c[2], 1], (sy * W + sx) * 4)
        }
    }
  }
  const d = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0
      for (let j = 0; j < S; j++)
        for (let i = 0; i < S; i++) {
          const q = ((y * S + j) * W + x * S + i) * 4
          if (!buf[q + 3]) continue
          r += buf[q]; g += buf[q + 1]; b += buf[q + 2]; a++
        }
      const p = (y * w + x) * 4
      if (a) {
        d[p] = r / a; d[p + 1] = g / a; d[p + 2] = b / a
      }
      d[p + 3] = Math.round((255 * a) / (S * S))
    }
  return new FakeImageData(d, w, h) as unknown as ImageData
}

/** Share (0–1) of sample points inside `rings` that the SVG paints `fill`, and of points outside it that it doesn't. */
export function iou(paths: SvgPath[], fill: string, truth: Point[][], box: [number, number, number, number], step = 0.25): number {
  let inter = 0, union = 0
  for (let y = box[1] + step / 2; y < box[3]; y += step)
    for (let x = box[0] + step / 2; x < box[2]; x += step) {
      const t = winding(truth, x, y) !== 0
      const v = colourAt(paths, x, y) === fill.toUpperCase()
      if (t && v) inter++
      if (t || v) union++
    }
  return union ? inter / union : 1
}

export const area = (r: Point[]) => {
  let a = 0
  for (let i = 0; i < r.length; i++) a += r[i][0] * r[(i + 1) % r.length][1] - r[(i + 1) % r.length][0] * r[i][1]
  return a / 2
}

export function selfIntersects(r: Point[]): boolean {
  const n = r.length
  const o = (p: Point, q: Point, s: Point) => (q[0] - p[0]) * (s[1] - p[1]) - (q[1] - p[1]) * (s[0] - p[0])
  for (let i = 0; i < n; i++)
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue
      const a = r[i], b = r[(i + 1) % n], c = r[j], d = r[(j + 1) % n]
      if (o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0) return true
    }
  return false
}

const box = (r: Point[]) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const [x, y] of r) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y)
  }
  return [x0, y0, x1, y1]
}

/**
 * Outlines drawn more than once: a ring in one path whose area (within 3%) and bounding box
 * (within 1 px) match a ring in another path. Includes the same shape under a different fill,
 * which in a stacked file is an object hidden under its copy.
 */
export function duplicateRings(paths: SvgPath[]): { a: string; b: string; area: number }[] {
  const rings = paths.flatMap((p, k) => p.rings.map((r) => ({ k, fill: p.fill, area: Math.abs(area(r)), box: box(r) })))
  const out: { a: string; b: string; area: number }[] = []
  for (let i = 0; i < rings.length; i++)
    for (let j = i + 1; j < rings.length; j++) {
      const a = rings[i], b = rings[j]
      if (a.k === b.k || a.area < 4) continue
      if (Math.abs(a.area - b.area) <= 0.03 * a.area && a.box.every((v, n) => Math.abs(v - b.box[n]) <= 1)) out.push({ a: a.fill, b: b.fill, area: Math.round(a.area) })
    }
  return out
}

/** Whether the SVG has a path that covers the whole canvas in a near-white colour (a paper plate). */
export function paperPlate(paths: SvgPath[], w: number, h: number): string | null {
  for (const p of paths) {
    const n = parseInt(p.fill.slice(1), 16)
    const light = Math.min((n >> 16) & 255, (n >> 8) & 255, n & 255) >= 235
    if (light && p.rings.some((r) => Math.abs(area(r)) >= 0.97 * w * h)) return p.fill
  }
  return null
}
