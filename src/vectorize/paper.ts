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

/** Below this share of the image, enclosed paper-coloured areas are noise, not a question. */
const ENCLOSED_MIN_SHARE = 0.001

/**
 * Whether the artwork encloses areas of the paper colour (the inside of an "o", white lettering on a
 * badge). Nothing in the image says whether they are intentional white or paper showing through, so
 * the white-ink choice decides, and the person should be told.
 */
export function enclosesPaper(map: LabelMap, bgLabel: number, mask: Uint8Array): boolean {
  let n = 0
  for (let p = 0; p < mask.length; p++) if (!mask[p] && map.labels[p] === bgLabel) n++
  return n >= Math.max(9, ENCLOSED_MIN_SHARE * mask.length)
}

/**
 * White ink in print and cut files for artwork on paper: none (white garments), the white inside
 * the artwork only (coloured garments), or the background too (today's files).
 */
export type WhiteInk = 'none' | 'artwork' | 'all'

/** The paper option print plates are made with for a white-ink choice (undefined: as today). */
export const paperOutFor = (mode: WhiteInk): 'border' | 'all' | undefined => (mode === 'none' ? 'all' : mode === 'artwork' ? 'border' : undefined)

/** An area of the paper colour that the artwork encloses (not connected to the paper background). */
export interface EnclosedRegion {
  /** Its pixels (indices into the map). */
  pixels: number[]
  area: number
  box: [number, number, number, number]
  /** The largest distance from inside it to its edge (px): half its thickness. */
  inradius: number
  /** Its most central pixel (index into the map). */
  centre: number
  /** Labels around it, with how many edge pixels touch each. */
  neighbours: Map<number, number>
  /**
   * How far the artwork around it reaches before the paper background (px, median over its edge):
   * the stroke width of a letter around a counter, the size of a body around an eye.
   */
  rim: number
}

/** Chamfer (3-4) distance from every pixel to the nearest `seed` pixel, through pixels where `pass` is true. */
function distanceFrom(w: number, h: number, seed: (p: number) => boolean, pass: (p: number) => boolean): Float32Array {
  const d = new Float32Array(w * h).fill(Infinity)
  for (let p = 0; p < w * h; p++) if (seed(p)) d[p] = 0
  const relax = (p: number, q: number, c: number) => {
    if (d[q] + c < d[p]) d[p] = d[q] + c
  }
  for (let pass2 = 0; pass2 < 2; pass2++) {
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const p = y * w + x
        if (d[p] === 0 || !pass(p)) continue
        if (x > 0) relax(p, p - 1, 3)
        if (y > 0) relax(p, p - w, 3)
        if (x > 0 && y > 0) relax(p, p - w - 1, 4)
        if (x < w - 1 && y > 0) relax(p, p - w + 1, 4)
      }
    for (let y = h - 1; y >= 0; y--)
      for (let x = w - 1; x >= 0; x--) {
        const p = y * w + x
        if (d[p] === 0 || !pass(p)) continue
        if (x < w - 1) relax(p, p + 1, 3)
        if (y < h - 1) relax(p, p + w, 3)
        if (x < w - 1 && y < h - 1) relax(p, p + w + 1, 4)
        if (x > 0 && y < h - 1) relax(p, p + w - 1, 4)
      }
  }
  for (let p = 0; p < w * h; p++) d[p] /= 3
  return d
}

