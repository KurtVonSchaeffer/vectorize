import { deltaE2000, labToRgb, rgbToHex, rgbToLab, type Lab } from './color'
import type { Palette, Swatch } from './parse'
import type { LabelMap } from '../trace'

export interface InkSettings {
  enabled: boolean
  /** Maximum number of distinct inks (spot colors) in the output. */
  maxInks: number
  /** Treat near-white as unprinted paper: no ink, left transparent. */
  whiteIsPaper: boolean
  /** User swaps: auto-matched swatch name → chosen swatch name. */
  overrides: Record<string, string>
}

export const DEFAULT_INKS: InkSettings = { enabled: false, maxInks: 4, whiteIsPaper: true, overrides: {} }

export interface Ink {
  swatch: Swatch
  /** Swatch picked automatically, before any override. */
  auto: Swatch
  /** CIEDE2000 between the artwork's color and the chosen swatch. */
  deltaE: number
  /** Share of the printed area, 0–1. */
  coverage: number
}

export interface Quantized {
  image: ImageData
  inks: Ink[]
  /** The cleaned color map at source resolution, with edge blend information, for tracing. */
  map: LabelMap
  /** Edge-blend colors (anti-aliasing or JPEG fringes) that were folded into real colors. */
  blendsRemoved: number
}

// Pixels are bucketed at 5 bits per channel; every bucket gets one ink via a lookup table, so
// recoloring millions of pixels is a single pass.
const BITS = 5
const BINS = 1 << (BITS * 3)
const binOf = (r: number, g: number, b: number) => ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)

export interface QuantizeOptions {
  /** Upper bound on distinct colors. */
  maxColors: number
  /** Merge clusters closer than this CIEDE2000 distance (0 = never). */
  mergeDelta: number
  /** Treat near-white as unprinted paper: no ink, left transparent. */
  whiteIsPaper: boolean
  /** Snap every color to the nearest swatch; null keeps the artwork's own colors. */
  palette: Palette | null
  /** Swatch swaps (auto-matched name → chosen name); only with a palette. */
  overrides: Record<string, string>
  /** Regions smaller than this many source pixels are merged into their surroundings. */
  minArea: number
  /** Integer upscale factor applied to the color map before tracing. */
  upscale: number
  /** Edge smoothing radius (Gaussian sigma, in source pixels) used while upscaling. */
  smoothing: number
  /** Keep edge-blend clusters as real colors (normally they're folded away). */
  keepBlends?: boolean
  /**
   * Fine detail (behind a flag): also gives the map a second labelling (LabelMap.fine) in which
   * noise cleanup leaves the solid end pixels of thin lines alone, for the fine-detail tracer. The
   * map's own labels are unchanged.
   */
  keepSolidDetail?: boolean
}

/**
 * Pixels whose label is already decided (gradient regions): `labels[p]` indexes `colors`, or is
 * negative for pixels to quantize normally. They're left out of color clustering, so gradients
 * don't use up the color budget, and get labels after the clustered ones.
 */
export interface FixedLabels {
  labels: Int16Array
  colors: number[]
}

/**
 * Reduces an image to a few flat colors, ready for tracing.
 *
 * Colors are clustered at the source resolution, the resulting color map is cleaned of noise,
 * and then it's upscaled with a smooth (Gaussian-weighted) vote between neighboring labels.
 * That last step is what produces clean, sub-pixel-accurate boundaries: VTracer fits curves to
 * smooth contours instead of to JPEG noise and pixel staircases.
 */
