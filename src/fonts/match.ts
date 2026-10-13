import type { Box, OcrWord } from './ocr'

/** Letter shapes are compared at this size (px per side). */
const CELL = 32

/** A normalized letter shape plus how tall it is relative to its word. */
export interface Glyph {
  char: string
  mask: Float32Array
  /** Height relative to the tallest letter in the word (cap height for most words). */
  rel: number
}

export interface WordShapes {
  text: string
  glyphs: Glyph[]
}

export interface FontCandidate {
  /** CSS font-family to render with. */
  family: string
  /** Name to show (e.g. "Arial Black", "Montserrat ExtraBold"). */
  label: string
  weight: number
  style: 'normal' | 'italic'
  source: 'installed' | 'google'
}

export interface FontMatch extends FontCandidate {
  /** 0–1, how closely the letter shapes agree. */
  score: number
}

// ---------- Letter shapes from the artwork ----------

/**
 * Cuts each recognized letter out of the image as a soft ink mask. Ink vs background comes
 * from splitting the word's pixels into two colors; the one that touches the word's border
 * less is the ink (works for dark-on-light, light-on-dark and colored text).
 */
export function wordShapes(img: ImageData, word: OcrWord): WordShapes | null {
  const pad = 2
  const box = clampBox({ x0: word.box.x0 - pad, y0: word.box.y0 - pad, x1: word.box.x1 + pad, y1: word.box.y1 + pad }, img)
  const ink = inkMask(img, box)
  if (!ink) return null
  const W = box.x1 - box.x0
  const raw: { char: string; mask: Float32Array; w: number; h: number }[] = []
  for (const g of word.glyphs) {
    const gb = clampBox(g.box, img)
    const tight = tightBox(ink, W, { x0: gb.x0 - box.x0, y0: gb.y0 - box.y0, x1: gb.x1 - box.x0, y1: gb.y1 - box.y0 })
    if (!tight) continue
    raw.push({ char: g.char, ...normalize((x, y) => ink[y * W + x], tight) })
  }
  if (raw.length < 2) return null
  const maxH = Math.max(...raw.map((r) => r.h))
  return { text: word.text, glyphs: raw.map((r) => ({ char: r.char, mask: r.mask, rel: r.h / maxH })) }
}

function clampBox(b: Box, img: ImageData): Box {
  return { x0: Math.max(0, Math.floor(b.x0)), y0: Math.max(0, Math.floor(b.y0)), x1: Math.min(img.width, Math.ceil(b.x1)), y1: Math.min(img.height, Math.ceil(b.y1)) }
}

/** Soft ink coverage (0–1) per pixel of the box. */
export function inkMask(img: ImageData, b: Box): Float32Array | null {
  const W = b.x1 - b.x0
  const H = b.y1 - b.y0
  if (W < 4 || H < 4) return null
  const px = (x: number, y: number) => {
    const i = ((b.y0 + y) * img.width + b.x0 + x) * 4
    return [img.data[i], img.data[i + 1], img.data[i + 2]]
  }
  // Two-color k-means, seeded with the darkest and lightest pixels.
  let lo = [255, 255, 255], hi = [0, 0, 0], loL = Infinity, hiL = -Infinity
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const c = px(x, y)
      const l = c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114
      if (l < loL) [loL, lo] = [l, c]
      if (l > hiL) [hiL, hi] = [l, c]
    }
  let A = lo.slice(), B = hi.slice()
  for (let it = 0; it < 6; it++) {
    const sa = [0, 0, 0, 0], sb = [0, 0, 0, 0]
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const c = px(x, y)
        const s = d2(c, A) <= d2(c, B) ? sa : sb
        s[0] += c[0]; s[1] += c[1]; s[2] += c[2]; s[3]++
      }
    if (sa[3]) A = [sa[0] / sa[3], sa[1] / sa[3], sa[2] / sa[3]]
    if (sb[3]) B = [sb[0] / sb[3], sb[1] / sb[3], sb[2] / sb[3]]
  }
  const dist = Math.sqrt(d2(A, B))
  if (dist < 40) return null // too little contrast to separate text from background
  // The background touches the border more.
  let borderA = 0, borderN = 0
  for (let x = 0; x < W; x++) for (const y of [0, H - 1]) { borderN++; if (d2(px(x, y), A) <= d2(px(x, y), B)) borderA++ }
  for (let y = 0; y < H; y++) for (const x of [0, W - 1]) { borderN++; if (d2(px(x, y), A) <= d2(px(x, y), B)) borderA++ }
  const [ink, bg] = borderA / borderN > 0.5 ? [B, A] : [A, B]
  const mask = new Float32Array(W * H)
  const ib = [ink[0] - bg[0], ink[1] - bg[1], ink[2] - bg[2]]
  const len2 = ib[0] ** 2 + ib[1] ** 2 + ib[2] ** 2
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const c = px(x, y)
      const t = ((c[0] - bg[0]) * ib[0] + (c[1] - bg[1]) * ib[1] + (c[2] - bg[2]) * ib[2]) / len2
      mask[y * W + x] = Math.min(1, Math.max(0, t))
    }
  return mask
}

