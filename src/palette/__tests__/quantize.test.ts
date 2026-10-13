import { describe, expect, it } from 'vitest'
import { quantize, upscaleLabels, type QuantizeOptions } from '../quantize'

// ImageData isn't available in Node.
class FakeImageData {
  constructor(
    public data: Uint8ClampedArray,
    public width: number,
    public height: number,
  ) {}
}
;(globalThis as unknown as { ImageData: unknown }).ImageData = FakeImageData

const EMPTY = 255
const OPTS: QuantizeOptions = { maxColors: 8, mergeDelta: 10, whiteIsPaper: false, palette: null, overrides: {}, minArea: 9, upscale: 1, smoothing: 0 }

/** An image drawn per pixel: [r, g, b, a]. */
function image(w: number, h: number, px: (x: number, y: number) => [number, number, number, number]): ImageData {
  const d = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d.set(px(x, y), (y * w + x) * 4)
  return new FakeImageData(d, w, h) as unknown as ImageData
}

const mix = (a: number[], b: number[], t: number) => a.map((v, i) => Math.round(v * (1 - t) + b[i] * t))
const RED = [220, 30, 40]
const BLUE = [20, 60, 200]

describe('quantize: transparency', () => {
  it('keeps genuinely transparent pixels transparent through noise cleanup', () => {
    // A red disc on a transparent background, with isolated transparent pinholes inside it.
    const holes = new Set([20 * 40 + 20, 15 * 40 + 22, 24 * 40 + 17])
    const src = image(40, 40, (x, y) => (holes.has(y * 40 + x) || Math.hypot(x - 20, y - 20) > 12 ? [0, 0, 0, 0] : [...RED, 255] as [number, number, number, number]))
    const { map } = quantize(src, OPTS)
    for (const p of holes) expect(map.labels[p]).toBe(EMPTY)
    expect(map.labels[0]).toBe(EMPTY)
    // And no inked pixel was turned transparent.
    for (let p = 0; p < 1600; p++) if (src.data[p * 4 + 3] === 255) expect(map.labels[p]).not.toBe(EMPTY)
  })

  it('never makes ink transparent while smoothing edges, even without blend information', () => {
    const w = 12
    const labels = new Uint8Array(w * w).map((_, p) => (p % w < 6 ? 0 : 1))
    const second = new Uint8Array(w * w).fill(EMPTY)
    // Partial coverage but no second color recorded: the vote must stay with the first color.
    const cov = new Float32Array(w * w).fill(0.3)
    const out = upscaleLabels(labels, w, w, 3, 0.8, second, cov)
    expect(out.every((l) => l === 0 || l === 1)).toBe(true)
  })
})

describe('quantize: colours', () => {
  it('keeps two adjacent colours with an anti-aliased edge as exactly two colours', () => {
    // Blue left, red right, with a soft 2px anti-aliased boundary.
    const src = image(48, 32, (x) => [...mix(BLUE, RED, Math.min(1, Math.max(0, (x - 23) / 2))), 255] as [number, number, number, number])
    const { map } = quantize(src, OPTS)
    expect(new Set(map.labels).size).toBe(2)
    // The boundary stays where it was drawn (between x=23 and x=25).
    const row = Array.from(map.labels.subarray(16 * 48, 17 * 48))
    const edge = row.findIndex((l) => l !== row[0])
    expect(edge).toBeGreaterThanOrEqual(23)
    expect(edge).toBeLessThanOrEqual(25)
  })

  it('keeps the original colours, not their anti-aliased or JPEG-drifted average', () => {
    const src = image(48, 32, (x, y) => {
      const noise = ((x * 7 + y * 13) % 5) - 2
      const c = x < 24 ? BLUE : RED
      return [c[0] + noise, c[1] - noise, c[2] + noise, 255]
    })
    const { map } = quantize(src, OPTS)
    const colors = [...new Set(map.labels)].map((l) => map.colors[l])
    const near = (c: number, t: number[]) => Math.max(Math.abs(((c >> 16) & 255) - t[0]), Math.abs(((c >> 8) & 255) - t[1]), Math.abs((c & 255) - t[2]))
    expect(colors.some((c) => near(c, BLUE) <= 3)).toBe(true)
    expect(colors.some((c) => near(c, RED) <= 3)).toBe(true)
  })

  it('keeps a small but distinct detail instead of erasing it for being small', () => {
    // A 4×4 yellow square: above the speck size, so it stays, though it's tiny.
    const src = image(40, 40, (x, y) => (x >= 18 && x < 22 && y >= 18 && y < 22 ? [250, 210, 20, 255] : [...BLUE, 255] as [number, number, number, number]))
    const { map } = quantize(src, OPTS)
    expect(map.colors[map.labels[20 * 40 + 20]]).not.toBe(map.colors[map.labels[0]])
  })

  it('keeps gradient (fixed) regions out of the colour budget and labelled as given', () => {
    const fixed = new Int16Array(40 * 40).fill(-1)
    for (let y = 5; y < 35; y++) for (let x = 5; x < 20; x++) fixed[y * 40 + x] = 0
    const src = image(40, 40, (x, y) => (fixed[y * 40 + x] >= 0 ? [...mix(RED, BLUE, (y - 5) / 30), 255] : [240, 240, 240, 255]) as [number, number, number, number])
    const { map } = quantize(src, { ...OPTS, maxColors: 1 }, { labels: fixed, colors: [0x7f2f80] })
    const g = map.labels[20 * 40 + 12]
    for (let y = 6; y < 34; y++) for (let x = 6; x < 19; x++) expect(map.labels[y * 40 + x]).toBe(g)
    // The one clustered colour went to the background, not to the gradient's shades.
    expect(map.labels[0]).not.toBe(g)
  })
})

describe('quantize: similar brand tints', () => {
  const BLUE = [28, 126, 214]
  const BLUE2 = [42, 134, 217] // ΔE 2.9 from BLUE
  const opts = { ...OPTS, minArea: 9 }
  const colours = (src: ImageData) => {
    const { map } = quantize(src, opts)
    return new Set([...map.labels].filter((l) => l < 254).map((l) => map.colors[l])).size
  }

  it('keeps two exact tints side by side apart, however close', () => {
    const src = image(120, 60, (x, y) => (x < 10 || x >= 110 || y < 10 || y >= 50 ? [255, 255, 255, 255] : [...(x < 60 ? BLUE : BLUE2), 255] as [number, number, number, number]))
    expect(colours(src)).toBe(3)
  })

  it('merges one colour split into two shades by noise', () => {
    // The two shades mixed pixel by pixel all through one area, as noise leaves them.
    const src = image(120, 60, (x, y) => (x < 10 || x >= 110 || y < 10 || y >= 50 ? [255, 255, 255, 255] : [...((x * 7 + y * 13) % 3 ? BLUE : BLUE2), 255] as [number, number, number, number]))
    expect(colours(src)).toBe(2)
  })

  it('merges a gradual shade into one colour, not two bands', () => {
    const src = image(120, 60, (x, y) => (x < 10 || x >= 110 || y < 10 || y >= 50 ? [255, 255, 255, 255] : [...mix(BLUE, BLUE2, (x - 10) / 100), 255] as [number, number, number, number]))
    expect(colours(src)).toBe(2)
  })
})