export function quantize(src: ImageData, opts: QuantizeOptions, fixed?: FixedLabels): Quantized {
  const d = src.data
  const count = new Float64Array(BINS)
  const sum = new Float64Array(BINS * 3)
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0 || (fixed && fixed.labels[i >> 2] >= 0)) continue
    const b = binOf(d[i], d[i + 1], d[i + 2])
    count[b]++
    sum[b * 3] += d[i]
    sum[b * 3 + 1] += d[i + 1]
    sum[b * 3 + 2] += d[i + 2]
  }

  // Distinct colors present, with their pixel counts as weights.
  const bins: number[] = []
  const labs: Lab[] = []
  const weights: number[] = []
  const paper = new Uint8Array(BINS)
  const paperAcc = [0, 0, 0, 0]
  let total = 0
  for (let b = 0; b < BINS; b++) {
    if (!count[b]) continue
    const lab = rgbToLab([sum[b * 3] / count[b], sum[b * 3 + 1] / count[b], sum[b * 3 + 2] / count[b]])
    total += count[b]
    if (opts.whiteIsPaper && lab[0] > 92 && Math.hypot(lab[1], lab[2]) < 8) {
      paper[b] = 1
      paperAcc[0] += lab[0] * count[b]
      paperAcc[1] += lab[1] * count[b]
      paperAcc[2] += lab[2] * count[b]
      paperAcc[3] += count[b]
      continue
    }
    bins.push(b)
    labs.push(lab)
    weights.push(count[b])
  }

  const k = Math.max(1, Math.min(opts.maxColors, labs.length))
  const clustered = labs.length ? kmeans(labs, weights, k) : { centers: [], assign: new Int32Array(0) }
  const interior = interiorShare(src, bins, clustered.assign, clustered.centers.length, paper)
  const pruned = opts.keepBlends ? clustered : dropBlendClusters(clustered.centers, clustered.assign, labs, weights, opts.whiteIsPaper, interior)
  const apart = separateRegions(src, bins, pruned.assign, pruned.centers, paper, opts.mergeDelta, fixed)
  const merged = mergeSimilar(pruned.centers, labs, weights, opts.mergeDelta, opts.maxColors, apart)
  const centers = pureCenters(merged.centers, merged.assign, bins, sum, count)
  // Final assignment by nearest color in RGB, consistent with how edges blend.
  const plainAssign = new Int32Array(bins.length)
  const assign = nearestRgb(centers, bins, sum, count, plainAssign)

  // Decide each cluster's final color: its own average, or the nearest swatch.
  const clusterSwatch = centers.map((c) => {
    if (!opts.palette) {
      const own = ownSwatch(c)
      return { auto: own, swatch: own }
    }
    const auto = nearestSwatch(opts.palette, c)
    const swatch = opts.palette.swatches.find((s) => s.name === opts.overrides[auto.name]) ?? auto
    return { auto, swatch }
  })

  // Clusters that land on the same swatch share one label.
  const labelOf = new Map<string, number>()
  const labelRgb: number[] = []
  const clusterLabel = clusterSwatch.map(({ swatch }) => {
    let l = labelOf.get(swatch.name)
    if (l === undefined) {
      l = labelRgb.length
      labelRgb.push((swatch.rgb[0] << 16) | (swatch.rgb[1] << 8) | swatch.rgb[2])
      labelOf.set(swatch.name, l)
    }
    return l
  })

  const lut = new Uint8Array(BINS).fill(EMPTY)
  const plainLut = new Uint8Array(BINS).fill(EMPTY)
  bins.forEach((b, i) => (plainLut[b] = clusterLabel[plainAssign[i]]))
  const inkCoverage = new Map<string, { ink: Ink; weight: number; deSum: number }>()
  bins.forEach((b, i) => {
    const cs = clusterSwatch[assign[i]]
    lut[b] = clusterLabel[assign[i]]
    const entry = inkCoverage.get(cs.swatch.name) ?? { ink: { swatch: cs.swatch, auto: cs.auto, deltaE: 0, coverage: 0 }, weight: 0, deSum: 0 }
    entry.weight += weights[i]
    entry.deSum += deltaE2000(labs[i], cs.swatch.lab) * weights[i]
    inkCoverage.set(cs.swatch.name, entry)
  })

  // Anti-aliased edge pixels are blends of two colors; the blend ratio says where the edge
  // really is inside the pixel. Record each color's second-closest label and how much of the
  // primary label it contains, so upscaling can place edges at sub-pixel accuracy.
  // Done in sRGB, where anti-aliasing blends are linear.
  const anchors: { lab: number[]; label: number }[] = centers.map((c, i) => ({ lab: labToRgb(c), label: clusterLabel[i] }))
  if (paperAcc[3]) anchors.push({ lab: labToRgb([paperAcc[0] / paperAcc[3], paperAcc[1] / paperAcc[3], paperAcc[2] / paperAcc[3]]), label: PAPER_LABEL })
  const lutB = new Uint8Array(BINS).fill(EMPTY)
  const lutCov = new Float32Array(BINS).fill(1)
  for (let b = 0; b < BINS; b++) {
    if (!count[b]) continue
    const primary = paper[b] ? PAPER_LABEL : lut[b]
    const c = [sum[b * 3] / count[b], sum[b * 3 + 1] / count[b], sum[b * 3 + 2] / count[b]]
    const P = anchors.find((a) => a.label === primary)
    if (!P) continue
    // The partner is the color the pixel is actually a mix of: the one whose straight line from
    // the primary passes closest to it. The nearest other color can be unrelated: a grey edge of
    // black lettering sits nearer a dark purple than white paper, and would place purple slivers
    // along the letters.
    let S: (typeof anchors)[number] | null = null
    let sd = Infinity
    for (const a of anchors) {
      if (a.label === primary) continue
      const off = lineOffset(c, P.lab, a.lab)
      if (off < sd) {
        sd = off
        S = a
      }
    }
    if (!S) continue
    const t = blendRatio(c, P.lab, S.lab, BLEND_RESIDUAL)
    if (t === null) continue // not a mix of these two
    lutB[b] = S.label
    lutCov[b] = 1 - t
  }

  // Fixed labels follow the clustered ones, each with a color no clustered label uses.
  const fixedBase = labelRgb.length
  for (const c of fixed?.colors ?? []) {
    let u = c
    while (labelRgb.includes(u)) u ^= 1
    labelRgb.push(u)
  }

  const { width: w, height: h } = src
  const labels = new Uint8Array(w * h)
  const plainLabels = new Uint8Array(w * h).fill(EMPTY)
  const second = new Uint8Array(w * h).fill(EMPTY)
  const cov = new Float32Array(w * h).fill(1)
  for (let p = 0, i = 0; p < labels.length; p++, i += 4) {
    if (d[i + 3] === 0) labels[p] = EMPTY
    else if (fixed && fixed.labels[p] >= 0) labels[p] = fixedBase + fixed.labels[p]
    else {
      const b = binOf(d[i], d[i + 1], d[i + 2])
      labels[p] = paper[b] ? PAPER_LABEL : lut[b]
      plainLabels[p] = paper[b] ? PAPER_LABEL : plainLut[b]
      second[p] = lutB[b]
      cov[p] = lutCov[b]
    }
  }
  vetoDistantBlends(w, h, labels, plainLabels)
  vetoDistantPartners(d, w, h, labels, second, cov, anchors)
  let clean = majorityFilter(majorityFilter(labels, w, h), w, h)
  // Fine detail: the same cleanup, except that a line's solid end pixel in a colour unlike the one
  // around it stays (it is the line's end, not noise). Only the fine-detail tracer sees these pixels.
  const solid = (p: number, own: number, around: number, ownCount: number, src: Uint8Array) => ownCount === 2 && lineEnd(src, w, h, p) && isSolid(d, p, labelRgb[own], labelRgb[around])
  const kept = opts.keepSolidDetail ? majorityFilter(majorityFilter(labels, w, h, solid), w, h, solid) : null
  const raw = kept ? { second: second.slice(), cov: cov.slice() } : null
  if (opts.minArea > 1) removeSpecks(clean, w, h, opts.minArea, (members, label, around) => isDetail(members, label, around, d, labelRgb))
  // Pixels relabeled by cleanup no longer carry meaningful blend information.
  for (let p = 0; p < clean.length; p++) {
    if (clean[p] !== labels[p]) {
      second[p] = EMPTY
      cov[p] = 1
    }
  }

  const map: LabelMap = { w, h, labels: clean, second, cov, colors: labelRgb }
  if (kept && raw) {
    const fine = { labels: clean.slice(), second: second.slice(), cov: cov.slice() }
    let any = false
    for (let p = 0; p < clean.length; p++)
      if (kept[p] === labels[p] && clean[p] !== labels[p]) {
        fine.labels[p] = labels[p]
        fine.second[p] = raw.second[p]
        fine.cov[p] = raw.cov[p]
        any = true
      }
    if (any) map.fine = fine
  }

  const f = Math.max(1, Math.round(opts.upscale))
  if (f > 1 || opts.smoothing > 0) clean = upscaleLabels(clean, w, h, f, opts.smoothing, second, cov)
  const image = paintLabels(clean, w * f, h * f, labelRgb)

  const inks = [...inkCoverage.values()]
    .map(({ ink, weight, deSum }) => ({ ...ink, coverage: weight / total, deltaE: deSum / weight }))
    .sort((a, b) => b.coverage - a.coverage)
  return { image, inks, map, blendsRemoved: clustered.centers.length - pruned.centers.length }
}

/** Spot-color quantization at the image's own resolution (no upscaling). */
export function quantizeToPalette(src: ImageData, palette: Palette, settings: InkSettings, minArea = 0): Quantized {
  return quantize(src, {
    maxColors: settings.maxInks,
    mergeDelta: 0,
    whiteIsPaper: settings.whiteIsPaper,
    palette,
    overrides: settings.overrides,
    minArea,
    upscale: 1,
    smoothing: 0,
  })
}

function nearestSwatch(palette: Palette, lab: Lab): Swatch {
  let best = palette.swatches[0]
  let bestD = Infinity
  for (const s of palette.swatches) {
    const dist = deltaE2000(lab, s.lab)
    if (dist < bestD) {
      bestD = dist
      best = s
    }
  }
  return best
}

function ownSwatch(lab: Lab): Swatch {
  const rgb = labToRgb(lab)
  return { name: rgbToHex(rgb), rgb, lab }
}

