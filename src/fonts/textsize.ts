import type { Box } from './ocr'

/**
 * Lettering lines shorter than this, in source pixels, lose strokes when traced. Measured lines: a
 * 10 px tagline (7 px) came out illegible and 10 px capitals (10.5 px) rough, while 12 px capitals
 * (12.8 px) and larger traced cleanly.
 */
export const SMALL_TEXT_PX = 12

/**
 * Lines that read as real words: at least one run of 3 letters or digits. Shapes misread as text
 * ("[v4", "AA" in an illustration) don't count.
 */
export const WORDLIKE = /[\p{L}\p{N}]{3}/u

/** Height of the shortest text line, in source pixels; null when no text was found. */
export function smallestTextLine(report: { lines: { text: string; box: Box }[]; scale: number }): number | null {
  const heights = report.lines.filter((l) => WORDLIKE.test(l.text)).map((l) => (l.box.y1 - l.box.y0) / report.scale)
  return heights.length ? Math.min(...heights) : null
}

/** The words that read as real words, as boxes in source pixels [x0, y0, x1, y1]. */
export function wordBoxes(report: { lines: { shapes: { text: string; box: Box }[] }[]; scale: number }): [number, number, number, number][] {
  return report.lines.flatMap((l) => l.shapes.filter((s) => WORDLIKE.test(s.text)).map((s) => [s.box.x0, s.box.y0, s.box.x1, s.box.y1].map((v) => v / report.scale) as [number, number, number, number]))
}
