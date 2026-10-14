import { deltaE2000, rgbToLab } from '../palette/color'

/**
 * Measures how closely a candidate raster (e.g. a rendered SVG) matches a reference (the
 * original artwork). Pure and deterministic; both images must be aligned RGBA of the same size.
 *
 * What each number means, and what it can't tell you:
 * - Colour error compares both images composited over `background`, so the colour of fully
 *   transparent pixels doesn't count. It's plain sRGB distance, not perceptual: a 10-unit
 *   error in dark blue and in yellow look different to people but score the same.
 * - Edge-position differences up to `tolerance` px are forgiven (anti-aliasing and sub-pixel
 *   placement differ between renderers). A pixel only counts as wrong ("tolerant") when the
 *   other image has no similar colour anywhere within that distance. Larger tolerances also
 *   forgive genuinely shifted or thinner shapes.
 * - Edge precision/recall come from a thresholded Sobel filter on luminance, so edges between
 *   two colours of equal brightness aren't seen, and soft gradients produce no edges at all.
 * - Missing details / artefacts are connected areas of tolerant-wrong pixels: reference colour
 *   the candidate doesn't show nearby, and candidate colour the reference doesn't have nearby.
 *   An edge moved further than the tolerance shows up as both, one on each side of it. Areas
 *   below `minDetailArea` are ignored, so a missing detail smaller than that isn't reported.
 * - None of these is a "quality percentage". JPEG noise in the reference counts as error
 *   against a clean vector, so compare scores between versions on the same input, not across
 *   different images.
 */

export interface CompareOptions {
  /** Edge-position differences (px) to forgive. Default 1. */
  tolerance?: number
  /** Per-pixel colour error (0–255, mean of R, G, B) above which a pixel is wrong. Default 48. */
  wrongThreshold?: number
  /** Sobel luminance gradient (0–255 for a hard black/white step) that counts as an edge. Default 40. */
  edgeThreshold?: number
  /** Smallest connected wrong area (px) reported as a missing detail or artefact. Default 4. */
  minDetailArea?: number
  /** Colour both images are composited over, as 0xRRGGBB. Default white. */
  background?: number
}

export interface Region {
  x: number
  y: number
  w: number
  h: number
  /** Pixels in the region. */
  area: number
}

export interface RasterComparison {
  width: number
  height: number
  /** Mean absolute colour difference after compositing (0–255). */
  meanError: number
  /** Root-mean-square colour difference after compositing (0–255). */
  rmse: number
  /** Share of pixels whose colour error exceeds `wrongThreshold`, edges included (0–1). */
  wrongShare: number
  /** Same, with edge-position differences up to `tolerance` forgiven (0–1). */
  tolerantWrongShare: number
  /** Mean absolute alpha difference (0–255). */
  alphaError: number
  /** Share of pixels opaque in one image (alpha ≥ 128) and transparent in the other (0–1). */
  alphaFlips: number
  /** Share of the candidate's edge pixels with a reference edge within `tolerance` (1 if none). */
  edgePrecision: number
  /** Share of the reference's edge pixels with a candidate edge within `tolerance` (1 if none). */
  edgeRecall: number
  edgeF1: number
  /** Reference detail the candidate doesn't show (largest first). */
  missingDetails: Region[]
  /** Things in the candidate that aren't in the reference (largest first). */
  artefacts: Region[]
}