function paintLabels(labels: Uint8Array, w: number, h: number, labelRgb: number[]): ImageData {
  const out = new Uint8ClampedArray(w * h * 4)
  for (let p = 0, i = 0; p < labels.length; p++, i += 4) {
    const l = labels[p]
    if (l === EMPTY || l === PAPER_LABEL) continue
    const c = labelRgb[l]
    out[i] = c >> 16
    out[i + 1] = (c >> 8) & 255
    out[i + 2] = c & 255
    out[i + 3] = 255
  }
  return new ImageData(out, w, h)
}

/**
 * Upscales a label map by `f`, choosing each output pixel's label by a Gaussian-weighted vote
 * of nearby source labels. Boundaries come out smooth and sub-pixel accurate (like the 50%
 * contour of a blurred mask) instead of as pixel staircases. Interior pixels, far from any
 * boundary, take the fast path.
 */
export function upscaleLabels(src: Uint8Array, w: number, h: number, f: number, sigma: number, second?: Uint8Array, cov?: Float32Array): Uint8Array {
  const W = w * f
  const H = h * f
  const out = new Uint8Array(W * H)
  if (sigma <= 0) {
    for (let Y = 0; Y < H; Y++) for (let X = 0; X < W; X++) out[Y * W + X] = src[((Y / f) | 0) * w + ((X / f) | 0)]
    return out
  }
  const R = Math.max(1, Math.ceil(sigma * 2.5))

  // Source pixels whose neighborhood (radius R+1) is all one label can be copied directly.
  const mixed = new Uint8Array(w * h)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const l = src[y * w + x]
      if ((x + 1 < w && src[y * w + x + 1] !== l) || (y + 1 < h && src[(y + 1) * w + x] !== l)) {
        // Mark a window around the boundary between (x,y) and its neighbor.
        for (let yy = Math.max(0, y - R - 1); yy <= Math.min(h - 1, y + R + 2); yy++)
          for (let xx = Math.max(0, x - R - 1); xx <= Math.min(w - 1, x + R + 2); xx++) mixed[yy * w + xx] = 1
      }
    }

  const votes = new Float64Array(256)
  const touched: number[] = []
  const inv2s2 = 1 / (2 * sigma * sigma)
  for (let Y = 0; Y < H; Y++) {
    const sy = (Y + 0.5) / f - 0.5
    const cy = Math.min(h - 1, Math.max(0, Math.round(sy)))
    for (let X = 0; X < W; X++) {
      const sx = (X + 0.5) / f - 0.5
      const cx = Math.min(w - 1, Math.max(0, Math.round(sx)))
      if (!mixed[cy * w + cx]) {
        out[Y * W + X] = src[cy * w + cx]
        continue
      }
      const x0 = Math.floor(sx)
      const y0 = Math.floor(sy)
      for (let yy = y0 - R + 1; yy <= y0 + R; yy++) {
        const py = Math.min(h - 1, Math.max(0, yy))
        const dy2 = (yy - sy) * (yy - sy)
        for (let xx = x0 - R + 1; xx <= x0 + R; xx++) {
          const px = Math.min(w - 1, Math.max(0, xx))
          const q = py * w + px
          const l = src[q]
          const g = Math.exp(-((xx - sx) * (xx - sx) + dy2) * inv2s2)
          // A blended pixel splits its vote between its two colors by blend ratio.
          const c = cov ? cov[q] : 1
          if (votes[l] === 0) touched.push(l)
          votes[l] += g * c
          if (c < 1 && second) {
            // No usable second color: the whole vote stays with the first. An unset second
            // label (EMPTY) must never vote, or ink edges would turn transparent.
            const l2 = second[q] === EMPTY ? l : second[q]
            if (votes[l2] === 0) touched.push(l2)
            votes[l2] += g * (1 - c)
          }
        }
      }
      let best = touched[0]
      for (const l of touched) {
        if (votes[l] > votes[best]) best = l
      }
      for (const l of touched) votes[l] = 0
      touched.length = 0
      out[Y * W + X] = best
    }
  }
  return out
}

/**
 * Recomputes each cluster's color from its "pure" pixels only. Edge pixels are blends with a
 * neighboring color and would otherwise pull the result off (orange drifting toward brown next
 * to navy). A bin counts as a blend when it's a mix of its cluster and another (see blendRatio).
 */
function pureCenters(centers: Lab[], assign: Int32Array, bins: number[], sum: Float64Array, count: Float64Array): Lab[] {
  if (centers.length < 2) return centers
  const rgbs = centers.map((c) => labToRgb(c) as number[])
  const acc = centers.map(() => [0, 0, 0, 0])
  bins.forEach((b, i) => {
    const a = assign[i]
    const c = [sum[b * 3] / count[b], sum[b * 3 + 1] / count[b], sum[b * 3 + 2] / count[b]]
    const P = rgbs[a]
    let blend = false
    for (let j = 0; j < rgbs.length && !blend; j++) {
      if (j === a) continue
      const info = blendInfo(c, P, rgbs[j], BLEND_RESIDUAL)
      blend = !!info && Math.max(info.t, info.hue) >= 0.12
    }
    if (blend) return
    acc[a][0] += sum[b * 3]
    acc[a][1] += sum[b * 3 + 1]
    acc[a][2] += sum[b * 3 + 2]
    acc[a][3] += count[b]
  })
  return centers.map((c, i) => (acc[i][3] ? rgbToLab([acc[i][0] / acc[i][3], acc[i][1] / acc[i][3], acc[i][2] / acc[i][3]]) : c))
}

function nearestRgb(centers: Lab[], bins: number[], sum: Float64Array, count: Float64Array, plain?: Int32Array): Int32Array {
  const rgbs = centers.map((c) => labToRgb(c))
  const assign = new Int32Array(bins.length)
  bins.forEach((b, i) => {
    const r = sum[b * 3] / count[b]
    const g = sum[b * 3 + 1] / count[b]
    const bl = sum[b * 3 + 2] / count[b]
    let best = 0
    let bd = Infinity
    rgbs.forEach((c, j) => {
      const dd = (r - c[0]) ** 2 + (g - c[1]) ** 2 + (bl - c[2]) ** 2
      if (dd < bd) {
        bd = dd
        best = j
      }
    })
    if (plain) plain[i] = best
    assign[i] = Math.sqrt(bd) > BLEND_MIN_DISTANCE ? blendEnd(rgbs, [r, g, bl], best, Math.sqrt(bd)) : best
  })
  return assign
}

/** Distance from `c` to the segment from `a` to `b` (RGB); beyond the ends, to the nearer end. */
function lineOffset(c: number[], a: number[], b: number[]): number {
  const ab0 = b[0] - a[0]
  const ab1 = b[1] - a[1]
  const ab2 = b[2] - a[2]
  const len2 = ab0 ** 2 + ab1 ** 2 + ab2 ** 2
  const t = len2 ? Math.min(1, Math.max(0, ((c[0] - a[0]) * ab0 + (c[1] - a[1]) * ab1 + (c[2] - a[2]) * ab2) / len2)) : 0
  return Math.hypot(c[0] - a[0] - t * ab0, c[1] - a[1] - t * ab1, c[2] - a[2] - t * ab2)
}

