import { systemFonts } from './candidates'
import { loadIndex, loadStyles, screen } from './catalog'
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
  /** OCR canvas pixels per source image pixel. */
  scale: number
}

export type FontProgress = { step: 'reading' | 'loading' | 'comparing'; progress: number }

/**
 * Reads the text in an image and cuts out its letter shapes, grouped by text line. `alsoRead`: a
 * second version of the same image (the original upload, when `bitmap` is a sharpened copy) whose
 * readings are recorded on each word, so a disagreement between them marks the text as uncertain
 * (see PlacedWord.doubts). Agreement isn't taken as proof of anything.
 */
export async function findText(bitmap: ImageBitmap, colors: number[], onProgress?: (p: FontProgress) => void, alsoRead?: ImageBitmap): Promise<FontReport> {
  const { words, canvas, scale } = await readText(bitmap, colors, (p) => onProgress?.({ step: 'reading', progress: alsoRead ? p / 2 : p }))
  if (alsoRead) {
    const second = await readText(alsoRead, colors, (p) => onProgress?.({ step: 'reading', progress: 0.5 + p / 2 }))
    // Both in fractions of the image, to compare places.
    const norm = (b: Box, w: number, h: number) => ({ x0: b.x0 / w, y0: b.y0 / h, x1: b.x1 / w, y1: b.y1 / h })
    for (const w of words) {
      const a = norm(w.box, canvas.width, canvas.height)
      for (const o of second.words) {
        const b = norm(o.box, second.canvas.width, second.canvas.height)
        const ix = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0))
        const iy = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0))
        const area = (r: Box) => (r.x1 - r.x0) * (r.y1 - r.y0)
        const same = (ix * iy) / Math.max(area(a), area(b)) > 0.6
        if (same && o.text !== w.text && !(w.readings ?? []).includes(o.text)) w.readings = [...(w.readings ?? []), o.text]
      }
    }
  }
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
  return { lines, chars, canvas, scale }
}

/**
 * Ranks fonts for every line. Candidates: the best few dozen styles from the full free catalog
 * (screened by letter fingerprints), the common fonts on this computer, and installed fonts
 * when provided.
 */
export async function matchFonts(report: FontReport, installed: FontCandidate[], onProgress?: (p: FontProgress) => void): Promise<TextLine[]> {
  if (!report.lines.length) return []
  onProgress?.({ step: 'loading', progress: 0 })
  const [index, system] = await Promise.all([loadIndex(report.chars), systemFonts()])
  const out: TextLine[] = []
  for (let i = 0; i < report.lines.length; i++) {
    const line = report.lines[i]
    const shortlist = screen(index, line.shapes, 48)
    const free = await loadStyles(index, shortlist, (d, t) => onProgress?.({ step: 'loading', progress: (i + d / t) / report.lines.length }))
    const matches = await rankFonts(line.shapes, [...installed, ...system, ...free], (d, t) => onProgress?.({ step: 'comparing', progress: (i + d / t) / report.lines.length }))
    out.push({ ...line, matches: matches.slice(0, 8) })
  }
  return out
}