export function compareRasters(reference: ArrayLike<number>, candidate: ArrayLike<number>, width: number, height: number, options: CompareOptions = {}): RasterComparison {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new RangeError(`Image size must be positive whole numbers, not ${width}×${height}`)
  const n = width * height
  if (reference.length !== n * 4 || candidate.length !== n * 4)
    throw new RangeError(`Expected ${n * 4} RGBA values for ${width}×${height}; got ${reference.length} and ${candidate.length}`)
  const tolerance = options.tolerance ?? 1
  const wrongThreshold = options.wrongThreshold ?? 48
  const edgeThreshold = options.edgeThreshold ?? 40
  const minDetailArea = options.minDetailArea ?? 4
  const bg = options.background ?? 0xffffff
  if (!Number.isInteger(tolerance) || tolerance < 0 || tolerance > 16) throw new RangeError('tolerance must be a whole number of pixels from 0 to 16')
  for (const [name, v] of [['wrongThreshold', wrongThreshold], ['edgeThreshold', edgeThreshold], ['minDetailArea', minDetailArea]] as const)
    if (!Number.isFinite(v) || v < 0) throw new RangeError(`${name} must be a non-negative number`)

  const a = composite(reference, n, bg)
  const b = composite(candidate, n, bg)

  let abs = 0
  let sq = 0
  let wrong = 0
  let alpha = 0
  let flips = 0
  for (let p = 0; p < n; p++) {
    const e = pixelError(a, p, b, p)
    abs += e
    sq += sqError(a, b, p)
    if (e > wrongThreshold) wrong++
    const aa = reference[p * 4 + 3]
    const ab = candidate[p * 4 + 3]
    alpha += Math.abs(aa - ab)
    if (aa >= 128 !== ab >= 128) flips++
  }

  // Tolerant comparison: a pixel is unexplained in one direction when the other image has no
  // colour within the threshold anywhere in the tolerance window around it.
  const missing = new Uint8Array(n)
  const extra = new Uint8Array(n)
  let tolerantWrong = 0
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const p = y * width + x
      if (pixelError(a, p, b, p) <= wrongThreshold) continue
      if (!foundNear(a, p, b, x, y, width, height, tolerance, wrongThreshold)) missing[p] = 1
      if (!foundNear(b, p, a, x, y, width, height, tolerance, wrongThreshold)) extra[p] = 1
      if (missing[p] || extra[p]) tolerantWrong++
    }

  const ea = edges(luminance(a, n), width, height, edgeThreshold)
  const eb = edges(luminance(b, n), width, height, edgeThreshold)
  const na = dilate(ea, width, height, tolerance)
  const nb = dilate(eb, width, height, tolerance)
  let refEdges = 0
  let refHit = 0
  let candEdges = 0
  let candHit = 0
  for (let p = 0; p < n; p++) {
    if (ea[p]) {
      refEdges++
      if (nb[p]) refHit++
    }
    if (eb[p]) {
      candEdges++
      if (na[p]) candHit++
    }
  }
  const edgePrecision = candEdges ? candHit / candEdges : 1
  const edgeRecall = refEdges ? refHit / refEdges : 1

  return {
    width,
    height,
    meanError: abs / n,
    rmse: Math.sqrt(sq / (n * 3)),
    wrongShare: wrong / n,
    tolerantWrongShare: tolerantWrong / n,
    alphaError: alpha / n,
    alphaFlips: flips / n,
    edgePrecision,
    edgeRecall,
    edgeF1: edgePrecision + edgeRecall ? (2 * edgePrecision * edgeRecall) / (edgePrecision + edgeRecall) : 0,
    missingDetails: regions(missing, width, height, minDetailArea),
    artefacts: regions(extra, width, height, minDetailArea),
  }
}

/** RGB over the background colour (0–255 floats, 3 per pixel). */
function composite(rgba: ArrayLike<number>, n: number, bg: number): Float32Array {
  const out = new Float32Array(n * 3)
  const back = [(bg >> 16) & 255, (bg >> 8) & 255, bg & 255]
  for (let p = 0; p < n; p++) {
    const t = rgba[p * 4 + 3] / 255
    for (let c = 0; c < 3; c++) out[p * 3 + c] = rgba[p * 4 + c] * t + back[c] * (1 - t)
  }
  return out
}

const pixelError = (a: Float32Array, p: number, b: Float32Array, q: number) =>
  (Math.abs(a[p * 3] - b[q * 3]) + Math.abs(a[p * 3 + 1] - b[q * 3 + 1]) + Math.abs(a[p * 3 + 2] - b[q * 3 + 2])) / 3