/**
 * A color counts as present around a pixel when at least PRESENT_MIN pixels within the radius
 * carry its label: PRESENT_RADIUS for edge partners (wider let the slivers back: measured 15 dark
 * pixels at 3 px, 175 at 4, 276 at 5), BLEND_PRESENT_RADIUS for moving a blend pixel to a color
 * (narrower thinned lettering in compressed logos: Barron JPEG 75 error 4.8 at 3 px, 3.6 at 7).
 */
const PRESENT_RADIUS = 3
const BLEND_PRESENT_RADIUS = 7
const PRESENT_MIN = 2
/** A partner with no pixels nearby is kept when the pixel is within this (RGB) of a straight mix... */
const EXACT_MIX = 4
/** ...that is between this and 1 − this of the way between the two colors (a real mix). */
const MIX_MIN = 0.2

/**
 * A blend pixel is moved to one of the two colors it mixes (blendEnd) only when that color is
 * actually around it, judged by the pixels' nearest colors: a grey letter edge goes to black or
 * white, which surround the letters, but a pale feather edge isn't moved to the lettering's black.
 */
function vetoDistantBlends(w: number, h: number, labels: Uint8Array, plain: Uint8Array) {
  const keep: number[] = []
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = y * w + x
      const l = labels[p]
      if (l === EMPTY || plain[p] === EMPTY || l === plain[p]) continue
      let n = 0
      for (let yy = Math.max(0, y - BLEND_PRESENT_RADIUS); yy <= Math.min(h - 1, y + BLEND_PRESENT_RADIUS) && n < PRESENT_MIN; yy++)
        for (let xx = Math.max(0, x - BLEND_PRESENT_RADIUS); xx <= Math.min(w - 1, x + BLEND_PRESENT_RADIUS) && n < PRESENT_MIN; xx++) if (plain[yy * w + xx] === l) n++
      if (n < PRESENT_MIN) keep.push(p)
    }
  for (const p of keep) labels[p] = plain[p]
}

/**
 * An edge pixel's partner color places the edge between pixels, so it must be a color that is
 * actually next to the pixel. It's chosen per color (from all the image's colors), which can pick
 * one that's nowhere near: the pale edges of a bird's feathers paired with the lettering's black
 * and drew dark slivers along the feathers. Where the partner has no pixels nearby, the closest
 * mix with a color that has (or none) replaces it; everywhere else the choice is unchanged.
 */
export function vetoDistantPartners(d: Uint8ClampedArray, w: number, h: number, labels: Uint8Array, second: Uint8Array, cov: Float32Array, anchors: { lab: number[]; label: number }[]) {
  const rgbOf: (number[] | undefined)[] = []
  const colors: number[] = []
  for (const a of anchors)
    if (!rgbOf[a.label]) {
      rgbOf[a.label] = a.lab
      if (a.label !== EMPTY) colors.push(a.label)
    }
  // Label counts in the window around the pixel, slid along the row: the column entering on the
  // right is added, the one leaving on the left removed. Labels don't change here, so the counts
  // are the same as counting the whole window at every pixel, which was most of this step's time.
  // A color is present where it has at least PRESENT_MIN pixels in the window.
  const votes = new Int32Array(256)
  const c = [0, 0, 0]
  // Of equally close colors the one a scan of the window meets first wins: its first pixel there.
  const first = (l: number, x: number, top: number, bottom: number) => {
    const x0 = Math.max(0, x - PRESENT_RADIUS)
    const x1 = Math.min(w - 1, x + PRESENT_RADIUS)
    for (let row = top; row <= bottom; row += w) for (let xx = x0; xx <= x1; xx++) if (labels[row + xx] === l) return row + xx
    return Infinity
  }
  for (let y = 0; y < h; y++) {
    let x = 0
    while (x < w && (second[y * w + x] === EMPTY || cov[y * w + x] >= 1)) x++
    if (x === w) continue // no edge pixel on this row
    const top = Math.max(0, y - PRESENT_RADIUS) * w
    const bottom = Math.min(h - 1, y + PRESENT_RADIUS) * w
    // Start from the previous pixel's window; the loop then slides it onto this one.
    votes.fill(0)
    for (let xx = Math.max(0, x - PRESENT_RADIUS - 1); xx < Math.min(w, x + PRESENT_RADIUS); xx++) for (let q = top + xx; q <= bottom + xx; q += w) votes[labels[q]]++
    for (; x < w; x++) {
      const xin = x + PRESENT_RADIUS
      const xout = x - PRESENT_RADIUS - 1
      if (xin < w) for (let q = top + xin; q <= bottom + xin; q += w) votes[labels[q]]++
      if (xout >= 0) for (let q = top + xout; q <= bottom + xout; q += w) votes[labels[q]]--
      const p = y * w + x
      const s = second[p]
      if (s === EMPTY || cov[p] >= 1 || votes[s] >= PRESENT_MIN) continue
      const P = rgbOf[labels[p]]
      c[0] = d[p * 4]
      c[1] = d[p * 4 + 1]
      c[2] = d[p * 4 + 2]
      // An almost exact, real mix keeps its partner even with no pixel of it nearby: a 1 px line
      // drawn as two 50% rows has no pixel labelled with its color.
      const S = rgbOf[s]
      if (P && S && cov[p] >= MIX_MIN && cov[p] <= 1 - MIX_MIN && lineOffset(c, P, S) <= EXACT_MIX) continue
      // The partner isn't here: the closest mix with a color that is, or no partner.
      second[p] = EMPTY
      cov[p] = 1
      if (!P) continue
      let best = -1
      let bestOff = Infinity
      for (const l of colors) {
        if (l === labels[p] || votes[l] < PRESENT_MIN) continue
        const off = lineOffset(c, P, rgbOf[l]!)
        if (off < bestOff || (off === bestOff && first(l, x, top, bottom) < first(best, x, top, bottom))) {
          bestOff = off
          best = l
        }
      }
      if (best < 0) continue
      const t = blendRatio(c, P, rgbOf[best]!, BLEND_RESIDUAL)
      if (t === null) continue
      second[p] = best
      cov[p] = 1 - t
    }
  }
}

/** A color at least this far (RGB) from its nearest cluster may be an edge blend of two others. */
const BLEND_MIN_DISTANCE = 30
/** ...and is one when the straight line between two clusters passes this much closer. */
const BLEND_LINE_SHARE = 0.35
const BLEND_LINE_MAX = 20

/**
 * An anti-aliased edge pixel is a mix of the two colors it separates (grey between black lettering
 * and white paper). By plain distance it can be nearer an unrelated color: in a bird logo, mid
 * greys sat closer to dark purple and magenta than to black or white, so black lettering traced
 * with purple bands. When the pixel lies on the line between two clusters, much closer than to its
 * nearest one, it goes to whichever of those two it's nearer to.
 */