const d2 = (a: number[], b: number[]) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2

function tightBox(mask: Float32Array, W: number, b: Box): Box | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (let y = Math.max(0, b.y0); y < b.y1; y++)
    for (let x = Math.max(0, b.x0); x < Math.min(W, b.x1); x++)
      if (mask[y * W + x] > 0.5) {
        if (x < x0) x0 = x
        if (y < y0) y0 = y
        if (x > x1) x1 = x
        if (y > y1) y1 = y
      }
  return x1 >= x0 && y1 - y0 >= 2 ? { x0, y0, x1: x1 + 1, y1: y1 + 1 } : null
}

/** Scales a glyph into a CELL×CELL square, keeping its proportions, and blurs it slightly. */
function normalize(sample: (x: number, y: number) => number, b: Box): { mask: Float32Array; w: number; h: number } {
  const w = b.x1 - b.x0
  const h = b.y1 - b.y0
  const s = (CELL - 4) / Math.max(w, h)
  const ox = (CELL - w * s) / 2
  const oy = (CELL - h * s) / 2
  const m = new Float32Array(CELL * CELL)
  for (let y = 0; y < CELL; y++)
    for (let x = 0; x < CELL; x++) {
      // Area-average the source pixels this cell covers.
      const sx0 = (x - ox) / s, sx1 = (x + 1 - ox) / s, sy0 = (y - oy) / s, sy1 = (y + 1 - oy) / s
      let sum = 0, n = 0
      for (let yy = Math.floor(sy0); yy < Math.ceil(sy1); yy++)
        for (let xx = Math.floor(sx0); xx < Math.ceil(sx1); xx++) {
          n++
          if (xx >= 0 && yy >= 0 && xx < w && yy < h) sum += sample(b.x0 + xx, b.y0 + yy)
        }
      m[y * CELL + x] = n ? sum / n : 0
    }
  return { mask: soften(m), w, h }
}

function soften(m: Float32Array): Float32Array {
  const out = new Float32Array(m.length)
  for (let y = 0; y < CELL; y++)
    for (let x = 0; x < CELL; x++) {
      let s = 0, n = 0
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy
          if (xx < 0 || yy < 0 || xx >= CELL || yy >= CELL) continue
          s += m[yy * CELL + xx] * (dx === 0 && dy === 0 ? 2 : 1)
          n += dx === 0 && dy === 0 ? 2 : 1
        }
      out[y * CELL + x] = s / n
    }
  return out
}

// ---------- Letter shapes from a font ----------

const RENDER = 96
let renderCanvas: OffscreenCanvas | null = null

