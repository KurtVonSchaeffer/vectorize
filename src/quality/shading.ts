import { deltaE2000, rgbToLab, type Lab } from '../palette/color'
import { rasterizeSvg } from './render'

/** A colour difference (ΔE2000) above this inside the artwork is visible shading that was lost. */
export const SHADING_DE = 6

/**
 * A flat result has lost visible shading (gradients flattened into flat colour) when at least
 * this share of the artwork misses the upload's colour by more than SHADING_DE, with at least
 * this mean ΔE. Measured on the acceptance samples: a multi-colour gradient logo flattened into
 * 12 inks scored 35% / 5.9; flat logos 0% / ≤ 0.3; simple gradients kept as gradients 11% / 3.0.
 */
export const SHADING_LOST_SHARE = 0.25
export const SHADING_LOST_MEAN = 4

export interface ShadingLoss {
  /** Share of the upload's smooth interior pixels whose colour the vector misses by more than SHADING_DE (0–1). */
  share: number
  /** Mean ΔE2000 over those interior pixels. */
  meanDeltaE: number
}

/**
 * How much smooth shading the vector loses against the upload, away from edges. Interior pixels
 * are opaque pixels of the upload whose 8 neighbours are all within 20 levels of them, so flat
 * colour and gentle gradients count and edges, anti-aliasing and most compression ripple don't.
 * The background (the most common colour) is left out, so the share is of
 * the artwork itself.
 * Flat artwork traced as flat colour scores near 0; gradients flattened into bands score high.
 */
export function shadingLoss(upload: ImageData, vector: ImageData, smooth = 20): ShadingLoss {
  const { width: w, height: h, data: u } = upload
  const v = vector.data
  if (vector.width !== w || vector.height !== h) throw new RangeError('Images must be the same size')
  const labs = new Map<number, Lab>()
  const lab = (d: Uint8ClampedArray, i: number, a: number) => {
    // Composited over white, as both are shown.
    const k = a / 255
    const r = Math.round(d[i] * k + 255 * (1 - k)), g = Math.round(d[i + 1] * k + 255 * (1 - k)), b = Math.round(d[i + 2] * k + 255 * (1 - k))
    const key = (r << 16) | (g << 8) | b
    let l = labs.get(key)
    if (!l) labs.set(key, (l = rgbToLab([r, g, b])))
    return l
  }
  // The background: the image's most common colour (coarsely binned). Not the border colour: a
  // faint frame or vignette along the edge would hide a white background.
  const votes = new Map<number, number>()
  for (let p = 0; p < w * h; p++) {
    const q = ((u[p * 4] >> 3) << 10) | ((u[p * 4 + 1] >> 3) << 5) | (u[p * 4 + 2] >> 3) | (u[p * 4 + 3] < 255 ? 1 << 15 : 0)
    votes.set(q, (votes.get(q) ?? 0) + 1)
  }
  const bgq = [...votes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? -1
  const bg = [((bgq >> 10) & 31) * 8 + 4, ((bgq >> 5) & 31) * 8 + 4, (bgq & 31) * 8 + 4]
  const isBackground = (i: number) => bgq >= 0 && !(bgq & (1 << 15)) && Math.abs(u[i] - bg[0]) <= 12 && Math.abs(u[i + 1] - bg[1]) <= 12 && Math.abs(u[i + 2] - bg[2]) <= 12
  let interior = 0
  let lost = 0
  let sum = 0
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = (y * w + x) * 4
      if (u[i + 3] < 255 || isBackground(i)) continue
      let flat = true
      for (let dy = -1; dy <= 1 && flat; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const j = ((y + dy) * w + x + dx) * 4
          if (u[j + 3] < 255 || Math.abs(u[j] - u[i]) > smooth || Math.abs(u[j + 1] - u[i + 1]) > smooth || Math.abs(u[j + 2] - u[i + 2]) > smooth) {
            flat = false
            break
          }
        }
      if (!flat) continue
      interior++
      const de = deltaE2000(lab(u, i, 255), lab(v, i, v[i + 3]))
      sum += de
      if (de > SHADING_DE) lost++
    }
  return interior ? { share: lost / interior, meanDeltaE: sum / interior } : { share: 0, meanDeltaE: 0 }
}

export const lostShading = (s: ShadingLoss) => s.share >= SHADING_LOST_SHARE && s.meanDeltaE >= SHADING_LOST_MEAN

/** shadingLoss for an SVG against the uploaded image, both drawn at most `maxSide` px (browser only). */
export async function shadingLossOf(upload: ImageBitmap, svg: string, maxSide = 400): Promise<ShadingLoss> {
  const k = Math.min(1, maxSide / Math.max(upload.width, upload.height))
  const w = Math.max(3, Math.round(upload.width * k))
  const h = Math.max(3, Math.round(upload.height * k))
  const c = new OffscreenCanvas(w, h)
  const g = c.getContext('2d', { willReadFrequently: true })!
  g.drawImage(upload, 0, 0, w, h)
  return shadingLoss(g.getImageData(0, 0, w, h), await rasterizeSvg(svg, w, h))
}
