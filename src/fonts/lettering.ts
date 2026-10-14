import { flatten, parsePath, type Subpath } from '../export/path'
import { traceLabels } from '../trace'
import { fontFile } from './candidates'
import type { FontReport, TextLine } from './identify'
import { inkMask, type FontCandidate } from './match'
import type { Box } from './ocr'
import { scalePath } from './path'
import { yieldToPage } from './yield'

/**
 * Rebuilding lettering from a font: the traced letters of a word are replaced by the real letter
 * outlines of the matched font, sized and placed over the originals, so text is perfectly clean
 * at any size (the way a designer would redraw it).
 */

/** One rebuilt word, in source-image pixels. */
export interface PlacedWord {
  text: string
  /** Font name to record in the SVG. */
  font: string
  letters: { char: string; d: string }[]
  /** Bounds of the placed letters. */
  box: Box
}

export interface LineLettering {
  font: string
  words: PlacedWord[]
  /** Words left as traced because they couldn't be placed confidently. */
  skipped: number
}

/** Placement must explain the traced letters' heights and widths within this share of the height. */
const MAX_FIT_ERROR = 0.12
/** And the placed letters must overlap the artwork's letters at least this much. */
const MIN_OVERLAP = 0.6
/**
 * For a font the client named themselves. Thin lettering loses overlap to sub-pixel offsets and
 * soft edges: a light wordmark measured 0.51 with its likely font, and 0.38 one weight too thin.
 */
export const MIN_OVERLAP_NAMED = 0.45

/** Letter outlines from a font: bounds in font units (y up), and the path at a position and size. */
interface GlyphSource {
  unitsPerEm: number
  glyph(char: string): { bbox: { x1: number; y1: number; x2: number; y2: number }; path(x: number, y: number, size: number): string } | null
}

const fonts = new Map<string, Promise<GlyphSource>>()

/**
 * The font file's outlines when there is a file (free catalog fonts, installed fonts); otherwise
 * (fonts that ship with the computer, drawn by name) outlines traced from large renderings.
 */
async function loadFont(font: FontCandidate): Promise<GlyphSource> {
  const key = `${font.source}|${font.family}|${font.weight}`
  let f = fonts.get(key)
  if (!f) {
    f = font.source === 'system' ? Promise.resolve(renderedGlyphs(font)) : fileGlyphs(font).catch(() => renderedGlyphs(font))
    f.catch(() => fonts.delete(key))
    fonts.set(key, f)
  }
  return f
}

async function fileGlyphs(font: FontCandidate): Promise<GlyphSource> {
  const [opentype, buf] = await Promise.all([import('opentype.js'), fontFile(font)])
  const parsed = opentype.parse(buf)
  return {
    unitsPerEm: parsed.unitsPerEm,
    glyph(char) {
      const g = parsed.charToGlyph(char)
      const bb = g.getBoundingBox()
      if (g.index === 0 || !(bb.x2 > bb.x1 && bb.y2 > bb.y1)) return null
      return { bbox: bb, path: (x, y, size) => g.getPath(x, y, size).toPathData(2) }
    },
  }
}

/** Letters are drawn this tall (px) and traced, for fonts without a readable file. */
const RENDER = 320