const sqError = (a: Float32Array, b: Float32Array, p: number) =>
  (a[p * 3] - b[p * 3]) ** 2 + (a[p * 3 + 1] - b[p * 3 + 1]) ** 2 + (a[p * 3 + 2] - b[p * 3 + 2]) ** 2

/** Whether `other` has a colour close to `img`'s pixel p within r px of (x, y). */
function foundNear(img: Float32Array, p: number, other: Float32Array, x: number, y: number, w: number, h: number, r: number, threshold: number): boolean {
  for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r); yy++)
    for (let xx = Math.max(0, x - r); xx <= Math.min(w - 1, x + r); xx++) if (pixelError(img, p, other, yy * w + xx) <= threshold) return true
  return false
}

function luminance(rgb: Float32Array, n: number): Float32Array {
  const out = new Float32Array(n)
  for (let p = 0; p < n; p++) out[p] = 0.2126 * rgb[p * 3] + 0.7152 * rgb[p * 3 + 1] + 0.0722 * rgb[p * 3 + 2]
  return out
}

/** Sobel magnitude ≥ threshold, scaled so a hard 0→255 step measures 255. Borders are clamped. */
function edges(lum: Float32Array, w: number, h: number, threshold: number): Uint8Array {
  const out = new Uint8Array(w * h)
  const at = (x: number, y: number) => lum[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))]
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const gx = at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1)
      const gy = at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1)
      if (Math.hypot(gx, gy) / 4 >= threshold) out[y * w + x] = 1
    }
  return out
}

/** Square (Chebyshev) dilation by r px, done as two 1-D passes. */
function dilate(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r === 0) return src
  const mid = new Uint8Array(w * h)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let d = -r; d <= r; d++) {
        const xx = x + d
        if (xx >= 0 && xx < w && src[y * w + xx]) {
          mid[y * w + x] = 1
          break
        }
      }
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let d = -r; d <= r; d++) {
        const yy = y + d
        if (yy >= 0 && yy < h && mid[yy * w + x]) {
          out[y * w + x] = 1
          break
        }
      }
  return out
}

/** 8-connected regions of set pixels with at least `minArea` pixels, largest first. */
function regions(mask: Uint8Array, w: number, h: number, minArea: number): Region[] {
  const seen = new Uint8Array(w * h)
  const stack: number[] = []
  const out: Region[] = []
  for (let start = 0; start < w * h; start++) {
    if (!mask[start] || seen[start]) continue
    seen[start] = 1
    stack.push(start)
    let area = 0
    let x0 = w
    let y0 = h
    let x1 = -1
    let y1 = -1
    while (stack.length) {
      const p = stack.pop()!
      const x = p % w
      const y = (p / w) | 0
      area++
      x0 = Math.min(x0, x)
      y0 = Math.min(y0, y)
      x1 = Math.max(x1, x)
      y1 = Math.max(y1, y)
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx
          const yy = y + dy
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue
          const q = yy * w + xx
          if (mask[q] && !seen[q]) {
            seen[q] = 1
            stack.push(q)
          }
        }
    }
    if (area >= minArea) out.push({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, area })
  }
  return out.sort((p, q) => q.area - p.area)
}

export interface ColourMatch {
  /** A reference colour and the colour the candidate shows where it is, as #RRGGBB. */
  reference: string
  candidate: string
  /** CIEDE2000 difference between the two. */
  deltaE: number
  /** Share of the image's solid pixels in this colour. */
  share: number
}

export interface ColourFidelity {
  colours: ColourMatch[]
  /** Area-weighted mean and the largest ΔE over the reference colours. */
  meanDeltaE: number
  maxDeltaE: number
  /** Pairs of noticeably different reference colours (ΔE ≥ 2) shown as one colour (ΔE < 1). */
  merged: number
}

/**
 * How faithfully the candidate keeps the reference's flat colours. Each exact reference colour
 * covering at least `minShare` of the solid pixels (opaque, with all 8 neighbours the same
 * colour, so anti-aliasing is ignored) is compared, in ΔE2000, with the candidate's mean colour
 * over those same pixels. Meant for references with exact flat colours (rendered artwork); a
 * JPEG reference has few exactly repeated colours, so few or none are reported.
 */
