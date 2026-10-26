// Design-intent prototype (research, docs/design-intent.md): redraws the texture of an
// illustration object by object, as a designer would. Each object found by SAM (sam.ts) is drawn
// as its silhouette filled with a few smoothed tones, coarser for large objects (a head) and finer
// for small ones (an eye); objects that are symmetric left to right get mirrored halves.
import type { LabelMap } from '../trace'
import type { ObjectMask } from './sam'

export interface RedrawOptions {
  /** Smoothing radius per object: sqrt(area) / this, within [minRadius, maxRadius]. */
  radiusDivisor?: number
  minRadius?: number
  maxRadius?: number
  /** Shapes smaller than this share of their object join the tone around them. */
  speckShare?: number
  /** Mirror objects whose silhouette matches its mirror image at least this well (IoU)… */
  symmetry?: number
  /** …and that are at most this share of the image (parts such as a face, not a whole head). */
  mirrorMaxShare?: number
  /** Tones per object (2 for small ones). */
  tones?: number
}

export interface RedrawReport {
  objects: { area: number; radius: number; mirrored: boolean; axis: number | null; symmetry: number }[]
}

/**
 * `map` is the flat map with the texture already in tones (simplifyTexture). Objects are applied
 * largest first, each over the result so far, so a face is redrawn over the head it sits in.
 */
export function redrawObjects(map: LabelMap, objects: ObjectMask[], src: ImageData, texture: Uint8Array, opts: RedrawOptions = {}): { map: LabelMap; report: RedrawReport } {
  const { radiusDivisor = 50, minRadius = 1, maxRadius = 4, speckShare = 0.006, symmetry = 0.9, tones = 3, mirrorMaxShare = 0.03 } = opts
  const { w } = map
  const labels = map.labels.slice()
  const colors = map.colors.slice()
  const avg = boxAverage(src, 2)
  const report: RedrawReport = { objects: [] }
  // Objects change the texture only: lettering and rings beside it (a SAM object can reach into
  // them) stay as the flat tracer drew them. The symmetry test uses the whole silhouette.
  const clipped = objects.map((o) => {
    const mask = o.mask.map((v, p) => (v && texture[p] ? 1 : 0))
    return { ...o, mask, area: mask.reduce((s, v) => s + v, 0), whole: o }
  })
  for (const o of clipped.filter((c) => c.area > 0).sort((a, b) => b.whole.area - a.whole.area)) {
    // The object's own tones, as a designer picks them: base, shadow and highlight.
    toneWithin(labels, colors, o, w, avg, o.area < 3000 ? 2 : tones)
    const radius = Math.max(minRadius, Math.min(maxRadius, Math.round(Math.sqrt(o.area) / radiusDivisor)))
    smoothWithin(labels, o, w, radius)
    dropSpecks(labels, o, w, Math.max(12, Math.round(o.area * speckShare)))
    // Mirroring suits parts (a face, a muzzle); a head with its fur parting mirrors into a mask.
    const { axis, score } = mirrorAxis(o.whole, w)
    const mirrored = axis !== null && score >= symmetry && o.area <= labels.length * mirrorMaxShare
    if (mirrored) mirrorWithin(labels, o, w, axis!)
    report.objects.push({ area: o.area, radius, mirrored, axis, symmetry: +score.toFixed(3) })
  }
  // Changed pixels are pure (no edge blend); fine-detail labelling no longer matches, so it's dropped.
  const second = map.second.map((v, p) => (labels[p] !== map.labels[p] ? 255 : v))
  const cov = map.cov.map((v, p) => (labels[p] !== map.labels[p] ? 1 : v))
  return { map: { ...map, colors, labels, second, cov, fine: undefined }, report }
}