function blendEnd(rgbs: number[][], c: number[], best: number, bestDist: number): number {
  let pick = best
  let line = Math.min(BLEND_LINE_MAX, bestDist * BLEND_LINE_SHARE)
  for (let a = 0; a < rgbs.length; a++)
    for (let b = a + 1; b < rgbs.length; b++) {
      if (a === best || b === best) continue
      const A = rgbs[a]
      const B = rgbs[b]
      const ab = [B[0] - A[0], B[1] - A[1], B[2] - A[2]]
      const len2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2
      if (!len2) continue
      const t = ((c[0] - A[0]) * ab[0] + (c[1] - A[1]) * ab[1] + (c[2] - A[2]) * ab[2]) / len2
      if (t < 0 || t > 1) continue
      const off = Math.hypot(c[0] - A[0] - t * ab[0], c[1] - A[1] - t * ab[1], c[2] - A[2] - t * ab[2])
      if (off < line) {
        line = off
        pick = t < 0.5 ? a : b
      }
    }
  return pick
}

/**
 * Merges the closest pair of clusters (CIEDE2000) while they're closer than `delta` or there
 * are more than `maxCount`, then reassigns every color to its nearest center.
 */
function mergeSimilar(centers: Lab[], points: Lab[], weights: number[], delta: number, maxCount: number, apart?: (i: number, j: number) => boolean): { centers: Lab[]; assign: Int32Array } {
  let cs = centers.map((c) => [...c] as Lab)
  // The original clusters each current one stands for, to ask `apart` about.
  let groups = centers.map((_, i) => [i])
  const nearest = () => {
    const assign = new Int32Array(points.length)
    points.forEach((p, i) => {
      let best = 0
      let bd = Infinity
      cs.forEach((c, j) => {
        const dd = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2
        if (dd < bd) {
          bd = dd
          best = j
        }
      })
      assign[i] = best
    })
    return assign
  }
  let assign = nearest()
  {
    for (;;) {
      let bi = -1
      let bj = -1
      let bd = cs.length > maxCount ? Infinity : delta
      const over = cs.length > maxCount
      for (let i = 0; i < cs.length; i++)
        for (let j = i + 1; j < cs.length; j++) {
          const dd = deltaE2000(cs[i], cs[j])
          // Distinct colours side by side stay apart, unless there are more than allowed.
          if (!over && apart && groups[i].some((a) => groups[j].some((b) => apart(a, b)))) continue
          if (dd < bd) {
            bd = dd
            bi = i
            bj = j
          }
        }
      if (bi < 0) break
      // Weighted average of the two, by how many pixels each covers.
      let wi = 0
      let wj = 0
      assign.forEach((a, k) => {
        if (a === bi) wi += weights[k]
        else if (a === bj) wj += weights[k]
      })
      const t = wi + wj ? wj / (wi + wj) : 0.5
      cs[bi] = [cs[bi][0] + (cs[bj][0] - cs[bi][0]) * t, cs[bi][1] + (cs[bj][1] - cs[bi][1]) * t, cs[bi][2] + (cs[bj][2] - cs[bi][2]) * t]
      cs = cs.filter((_, k) => k !== bj)
      groups[bi] = [...groups[bi], ...groups[bj]]
      groups = groups.filter((_, k) => k !== bj)
      assign = nearest()
    }
  }
  // Recompute each center as the weighted mean of its members, so colors are accurate.
  const acc = cs.map(() => [0, 0, 0, 0])
  assign.forEach((a, i) => {
    acc[a][0] += points[i][0] * weights[i]
    acc[a][1] += points[i][1] * weights[i]
    acc[a][2] += points[i][2] * weights[i]
    acc[a][3] += weights[i]
  })
  cs = cs.map((c, i) => (acc[i][3] ? [acc[i][0] / acc[i][3], acc[i][1] / acc[i][3], acc[i][2] / acc[i][3]] : c))
  return { centers: cs, assign }
}

/**
 * Colours at least this far apart (CIEDE2000) may be distinct: 2 can be told apart by eye, for
 * exact (lossless) colours; JPEG shifts colours by up to about 3–4 on its own (small shapes lose
 * chroma), so lossy colours must differ by more.
 */
const DISTINCT_DE = 2
const DISTINCT_DE_LOSSY = 5
/** A cluster is exact when at least this share of its pixels is one exact colour. */
const EXACT_SHARE = 0.5
/** Regions are separate when their shared boundary is under this share of the smaller one. */
const SEPARATE_CONTACT = 0.25
/**
 * …and the step across it is in proportion to the colour difference: at least SHARP_STEP of it
 * (not a gradual shade), at most STEP_MAX (a bigger jump means something else lies between them,
 * as where pieces of one gradient meet across a thin line).
 */
const SHARP_STEP = 0.35
const STEP_MAX = 1.6
/** …and each covers at least this share of the colour pixels. */
const DISTINCT_MIN_SHARE = 0.002
/** …and is solid: at least this share of its pixels have all 4 neighbours in it (not a fringe). */
const DISTINCT_SOLID = 0.5

/**
 * Which pairs of clusters are distinct colours side by side, as similar brand tints are, rather
 * than one colour split by JPEG noise or shading. Each must be a region of its own (noise
 * splits a colour into pixels mixed all through one area, so the two touch everywhere), the
 * step across their shared boundary must be sharp (shading changes gradually), and both must
 * be solid areas of meaningful size (edge fringes are only a pixel or two wide).
 * JPEG colours are trusted only for larger differences (see DISTINCT_DE_LOSSY).
 */
