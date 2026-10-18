import { deltaE2000, rgbToLab, snapNearWhite } from '../palette/color'
import type { Palette } from '../palette/parse'
import { applyBrand, type BrandSettings } from '../palette/brand'
import { colorNames } from '../palette/names'
import { colorAt, findGradients } from '../palette/gradients'
import { blendRatio, nameSvg, quantize, type FixedLabels, type Ink, type InkSettings, type QuantizeOptions } from '../palette/quantize'
import { layersToSvg, traceLabels, type LabelMap, type ShapeCounts, type TracedLayer, type TraceOptions } from '../trace'
import { removeFlatBackground } from './background'
import type { FlatTracer } from './flat-tracer'
import { finalizeSvg, prepareImage, type InputImage } from './image'
import type { PlacedWord } from '../fonts/lettering'
import { scalePath } from '../fonts/path'
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
  /** Words to rebuild from a font (source-image pixels). */
  lettering?: PlacedWord[]
}

/** Rebuilt lettering, in the traced image's pixels. */
export interface TextOptions {
  words: { text: string; font: string; letters: { char: string; d: string }[]; box: [number, number, number, number] }[]
  /** Coverage (0–255) of all placed letters, per traced pixel. */
  coverage: Uint8Array
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
   * traced as flat color bands (the client turned them off). Unset: not looked for.
   */
  gradients?: 'apply' | 'report'
  /** Lettering to rebuild from a font. */
  text?: TextOptions
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
  /** Words rebuilt from a font. */
  lettered: number
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

/** Outlines smaller than this (px²) are dropped by the flat tracer. */
const TRACE_MIN_AREA = 2

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
      // Print PDFs fill gradients as full-color shadings; cut files cut each gradient as one shape.
      gradients: lineArt || spotOn ? undefined : s.gradients ? 'apply' : 'report',
      text: s.lettering?.length && !lineArt ? textOptions(s.lettering, scale, base.image.width, base.image.height) : undefined,
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
        // Noise is removed from the colour map (which keeps real small detail); the tracer only
        // drops near-empty outlines left by smoothing.
        minArea: Math.min(speckArea, TRACE_MIN_AREA),
        detailArea: speckArea,
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

/** Places rebuilt words in the traced image and renders their coverage (main thread). */
function textOptions(words: PlacedWord[], scale: number, w: number, h: number): TextOptions {
  const canvas = new OffscreenCanvas(w, h)
  const g = canvas.getContext('2d')!
  const placed = words.map((word) => {
    const letters = word.letters.map((l) => ({ char: l.char, d: scalePath(l.d, scale) }))
    for (const l of letters) g.fill(new Path2D(l.d))
    const box: [number, number, number, number] = [word.box.x0 * scale, word.box.y0 * scale, word.box.x1 * scale, word.box.y1 * scale]
    return { text: word.text, font: word.font, letters, box }
  })
  const data = g.getImageData(0, 0, w, h).data
  const coverage = new Uint8Array(w * h)
  for (let p = 0; p < coverage.length; p++) coverage[p] = data[p * 4 + 3]
  return { words: placed, coverage }
}

/** The flat-color pipeline: quantize, apply the client's color choices, trace. Pure. */
/** `inspect` receives the final colour map just before tracing (diagnostics; see bench/diagnose.ts). */
export function runFlat(image: ImageData, o: FlatOptions, inspect?: (map: LabelMap) => void): FlatResult {
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
  // Exact white for near-white, after every step that measures colours (speck cleanup, gradient
  // edges) so shapes don't change. Swatch inks, brand colours and gradients keep their own.
  if (!o.lineArt && !o.quantize.palette) map = { ...map, colors: map.colors.map((c, l) => (c >= 0 && !isGradient(l) && !branded.named.has(c) ? snapNearWhite(c) : c)) }

  const bgLabel = backgroundLabel(map)
  const background = bgLabel >= 0 ? map.colors[bgLabel] : o.lineArt ? 0xffffff : null
  if (o.lineArt && !o.transparent) {
    // Line art keeps paper out of the shapes; put it back as a white sheet when asked.
    map = { ...map, colors: map.colors.map((c) => (c < 0 ? 0xffffff : c)) }
  } else if (o.transparent && bgLabel >= 0) {
    map = { ...map, colors: map.colors.map((c, i) => (i === bgLabel ? -1 : c)) }
  }
  const palette = paletteOf(map, bgLabel).filter((e) => !map.fills?.[map.colors.indexOf(e.color)])
  const knockout = o.trace.mode === 'knockout'
  const text = o.text ? applyText(map, o.text, knockout) : null
  if (text) map = text.map
  inspect?.(map)
  const traced = traceLabels(map, o.trace)
  let { svg } = traced
  const { paths, shapes } = traced
  if (text?.layers.length) svg = layersToSvg([...(knockout ? punchLetters(traced.layers, text.holes) : traced.layers), ...text.layers], map.w, map.h)
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
    lettered: text?.words ?? 0,
  }
}

