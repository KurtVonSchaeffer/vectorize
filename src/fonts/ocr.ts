import { createWorker, PSM, type Block, type Worker as TesseractWorker } from 'tesseract.js'

export interface Box {
  x0: number
  y0: number
  x1: number
  y1: number
}

export interface OcrGlyph {
  char: string
  box: Box
}

export interface OcrWord {
  /** Which text line the word is on (words on one line usually share a font). */
  line: number
  text: string
  confidence: number
  box: Box
  glyphs: OcrGlyph[]
  /** What other OCR passes read at the same place (when they read it differently). */
  readings?: string[]
}

let worker: Promise<TesseractWorker> | null = null
let progress: ((p: number) => void) | undefined

/** Tesseract runs entirely in the browser; its engine and English data are served by the app. */
function getWorker(): Promise<TesseractWorker> {
  worker ??= createWorker('eng', 1, {
    workerPath: '/ocr/worker.min.js',
    corePath: '/ocr',
    langPath: '/ocr',
    workerBlobURL: false,
    gzip: true,
    logger: (m) => {
      if (m.status === 'recognizing text') progress?.(m.progress)
    },
  })
  // Logos and badges aren't pages: "sparse text" finds scattered words anywhere in a graphic,
  // where the default page layout analysis treats the whole thing as a picture.
  worker = worker.then(async (w) => {
    await w.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT })
    return w
  })
  worker.catch(() => (worker = null))
  return worker
}

/** Upscaled so letters are tall enough for OCR (it wants x-heights of ~20 px or more). */
const OCR_TARGET = 1800

/**
 * Finds words in an image, in the upscaled canvas's coordinates (also returned).
 *
 * OCR expects dark text on a light page, and struggles with light text on dark shapes inside a
 * busy graphic. So besides the image itself, each of the artwork's colors is read as its own
 * black-on-white picture (that color black, everything else white): cream lettering on a navy
 * disc becomes black letters on a white disc. Words found in several passes are kept once, at
 * their most confident reading.
 */
export async function readText(bitmap: ImageBitmap, colors: number[] = [], onProgress?: (p: number) => void): Promise<{ words: OcrWord[]; scale: number; canvas: OffscreenCanvas }> {
  const scale = Math.min(4, Math.max(1, OCR_TARGET / Math.max(bitmap.width, bitmap.height)))
  const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale))
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)

  // Photos, or a result that isn't ready yet, come without colors: find the main ones here.
  const inks = colors.length ? colors : mainColors(ctx.getImageData(0, 0, canvas.width, canvas.height))
  const passes: OffscreenCanvas[] = [canvas, ...inks.map((c) => colorMask(ctx.getImageData(0, 0, canvas.width, canvas.height), c, inks))]
  const w = await getWorker()
  const found: OcrWord[] = []
  for (let i = 0; i < passes.length; i++) {
    progress = (p) => onProgress?.((i + p) / passes.length)
    const { data } = await w.recognize(passes[i], {}, { blocks: true })
    found.push(...wordsOf(data.blocks ?? [], i * 1000))
  }
  return { words: dedupe(found), scale, canvas }
}

function wordsOf(blocks: Block[], lineBase: number): OcrWord[] {
  const words: OcrWord[] = []
  let lineNo = lineBase
  for (const block of blocks)
    for (const para of block.paragraphs)
      for (const line of para.lines) {
        lineNo++
        for (const word of line.words) {
          // Letters, digits and punctuation (punctuation helps place a word, not identify a font).
          const glyphs = word.symbols.filter((s) => /[\p{L}\p{N}\p{P}]/u.test(s.text) && s.confidence > 40).map((s) => ({ char: s.text, box: s.bbox }))
          const alnum = word.text.replace(/[^\p{L}\p{N}]/gu, '')
          if (word.confidence < 55 || alnum.length < 2 || glyphs.filter((g) => /[\p{L}\p{N}]/u.test(g.char)).length < 2) continue
          words.push({ line: lineNo, text: word.text, confidence: word.confidence, box: word.bbox, glyphs })
        }
      }
  return words
}

