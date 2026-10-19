import { rgbToLab } from '../palette/color'
import { findGradients } from '../palette/gradients'

export type ArtKind = 'flat' | 'photo' | 'lineart' | 'pixel'

export interface Detection {
  kind: ArtKind
  /** The image already has transparent pixels. */
  hasAlpha: boolean
  /** A plain, single-color background along the edges (0xRRGGBB), or null. */
  background: number | null
  /** Smooth gradients found (flat art); they can be kept as SVG gradients. */
  gradients: number
  /**
   * How much of the artwork is fine strokes (0–1): the share of its ink that a 1 px erosion
   * removes. Hairlines and small text are near 1; large shapes only lose their rim.
   */
  fine: number
}

const SAMPLE = 200

/**
 * Guesses what kind of artwork an image is, so clients never have to pick a preset:
 * - pixel: small, with hard edges (almost every pixel is one of a few exact colors);
 * - lineart: gray or black ink of varying tone on light paper (scans, sketches); flat digital
 *   artwork in one ink colour stays flat, which keeps that exact colour;
 * - photo: colors spread over many shades (photos, painterly art);
 * - flat: everything else (logos, illustrations, badges), including flat art with smooth
 *   gradients: those spread over many shades too, but each is explained by one gradient.
 */
export function detectArt(img: ImageData): Detection {
  const { width: w, height: h, data: d } = img
  const step = Math.max(1, Math.ceil(Math.max(w, h) / SAMPLE))

  let total = 0
  let transparent = 0
  let gray = 0
  let extremes = 0
  let dark = 0
  const bins = new Map<number, number>()
  const exact = new Map<number, number>()
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4
      if (d[i + 3] < 250) {
        transparent++
        if (d[i + 3] < 128) continue
      }
      const r = d[i], g = d[i + 1], b = d[i + 2]
      total++
      if (Math.max(r, g, b) - Math.min(r, g, b) < 28) gray++
      const luma = 0.299 * r + 0.587 * g + 0.114 * b
      if (luma < 90 || luma > 170) extremes++
      if (luma < 90) dark++
      const bin = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)
      bins.set(bin, (bins.get(bin) ?? 0) + 1)
      if (exact.size < 4096 || exact.has((r << 16) | (g << 8) | b)) {
        const key = (r << 16) | (g << 8) | b
        exact.set(key, (exact.get(key) ?? 0) + 1)
      }
    }
  }

  const hasAlpha = transparent > 0
  const background = edgeBackground(img)
  if (!total) return { kind: 'flat', hasAlpha, background, gradients: 0, fine: 0 }

  const topShare = (m: Map<number, number>, k: number) =>
    [...m.values()].sort((a, b) => b - a).slice(0, k).reduce((s, v) => s + v, 0) / total

  let kind: ArtKind = 'flat'
  // Pixel art: small, with hard edges, so pixels on a boundary are one color or the other,
  // never a mix. A small anti-aliased logo has mixed edge pixels and stays flat (smooth curves).
  // Straight edges that happen to sit on pixel boundaries are hard in any crisp logo, so the
  // decision rests on the diagonal and curved boundaries: pixel art draws those as hard
  // staircases too, while a logo still anti-aliases them (a shield's curved base, the rounded
  // corners of a speech bubble). Artwork with almost no such boundaries (only rectangles) has
  // nothing to tell it by and stays flat, which traces rectangles exactly.
  if (Math.max(w, h) <= 256 && softEdgeShare(img) < 0.15) {
    const curves = softCurveShare(img)
    if (curves !== null && curves < 0.15) kind = 'pixel'
  }
  else if (gray / total >= 0.8 && extremes / total >= 0.85 && dark / total > 0.005 && dark / total < 0.6) {
    // Judge the ink, not the whole image: the paper dominates most pictures, so a small coloured
    // accent or a tinted dark colour would otherwise be lost to black ink.
    const ink = inkStats(img, step, hasAlpha ? null : (background ?? dominant(exact)))
    // Uniform ink is flat digital art; it's only drawn as black line art when it's black already.
    if (ink.neutral >= 0.9 && (ink.uniform < 0.7 || ink.lightness <= BLACK_INK)) kind = 'lineart'
  }
  let gradients = 0
  if (kind === 'flat') {
    const sample = sampled(img, step)
    const found = findGradients(sample, { minArea: Math.max(60, sample.width * sample.height * 0.01) })
    gradients = found.length
    if (topShare(bins, 24) < 0.6 && !flatWithGradients(sample, found)) {
      kind = 'photo'
      gradients = 0
    }
  }
  return { kind, hasAlpha, background, gradients, fine: fineShare(img, hasAlpha ? null : (background ?? dominant(exact))) }
}

/**
 * The share of ink (pixels clearly unlike the paper, or opaque on transparent art) that has a
 * non-ink pixel among its 8 neighbours. Large images are read every `step` pixels, which only
 * happens when their features are large anyway.
 */