/**
 * Swaps traced letters for font outlines. Each word's letter color is the color under the
 * placed letters, and its background the color around the word. The traced letters are erased
 * (their pixels take the background) and the outlines are drawn on top; knockout output (print
 * plates, cut files) also gets the letters cut out of the background shape (punchLetters).
 */
function applyText(map: LabelMap, text: TextOptions, knockout: boolean): { map: LabelMap; layers: TracedLayer[]; words: number; holes: { color: number; box: [number, number, number, number]; d: string }[] } {
  const { w, h } = map
  const holes: { color: number; box: [number, number, number, number]; d: string }[] = []
  const labels = map.labels.slice()
  const second = map.second.slice()
  const cov = map.cov.slice()
  const layers: TracedLayer[] = []
  let words = 0
  for (const word of text.words) {
    const pad = 3
    const x0 = Math.max(0, Math.floor(word.box[0]) - pad), y0 = Math.max(0, Math.floor(word.box[1]) - pad)
    const x1 = Math.min(w, Math.ceil(word.box[2]) + pad), y1 = Math.min(h, Math.ceil(word.box[3]) + pad)
    if (x1 <= x0 || y1 <= y0) continue
    // Letter color: the majority under the placed letters. Background: the majority around the word.
    const under = new Map<number, number>()
    const around = new Map<number, number>()
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const p = y * w + x
        const l = map.labels[p]
        if (l >= 254) continue
        if (text.coverage[p] > 191) under.set(l, (under.get(l) ?? 0) + 1)
        if (x === x0 || x === x1 - 1 || y === y0 || y === y1 - 1) around.set(l, (around.get(l) ?? 0) + 1)
      }
    const top = (m: Map<number, number>, not = -1) => [...m].filter(([l]) => l !== not).sort((a, b) => b[1] - a[1])[0]?.[0] ?? -1
    const ink = top(under)
    const bg = top(around, ink)
    if (ink < 0 || bg < 0 || map.colors[ink] < 0) continue
    // Traced letter pixels: each connected shape of the ink color in the word's box that
    // overlaps the placed letters (punctuation and other marks nearby don't, and stay).
    const bw = x1 - x0, bh = y1 - y0
    const comp = new Int32Array(bw * bh).fill(-1)
    const replaced: boolean[] = []
    const isInk = (p: number) => map.labels[p] === ink || (map.second[p] === ink && map.cov[p] < 0.5)
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const i = (y - y0) * bw + (x - x0)
        if (comp[i] >= 0 || !isInk(y * w + x)) continue
        const id = replaced.length
        let size = 0, covered = 0
        const stack = [i]
        comp[i] = id
        while (stack.length) {
          const j = stack.pop()!
          const px = x0 + (j % bw), py = y0 + Math.floor(j / bw)
          size++
          if (text.coverage[py * w + px] > 0) covered++
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = px + dx - x0, ny = py + dy - y0
            if (nx < 0 || ny < 0 || nx >= bw || ny >= bh) continue
            const k = ny * bw + nx
            if (comp[k] < 0 && isInk((y0 + ny) * w + x0 + nx)) {
              comp[k] = id
              stack.push(k)
            }
          }
        }
        replaced.push(covered >= size * 0.3)
      }
    // Slivers of other colours on the traced letters' edges (anti-aliasing and compression mixed
    // with nearby colours, e.g. a gradient): thin shapes (1–2 px wide, almost no pixel with all four
    // neighbours in the shape) lying mostly on or within 2 px of the letters (traced or placed) go
    // too, or they would show as coloured lines along the clean outlines. Solid marks next to the
    // letters, even small ones (a 3×3 dot), have interior pixels and stay.
    const letterish = new Uint8Array(bw * bh)
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const i = (y - y0) * bw + (x - x0)
        if (!((comp[i] >= 0 && replaced[comp[i]]) || text.coverage[y * w + x] > 0)) continue
        for (let dy = -2; dy <= 2; dy++)
          for (let dx = -2; dx <= 2; dx++) {
            const nx = x - x0 + dx, ny = y - y0 + dy
            if (nx >= 0 && ny >= 0 && nx < bw && ny < bh) letterish[ny * bw + nx] = 1
          }
      }
    const other = new Int32Array(bw * bh).fill(-1)
    const sliver: boolean[] = []
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const i = (y - y0) * bw + (x - x0)
        const l = map.labels[y * w + x]
        if (other[i] >= 0 || comp[i] >= 0 || l === bg || l === ink || l >= 254) continue
        const id = sliver.length
        let size = 0, covered = 0, interior = 0
        const stack = [i]
        other[i] = id
        while (stack.length) {
          const j = stack.pop()!
          const px = x0 + (j % bw), py = y0 + Math.floor(j / bw)
          size++
          if (letterish[j]) covered++
          let same = 0
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = px + dx - x0, ny = py + dy - y0
            if (nx < 0 || ny < 0 || nx >= bw || ny >= bh) continue
            const k = ny * bw + nx
            if (map.labels[(y0 + ny) * w + x0 + nx] === l) same++
            if (other[k] < 0 && comp[k] < 0 && map.labels[(y0 + ny) * w + x0 + nx] === l) {
              other[k] = id
              stack.push(k)
            }
          }
          if (same === 4) interior++
        }
        sliver.push(covered >= size * 0.5 && interior < size * 0.1)
      }
    const traced = (x: number, y: number) => {
      const i = (y - y0) * bw + (x - x0)
      return (comp[i] >= 0 && replaced[comp[i]]) || (other[i] >= 0 && sliver[other[i]])
    }
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const p = y * w + x
        const a = text.coverage[p] / 255
        // Erase the traced letters; the outlines are drawn on top.
        if (traced(x, y)) [labels[p], second[p], cov[p]] = [bg, 255, 1]
        else if (map.second[p] === ink && a > 0) [second[p], cov[p]] = [255, 1]
      }
    layers.push({ color: map.colors[ink], d: word.letters.map((l) => l.d).join(''), shapes: word.letters.map((l) => l.d), text: { word: word.text, font: word.font, letters: word.letters.map((l) => l.char) } })
    if (knockout) holes.push({ color: map.colors[bg], box: word.box, d: word.letters.map((l) => l.d).join('') })
    words++
  }
  return { map: { ...map, labels, second, cov }, layers, words, holes }
}

