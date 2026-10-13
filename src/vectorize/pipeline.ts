import { deltaE2000, rgbToLab } from '../palette/color'
import type { Palette } from '../palette/parse'
import { applyBrand, type BrandSettings } from '../palette/brand'
import { colorNames } from '../palette/names'
import { colorAt, findGradients } from '../palette/gradients'
import { blendRatio, nameSvg, quantize, type FixedLabels, type Ink, type InkSettings, type QuantizeOptions } from '../palette/quantize'
import { traceLabels, type LabelMap, type ShapeCounts, type TraceOptions } from '../trace'
import { removeFlatBackground } from './background'
import type { FlatTracer } from './flat-tracer'
import { finalizeSvg, prepareImage, type InputImage } from './image'
import { toEngineConfig, type PrepParams, type TraceParams } from './params'
import type { Tracer } from './tracer'

export interface SpotOptions {
  settings: InkSettings
  palette: Palette
}

/** Everything that decides how one image is traced. */
export interface JobSettings {
  trace: TraceParams
  prep: PrepParams
  spot: SpotOptions | null
  /** Colors the client removed; their areas take the nearest remaining color. */
  removeColors: number[]
  /** Leave the plain background out (transparent). */
  transparent: boolean
  /** Each color covers only its own area (print plates, cut files) instead of stacking. */
  knockout: boolean
  keepBlends?: boolean
  /** Snap circles, ellipses, stars and polygons to exact geometry (flat art). */
  exactShapes?: boolean
  /** Brand colors to snap to or restrict to (flat art). */
  brand?: BrandSettings
  /** Draw gradients as smooth SVG gradients (on screen and web files). */
  gradients?: boolean
}

/** Settings for the flat-color pipeline; plain data so it can be sent to a worker. */
export interface FlatOptions {
  lineArt: boolean
  quantize: QuantizeOptions
  trace: TraceOptions
  removeColors: number[]
  transparent: boolean
  brand?: BrandSettings
  /**
   * 'apply': gradients become smooth SVG gradients. 'report': they're found and counted but
   * traced as flat colors (print plates and cut files can't hold gradients). Unset: not looked for.
   */
  gradients?: 'apply' | 'report'
}

export interface PaletteEntry {
  color: number
  /** Share of the artwork, 0–1. */
  coverage: number
  background: boolean
}

export interface FlatResult {
  svg: string
  inks: Ink[]
  paths: number
  palette: PaletteEntry[]
  /** The plain background color found (shown or not), or null. */
  background: number | null
  blendsRemoved: number
  shapes: ShapeCounts
  /** Colors matched to brand colors, with their names. */
  named: [number, string][]
  /** Gradients found in the artwork, and how many were kept as smooth gradients. */
  gradients: { found: number; kept: number }
}

/**
 * Everything needed to trace one image. Building it is cheap and synchronous (so it can be
 * memoized); running it does the heavy work off the main thread.
 * Flat-color and line-art jobs use our own tracer on a cleaned color map; photos, gradients and
 * pixel art go to VTracer.
 */
export type TraceJob =
  | { kind: 'vtracer'; image: ImageData; params: TraceParams; scale: number; background: number | null }
  | { kind: 'flat'; image: ImageData; options: FlatOptions; scale: number }