/** Renders the same letters in a candidate font, normalized the same way as the artwork's. */
export function fontShapes(font: FontCandidate, chars: string[]): Map<string, { mask: Float32Array; h: number }> | null {
  renderCanvas ??= new OffscreenCanvas(RENDER * 2, RENDER * 2)
  const ctx = renderCanvas.getContext('2d', { willReadFrequently: true })!
  ctx.font = `${font.style} ${font.weight} ${RENDER}px "${font.family}", __missing__`
  const out = new Map<string, { mask: Float32Array; h: number }>()
  for (const ch of new Set(chars)) {
    ctx.clearRect(0, 0, renderCanvas.width, renderCanvas.height)
    ctx.fillStyle = '#000'
    ctx.textBaseline = 'alphabetic'
    ctx.fillText(ch, RENDER * 0.4, RENDER * 1.4)
    const { data, width } = ctx.getImageData(0, 0, renderCanvas.width, renderCanvas.height)
    const alpha = (x: number, y: number) => data[(y * width + x) * 4 + 3] / 255
    const a = new Float32Array(width * renderCanvas.height)
    for (let i = 0; i < a.length; i++) a[i] = data[i * 4 + 3] / 255
    const tight = tightBox(a, width, { x0: 0, y0: 0, x1: width, y1: renderCanvas.height })
    if (!tight) return null
    out.set(ch, { ...normalize(alpha, tight) })
  }
  return out
}

// ---------- Scoring ----------

/**
 * How well a font explains the artwork's words: per letter, the soft overlap of the two
 * shapes (intersection over union), discounted when the letter's height relative to its word
 * differs (x-height and cap height are strong identifiers). Averaged over all letters.
 */
export function scoreFont(font: FontCandidate, words: WordShapes[]): number {
  const chars = words.flatMap((w) => w.glyphs.map((g) => g.char))
  const shapes = fontShapes(font, chars)
  if (!shapes) return 0
  let total = 0
  let n = 0
  for (const w of words) {
    const maxH = Math.max(...w.glyphs.map((g) => shapes.get(g.char)?.h ?? 0))
    if (!maxH) continue
    for (const g of w.glyphs) {
      const f = shapes.get(g.char)
      if (!f) continue
      let inter = 0, union = 0
      for (let i = 0; i < g.mask.length; i++) {
        inter += Math.min(g.mask[i], f.mask[i])
        union += Math.max(g.mask[i], f.mask[i])
      }
      const iou = union ? inter / union : 0
      const relDiff = Math.abs(g.rel - f.h / maxH)
      total += iou * Math.max(0, 1 - relDiff * 2)
      n++
    }
  }
  return n ? total / n : 0
}

/**
 * Ranks candidates. A quick first pass on a few letters keeps the best ~40; those are then
 * scored on every letter. Yields to the browser between batches so the page stays responsive.
 */
export async function rankFonts(words: WordShapes[], candidates: FontCandidate[], onProgress?: (done: number, total: number) => void): Promise<FontMatch[]> {
  const quick = words.map((w) => ({ ...w, glyphs: [...w.glyphs].sort((a, b) => b.rel - a.rel).slice(0, 3) })).slice(0, 3)
  const first: FontMatch[] = []
  for (let i = 0; i < candidates.length; i++) {
    first.push({ ...candidates[i], score: scoreFont(candidates[i], quick) })
    if (i % 25 === 24) {
      onProgress?.(i + 1, candidates.length)
      await new Promise((r) => setTimeout(r, 0))
    }
  }
  const finalists = first.sort((a, b) => b.score - a.score).slice(0, 40)
  const ranked = finalists.map((f) => ({ ...f, score: scoreFont(f, words) })).sort((a, b) => b.score - a.score)
  onProgress?.(candidates.length, candidates.length)
  // One entry per family+style, best first.
  const seen = new Set<string>()
  return ranked.filter((f) => {
    const k = `${f.label}|${f.source}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}
