import { googleFonts } from './candidates'
import { rankFonts, wordShapes, type FontCandidate, type FontMatch, type WordShapes } from './match'
import { readText, type Box } from './ocr'

export interface TextLine {
  text: string
  shapes: WordShapes[]
  matches: FontMatch[]
  /** Where the line is, in `FontReport.canvas` coordinates. */
  box: Box
}

export interface FontReport {
  lines: TextLine[]
  /** Every distinct character found, for loading font subsets. */
  chars: string
  /** The image the text was read from (upscaled for OCR). */
  canvas: OffscreenCanvas
}

export type FontProgress = { step: 'reading' | 'loading' | 'comparing'; progress: number }

/** Reads the text in an image and cuts out its letter shapes, grouped by text line. */
export async function findText(bitmap: ImageBitmap, colors: number[], onProgress?: (p: FontProgress) => void): Promise<FontReport> {
  const { words, canvas } = await readText(bitmap, colors, (p) => onProgress?.({ step: 'reading', progress: p }))
  const img = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height)
  const byLine = new Map<number, { text: string[]; shapes: WordShapes[]; y: number; box: Box }>()
  // Reading order: lines top to bottom, words left to right.
  const ordered = [...words].sort((a, b) => a.line - b.line || a.box.x0 - b.box.x0)
  for (const w of ordered) {
    const shapes = wordShapes(img, w)
    if (!shapes) continue
    const line = byLine.get(w.line) ?? { text: [], shapes: [], y: w.box.y0, box: { ...w.box } }
    line.box = { x0: Math.min(line.box.x0, w.box.x0), y0: Math.min(line.box.y0, w.box.y0), x1: Math.max(line.box.x1, w.box.x1), y1: Math.max(line.box.y1, w.box.y1) }
    line.text.push(w.text)
    line.shapes.push(shapes)
    byLine.set(w.line, line)
  }
  const lines = [...byLine.values()].sort((a, b) => a.y - b.y).map((l) => ({ text: l.text.join(' '), shapes: l.shapes, matches: [], box: l.box }))
  const chars = [...new Set(lines.flatMap((l) => l.shapes.flatMap((s) => s.glyphs.map((g) => g.char))))].join('')
  return { lines, chars, canvas }
}

/** Free candidates are loaded once per character set and reused across lines and reruns. */
let freeCache: { chars: string; fonts: Promise<FontCandidate[]> } | null = null

/** Ranks fonts for every line: free fonts always, plus installed fonts when provided. */
export async function matchFonts(report: FontReport, installed: FontCandidate[], onProgress?: (p: FontProgress) => void): Promise<TextLine[]> {
  if (!report.lines.length) return []
  if (!freeCache || freeCache.chars !== report.chars) {
    freeCache = { chars: report.chars, fonts: googleFonts(report.chars, (d, t) => onProgress?.({ step: 'loading', progress: d / t })) }
  }
  const candidates = [...installed, ...(await freeCache.fonts)]
  const out: TextLine[] = []
  for (let i = 0; i < report.lines.length; i++) {
    const line = report.lines[i]
    const matches = await rankFonts(line.shapes, candidates, (d, t) => onProgress?.({ step: 'comparing', progress: (i + d / t) / report.lines.length }))
    out.push({ ...line, matches: matches.slice(0, 8) })
  }
  return out
}