export function buildTraceJob(input: InputImage, sourceWidth: number, s: JobSettings): TraceJob {
  const { trace, prep, spot } = s
  const spotOn = !!spot?.settings.enabled
  const lineArt = !spotOn && trace.binary && trace.mode !== 'pixel'
  const flat = spotOn || lineArt || (trace.colors > 0 && trace.mode !== 'pixel')
  if (!flat) {
    const prepared = prepareImage(input, prep, trace.mode === 'pixel')
    let image = prepared.image
    let background: number | null = null
    if (s.transparent) {
      const removed = removeFlatBackground(image, { tolerance: 12, enclosed: false })
      if (removed) image = removed
    }
    background = edgeColor(prepared.image)
    return { kind: 'vtracer', image, params: trace, scale: image.width / sourceWidth, background }
  }

  // Flat colors are clustered and traced at source resolution (capped by max size); edges get
  // sub-pixel accuracy from anti-aliasing instead of from upscaling.
  const base = prepareImage(input, { ...prep, upscaleSmall: false }, false)
  const scale = base.image.width / sourceWidth
  const speckArea = Math.max(1, (trace.filterSpeckle * scale) ** 2)
  return {
    kind: 'flat',
    image: base.image,
    scale,
    options: {
      lineArt,
      removeColors: s.removeColors,
      transparent: s.transparent,
      brand: lineArt || spotOn ? undefined : s.brand,
      gradients: lineArt || spotOn ? undefined : s.gradients && !s.knockout ? 'apply' : 'report',
      quantize: {
        maxColors: lineArt ? 2 : spotOn ? spot!.settings.maxInks : trace.colors,
        mergeDelta: spotOn || lineArt ? 0 : trace.colorMerge,
        whiteIsPaper: spotOn && spot!.settings.whiteIsPaper,
        palette: spotOn ? spot!.palette : null,
        overrides: spotOn ? spot!.settings.overrides : {},
        minArea: Math.round(speckArea),
        upscale: 1,
        smoothing: 0,
        keepBlends: s.keepBlends,
      },
      trace: {
        smoothing: trace.smoothing,
        minArea: speckArea,
        error: trace.curveTolerance,
        cornerAngle: trace.cornerThreshold,
        precision: trace.pathPrecision,
        mode: s.knockout ? 'knockout' : 'stacked',
        spread: s.knockout ? 0.15 : 0,
        exactShapes: s.exactShapes ?? true,
      },
    },
  }
}

/** The flat-color pipeline: quantize, apply the client's color choices, trace. Pure. */
export function runFlat(image: ImageData, o: FlatOptions): FlatResult {
  const src = o.lineArt ? grayscale(image) : image
  const regions = o.gradients && !o.lineArt ? findGradients(src) : []
  const apply = o.gradients === 'apply' && regions.length > 0
  let fixed: FixedLabels | undefined
  if (apply) {
    fixed = { labels: new Int16Array(src.width * src.height).fill(-1), colors: regions.map((r) => r.color) }
    regions.forEach((r, k) => r.pixels.forEach((p) => (fixed!.labels[p] = k)))
  }
  const q = quantize(src, o.quantize, fixed)
  let map = o.lineArt ? inkOnPaper(q.map) : q.map
  const base = map.colors.length - (apply ? regions.length : 0)
  const isGradient = (l: number) => apply && l >= base
  if (apply) {
    map = absorbSlivers({ ...map, fills: map.colors.map((_, l) => (isGradient(l) ? regions[l - base].fill : undefined)) }, isGradient)
    map = gradientEdges(map, src, isGradient)
  }

  // Removing colors and brand matching work on flat colors only; gradients keep theirs.
  const gradientColors = map.colors.slice()
  map = { ...map, colors: map.colors.map((c, l) => (isGradient(l) ? -1 : c)) }
  map = removeColors(map, o.removeColors)
  const branded = o.brand ? applyBrand(map, o.brand, backgroundLabel(map)) : { map, named: new Map<number, string>() }
  map = { ...branded.map, fills: map.fills }
  map = { ...map, colors: map.colors.map((c, l) => (isGradient(l) ? gradientColors[l] : c)) }

  const bgLabel = backgroundLabel(map)
  const background = bgLabel >= 0 ? map.colors[bgLabel] : o.lineArt ? 0xffffff : null
  if (o.lineArt && !o.transparent) {
    // Line art keeps paper out of the shapes; put it back as a white sheet when asked.
    map = { ...map, colors: map.colors.map((c) => (c < 0 ? 0xffffff : c)) }
  } else if (o.transparent && bgLabel >= 0) {
    map = { ...map, colors: map.colors.map((c, i) => (i === bgLabel ? -1 : c)) }
  }
  const { svg, paths, shapes } = traceLabels(map, o.trace)
  const palette = paletteOf(map, bgLabel).filter((e) => !map.fills?.[map.colors.indexOf(e.color)])
  return {
    svg,
    inks: q.inks,
    paths,
    palette,
    background,
    blendsRemoved: q.blendsRemoved,
    shapes,
    named: [...branded.named],
    gradients: { found: regions.length, kept: apply ? regions.length : 0 },
  }
}