/** The source averaged over a (2r+1)² box, as RGB per pixel. */
function boxAverage(src: ImageData, r: number): Float32Array {
  const { width: w, height: h, data: d } = src
  const out = new Float32Array(w * h * 3)
  const sat = new Float64Array((w + 1) * (h + 1))
  for (let c = 0; c < 3; c++) {
    for (let y = 0; y < h; y++) {
      let row = 0
      for (let x = 0; x < w; x++) {
        row += d[(y * w + x) * 4 + c]
        sat[(y + 1) * (w + 1) + x + 1] = sat[y * (w + 1) + x + 1] + row
      }
    }
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1)
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1)
        out[(y * w + x) * 3 + c] = (sat[y1 * (w + 1) + x1] - sat[y0 * (w + 1) + x1] - sat[y1 * (w + 1) + x0] + sat[y0 * (w + 1) + x0]) / ((x1 - x0) * (y1 - y0))
      }
    }
  }
  return out
}

/** Colours this close (RGB distance) are one colour. */
const SAME = 24

/** The object's pixels in k tones of its own (k-means of the averaged source), sharing close colours. */
function toneWithin(labels: Uint8Array, colors: number[], o: ObjectMask, w: number, avg: Float32Array, k: number) {
  const [bx0, by0, bx1, by1] = o.box
  const px: number[] = []
  for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) if (o.mask[y * w + x]) px.push(y * w + x)
  if (!px.length) return
  const light = (p: number) => 0.299 * avg[p * 3] + 0.587 * avg[p * 3 + 1] + 0.114 * avg[p * 3 + 2]
  const sorted = px.filter((_, i) => i % Math.max(1, Math.floor(px.length / 8000)) === 0).sort((a, b) => light(a) - light(b))
  let centers = Array.from({ length: k }, (_, i) => {
    const p = sorted[Math.floor(((i + 0.5) / k) * sorted.length)]
    return [avg[p * 3], avg[p * 3 + 1], avg[p * 3 + 2]]
  })
  const nearest = (p: number) => {
    let best = 0
    let bd = Infinity
    centers.forEach(([r, g, b], c) => {
      const dd = (avg[p * 3] - r) ** 2 + (avg[p * 3 + 1] - g) ** 2 + (avg[p * 3 + 2] - b) ** 2
      if (dd < bd) [best, bd] = [c, dd]
    })
    return best
  }
  for (let it = 0; it < 10; it++) {
    const sums = centers.map(() => [0, 0, 0, 0])
    for (const p of sorted) {
      const c = nearest(p)
      sums[c][0] += avg[p * 3]
      sums[c][1] += avg[p * 3 + 1]
      sums[c][2] += avg[p * 3 + 2]
      sums[c][3]++
    }
    centers = centers.map((c, i) => (sums[i][3] ? [sums[i][0] / sums[i][3], sums[i][1] / sums[i][3], sums[i][2] / sums[i][3]] : c))
  }
  const toLabel = centers.map(([r, g, b]) => {
    let near = -1
    let nd = SAME * SAME
    colors.forEach((c, l) => {
      if (c < 0) return
      const dd = (((c >> 16) & 255) - r) ** 2 + (((c >> 8) & 255) - g) ** 2 + ((c & 255) - b) ** 2
      if (dd < nd) [near, nd] = [l, dd]
    })
    if (near >= 0 || colors.length >= 254) return Math.max(0, near)
    colors.push((Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b))
    return colors.length - 1
  })
  for (const p of px) labels[p] = toLabel[nearest(p)]
}