/** Keeps one reading per location: the most confident of overlapping words. Exported for tests. */
export function dedupe(words: OcrWord[]): OcrWord[] {
  const sorted = [...words].sort((a, b) => b.confidence - a.confidence)
  const kept: OcrWord[] = []
  const overlap = (a: Box, b: Box) => {
    const ix = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0))
    const iy = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0))
    const area = (r: Box) => (r.x1 - r.x0) * (r.y1 - r.y0)
    return (ix * iy) / Math.min(area(a), area(b))
  }
  // Same word, same place: the boxes cover each other almost entirely (a different word split
  // isn't a different reading).
  const same = (a: Box, b: Box) => overlap(a, b) > 0.8 && Math.abs((a.x1 - a.x0) - (b.x1 - b.x0)) <= 0.2 * Math.max(a.x1 - a.x0, b.x1 - b.x0)
  for (const w of sorted) {
    const k = kept.find((k) => overlap(k.box, w.box) > 0.5)
    if (!k) kept.push({ ...w })
    else if (same(k.box, w.box) && w.text !== k.text && !(k.readings ?? []).includes(w.text)) k.readings = [...(k.readings ?? []), w.text]
  }
  return kept
}

/** The pixels nearest to `color` (among the artwork's colors) in black, everything else white. */
function colorMask(img: ImageData, color: number, colors: number[]): OffscreenCanvas {
  const rgb = colors.map((c) => [(c >> 16) & 255, (c >> 8) & 255, c & 255])
  const target = colors.indexOf(color)
  const d = img.data
  const out = new ImageData(img.width, img.height)
  for (let i = 0; i < d.length; i += 4) {
    let best = 0
    let bd = Infinity
    for (let k = 0; k < rgb.length; k++) {
      const dd = (d[i] - rgb[k][0]) ** 2 + (d[i + 1] - rgb[k][1]) ** 2 + (d[i + 2] - rgb[k][2]) ** 2
      if (dd < bd) [best, bd] = [k, dd]
    }
    const v = best === target ? 0 : 255
    out.data[i] = out.data[i + 1] = out.data[i + 2] = v
    out.data[i + 3] = 255
  }
  const c = new OffscreenCanvas(img.width, img.height)
  c.getContext('2d')!.putImageData(out, 0, 0)
  return c
}

/**
 * The image's main colors (up to `max`): a coarse histogram (4 bits per channel) whose bins are
 * pooled into clusters of similar color, most common first, keeping clusters that cover at least
 * 2% of the image. Pooling first matters for JPEGs, which spread one color over many shades.
 */
export function mainColors(img: ImageData, max = 6): number[] {
  const bins = new Map<number, { n: number; r: number; g: number; b: number }>()
  const d = img.data
  const step = Math.max(1, Math.floor(d.length / 4 / 200_000)) * 4
  let total = 0
  for (let i = 0; i < d.length; i += step) {
    if (d[i + 3] < 128) continue
    const key = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4)
    const bin = bins.get(key) ?? { n: 0, r: 0, g: 0, b: 0 }
    bin.n++; bin.r += d[i]; bin.g += d[i + 1]; bin.b += d[i + 2]
    bins.set(key, bin)
    total++
  }
  const clusters: { n: number; r: number; g: number; b: number }[] = []
  for (const bin of [...bins.values()].sort((a, b) => b.n - a.n)) {
    const c = [bin.r / bin.n, bin.g / bin.n, bin.b / bin.n]
    const near = clusters.find((k) => (k.r / k.n - c[0]) ** 2 + (k.g / k.n - c[1]) ** 2 + (k.b / k.n - c[2]) ** 2 < 48 ** 2)
    if (near) {
      near.n += bin.n; near.r += bin.r; near.g += bin.g; near.b += bin.b
    } else clusters.push({ ...bin })
  }
  return clusters
    .filter((k) => k.n >= total * 0.02)
    .sort((a, b) => b.n - a.n)
    .slice(0, max)
    .map((k) => (Math.round(k.r / k.n) << 16) | (Math.round(k.g / k.n) << 8) | Math.round(k.b / k.n))
}