export interface TraceResult {
  svg: string
  ms: number
  paths: number
  /** Swatch-matched inks (spot-color mode). */
  inks: Ink[] | null
  /** Colors in the result (flat modes only). */
  palette: PaletteEntry[] | null
  background: number | null
  blendsRemoved: number
  /** Outlines replaced with exact circles, stars, etc. (flat modes only). */
  shapes: ShapeCounts | null
  /** Colors matched to brand colors, with their names. */
  named: [number, string][]
  /** Gradients found, and how many were kept smooth (flat modes only). */
  gradients: { found: number; kept: number }
  /** Size of the coordinate space the SVG paths use. */
  width: number
  height: number
}

export async function runTraceJob(
  tracers: { vtracer: Tracer; flat: FlatTracer | null },
  job: TraceJob,
  original: { width: number; height: number },
  annotate: boolean,
): Promise<TraceResult> {
  const start = performance.now()
  const size = { width: job.image.width, height: job.image.height }
  if (job.kind === 'flat') {
    const res = tracers.flat ? await tracers.flat.run(job.image, job.options) : runFlat(job.image, job.options)
    const finalized = finalizeSvg(res.svg, job.image, original)
    const svg = nameSvg(finalized, inkNames({ palette: res.palette, inks: annotate ? res.inks : [], named: res.named }))
    return { svg, ms: performance.now() - start, paths: res.paths, inks: annotate ? res.inks : null, palette: res.palette, background: res.background, blendsRemoved: res.blendsRemoved, shapes: res.shapes, named: res.named, gradients: res.gradients, ...size }
  }
  const out = await tracers.vtracer.trace(job.image, toEngineConfig(job.params, job.scale))
  const svg = finalizeSvg(out.svg, job.image, original)
  return { svg, ms: out.ms, paths: (svg.match(/<path\b/g) ?? []).length, inks: null, palette: null, background: job.background, blendsRemoved: 0, shapes: null, named: [], gradients: { found: 0, kept: 0 }, ...size }
}

/**
 * Display names for a flat result's colors: swatch/brand names where colors were matched,
 * everyday names ("Navy") otherwise. The app's color chips use the same function.
 */
export function inkNames(res: { palette: PaletteEntry[]; inks: Ink[]; named?: [number, string][] }): Map<number, string> {
  const rgb = (c: [number, number, number]) => (c[0] << 16) | (c[1] << 8) | c[2]
  const named = new Map<number, string>([...res.inks.map((i): [number, string] => [rgb(i.swatch.rgb), i.swatch.name]), ...(res.named ?? [])])
  const generic = colorNames(res.palette.map((p) => p.color))
  return new Map(res.palette.map((p, i) => [p.color, named.get(p.color) ?? generic[i]]))
}

function grayscale(src: ImageData): ImageData {
  const d = new Uint8ClampedArray(src.data)
  for (let i = 0; i < d.length; i += 4) {
    const y = Math.round(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2])
    d[i] = d[i + 1] = d[i + 2] = y
  }
  return new ImageData(d, src.width, src.height)
}

/**
 * Line art: of the (at most two) gray levels found, the darker becomes solid black ink and the
 * lighter becomes paper (no shape). A single level is ink only if it's dark.
 */
function inkOnPaper(map: LabelMap): LabelMap {
  const grays = map.colors.map((c) => c & 255)
  const dark = grays.indexOf(Math.min(...grays))
  const colors = map.colors.map((_, i) => (i === dark && (grays.length > 1 || grays[i] < 128) ? 0x000000 : -1))
  return { ...map, colors }
}

/**
 * Edge pixels between a gradient and its neighbors are mixes that match no real color, so they
 * can form tiny extra colors. A small color whose pixels mostly touch a gradient is such a
 * sliver: its pixels join the gradient (or, away from it, a neighboring real color).
 */