function fineShare(img: ImageData, paper: number | null): number {
  const step = Math.max(1, Math.ceil(Math.max(img.width, img.height) / 1600))
  const w = Math.ceil(img.width / step)
  const h = Math.ceil(img.height / step)
  const d = img.data
  const pr = paper === null ? 0 : (paper >> 16) & 255
  const pg = paper === null ? 0 : (paper >> 8) & 255
  const pb = paper === null ? 0 : paper & 255
  const ink = new Uint8Array(w * h)
  let count = 0
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * step * img.width + x * step) * 4
      if (d[i + 3] < 128) continue
      if (paper !== null && Math.max(Math.abs(d[i] - pr), Math.abs(d[i + 1] - pg), Math.abs(d[i + 2] - pb)) <= 40) continue
      ink[y * w + x] = 1
      count++
    }
  if (count < w * h * 0.002) return 0
  let edge = 0
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (!ink[y * w + x]) continue
      let rim = x === 0 || y === 0 || x === w - 1 || y === h - 1
      for (let dy = -1; dy <= 1 && !rim; dy++) for (let dx = -1; dx <= 1 && !rim; dx++) if (!ink[(y + dy) * w + x + dx]) rim = true
      if (rim) edge++
    }
  return edge / count
}

/** The most common exact colour among the samples. */
function dominant(exact: Map<number, number>): number {
  let best = 0
  let n = -1
  for (const [k, v] of exact) if (v > n) [best, n] = [k, v]
  return best
}

/** Lab chroma below this is neutral (gray/black) ink. Black is 0; a dark navy like #2b2d42 is 14. */
const NEUTRAL_CHROMA = 10
/** Ink at most this light (L*, about #303030) is near-black, as scanned or printed black ink is. */
const BLACK_INK = 20

/**
 * The ink: sampled pixels clearly unlike the paper (or, on transparent art, all opaque pixels).
 * `neutral` is the share of ink with little colour. `uniform` is the share of solid ink (far from
 * the paper) within a small distance of its median colour: flat digital art is close to 1,
 * scanned or drawn ink, whose tone varies, is lower. `lightness` is the solid ink's median L*.
 */
function inkStats(img: ImageData, step: number, paper: number | null): { neutral: number; uniform: number; lightness: number } {
  const { width: w, height: h, data: d } = img
  const pr = paper === null ? 0 : (paper >> 16) & 255
  const pg = paper === null ? 0 : (paper >> 8) & 255
  const pb = paper === null ? 0 : paper & 255
  let ink = 0
  let neutral = 0
  const solid: number[] = []
  for (let y = 0; y < h; y += step)
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4
      if (d[i + 3] < 128) continue
      const r = d[i], g = d[i + 1], b = d[i + 2]
      const diff = paper === null ? 255 : Math.max(Math.abs(r - pr), Math.abs(g - pg), Math.abs(b - pb))
      if (diff <= 48) continue
      ink++
      const [, A, B] = rgbToLab([r, g, b])
      if (Math.hypot(A, B) < NEUTRAL_CHROMA) neutral++
      if (diff > 96) solid.push((r << 16) | (g << 8) | b)
    }
  if (!ink) return { neutral: 0, uniform: 1, lightness: 100 }
  const median = (shift: number) => solid.map((c) => (c >> shift) & 255).sort((a, b) => a - b)[solid.length >> 1] ?? 0
  const [mr, mg, mb] = [median(16), median(8), median(0)]
  const near = solid.filter((c) => Math.max(Math.abs(((c >> 16) & 255) - mr), Math.abs(((c >> 8) & 255) - mg), Math.abs((c & 255) - mb)) <= 16).length
  return { neutral: neutral / ink, uniform: solid.length ? near / solid.length : 1, lightness: rgbToLab([mr, mg, mb])[0] }
}

/** Every `step`-th pixel, as a small image. */
function sampled(img: ImageData, step: number): ImageData {
  const w = Math.ceil(img.width / step)
  const h = Math.ceil(img.height / step)
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * step * img.width + x * step) * 4
      data.set(img.data.subarray(i, i + 4), (y * w + x) * 4)
    }
  return { width: w, height: h, data } as ImageData
}

/**
 * Many shades, but explained by gradients: outside the gradients, a few colors cover nearly
 * everything (as in flat art).
 */
function flatWithGradients(img: ImageData, found: { pixels: Uint32Array }[]): boolean {
  if (!found.length) return false
  const inGradient = new Uint8Array(img.width * img.height)
  for (const g of found) for (const p of g.pixels) inGradient[p] = 1
  const bins = new Map<number, number>()
  let rest = 0
  let covered = 0
  const d = img.data
  for (let p = 0; p < inGradient.length; p++) {
    if (d[p * 4 + 3] < 128) continue
    if (inGradient[p]) {
      covered++
      continue
    }
    rest++
    const bin = ((d[p * 4] >> 3) << 10) | ((d[p * 4 + 1] >> 3) << 5) | (d[p * 4 + 2] >> 3)
    bins.set(bin, (bins.get(bin) ?? 0) + 1)
  }
  const top = [...bins.values()].sort((a, b) => b - a).slice(0, 24).reduce((s, v) => s + v, 0)
  // Edges between shapes add stray shades, as anti-aliasing does in any flat art.
  return covered + top >= (covered + rest) * 0.8
}