function separateRegions(src: ImageData, bins: number[], assign: Int32Array, centers: Lab[], paper: Uint8Array, mergeDelta: number, fixed?: FixedLabels): (i: number, j: number) => boolean {
  const { width: w, height: h, data: d } = src
  const k = centers.length
  // Only pairs close enough to be merged at all need judging; usually there are none.
  const de = new Float64Array(k * k)
  const candidate = new Uint8Array(k * k)
  let candidates = false
  for (let a = 0; a < k; a++)
    for (let b = a + 1; b < k; b++) {
      de[a * k + b] = deltaE2000(centers[a], centers[b])
      if (de[a * k + b] >= DISTINCT_DE && de[a * k + b] < mergeDelta) candidate[a * k + b] = 1
    }
  for (let i = 0; i < k * k; i++) if (candidate[i]) candidates = true
  if (!candidates) return () => false
  const point = new Int32Array(BINS).fill(-1)
  bins.forEach((b, i) => (point[b] = i))
  const cluster = new Int16Array(w * h).fill(-1)
  const size = new Float64Array(k)
  for (let p = 0, i = 0; p < w * h; p++, i += 4) {
    if (d[i + 3] === 0 || (fixed && fixed.labels[p] >= 0)) continue
    const b = binOf(d[i], d[i + 1], d[i + 2])
    if (paper[b] || point[b] < 0) continue
    cluster[p] = assign[point[b]]
    size[cluster[p]]++
  }
  const inner = new Float64Array(k)
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x
      const c = cluster[p]
      if (c >= 0 && cluster[p - 1] === c && cluster[p + 1] === c && cluster[p - w] === c && cluster[p + w] === c) inner[c]++
    }
  const contact = new Float64Array(k * k)
  const step = new Float64Array(k * k)
  const pair = (p: number, q: number) => {
    const a = cluster[p]
    const b = cluster[q]
    if (a < 0 || b < 0 || a === b) return
    const lo = Math.min(a, b) * k + Math.max(a, b)
    if (!candidate[lo]) return
    contact[lo]++
    step[lo] += Math.hypot(d[p * 4] - d[q * 4], d[p * 4 + 1] - d[q * 4 + 1], d[p * 4 + 2] - d[q * 4 + 2])
  }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = y * w + x
      if (x + 1 < w) pair(p, p + 1)
      if (y + 1 < h) pair(p, p + w)
    }
  const total = size.reduce((s, v) => s + v, 0)
  const rgb = centers.map((c) => labToRgb(c))
  const result = new Uint8Array(k * k)
  // Exact (lossless) colour: most of the cluster's pixels are one RGB value. Counted only when a
  // pair's difference is in the range where it matters.
  const losslessCache = new Map<number, boolean>()
  const lossless = (c: number) => {
    let v = losslessCache.get(c)
    if (v === undefined) {
      const counts = new Map<number, number>()
      for (let p = 0; p < w * h; p++) {
        if (cluster[p] !== c) continue
        const key = (d[p * 4] << 16) | (d[p * 4 + 1] << 8) | d[p * 4 + 2]
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
      let top = 0
      for (const n of counts.values()) if (n > top) top = n
      v = top >= size[c] * EXACT_SHARE
      losslessCache.set(c, v)
    }
    return v
  }
  for (let a = 0; a < k; a++)
    for (let b = a + 1; b < k; b++) {
      const lo = a * k + b
      const small = Math.min(size[a], size[b])
      if (small < total * DISTINCT_MIN_SHARE || inner[a] < size[a] * DISTINCT_SOLID || inner[b] < size[b] * DISTINCT_SOLID) continue
      const d0 = de[lo]
      if (d0 < DISTINCT_DE || d0 >= mergeDelta) continue
      // Without a shared boundary there's no telling two tints from two pieces of one gradient.
      if (!contact[lo] || contact[lo] / small >= SEPARATE_CONTACT) continue
      const gap = Math.hypot(rgb[a][0] - rgb[b][0], rgb[a][1] - rgb[b][1], rgb[a][2] - rgb[b][2])
      const across = step[lo] / contact[lo]
      if (across < SHARP_STEP * gap || across > STEP_MAX * gap) continue
      if (d0 < DISTINCT_DE_LOSSY && !(lossless(a) && lossless(b))) continue
      result[lo] = 1
    }
  return (i, j) => result[Math.min(i, j) * k + Math.max(i, j)] === 1
}

/** Max Lab distance from the line between two colors for a pixel to count as their blend. */
const BLEND_RESIDUAL = 24 // sRGB units

const EMPTY = 255
const PAPER_LABEL = 254

/**
 * 3×3 noise filter over the ink labels. Snapping pixels one by one leaves JPEG noise: stray
 * pixels and ragged edges that become extra paths or nodes once traced. A pixel that shares
 * its label with at most one neighbor takes the clear majority label around it (≥5 of 9).
 * Pixels on a 1px line always have two same-label neighbors, so lines survive.
 * Originally transparent pixels are left alone.
 */
function majorityFilter(src: Uint8Array, w: number, h: number, keep?: (p: number, own: number, around: number, ownCount: number, src: Uint8Array) => boolean): Uint8Array {
  const out = new Uint8Array(src)
  const counts = new Uint16Array(256)
  const seen: number[] = []
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x
      const own0 = src[p]
      if (own0 === EMPTY) continue
      // Only a pixel with at most one same-label neighbour can change: stop at the second match.
      let same = 0
      if (src[p - w - 1] === own0) same++
      if (src[p - w] === own0) same++
      if (same < 2 && src[p - w + 1] === own0) same++
      if (same < 2 && src[p - 1] === own0) same++
      if (same < 2 && src[p + 1] === own0) same++
      if (same < 2 && src[p + w - 1] === own0) same++
      if (same < 2 && src[p + w] === own0) same++
      if (same < 2 && src[p + w + 1] === own0) same++
      if (same >= 2) continue
      seen.length = 0
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const l = src[p + dy * w + dx]
          if (counts[l]++ === 0) seen.push(l)
        }
      const own = src[p]
      const ownCount = counts[own]
      let best = own
      let bestCount = ownCount
      for (const l of seen) {
        if (l !== EMPTY && counts[l] > bestCount) {
          best = l
          bestCount = counts[l]
        }
        counts[l] = 0
      }
      if (ownCount <= 2 && bestCount >= 5 && !keep?.(p, own, best, ownCount, src)) out[p] = best
    }
  }
  return out
}

/**
 * Merges connected regions smaller than `minArea` pixels into the label that surrounds them
 * most. Small but long features (thin lines) have a large area and are kept, and so are
 * regions `keep` accepts (real detail, such as letter counters and full stops).
 */
function removeSpecks(labels: Uint8Array, w: number, h: number, minArea: number, keep?: (members: number[], label: number, around: number[]) => boolean) {
  const n = w * h
  const comp = new Int32Array(n).fill(-1)
  const stack = new Int32Array(n)
  const members: number[] = []
  const border = new Uint32Array(256)
  let id = 0
  for (let start = 0; start < n; start++) {
    if (comp[start] !== -1 || labels[start] === EMPTY) continue
    const label = labels[start]
    members.length = 0
    let top = 0
    stack[top++] = start
    comp[start] = id
    let touched: number[] = []
    while (top) {
      const p = stack[--top]
      members.push(p)
      const x = p % w
      const nbrs = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p >= w ? p - w : -1, p < n - w ? p + w : -1]
      for (const q of nbrs) {
        if (q < 0) continue
        if (labels[q] === label) {
          if (comp[q] === -1) {
            comp[q] = id
            stack[top++] = q
          }
        } else if (labels[q] !== EMPTY) {
          if (border[labels[q]]++ === 0) touched.push(labels[q])
        }
      }
      // Stop counting once it's clearly not a speck.
      if (members.length >= minArea) break
    }
    if (members.length < minArea && touched.length && !keep?.(members, label, touched)) {
      let best = touched[0]
      for (const l of touched) if (border[l] > border[best]) best = l
      for (const p of members) labels[p] = best
    } else if (members.length >= minArea) {
      // Finish marking the region so its pixels aren't revisited as new seeds.
      while (top) {
        const p = stack[--top]
        const x = p % w
        for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p >= w ? p - w : -1, p < n - w ? p + w : -1]) {
          if (q >= 0 && labels[q] === label && comp[q] === -1) {
            comp[q] = id
            stack[top++] = q
          }
        }
      }
    }
    for (const l of touched) border[l] = 0
    touched = []
    id++
  }
}

/** A small region's colour must differ from the one around it by at least this (sRGB distance). */
const DETAIL_CONTRAST = 64
/** …and at least one of its pixels must be this far from the surrounding colour towards its own. */
const DETAIL_SOLID = 0.7

/**
 * Whether a region below the speck size is real detail rather than compression noise: it's
 * enclosed by a single colour (a letter counter inside its letter, a full stop or dot on the
 * background; noise usually sits on a boundary between colours), it contrasts clearly with
 * that colour, and it's solid somewhere (a real dot has a solid centre; a smudge is a half-blend
 * that happened to land nearer one colour).
 */