function absorbSlivers(map: LabelMap, isGradient: (l: number) => boolean): LabelMap {
  const { w, h, colors } = map
  const labels = map.labels.slice()
  const n = w * h
  const count = new Float64Array(colors.length)
  const touching = new Float64Array(colors.length)
  const neighbors = (p: number) => {
    const x = p % w
    return [x > 0 ? p - 1 : -1, x + 1 < w ? p + 1 : -1, p >= w ? p - w : -1, p + w < n ? p + w : -1].filter((q) => q >= 0)
  }
  for (let p = 0; p < n; p++) {
    const l = labels[p]
    if (l >= 254) continue
    count[l]++
    if (!isGradient(l) && neighbors(p).some((q) => labels[q] < 254 && isGradient(labels[q]))) touching[l]++
  }
  const sliver = colors.map((_, l) => !isGradient(l) && count[l] > 0 && count[l] < n * 0.015 && touching[l] > count[l] * 0.4)
  if (!sliver.some(Boolean)) return map
  const second = map.second.slice()
  const cov = map.cov.slice()
  // A few passes inward from the sliver's edges; gradients win ties.
  for (let pass = 0; pass < 4; pass++) {
    let changed = 0
    const next = labels.slice()
    for (let p = 0; p < n; p++) {
      if (labels[p] >= 254 || !sliver[labels[p]]) continue
      const around = neighbors(p).map((q) => labels[q]).filter((l) => l < 254 && !sliver[l])
      if (!around.length) continue
      next[p] = around.find(isGradient) ?? around[0]
      second[p] = 255
      cov[p] = 1
      changed++
    }
    labels.set(next)
    if (!changed) break
  }
  return { ...map, labels, second, cov }
}

/**
 * Sub-pixel edges where a gradient meets a flat color. The quantizer records how much of each
 * color an anti-aliased edge pixel holds, but only between flat colors; here the same is done
 * against the gradient's color at that pixel, so gradient outlines are as smooth as any other.
 * Detection blurs, so a gradient's area can stop a pixel or two short of its real edge: every
 * pixel within 2 px of a gradient/flat boundary is re-decided by which color it mostly holds.
 */
function gradientEdges(map: LabelMap, img: ImageData, isGradient: (l: number) => boolean): LabelMap {
  const { w, h, colors, fills } = map
  const src = map.labels
  const labels = src.slice()
  const second = map.second.slice()
  const cov = map.cov.slice()
  const d = img.data
  const colorOf = (l: number, x: number, y: number): number[] =>
    isGradient(l) ? colorAt(fills![l]!, x + 0.5, y + 0.5) : [(colors[l] >> 16) & 255, (colors[l] >> 8) & 255, colors[l] & 255]
  const R = 2
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = y * w + x
      const a = src[p]
      if (a >= 254) continue
      // The nearest label of the other kind (gradient vs flat) within R px.
      let other = -1
      let bestD = Infinity
      for (let dy = -R; dy <= R; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= h) continue
        for (let dx = -R; dx <= R; dx++) {
          const xx = x + dx
          if (xx < 0 || xx >= w) continue
          const b = src[yy * w + xx]
          if (b >= 254 || isGradient(a) === isGradient(b)) continue
          const dd = dx * dx + dy * dy
          if (dd < bestD) [bestD, other] = [dd, b]
        }
      }
      if (other < 0) continue
      const c = [d[p * 4], d[p * 4 + 1], d[p * 4 + 2]]
      const ca = colorOf(a, x, y)
      const cb = colorOf(other, x, y)
      // JPEG edges stray further from a straight mix than flat edges do; allow more.
      const t = blendRatio(c, ca, cb, 40)
      if (t === null) {
        // Not a clean mix: side with the nearer color, as the quantizer does for flat edges.
        const dist = (q: number[]) => (c[0] - q[0]) ** 2 + (c[1] - q[1]) ** 2 + (c[2] - q[2]) ** 2
        if (dist(cb) < dist(ca)) {
          labels[p] = other
          second[p] = 255
          cov[p] = 1
        }
        continue
      }
      if (t > 0.5) {
        // Mostly the other color: it becomes the primary label.
        labels[p] = other
        second[p] = a
        cov[p] = t
      } else {
        second[p] = other
        cov[p] = 1 - t
      }
    }
  return { ...map, labels, second, cov }
}