/** The enclosed paper-coloured areas of a map on paper, with what surrounds each. */
export function enclosedRegions(map: LabelMap, bgLabel: number, mask: Uint8Array): EnclosedRegion[] {
  const { w, h, labels } = map
  const n = w * h
  const comp = new Int32Array(n).fill(-1)
  const regions: number[][] = []
  for (let s = 0; s < n; s++) {
    if (mask[s] || labels[s] !== bgLabel || comp[s] >= 0) continue
    const id = regions.length
    const px: number[] = [s]
    comp[s] = id
    for (let i = 0; i < px.length; i++) {
      const p = px[i]
      const x = p % w
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w])
        if (q >= 0 && q < n && comp[q] < 0 && !mask[q] && labels[q] === bgLabel) (comp[q] = id), px.push(q)
    }
    regions.push(px)
  }
  if (!regions.length) return []
  // Distance through the artwork to the paper background, and inside each region to its edge.
  const toPaper = distanceFrom(w, h, (p) => !!mask[p], (p) => !mask[p])
  const toEdge = distanceFrom(w, h, (p) => comp[p] < 0, (p) => comp[p] >= 0)
  return regions.map((px, id) => {
    let x0 = w, y0 = h, x1 = 0, y1 = 0, inradius = 0, centre = px[0]
    const neighbours = new Map<number, number>()
    const rims: number[] = []
    for (const p of px) {
      const x = p % w, y = (p - x) / w
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + 1); y1 = Math.max(y1, y + 1)
      if (toEdge[p] > inradius) (inradius = toEdge[p]), (centre = p)
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w])
        if (q >= 0 && q < n && comp[q] !== id) {
          neighbours.set(labels[q], (neighbours.get(labels[q]) ?? 0) + 1)
          rims.push(toPaper[q])
        }
    }
    rims.sort((a, b) => a - b)
    return { pixels: px, area: px.length, box: [x0, y0, x1, y1], inradius, centre, neighbours, rim: rims[rims.length >> 1] ?? 0 }
  })
}

/** An enclosed paper-coloured area in print plates made with 'border', and what became of it. */
export interface EnclosedArea {
  box: [number, number, number, number]
  /** A point inside it (pixel centre), to show it and to refer to it in a choice. */
  at: [number, number]
  area: number
  /**
   * 'counter': inside a letter of text printed on the paper, so it is paper (left out).
   * 'white' / 'garment': printed in white ink, or left out.
   */
  kind: 'counter' | 'white' | 'garment'
  /** Decided: a counter, or the person chose. Otherwise it is white by default and needs checking. */
  decided: boolean
  /**
   * Thinner than THIN_SHARE of the long side (1 mm at the 254 mm print size): usually slivers where
   * blended edge colours meet, but possibly a fine white line, so checked as a group.
   */
  thin: boolean
}

/** A person's choice for one enclosed area, by a point inside it. */
export interface WhiteChoice {
  at: [number, number]
  white: boolean
}

/** Share of a word's box that must be the paper background for the word to be printed on the paper. */
const WORD_ON_PAPER = 0.2

/** Colour difference (Lab) from the paper above which a colour is solid ink, not a blended halo. */
const SOLID_INK = 20
/** How far (share of the long side) from an area to look through blended halo for its letter. */
const HALO_SHARE = 0.008
/** Half-thickness (share of the long side) below which an area is thin: 0.5 mm of 254 mm. */
const THIN_SHARE = 0.5 / 254

/** How far (share of the word's height) a letter's ink may reach past the word's OCR box. */
const WORD_MARGIN = 0.08
/** A counter's letter is at most this share of its word's width (a word has several letters). */
const LETTER_MAX_WIDTH = 0.6

/**
 * Splits the enclosed paper-coloured areas for 'border' (white artwork only). Only one case is
 * decided from the image: an area inside one letter of a word of text that sits on the paper is a
 * counter (the inside of an "o"), paper showing through the letter. The letter (the ink around the
 * area) must lie inside the word and be narrower than most of it, so a shape misread as a word (a
 * logo read as "AAA") doesn't make its white eye a counter; joined script lettering stays undecided. Nothing else in the image tells white
 * artwork (an eye, a belly, white lettering on a badge) from paper inside an outline (a ring), so
 * every other area prints white, as the choice says, and is reported undecided for a person to check,
 * unless `choices` already says.
 *
 * Returns the paper mask with the areas left out added, and what became of each area.
 */
