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
}

const SAMPLE = 200

/**
 * Guesses what kind of artwork an image is, so clients never have to pick a preset:
 * - pixel: small, with hard edges (almost every pixel is one of a few exact colors);
 * - lineart: gray ink on paper (two tones, little color);
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
  if (!total) return { kind: 'flat', hasAlpha, background, gradients: 0 }

  const topShare = (m: Map<number, number>, k: number) =>
    [...m.values()].sort((a, b) => b - a).slice(0, k).reduce((s, v) => s + v, 0) / total

  let kind: ArtKind = 'flat'
  // Pixel art: small, with hard edges, so pixels on a boundary are one color or the other,
  // never a mix. A small anti-aliased logo has mixed edge pixels and stays flat (smooth curves).
  if (Math.max(w, h) <= 256 && softEdgeShare(img) < 0.15) kind = 'pixel'
  else if (gray / total >= 0.95 && extremes / total >= 0.85 && dark / total > 0.005 && dark / total < 0.6) kind = 'lineart'
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
  return { kind, hasAlpha, background, gradients }
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