/**
 * Of the pixels whose left and right neighbors differ, the share that are a mix of the two
 * (anti-aliasing). Pixel art scores near 0; smooth artwork scores high.
 */
function softEdgeShare(img: ImageData): number {
  const { width: w, height: h, data: d } = img
  let edges = 0
  let soft = 0
  for (let y = 0; y < h; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = (y * w + x) * 4
      const a = i - 4
      const b = i + 4
      if (d[a + 3] < 128 || d[b + 3] < 128 || d[i + 3] < 128) continue
      const ab = Math.abs(d[a] - d[b]) + Math.abs(d[a + 1] - d[b + 1]) + Math.abs(d[a + 2] - d[b + 2])
      if (ab < 60) continue
      edges++
      const ca = Math.abs(d[i] - d[a]) + Math.abs(d[i + 1] - d[a + 1]) + Math.abs(d[i + 2] - d[a + 2])
      const cb = Math.abs(d[i] - d[b]) + Math.abs(d[i + 1] - d[b + 1]) + Math.abs(d[i + 2] - d[b + 2])
      // A mix sits strictly between its neighbors: different from both, and not farther out.
      if (ca > 24 && cb > 24 && ca + cb < ab * 1.25) soft++
    }
  }
  return edges ? soft / edges : 1
}

/**
 * Diagonal or curved boundary pixels needed before softCurveShare decides anything: at least
 * this many, and this share of all left–right edge pixels. A logo of rectangles has a hard
 * corner pixel at each corner (about 5% of its edge pixels); pixel art's staircases are a large
 * share (about 25% for 4-pixel blocks, more for sprites).
 */
const MIN_CURVE_EDGES = 12
const MIN_CURVE_SHARE = 0.1

/**
 * At boundaries that run diagonally or curve (a pixel's neighbours differ both left–right and
 * up–down), the share of pixels that are a mix of their neighbours on either axis. Pixel art
 * scores near 0 (hard staircases); anti-aliased artwork scores high. Null when there are fewer
 * than MIN_CURVE_EDGES such pixels, or fewer than MIN_CURVE_SHARE of the left–right edge pixels.
 */
function softCurveShare(img: ImageData): number | null {
  const { width: w, height: h, data: d } = img
  const diff = (a: number, b: number) => Math.abs(d[a] - d[b]) + Math.abs(d[a + 1] - d[b + 1]) + Math.abs(d[a + 2] - d[b + 2])
  // A mix sits strictly between its neighbours: different from both, and not farther out.
  const mix = (i: number, a: number, b: number) => {
    const ab = diff(a, b)
    const ca = diff(i, a)
    const cb = diff(i, b)
    return ca > 24 && cb > 24 && ca + cb < ab * 1.25
  }
  let across = 0
  let edges = 0
  let soft = 0
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = (y * w + x) * 4
      const l = i - 4, r = i + 4, u = i - w * 4, dn = i + w * 4
      if (d[i + 3] < 128 || d[l + 3] < 128 || d[r + 3] < 128 || d[u + 3] < 128 || d[dn + 3] < 128) continue
      if (diff(l, r) < 60) continue
      across++
      if (diff(u, dn) < 60) continue
      edges++
      if (mix(i, l, r) || mix(i, u, dn)) soft++
    }
  return edges >= MIN_CURVE_EDGES && edges >= across * MIN_CURVE_SHARE ? soft / edges : null
}

/** Most common opaque color along the border, if it clearly dominates. */
function edgeBackground(img: ImageData): number | null {
  const { width: w, height: h, data: d } = img
  const counts = new Map<number, { n: number; r: number; g: number; b: number }>()
  let total = 0
  const add = (x: number, y: number) => {
    const i = (y * w + x) * 4
    if (d[i + 3] < 250) return
    const key = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4)
    const e = counts.get(key) ?? { n: 0, r: 0, g: 0, b: 0 }
    e.n++
    e.r += d[i]
    e.g += d[i + 1]
    e.b += d[i + 2]
    counts.set(key, e)
    total++
  }
  const sx = Math.max(1, Math.floor(w / 400))
  const sy = Math.max(1, Math.floor(h / 400))
  for (let x = 0; x < w; x += sx) {
    add(x, 0)
    add(x, h - 1)
  }
  for (let y = 0; y < h; y += sy) {
    add(0, y)
    add(w - 1, y)
  }
  let best: { n: number; r: number; g: number; b: number } | null = null
  for (const e of counts.values()) if (!best || e.n > best.n) best = e
  if (!best || best.n < total * 0.6) return null
  return (Math.round(best.r / best.n) << 16) | (Math.round(best.g / best.n) << 8) | Math.round(best.b / best.n)
}