export function splitEnclosed(map: LabelMap, bgLabel: number, mask: Uint8Array, words: [number, number, number, number][], choices: WhiteChoice[]): { mask: Uint8Array; areas: EnclosedArea[] } {
  const { w } = map
  const regions = enclosedRegions(map, bgLabel, mask)
  const out = mask.slice()
  // A word is on the paper when the paper surrounds it: measured in the word's box widened by half
  // its height (a tight box is mostly letters and their halos; a badge's lettering has the badge around it).
  const onPaper = words.filter(([x0, y0, x1, y1]) => {
    const g = 0.5 * (y1 - y0)
    let n = 0, all = 0
    for (let y = Math.max(0, Math.floor(y0 - g)); y < Math.min(map.h, Math.ceil(y1 + g)); y++)
      for (let x = Math.max(0, Math.floor(x0 - g)); x < Math.min(w, Math.ceil(x1 + g)); x++) (all++, (n += mask[y * w + x]))
    return all > 0 && n >= WORD_ON_PAPER * all
  })
  // Each letter's solid ink (colours clearly unlike the paper; halos of blended colour between
  // letters would join a word into one shape), and the ink reached from an area through any halo.
  const n = w * map.h
  const pc = map.colors[bgLabel]
  const paperLab = rgbToLab([(pc >> 16) & 255, (pc >> 8) & 255, pc & 255])
  const solid = map.colors.map((c) => {
    if (c < 0) return false
    const lab = rgbToLab([(c >> 16) & 255, (c >> 8) & 255, c & 255])
    return Math.hypot(lab[0] - paperLab[0], lab[1] - paperLab[1], lab[2] - paperLab[2]) >= SOLID_INK
  })
  const isSolid = (p: number) => !mask[p] && map.labels[p] < map.colors.length && solid[map.labels[p]]
  const ink = new Int32Array(n).fill(-1)
  const inkBox: [number, number, number, number][] = []
  for (let s0 = 0; s0 < n; s0++) {
    if (!isSolid(s0) || ink[s0] >= 0) continue
    const id = inkBox.length
    const box: [number, number, number, number] = [w, map.h, 0, 0]
    const stack = [s0]
    ink[s0] = id
    while (stack.length) {
      const p = stack.pop()!
      const x = p % w, y = (p - x) / w
      box[0] = Math.min(box[0], x); box[1] = Math.min(box[1], y); box[2] = Math.max(box[2], x + 1); box[3] = Math.max(box[3], y + 1)
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w])
        if (q >= 0 && q < n && ink[q] < 0 && isSolid(q)) (ink[q] = id), stack.push(q)
    }
    inkBox.push(box)
  }
  const halo = Math.max(2, HALO_SHARE * Math.max(w, map.h))
  const letterOf = (r: EnclosedRegion): [number, number, number, number] | null => {
    const ids = new Set<number>()
    const seen = new Map<number, number>()
    let front = r.pixels
    for (const p of front) seen.set(p, 0)
    for (let depth = 1; depth <= halo && front.length; depth++) {
      const next: number[] = []
      for (const p of front) {
        const x = p % w
        for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w]) {
          if (q < 0 || q >= n || seen.has(q) || mask[q]) continue
          seen.set(q, depth)
          if (ink[q] >= 0) ids.add(ink[q])
          else next.push(q)
        }
      }
      front = next
    }
    if (!ids.size) return null
    const bs = [...ids].map((i) => inkBox[i])
    return [Math.min(...bs.map((b) => b[0])), Math.min(...bs.map((b) => b[1])), Math.max(...bs.map((b) => b[2])), Math.max(...bs.map((b) => b[3]))]
  }
  const thin = Math.max(1, THIN_SHARE * Math.max(w, map.h))
  const areas = regions.map((r): EnclosedArea => {
    const inside = new Set(r.pixels)
    const choice = choices.find(({ at: [x, y] }) => inside.has(Math.floor(y) * w + Math.floor(x)))
    const letter = letterOf(r)
    const counter =
      !!letter &&
      onPaper.some(([a, b, c, d]) => {
        // OCR boxes are tighter than blurred ink: a margin of a little of the word's height.
        const m = Math.max(1, WORD_MARGIN * (d - b))
        return letter[0] >= a - m && letter[1] >= b - m && letter[2] <= c + m && letter[3] <= d + m && letter[2] - letter[0] <= LETTER_MAX_WIDTH * (c - a)
      })
    const kind = choice ? (choice.white ? 'white' : 'garment') : counter ? 'counter' : 'white'
    if (kind !== 'white') for (const p of r.pixels) out[p] = 1
    const cx = r.centre % w
    return { box: r.box, at: [cx + 0.5, (r.centre - cx) / w + 0.5], area: r.area, kind, decided: !!choice || counter, thin: r.inradius < thin }
  })
  return { mask: out, areas }
}