function renderedGlyphs(font: FontCandidate): GlyphSource {
  const W = RENDER * 2
  const H = RENDER * 2
  const ox = RENDER * 0.5
  const base = RENDER * 1.4
  const cache = new Map<string, ReturnType<GlyphSource['glyph']>>()
  return {
    unitsPerEm: RENDER,
    glyph(char) {
      if (cache.has(char)) return cache.get(char)!
      const canvas = new OffscreenCanvas(W, H)
      const g = canvas.getContext('2d', { willReadFrequently: true })!
      g.font = `${font.style} ${font.weight} ${RENDER}px "${font.family}"`
      g.fillText(char, ox, base)
      const a = g.getImageData(0, 0, W, H).data
      const n = W * H
      const labels = new Uint8Array(n).fill(254)
      const second = new Uint8Array(n).fill(255)
      const cov = new Float32Array(n).fill(1)
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
      for (let p = 0; p < n; p++) {
        const v = a[p * 4 + 3] / 255
        if (!v) continue
        // Anti-aliased edges carry how much of the pixel is ink, for sub-pixel outlines.
        if (v >= 0.5) [labels[p], cov[p]] = [0, v]
        else [second[p], cov[p]] = [0, 1 - v]
        const x = p % W, y = Math.floor(p / W)
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
      let out: ReturnType<GlyphSource['glyph']> = null
      if (x1 > x0) {
        const traced = traceLabels({ w: W, h: H, labels, second, cov, colors: [0] }, { smoothing: 0.7, minArea: 6, error: 0.3, cornerAngle: 55, precision: 2 })
        const d = fontWinding(traced.layers.map((l) => l.d).join(''))
        if (d) {
          out = {
            bbox: { x1: x0 - ox, x2: x1 + 1 - ox, y1: base - (y1 + 1), y2: base - y0 },
            path: (x, y, size) => {
              const k = size / RENDER
              return mapPoints(d, (px, py) => [x + (px - ox) * k, y + (py - base) * k])
            },
          }
        }
      }
      cache.set(char, out)
      return out
    },
  }
}

/**
 * Orients traced outlines the way fonts are: outer edges one way, holes (the counter of an "o")
 * the other, so the default nonzero fill keeps holes open everywhere the letters are drawn.
 */
function fontWinding(d: string): string {
  const subs = parsePath(d)
  const polys = subs.map((s) => flatten(s, 0.5))
  const area = (pts: [number, number][]) => pts.reduce((a, p, i) => a + p[0] * pts[(i + 1) % pts.length][1] - pts[(i + 1) % pts.length][0] * p[1], 0) / 2
  const inside = (p: [number, number], poly: [number, number][]) => {
    let c = false
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++)
      if (poly[i][1] > p[1] !== poly[j][1] > p[1] && p[0] < ((poly[j][0] - poly[i][0]) * (p[1] - poly[i][1])) / (poly[j][1] - poly[i][1]) + poly[i][0]) c = !c
    return c
  }
  return subs
    .map((sub, i) => {
      const depth = polys.filter((other, j) => j !== i && inside(polys[i][0], other)).length
      const clockwise = area(polys[i]) > 0 // y grows downward
      return serialize(clockwise === (depth % 2 === 0) ? sub : reverse(sub))
    })
    .join('')
}

function reverse(s: Subpath): Subpath {
  const points = [s.start, ...s.segs.map((g) => g.p)]
  const segs: Subpath['segs'] = []
  for (let k = s.segs.length - 1; k >= 0; k--) {
    const g = s.segs[k]
    const to = points[k]
    segs.push(g.t === 'L' ? { t: 'L', p: to } : { t: 'C', c1: g.c2, c2: g.c1, p: to })
  }
  return { start: points[points.length - 1], segs, closed: s.closed }
}

function serialize(s: Subpath): string {
  const f = (v: number) => +v.toFixed(2)
  let out = `M${f(s.start[0])} ${f(s.start[1])}`
  for (const g of s.segs) out += g.t === 'L' ? `L${f(g.p[0])} ${f(g.p[1])}` : `C${f(g.c1[0])} ${f(g.c1[1])} ${f(g.c2[0])} ${f(g.c2[1])} ${f(g.p[0])} ${f(g.p[1])}`
  return out + 'Z'
}

/** Applies `f` to every coordinate pair of an absolute path (M, L, C, Z only, as the tracer writes). */
function mapPoints(d: string, f: (x: number, y: number) => [number, number]): string {
  return d.replace(/(-?\d*\.?\d+)[ ,]+(-?\d*\.?\d+)/g, (_, a: string, b: string) => {
    const [x, y] = f(Number(a), Number(b))
    return `${+x.toFixed(2)} ${+y.toFixed(2)}`
  })
}

export async function placeLine(report: FontReport, line: TextLine, match: FontCandidate, minOverlap = MIN_OVERLAP): Promise<LineLettering> {
  const font = await loadFont(match)
  const img = report.canvas.getContext('2d')!.getImageData(0, 0, report.canvas.width, report.canvas.height)
  const words: PlacedWord[] = []
  let skipped = 0
  for (const w of line.shapes) {
    // Placing traces letters on the main thread; let the page respond between words.
    await yieldToPage()
    const placed = w.complete ? placeWord(font, w.glyphs, w.box, img, minOverlap) : null
    if (!placed) {
      skipped++
      continue
    }
    // OCR canvas → source pixels.
    const k = 1 / report.scale
    words.push({
      text: w.text,
      font: match.label,
      letters: placed.letters.map((l) => ({ char: l.char, d: scalePath(l.d, k) })),
      box: { x0: placed.box.x0 * k, y0: placed.box.y0 * k, x1: placed.box.x1 * k, y1: placed.box.y1 * k },
    })
  }
  return { font: match.label, words, skipped }
}

