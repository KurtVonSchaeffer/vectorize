import type { Box } from './ocr'

/**
 * Lettering lines shorter than this, in source pixels, lose strokes when traced. Measured lines: a
 * 10 px tagline (7 px) came out illegible and 10 px capitals (10.5 px) rough, while 12 px capitals
 * (12.8 px) and larger traced cleanly.
 */
export const SMALL_TEXT_PX = 12

/** Height of the shortest text line, in source pixels; null when no text was found. */
export function smallestTextLine(report: { lines: { box: Box }[]; scale: number }): number | null {
  const heights = report.lines.map((l) => (l.box.y1 - l.box.y0) / report.scale)
  return heights.length ? Math.min(...heights) : null
}
