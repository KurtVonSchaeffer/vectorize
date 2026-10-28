/**
 * vetoDistantPartners counts labels in a window slid along each row instead of recounting the
 * window at every pixel. That must not change its result: `second` and `cov` have to match, bit for
 * bit, those of the original per-pixel count (kept below as the reference) on the same inputs.
 */
import { describe, expect, it } from 'vitest'
import { blendRatio, vetoDistantPartners } from '../quantize'

const EMPTY = 255

// The implementation before the sliding window, verbatim (constants inlined).
function lineOffset(c: number[], a: number[], b: number[]): number {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
  const len2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2
  const t = len2 ? Math.min(1, Math.max(0, ((c[0] - a[0]) * ab[0] + (c[1] - a[1]) * ab[1] + (c[2] - a[2]) * ab[2]) / len2)) : 0
  return Math.hypot(c[0] - a[0] - t * ab[0], c[1] - a[1] - t * ab[1], c[2] - a[2] - t * ab[2])
}
function reference(d: Uint8ClampedArray, w: number, h: number, labels: Uint8Array, second: Uint8Array, cov: Float32Array, anchors: { lab: number[]; label: number }[]) {
  const PRESENT_RADIUS = 3, PRESENT_MIN = 2, EXACT_MIX = 4, MIX_MIN = 0.2, BLEND_RESIDUAL = 24
  const rgbOf = new Map<number, number[]>()
  for (const a of anchors) if (!rgbOf.has(a.label)) rgbOf.set(a.label, a.lab)
  const votes = new Uint16Array(256)
  const seen: number[] = []
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = y * w + x
      const s = second[p]
      if (s === EMPTY || cov[p] >= 1) continue
      for (let yy = Math.max(0, y - PRESENT_RADIUS); yy <= Math.min(h - 1, y + PRESENT_RADIUS); yy++)
        for (let xx = Math.max(0, x - PRESENT_RADIUS); xx <= Math.min(w - 1, x + PRESENT_RADIUS); xx++) {
          const l = labels[yy * w + xx]
          if (l === EMPTY) continue
          if (!votes[l]) seen.push(l)
          votes[l]++
        }
      const present = seen.filter((l) => votes[l] >= PRESENT_MIN)
      for (const l of seen) votes[l] = 0
      seen.length = 0
      if (present.includes(s)) continue
      const P = rgbOf.get(labels[p])
      const c = [d[p * 4], d[p * 4 + 1], d[p * 4 + 2]]
      const S = rgbOf.get(s)
      if (P && S && lineOffset(c, P, S) <= EXACT_MIX && cov[p] >= MIX_MIN && cov[p] <= 1 - MIX_MIN) continue
      second[p] = EMPTY
      cov[p] = 1
      if (!P) continue
      let best = -1
      let bestOff = Infinity
      for (const l of present) {
        if (l === labels[p] || !rgbOf.has(l)) continue
        const off = lineOffset(c, P, rgbOf.get(l)!)
        if (off < bestOff) [bestOff, best] = [off, l]
      }
      if (best < 0) continue
      const t = blendRatio(c, P, rgbOf.get(best)!, BLEND_RESIDUAL)
      if (t === null) continue
      second[p] = best
      cov[p] = 1 - t
    }
}

/**
 * A random label map of blobs (so colours are present in some windows and absent in others), with
 * scattered single pixels and transparent holes; edge pixels with partners chosen anywhere, some of
 * them exact mixes of their two colours, and anchors missing or repeated for some labels.
 */
function scene(seed: number, w: number, h: number) {
  let s = seed
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647
  const nLabels = 2 + Math.floor(rnd() * 8)
  const rgb = Array.from({ length: nLabels }, () => [rnd() * 255, rnd() * 255, rnd() * 255])
  if (nLabels > 3 && rnd() < 0.5) rgb[nLabels - 1] = rgb[1].slice() // equally close partners: the scan order decides
  const labels = new Uint8Array(w * h)
  const blobs = Array.from({ length: 3 + Math.floor(rnd() * 10) }, () => ({ x: rnd() * w, y: rnd() * h, r: 1 + rnd() * 12, l: Math.floor(rnd() * nLabels) }))
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let l = 0
      for (const b of blobs) if (Math.hypot(x - b.x, y - b.y) < b.r) l = b.l
      const u = rnd()
      labels[y * w + x] = u < 0.03 ? EMPTY : u < 0.08 ? Math.floor(rnd() * nLabels) : l
    }
  const d = new Uint8ClampedArray(w * h * 4)
  const second = new Uint8Array(w * h).fill(EMPTY)
  const cov = new Float32Array(w * h).fill(1)
  for (let p = 0; p < w * h; p++) {
    const l = labels[p]
    const base = l === EMPTY ? [0, 0, 0] : rgb[l]
    d.set([base[0] + (rnd() - 0.5) * 30, base[1] + (rnd() - 0.5) * 30, base[2] + (rnd() - 0.5) * 30, 255], p * 4)
    if (l === EMPTY || rnd() < 0.3) continue
    const s2 = rnd() < 0.05 ? nLabels + 3 : Math.floor(rnd() * nLabels) // a few partners with no anchor
    second[p] = s2
    cov[p] = rnd() < 0.1 ? 1 : rnd()
    if (s2 < nLabels && rnd() < 0.3) {
      // An exact mix of the two colours.
      const t = 0.1 + rnd() * 0.8
      d.set([0, 1, 2].map((i) => base[i] * (1 - t) + rgb[s2][i] * t), p * 4)
      cov[p] = 1 - t
    }
  }
  const anchors = rgb.map((lab, label) => ({ lab, label })).filter(() => rnd() > 0.1)
  anchors.push({ lab: [rnd() * 255, rnd() * 255, rnd() * 255], label: Math.floor(rnd() * nLabels) }) // a repeated label: the first anchor wins
  return { d, labels, second, cov, anchors }
}

describe('vetoDistantPartners', () => {
  const sizes: [number, number][] = [[1, 1], [1, 9], [9, 1], [3, 5], [7, 7], [8, 8], [40, 3], [3, 40], [64, 48], [120, 90], [160, 120]]
  it('matches the per-pixel window count bit for bit', { timeout: 30000 }, () => {
    let changed = 0
    let repartnered = 0
    for (const [w, h] of sizes)
      for (let seed = 1; seed <= 12; seed++) {
        const a = scene(seed * 7919 + w * 31 + h, w, h)
        const b = { second: a.second.slice(), cov: a.cov.slice() }
        const before = a.second.slice()
        reference(a.d, w, h, a.labels, a.second, a.cov, a.anchors)
        vetoDistantPartners(a.d, w, h, a.labels, b.second, b.cov, a.anchors)
        expect(b.second).toEqual(a.second)
        expect(b.cov).toEqual(a.cov)
        for (let p = 0; p < w * h; p++)
          if (before[p] !== a.second[p]) {
            changed++
            if (a.second[p] !== EMPTY) repartnered++
          }
      }
    // Both outcomes of the veto were exercised, not only the "partner is present" path.
    expect(changed).toBeGreaterThan(100)
    expect(repartnered).toBeGreaterThan(20)
  })
})
