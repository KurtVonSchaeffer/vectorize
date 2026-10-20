import { rgbToLab } from '../palette/color'
import type { LabelMap } from '../trace'

/**
 * Paper: the light background of an opaque upload (a JPEG or a flattened PNG), which in print and
 * cut files is the material, not an ink. Only the background connected to the image border is
 * paper. White inside the artwork (white lettering on a blue badge, the white of an eye) is
 * intentional and stays a shape, so it can still be printed in white ink on a coloured garment.
 *
 * A background counts as paper only when it is light and neutral, and frames the artwork: it
 * covers most of the border and every side of it. A white stripe that touches only two edges (the
 * Mexican flag's) is artwork, not paper.
 */

/** Lab lightness and chroma limits for paper. */
export const PAPER_MIN_L = 92
export const PAPER_MAX_CHROMA = 8
/** Share of all border pixels, and of each side's pixels, that must be the background. */
export const PAPER_BORDER = 0.9
export const PAPER_SIDE = 0.75
/** At most this share of the upload's pixels may be less than opaque. */
const PAPER_MAX_TRANSLUCENT = 0.005

/** The paper pixels (1) of the map, or null when its background isn't paper. */
export function paperMask(map: LabelMap, bgLabel: number, image: ImageData): Uint8Array | null {
  const { w, h, labels, colors } = map
  if (bgLabel < 0 || colors[bgLabel] < 0 || image.width !== w || image.height !== h) return null
  let translucent = 0
  for (let i = 3; i < image.data.length; i += 4) if (image.data[i] < 255) translucent++
  if (translucent > PAPER_MAX_TRANSLUCENT * w * h) return null
  const c = colors[bgLabel]
  const [L, a, b] = rgbToLab([(c >> 16) & 255, (c >> 8) & 255, c & 255])
  if (L < PAPER_MIN_L || Math.hypot(a, b) > PAPER_MAX_CHROMA) return null

  // Frames the artwork: most of the border, and every side.
  const sides = [
    Array.from({ length: w }, (_, x) => x),
    Array.from({ length: w }, (_, x) => (h - 1) * w + x),
    Array.from({ length: h }, (_, y) => y * w),
    Array.from({ length: h }, (_, y) => y * w + w - 1),
  ]
  let on = 0
  let total = 0
  for (const side of sides) {
    const n = side.filter((p) => labels[p] === bgLabel).length
    if (n < PAPER_SIDE * side.length) return null
    on += n
    total += side.length
  }
  if (on < PAPER_BORDER * total) return null

  // The background reachable from the border (4-connected).
  const mask = new Uint8Array(w * h)
  const stack: number[] = []
  for (const side of sides) for (const p of side) if (labels[p] === bgLabel && !mask[p]) (mask[p] = 1), stack.push(p)
  while (stack.length) {
    const p = stack.pop()!
    const x = p % w
    for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w])
      if (q >= 0 && q < w * h && !mask[q] && labels[q] === bgLabel) (mask[q] = 1), stack.push(q)
  }
  return mask
}

/** Labels from this value up are paper / empty: no shape (see LabelMap). */
const PAPER = 254

/**
 * The map with the paper pixels made empty (no shape). Anti-aliased artwork pixels that blend into
 * the paper now blend into nothing, as they do against a transparent background, so artwork edges
 * stay where they were. The background colour keeps its enclosed areas.
 */
export function withPaper(map: LabelMap, bgLabel: number, mask: Uint8Array): LabelMap {
  const { w, h } = map
  const labels = map.labels.slice()
  const second = map.second.slice()
  for (let p = 0; p < w * h; p++) {
    if (mask[p]) {
      labels[p] = PAPER
      if (second[p] === bgLabel) second[p] = PAPER
      continue
    }
    if (second[p] !== bgLabel) continue
    const x = p % w
    if ((x > 0 && mask[p - 1]) || (x < w - 1 && mask[p + 1]) || (p >= w && mask[p - w]) || (p + w < w * h && mask[p + w])) second[p] = PAPER
  }
  return { ...map, labels, second }
}