export function colourFidelity(reference: ArrayLike<number>, candidate: ArrayLike<number>, width: number, height: number, minShare = 0.002): ColourFidelity {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new RangeError(`Image size must be positive whole numbers, not ${width}×${height}`)
  const n = width * height
  if (reference.length !== n * 4 || candidate.length !== n * 4) throw new RangeError(`Expected ${n * 4} RGBA values for ${width}×${height}`)
  const key = (d: ArrayLike<number>, p: number) => (d[p * 4 + 3] < 255 ? -1 : (d[p * 4] << 16) | (d[p * 4 + 1] << 8) | d[p * 4 + 2])
  const sums = new Map<number, [number, number, number, number]>()
  let solid = 0
  for (let y = 1; y < height - 1; y++)
    for (let x = 1; x < width - 1; x++) {
      const p = y * width + x
      const k = key(reference, p)
      if (k < 0 || candidate[p * 4 + 3] < 255) continue
      let same = true
      for (let dy = -1; dy <= 1 && same; dy++) for (let dx = -1; dx <= 1 && same; dx++) if (key(reference, p + dy * width + dx) !== k) same = false
      if (!same) continue
      solid++
      const s = sums.get(k) ?? [0, 0, 0, 0]
      s[0] += candidate[p * 4]
      s[1] += candidate[p * 4 + 1]
      s[2] += candidate[p * 4 + 2]
      s[3]++
      sums.set(k, s)
    }
  const hex = (r: number, g: number, b: number) => '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase()
  const found = [...sums]
    .filter(([, s]) => s[3] >= solid * minShare)
    .map(([k, s]) => {
      const ref: [number, number, number] = [(k >> 16) & 255, (k >> 8) & 255, k & 255]
      const out: [number, number, number] = [s[0] / s[3], s[1] / s[3], s[2] / s[3]]
      return { ref, out, match: { reference: hex(...ref), candidate: hex(...out), deltaE: deltaE2000(rgbToLab(ref), rgbToLab(out)), share: s[3] / Math.max(1, solid) } }
    })
    .sort((a, b) => b.match.share - a.match.share)
  let merged = 0
  for (let i = 0; i < found.length; i++)
    for (let j = i + 1; j < found.length; j++)
      if (deltaE2000(rgbToLab(found[i].ref), rgbToLab(found[j].ref)) >= 2 && deltaE2000(rgbToLab(found[i].out), rgbToLab(found[j].out)) < 1) merged++
  const total = found.reduce((s, f) => s + f.match.share, 0)
  return {
    colours: found.map((f) => f.match),
    meanDeltaE: total ? found.reduce((s, f) => s + f.match.deltaE * f.match.share, 0) / total : 0,
    maxDeltaE: found.reduce((m, f) => Math.max(m, f.match.deltaE), 0),
    merged,
  }
}

/**
 * Detail missing and added, as shares (0–1) of the reference's ink: pixels unlike its most
 * common exact colour (the background). Uses the regions a comparison found (see
 * compareRasters), so edge shifts within its tolerance don't count. On JPEG references the
 * background isn't one exact colour, so the ink count is inflated and the shares come out
 * lower; compare shares for the same reference only.
 */
export function inkChange(reference: ArrayLike<number>, r: RasterComparison): { missing: number; extra: number } {
  const counts = new Map<number, number>()
  const key = (i: number) => (reference[i + 3] < 128 ? -1 : (reference[i] << 16) | (reference[i + 1] << 8) | reference[i + 2])
  for (let i = 0; i < reference.length; i += 4) counts.set(key(i), (counts.get(key(i)) ?? 0) + 1)
  let most = 0
  for (const n of counts.values()) if (n > most) most = n
  const ink = Math.max(1, reference.length / 4 - most)
  const area = (rs: Region[]) => rs.reduce((s, x) => s + x.area, 0)
  return { missing: area(r.missingDetails) / ink, extra: area(r.artefacts) / ink }
}
