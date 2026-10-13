import { describe, expect, it } from 'vitest'
import { findGradients } from '../gradients'

type RGB = [number, number, number]
function image(w: number, h: number, paint: (x: number, y: number) => RGB): ImageData {
  const d = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d.set([...paint(x, y), 255], (y * w + x) * 4)
  return { data: d, width: w, height: h } as ImageData
}
const lerp = (a: RGB, b: RGB, t: number): RGB => a.map((v, i) => v + (b[i] - v) * Math.max(0, Math.min(1, t))) as RGB
const rgb = (c: number): RGB => [(c >> 16) & 255, (c >> 8) & 255, c & 255]
const close = (a: RGB, b: RGB, tol: number) => a.every((v, i) => Math.abs(v - b[i]) <= tol)
/** Seeded noise, like JPEG grain. */
const noise = (x: number, y: number) => (((x * 73856093) ^ (y * 19349663)) % 7) - 3

const CREAM: RGB = [255, 248, 230]
const PINK: RGB = [236, 72, 153]
const PURPLE: RGB = [88, 28, 135]

describe('findGradients', () => {
  it('finds a linear gradient in a box on a flat background', () => {
    // Pink → purple, left to right, inside x 40..160, y 30..90.
    const img = image(200, 120, (x, y) => (x >= 40 && x < 160 && y >= 30 && y < 90 ? lerp(PINK, PURPLE, (x - 40) / 119) : CREAM))
    const g = findGradients(img)
    expect(g).toHaveLength(1)
    const f = g[0].fill
    expect(f.kind).toBe('linear')
    if (f.kind !== 'linear') return
    expect(f.x2 - f.x1).toBeGreaterThan(100) // runs left to right
    expect(Math.abs(f.y2 - f.y1)).toBeLessThan(3)
    expect(close(rgb(f.stops[0].color), PINK, 12)).toBe(true)
    expect(close(rgb(f.stops.at(-1)!.color), PURPLE, 12)).toBe(true)
    expect(f.stops.length).toBeLessThanOrEqual(3) // a straight blend needs few stops
  })

  it('finds a radial gradient in a disc and its center', () => {
    const img = image(200, 200, (x, y) => {
      const r = Math.hypot(x + 0.5 - 100, y + 0.5 - 100)
      return r < 80 ? lerp([255, 220, 80], [200, 40, 20], r / 80) : CREAM
    })
    const g = findGradients(img)
    expect(g).toHaveLength(1)
    const f = g[0].fill
    expect(f.kind).toBe('radial')
    if (f.kind !== 'radial') return
    expect(Math.hypot(f.cx - 100, f.cy - 100)).toBeLessThan(3)
    expect(f.r).toBeGreaterThan(70)
  })

  it('keeps multi-stop gradients and tolerates JPEG-like noise', () => {
    const img = image(240, 80, (x, y) => {
      const t = x / 239
      const c = t < 0.5 ? lerp(PINK, [250, 200, 40], t * 2) : lerp([250, 200, 40], [40, 120, 220], (t - 0.5) * 2)
      return c.map((v) => v + noise(x, y)) as RGB
    })
    const g = findGradients(img)
    expect(g).toHaveLength(1)
    const stops = g[0].fill.stops
    expect(stops.length).toBeGreaterThanOrEqual(3)
    expect(stops.some((s) => Math.abs(s.offset - 0.5) < 0.1 && close(rgb(s.color), [250, 200, 40], 20))).toBe(true)
  })

  it('ignores flat artwork', () => {
    const img = image(200, 120, (x, y) => (Math.hypot(x - 100, y - 60) < 40 ? PURPLE : x < 100 ? CREAM : PINK))
    expect(findGradients(img)).toHaveLength(0)
  })

  it('ignores photo-like texture', () => {
    const img = image(160, 160, (x, y) => {
      const v = 128 + 60 * Math.sin(x * 0.9) * Math.cos(y * 0.7) + ((x * 31 + y * 17) % 23)
      return [v, v * 0.8, v * 0.6]
    })
    expect(findGradients(img)).toHaveLength(0)
  })
})
