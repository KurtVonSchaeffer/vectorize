import type { Font } from 'opentype.js'
import { fontFile } from './candidates'
import type { FontReport, TextLine } from './identify'
import { inkMask, type FontCandidate } from './match'
import type { Box } from './ocr'
import { scalePath } from './path'

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

const fonts = new Map<string, Promise<Font>>()

async function loadFont(font: FontCandidate): Promise<Font> {
  const key = `${font.source}|${font.family}|${font.weight}`
  let f = fonts.get(key)
  if (!f) {
    f = Promise.all([import('opentype.js'), fontFile(font)]).then(([opentype, buf]) => opentype.parse(buf))
    f.catch(() => fonts.delete(key))
    fonts.set(key, f)
  }
  return f
}

export async function placeLine(report: FontReport, line: TextLine, match: FontCandidate): Promise<LineLettering> {
  const font = await loadFont(match)
  const img = report.canvas.getContext('2d')!.getImageData(0, 0, report.canvas.width, report.canvas.height)
  const words: PlacedWord[] = []
  let skipped = 0
  for (const w of line.shapes) {
    const placed = w.complete ? placeWord(font, w.glyphs, w.box, img) : null
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
function placeWord(font: Font, glyphs: { char: string; box: Box }[], wordBox: Box, img: ImageData): { letters: { char: string; d: string }[]; box: Box } | null {
  const outlines = glyphs.map((g) => {
    const glyph = font.charToGlyph(g.char)
    const bb = glyph.getBoundingBox()
    return { g, glyph, bb, ok: glyph.index !== 0 && bb.x2 > bb.x1 && bb.y2 > bb.y1 }
  })
  if (outlines.some((o) => !o.ok)) return null

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
    return { char: g.char, d: glyph.getPath(x, y0, size).toPathData(2) }
  })
  const box: Box = {
    x0: Math.min(...outlines.map((o) => o.g.box.x0)),
    y0: Math.min(...outlines.map((o) => o.g.box.y0)),
    x1: Math.max(...outlines.map((o) => o.g.box.x1)),
    y1: Math.max(...outlines.map((o) => o.g.box.y1)),
  }
  if (overlap(letters.map((l) => l.d), wordBox, img) < MIN_OVERLAP) return null
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