function isDetail(members: number[], label: number, around: number[], d: Uint8ClampedArray, labelRgb: number[]): boolean {
  if (around.length !== 1 || label >= labelRgb.length || around[0] >= labelRgb.length) return false
  const own = labelRgb[label]
  const out = labelRgb[around[0]]
  const L = [(own >> 16) & 255, (own >> 8) & 255, own & 255]
  const E = [(out >> 16) & 255, (out >> 8) & 255, out & 255]
  const v = [L[0] - E[0], L[1] - E[1], L[2] - E[2]]
  const len2 = v[0] * v[0] + v[1] * v[1] + v[2] * v[2]
  if (len2 < DETAIL_CONTRAST * DETAIL_CONTRAST) return false
  let best = 0
  for (const p of members) {
    const t = ((d[p * 4] - E[0]) * v[0] + (d[p * 4 + 1] - E[1]) * v[1] + (d[p * 4 + 2] - E[2]) * v[2]) / len2
    if (t > best) best = t
  }
  return best >= DETAIL_SOLID
}

/**
 * Whether pixel p is solidly its own label's colour against the colour around it (the test
 * isDetail applies to a whole region): the two colours differ clearly, and the pixel sits at
 * least DETAIL_SOLID of the way from the surrounding colour to its own.
 */
/**
 * Whether pixel p ends a line: its one same-label neighbour continues in the same direction for at
 * least two more pixels (not a speck or a two-pixel clump).
 */
function lineEnd(src: Uint8Array, w: number, h: number, p: number): boolean {
  const own = src[p]
  const x = p % w
  const y = (p / w) | 0
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      if ((!dx && !dy) || src[p + dy * w + dx] !== own) continue
      const x2 = x + 3 * dx
      const y2 = y + 3 * dy
      if (x2 < 0 || y2 < 0 || x2 >= w || y2 >= h) return false
      return src[p + 2 * (dy * w + dx)] === own && src[p + 3 * (dy * w + dx)] === own
    }
  return false
}

function isSolid(d: Uint8ClampedArray, p: number, own: number | undefined, out: number | undefined): boolean {
  if (own === undefined || out === undefined) return false
  const L = [(own >> 16) & 255, (own >> 8) & 255, own & 255]
  const E = [(out >> 16) & 255, (out >> 8) & 255, out & 255]
  const v = [L[0] - E[0], L[1] - E[1], L[2] - E[2]]
  const len2 = v[0] * v[0] + v[1] * v[1] + v[2] * v[2]
  if (len2 < DETAIL_CONTRAST * DETAIL_CONTRAST) return false
  const t = ((d[p * 4] - E[0]) * v[0] + (d[p * 4 + 1] - E[1]) * v[1] + (d[p * 4 + 2] - E[2]) * v[2]) / len2
  return t >= DETAIL_SOLID
}

/** Clusters smaller than this share of the inked area are candidates for being blend fringe. */
const BLEND_MAX_SHARE = 0.06
/** Fringe clusters have at most this share of pixels whose 4 neighbors share their cluster. */
const BLEND_MAX_INTERIOR = 0.25
/** Max distance (sRGB units) from the mix of two colors to count as a blend of them. */
const BLEND_TOLERANCE = 14

/** Per cluster: share of its pixels whose 4 neighbors are all in the same cluster. */
function interiorShare(src: ImageData, bins: number[], assign: Int32Array, k: number, paper: Uint8Array): number[] {
  const clusterOfBin = new Int16Array(BINS).fill(-1)
  bins.forEach((b, i) => (clusterOfBin[b] = assign[i]))
  const { width: w, height: h, data: d } = src
  const cl = new Int16Array(w * h).fill(-1)
  for (let p = 0, i = 0; p < cl.length; p++, i += 4) {
    if (d[i + 3] === 0) continue
    const b = binOf(d[i], d[i + 1], d[i + 2])
    if (!paper[b]) cl[p] = clusterOfBin[b]
  }
  const total = new Float64Array(k)
  const inner = new Float64Array(k)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = y * w + x
      const c = cl[p]
      if (c < 0) continue
      total[c]++
      if (x > 0 && x < w - 1 && y > 0 && y < h - 1 && cl[p - 1] === c && cl[p + 1] === c && cl[p - w] === c && cl[p + w] === c) inner[c]++
    }
  return Array.from(total, (t, c) => (t ? inner[c] / t : 0))
}

/**
 * Anti-aliased edges and JPEG fringes produce in-between colors (blue fading into white paper,
 * red into blue) that k-means happily turns into extra inks. Each such ink would be a whole
 * extra screen at the printer, so drop small clusters that sit on the line between two other
 * colors (or a color and paper) and hand their pixels to the nearest remaining cluster.
 */
function dropBlendClusters(
  centers: Lab[],
  assign: Int32Array,
  points: Lab[],
  weights: number[],
  paper: boolean,
  interior: number[],
): { centers: Lab[]; assign: Int32Array } {
  const share = centers.map(() => 0)
  let total = 0
  assign.forEach((c, i) => {
    share[c] += weights[i]
    total += weights[i]
  })
  const alive = centers.map(() => true)
  // Smallest first, so a fringe is judged against the real colors, not other fringes.
  const order = centers.map((_, i) => i).sort((a, b) => share[a] - share[b])
  for (const c of order) {
    // Fringes are thin: hardly any of their pixels are surrounded by the same color. A real
    // color, however small (a tree trunk, a dot), has an interior.
    if (share[c] / total > BLEND_MAX_SHARE || interior[c] > BLEND_MAX_INTERIOR) continue
    const others: number[][] = centers.filter((_, i) => i !== c && alive[i]).map((o) => labToRgb(o))
    if (paper) others.push([255, 255, 255])
    const self = labToRgb(centers[c])
    let blend = false
    for (let i = 0; i < others.length && !blend; i++)
      for (let j = i + 1; j < others.length && !blend; j++) {
        const info = blendInfo(self, others[i], others[j], BLEND_TOLERANCE)
        blend = !!info && info.mix > 0.05 && info.mix < 0.95
      }
    if (blend && alive.filter(Boolean).length > 1) alive[c] = false
  }
  if (alive.every(Boolean)) return { centers, assign }

  const kept = centers.filter((_, i) => alive[i])
  const out = new Int32Array(assign.length)
  points.forEach((p, i) => {
    let best = 0
    let bd = Infinity
    kept.forEach((k, j) => {
      const d = (p[0] - k[0]) ** 2 + (p[1] - k[1]) ** 2 + (p[2] - k[2]) ** 2
      if (d < bd) {
        bd = d
        best = j
      }
    })
    out[i] = best
  })
  return { centers: kept, assign: out }
}

const toYcc = (c: number[]) => [
  0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2],
  -0.1687 * c[0] - 0.3313 * c[1] + 0.5 * c[2],
  0.5 * c[0] - 0.4187 * c[1] - 0.0813 * c[2],
]