/**
 * Knockout output can't overlap, so each word's letters are cut out of the shape behind them,
 * exactly (even-odd: the letters become holes, their own counters stay filled). The shape is the
 * smallest one of the background color that encloses the word.
 */
function punchLetters(layers: TracedLayer[], holes: { color: number; box: [number, number, number, number]; d: string }[]): TracedLayer[] {
  const bounds = (d: string) => {
    const n = (d.match(/-?\d*\.?\d+/g) ?? []).map(Number)
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (let i = 0; i + 1 < n.length; i += 2) {
      x0 = Math.min(x0, n[i]); x1 = Math.max(x1, n[i]); y0 = Math.min(y0, n[i + 1]); y1 = Math.max(y1, n[i + 1])
    }
    return [x0, y0, x1, y1]
  }
  const out = layers.map((l) => ({ ...l, shapes: l.shapes ? [...l.shapes] : undefined }))
  for (const hole of holes) {
    const [wx0, wy0, wx1, wy1] = hole.box
    let best: { layer: number; shape: number; area: number } | null = null
    out.forEach((l, li) => {
      if (l.text || l.color !== hole.color) return
      ;(l.shapes ?? [l.d]).forEach((d, si) => {
        const [x0, y0, x1, y1] = bounds(d)
        if (x0 > wx0 || y0 > wy0 || x1 < wx1 || y1 < wy1) return
        const area = (x1 - x0) * (y1 - y0)
        if (!best || area < best.area) best = { layer: li, shape: si, area }
      })
    })
    if (!best) continue
    const { layer, shape } = best as { layer: number; shape: number }
    const l = out[layer]
    if (l.shapes) l.shapes[shape] += hole.d
    l.d += hole.d
  }
  return out
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
  /** Words rebuilt from a font. */
  lettered: number
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
    return { svg, ms: performance.now() - start, paths: res.paths, inks: annotate ? res.inks : null, palette: res.palette, background: res.background, blendsRemoved: res.blendsRemoved, shapes: res.shapes, named: res.named, gradients: res.gradients, lettered: res.lettered, ...size }
  }
  const out = await tracers.vtracer.trace(job.image, toEngineConfig(job.params, job.scale))
  const svg = finalizeSvg(out.svg, job.image, original)
  return { svg, ms: out.ms, paths: (svg.match(/<path\b/g) ?? []).length, inks: null, palette: null, background: job.background, blendsRemoved: 0, shapes: null, named: [], gradients: { found: 0, kept: 0 }, lettered: 0, ...size }
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