const labOf = (c: number) => rgbToLab([(c >> 16) & 255, (c >> 8) & 255, c & 255])

/** Merges every label whose color is in `removed` into the nearest remaining color. */
export function removeColors(map: LabelMap, removed: number[]): LabelMap {
  if (!removed.length) return map
  const live = map.colors.map((c, i) => ({ c, i })).filter(({ c }) => c >= 0)
  const isRemoved = (c: number) => removed.some((r) => deltaE2000(labOf(c), labOf(r)) < 8)
  const gone = live.filter(({ c }) => isRemoved(c))
  const kept = live.filter(({ c }) => !isRemoved(c))
  if (!gone.length || !kept.length) return map // never remove the last color
  const target = new Map<number, number>()
  for (const g of gone) {
    let best = kept[0]
    let bd = Infinity
    for (const k of kept) {
      const d = deltaE2000(labOf(g.c), labOf(k.c))
      if (d < bd) {
        bd = d
        best = k
      }
    }
    target.set(g.i, best.i)
  }
  const remap = (l: number) => target.get(l) ?? l
  return { ...map, labels: map.labels.map(remap), second: map.second.map(remap) }
}

/** The label covering most of the image border, if it covers at least half of it. */
function backgroundLabel(map: LabelMap): number {
  const { w, h, labels, colors } = map
  const counts = new Map<number, number>()
  let total = 0
  const add = (p: number) => {
    const l = labels[p]
    if (l >= 254 || colors[l] < 0) return
    counts.set(l, (counts.get(l) ?? 0) + 1)
    total++
  }
  for (let x = 0; x < w; x++) {
    add(x)
    add((h - 1) * w + x)
  }
  for (let y = 1; y < h - 1; y++) {
    add(y * w)
    add(y * w + w - 1)
  }
  let best = -1
  let bn = 0
  for (const [l, n] of counts) if (n > bn) [best, bn] = [l, n]
  // A background must surround the art, not just touch one edge.
  return best >= 0 && bn >= total * 0.5 && bn >= (2 * (w + h)) * 0.3 ? best : -1
}

function paletteOf(map: LabelMap, bgLabel: number): PaletteEntry[] {
  const counts = new Float64Array(map.colors.length)
  let total = 0
  for (const l of map.labels) {
    if (l < 254 && map.colors[l] >= 0) {
      counts[l]++
      total++
    }
  }
  const out: PaletteEntry[] = []
  map.colors.forEach((c, i) => {
    if (counts[i] > 0 && (c >= 0 || i === bgLabel)) out.push({ color: c >= 0 ? c : -1, coverage: total ? counts[i] / total : 0, background: i === bgLabel })
  })
  return out.filter((e) => e.color >= 0).sort((a, b) => b.coverage - a.coverage)
}

/** Dominant border color of an image, if any (used to describe the background for photos). */
function edgeColor(img: ImageData): number | null {
  const { width: w, height: h, data: d } = img
  const counts = new Map<number, number>()
  let total = 0
  const add = (x: number, y: number) => {
    const i = (y * w + x) * 4
    if (d[i + 3] < 250) return
    const key = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4)
    counts.set(key, (counts.get(key) ?? 0) + 1)
    total++
  }
  for (let x = 0; x < w; x++) {
    add(x, 0)
    add(x, h - 1)
  }
  for (let y = 0; y < h; y++) {
    add(0, y)
    add(w - 1, y)
  }
  let best = -1
  let bn = 0
  for (const [k, n] of counts) if (n > bn) [best, bn] = [k, n]
  if (best < 0 || bn < total * 0.6) return null
  return (((best >> 8) & 15) * 17 << 16) | (((best >> 4) & 15) * 17 << 8) | ((best & 15) * 17)
}