/**
 * Fits one size and baseline for the word (least squares over every letter's top, bottom and
 * width), then puts each letter at its own traced position, so spacing matches the artwork.
 */
function placeWord(font: GlyphSource, glyphs: { char: string; box: Box }[], wordBox: Box, img: ImageData, minOverlap: number): { letters: { char: string; d: string }[]; box: Box } | null {
  const found = glyphs.map((g) => ({ g, glyph: font.glyph(g.char) }))
  if (found.some((o) => !o.glyph)) return null
  const outlines = found.map(({ g, glyph }) => ({ g, glyph: glyph!, bb: glyph!.bbox }))

  // Unknowns: baseline y0 and scale s (px per font unit); image y grows downward.
  //   top:    y0 − s·yMax = box.y0     bottom: y0 − s·yMin = box.y1     width: s·(xMax − xMin) = box width
  let a11 = 0, a12 = 0, a22 = 0, b1 = 0, b2 = 0
  const eq = (c1: number, c2: number, v: number) => {
    a11 += c1 * c1; a12 += c1 * c2; a22 += c2 * c2; b1 += c1 * v; b2 += c2 * v
  }
  for (const { g, bb } of outlines) {
    eq(1, -bb.y2, g.box.y0)
    eq(1, -bb.y1, g.box.y1)
    eq(0, bb.x2 - bb.x1, g.box.x1 - g.box.x0)
  }
  const det = a11 * a22 - a12 * a12
  if (Math.abs(det) < 1e-9) return null
  const y0 = (b1 * a22 - b2 * a12) / det
  const s = (a11 * b2 - a12 * b1) / det
  if (!(s > 0)) return null

  // How well one size explains every letter.
  let err = 0
  let height = 0
  for (const { g, bb } of outlines) {
    err += (y0 - s * bb.y2 - g.box.y0) ** 2 + (y0 - s * bb.y1 - g.box.y1) ** 2 + (s * (bb.x2 - bb.x1) - (g.box.x1 - g.box.x0)) ** 2
    height = Math.max(height, g.box.y1 - g.box.y0)
  }
  if (Math.sqrt(err / (outlines.length * 3)) > height * MAX_FIT_ERROR) return null

  const size = s * font.unitsPerEm
  const letters = outlines.map(({ g, glyph, bb }) => {
    // Center each letter on its traced position.
    const x = (g.box.x0 + g.box.x1) / 2 - (s * (bb.x1 + bb.x2)) / 2
    return { char: g.char, d: glyph.path(x, y0, size) }
  })
  const box: Box = {
    x0: Math.min(...outlines.map((o) => o.g.box.x0)),
    y0: Math.min(...outlines.map((o) => o.g.box.y0)),
    x1: Math.max(...outlines.map((o) => o.g.box.x1)),
    y1: Math.max(...outlines.map((o) => o.g.box.y1)),
  }
  if (overlap(letters.map((l) => l.d), wordBox, img) < minOverlap) return null
  return { letters, box }
}

/** Overlap (IoU) between the placed letters and the artwork's ink inside the word's box. */
function overlap(paths: string[], b: Box, img: ImageData): number {
  const ink = inkMask(img, b)
  if (!ink) return 0
  const W = b.x1 - b.x0
  const H = b.y1 - b.y0
  const c = new OffscreenCanvas(W, H)
  const g = c.getContext('2d')!
  g.translate(-b.x0, -b.y0)
  for (const d of paths) g.fill(new Path2D(d))
  const a = g.getImageData(0, 0, W, H).data
  let inter = 0, union = 0
  for (let i = 0; i < W * H; i++) {
    const f = a[i * 4 + 3] / 255
    const t = ink[i]
    inter += Math.min(f, t)
    union += Math.max(f, t)
  }
  return union ? inter / union : 0
}