/**
 * If sRGB color `c` is a mix of `a` and `b`, returns how much of `b` it contains (0–1);
 * otherwise null. Two kinds of mixing are recognized:
 * - anti-aliasing, which blends linearly in RGB;
 * - JPEG chroma subsampling, where brightness mixes per pixel but hue per 2×2 block, so an edge
 *   pixel can be dark like one color yet tinted like the other (dark orange between navy and
 *   orange). Then brightness gives the ratio, and the hue only has to lie between the two.
 */
export function blendRatio(c: number[], a: number[], b: number[], tolerance: number): number | null {
  return blendInfo(c, a, b, tolerance)?.t ?? null
}

/**
 * Like blendRatio, but also reports how far the color's hue has moved from `a` toward `b`
 * (`hue`, 0–1). A JPEG edge pixel can keep one color's brightness while its hue bleeds toward
 * the neighbour (dark brown between navy and orange): by brightness it looks like pure navy
 * (t ≈ 0), but its hue says it's a mix. Use `t` for placing edges, `mix` for deciding whether a
 * color is a blend at all.
 */
export function blendInfo(c: number[], a: number[], b: number[], tolerance: number): { t: number; hue: number; mix: number } | null {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
  const len2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2
  if (!len2) return null
  const t = ((c[0] - a[0]) * ab[0] + (c[1] - a[1]) * ab[1] + (c[2] - a[2]) * ab[2]) / len2
  if (t >= -0.05 && t <= 1.05 && Math.hypot(c[0] - a[0] - t * ab[0], c[1] - a[1] - t * ab[1], c[2] - a[2] - t * ab[2]) < tolerance) {
    const tt = Math.min(1, Math.max(0, t))
    return { t: tt, hue: tt, mix: tt }
  }

  const [yc, ubc, vc] = toYcc(c)
  const [ya, ua, va] = toYcc(a)
  const [yb, ub, vb] = toYcc(b)
  if (Math.abs(yb - ya) < 24) return null // too close in brightness to tell the ratio
  const tl = (yc - ya) / (yb - ya)
  if (tl < -0.05 || tl > 1.05) return null
  const du = ub - ua
  const dv = vb - va
  const cl2 = du * du + dv * dv
  const tc = cl2 ? Math.min(1, Math.max(0, ((ubc - ua) * du + (vc - va) * dv) / cl2)) : 0
  if (Math.hypot(ubc - ua - tc * du, vc - va - tc * dv) >= tolerance) return null
  const tt = Math.min(1, Math.max(0, tl))
  // How mixed the color is overall: whichever of brightness or hue is further from both ends.
  const mix = Math.abs(tc - 0.5) < Math.abs(tt - 0.5) ? tc : tt
  return { t: tt, hue: tc, mix }
}

/** Weighted k-means in Lab with deterministic farthest-point seeding (stable across reruns). */
function kmeans(points: Lab[], weights: number[], k: number): { centers: Lab[]; assign: Int32Array } {
  const n = points.length
  const d2 = (a: Lab, b: Lab) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2

  let first = 0
  for (let i = 1; i < n; i++) if (weights[i] > weights[first]) first = i
  const centers: Lab[] = [[...points[first]] as Lab]
  const minD = points.map((p) => d2(p, centers[0]))
  while (centers.length < k) {
    // Favor colors that are both far from existing centers and common, so small noise
    // doesn't become an ink while a distinct small accent color still can.
    let best = -1
    let bestScore = 0
    for (let i = 0; i < n; i++) {
      const score = minD[i] * Math.sqrt(weights[i])
      if (score > bestScore) {
        bestScore = score
        best = i
      }
    }
    if (best < 0) break
    centers.push([...points[best]] as Lab)
    for (let i = 0; i < n; i++) minD[i] = Math.min(minD[i], d2(points[i], centers[centers.length - 1]))
  }

  const assign = new Int32Array(n)
  for (let iter = 0; iter < 20; iter++) {
    let moved = false
    for (let i = 0; i < n; i++) {
      let bi = 0
      let bd = Infinity
      for (let c = 0; c < centers.length; c++) {
        const dist = d2(points[i], centers[c])
        if (dist < bd) {
          bd = dist
          bi = c
        }
      }
      if (assign[i] !== bi) {
        assign[i] = bi
        moved = true
      }
    }
    const acc = centers.map(() => [0, 0, 0, 0])
    for (let i = 0; i < n; i++) {
      const a = acc[assign[i]]
      const w = weights[i]
      a[0] += points[i][0] * w
      a[1] += points[i][1] * w
      a[2] += points[i][2] * w
      a[3] += w
    }
    acc.forEach((a, c) => {
      if (a[3]) centers[c] = [a[0] / a[3], a[1] / a[3], a[2] / a[3]]
    })
    if (!moved && iter > 0) break
  }
  return { centers, assign }
}

/**
 * Attaches ink names to the traced SVG: each path gets an `id` (Illustrator shows it as the
 * object name) and a `data-ink` attribute, and a <desc> lists the inks used.
 */
export function annotateSvg(svg: string, inks: Ink[]): string {
  return nameSvg(svg, new Map(inks.map((i) => [(i.swatch.rgb[0] << 16) | (i.swatch.rgb[1] << 8) | i.swatch.rgb[2], i.swatch.name])))
}

/**
 * Names everything in a traced SVG after its ink: each color group gets an `id` (Illustrator
 * and Figma show it as the group/layer name), each shape gets `Name_1`, `Name_2`, …, and a
 * <desc> lists the inks used. Colors without a name are left as they are.
 */
export function nameSvg(svg: string, names: Map<number, string>): string {
  const nameOf = (fill: string) => names.get(parseInt(fill.slice(1), 16))
  const slug = (n: string) => n.replace(/[^A-Za-z0-9-]+/g, '_').replace(/^_+|_+$/g, '') || 'Color'
  const groups = new Map<string, number>()
  let out = svg.replace(/<g data-color="(#[0-9A-Fa-f]{6})">/g, (m, fill: string) => {
    const name = nameOf(fill)
    if (!name) return m
    const k = (groups.get(name) ?? 0) + 1
    groups.set(name, k)
    const id = k === 1 ? slug(name) : `${slug(name)}-layer${k}`
    return `<g id="${id}" data-name="${escapeXml(name)}" data-color="${fill}">`
  })
  const counters = new Map<string, number>()
  out = out.replace(/<path\b([^>]*?)fill="(#[0-9A-Fa-f]{6})"/g, (m, pre: string, fill: string) => {
    const name = nameOf(fill)
    if (!name || /\sid="/.test(pre)) return m
    const n = (counters.get(name) ?? 0) + 1
    counters.set(name, n)
    return `<path id="${slug(name)}_${n}" data-ink="${escapeXml(name)}"${pre}fill="${fill}"`
  })
  const used = [...new Set([...out.matchAll(/fill="(#[0-9A-Fa-f]{6})"/g)].map((x) => x[1].toUpperCase()))]
  const list = used.map((f) => `${nameOf(f) ?? f} (${f})`).join('; ')
  return out.replace(/(<svg[^>]*>)/, `$1\n<desc>Inks: ${escapeXml(list)}</desc>`)
}

const escapeXml = (s: string) => s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`)