/** Mode filter of the labels inside the object (only its own pixels count), radius r. */
function smoothWithin(labels: Uint8Array, o: ObjectMask, w: number, r: number) {
  const [bx0, by0, bx1, by1] = o.box
  const bw = bx1 - bx0 + 1
  const bh = by1 - by0 + 1
  const present = new Set<number>()
  for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) if (o.mask[y * w + x]) present.add(labels[y * w + x])
  const best = new Int32Array(bw * bh)
  const out = new Uint8Array(bw * bh)
  const sat = new Int32Array((bw + 1) * (bh + 1))
  for (const l of present) {
    for (let y = 0; y < bh; y++) {
      let row = 0
      for (let x = 0; x < bw; x++) {
        const p = (y + by0) * w + x + bx0
        if (o.mask[p] && labels[p] === l) row++
        sat[(y + 1) * (bw + 1) + x + 1] = sat[y * (bw + 1) + x + 1] + row
      }
    }
    for (let y = 0; y < bh; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(bh, y + r + 1)
      for (let x = 0; x < bw; x++) {
        if (!o.mask[(y + by0) * w + x + bx0]) continue
        const x0 = Math.max(0, x - r), x1 = Math.min(bw, x + r + 1)
        const c = sat[y1 * (bw + 1) + x1] - sat[y0 * (bw + 1) + x1] - sat[y1 * (bw + 1) + x0] + sat[y0 * (bw + 1) + x0]
        if (c > best[y * bw + x]) {
          best[y * bw + x] = c
          out[y * bw + x] = l
        }
      }
    }
  }
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) if (o.mask[(y + by0) * w + x + bx0]) labels[(y + by0) * w + x + bx0] = out[y * bw + x]
}

/** Pieces of one label inside the object smaller than minArea take the label they border most. */
function dropSpecks(labels: Uint8Array, o: ObjectMask, w: number, minArea: number) {
  const seen = new Uint8Array(labels.length)
  const [bx0, by0, bx1, by1] = o.box
  for (let y = by0; y <= by1; y++)
    for (let x = bx0; x <= bx1; x++) {
      const s = y * w + x
      if (!o.mask[s] || seen[s]) continue
      const l = labels[s]
      const members: number[] = []
      const around = new Map<number, number>()
      const stack = [s]
      seen[s] = 1
      while (stack.length) {
        const p = stack.pop()!
        members.push(p)
        const px = p % w
        for (const q of [px > 0 ? p - 1 : -1, px < w - 1 ? p + 1 : -1, p - w, p + w]) {
          if (q < 0 || q >= labels.length) continue
          if (labels[q] === l && o.mask[q]) {
            if (!seen[q]) (seen[q] = 1), stack.push(q)
          } else if (o.mask[q]) around.set(labels[q], (around.get(labels[q]) ?? 0) + 1)
        }
      }
      if (members.length >= minArea || !around.size) continue
      let to = l
      let most = 0
      for (const [k, c] of around) if (c > most) [to, most] = [k, c]
      for (const p of members) labels[p] = to
    }
}

/** The vertical axis (x) about which the object's silhouette best matches its mirror image, and how well (IoU). */
export function mirrorAxis(o: ObjectMask, w: number): { axis: number | null; score: number } {
  const [bx0, by0, bx1, by1] = o.box
  const centre = (bx0 + bx1) / 2
  const span = Math.max(2, Math.round((bx1 - bx0) * 0.1))
  let best = { axis: null as number | null, score: 0 }
  for (let a2 = Math.round((centre - span) * 2); a2 <= Math.round((centre + span) * 2); a2++) {
    // Axis at a2 / 2: pixel x mirrors to a2 - x.
    let inter = 0
    let union = 0
    for (let y = by0; y <= by1; y++)
      for (let x = bx0; x <= bx1; x++) {
        const a = o.mask[y * w + x]
        const mx = a2 - x
        const b = mx >= 0 && mx < w ? o.mask[y * w + mx] : 0
        if (a && b) inter++
        if (a || b) union++
      }
    const score = union ? inter / union : 0
    if (score > best.score) best = { axis: a2 / 2, score }
  }
  return best
}

/** The object's left half copied onto its right, mirrored about x = axis (where both are inside it). */
function mirrorWithin(labels: Uint8Array, o: ObjectMask, w: number, axis: number) {
  const [bx0, by0, bx1, by1] = o.box
  const a2 = Math.round(axis * 2)
  for (let y = by0; y <= by1; y++)
    for (let x = Math.ceil(axis); x <= bx1; x++) {
      const mx = a2 - x
      if (mx < bx0 || mx >= x) continue
      const p = y * w + x
      const q = y * w + mx
      if (o.mask[p] && o.mask[q]) labels[p] = labels[q]
    }
}
