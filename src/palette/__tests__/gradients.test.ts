import { describe, expect, it } from 'vitest'
import { findGradients, isStaircase } from '../gradients'

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

describe('findGradients: overlapping gradient shapes', () => {
  // Two "feathers" that run in different directions: A orange→pink left to right, B pink→blue top
  // to bottom. Where they meet, B's colour is about 10 units off A's: after the light blur that's
  // close enough to join them into one region (which no single gradient explains), as overlapping
  // feathers in a bird logo do. Without splitting, neither is found.
  const ORANGE: RGB = [244, 150, 70]
  const PINKA: RGB = [226, 70, 140]
  const PINKB: RGB = [236, 61, 150]
  const BLUE: RGB = [40, 110, 200]
  const feathers = (opts: { grain?: boolean; transparent?: boolean; letters?: boolean } = {}) => {
    const w = 260, h = 160
    const d = new Uint8ClampedArray(w * h * 4)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let c: RGB | null = null
        if (y >= 20 && y < 140 && x >= 20 && x < 130) c = lerp(ORANGE, PINKA, (x - 20) / 109)
        else if (y >= 20 && y < 140 && x >= 130 && x < 240) c = lerp(PINKB, BLUE, (y - 20) / 119)
        if (c && opts.letters && y >= 70 && y < 90 && (x % 26) < 12 && x > 40 && x < 220) c = [20, 18, 22]
        const i = (y * w + x) * 4
        if (!c) {
          if (opts.transparent) d.set([0, 0, 0, 0], i)
          else d.set([...CREAM, 255], i)
          continue
        }
        const n = opts.grain ? noise(x, y) : 0
        d.set([c[0] + n, c[1] + n, c[2] + n, 255], i)
      }
    return { data: d, width: w, height: h } as ImageData
  }
  const coverage = (g: ReturnType<typeof findGradients>, x0: number, x1: number) =>
    g.reduce((n, r) => n + [...r.pixels].filter((p) => p % 260 >= x0 && p % 260 < x1).length, 0)

  for (const [label, opts] of [
    ['clean', {}],
    ['with JPEG-like grain', { grain: true }],
    ['on a transparent background', { transparent: true }],
  ] as [string, { grain?: boolean; transparent?: boolean }][])
    it(`keeps two overlapping gradient shapes as two gradients (${label})`, () => {
      const g = findGradients(feathers(opts))
      expect(g.length).toBeGreaterThanOrEqual(2)
      // Each feather is mostly covered by gradients (13,200 px each).
      expect(coverage(g, 20, 130)).toBeGreaterThan(13200 * 0.8)
      expect(coverage(g, 130, 240)).toBeGreaterThan(13200 * 0.8)
      // And each gradient matches its own feather: one runs left to right, one top to bottom.
      const dirs = g.filter((r) => r.fill.kind === 'linear').map((r) => (r.fill.kind === 'linear' ? Math.abs(r.fill.x2 - r.fill.x1) > Math.abs(r.fill.y2 - r.fill.y1) : false))
      expect(dirs).toContain(true)
      expect(dirs).toContain(false)
    })

  it('keeps the gradients under lettering', () => {
    const g = findGradients(feathers({ letters: true }))
    expect(g.length).toBeGreaterThanOrEqual(2)
  })

  it('does not turn flat shapes joined by soft edges into a staircase gradient when splitting', () => {
    // A vertical gradient feather (left) whose bottom flows into a flat green shape, which in turn
    // meets a flat blue shape through a soft 6 px edge: one region, no single gradient. Splitting
    // must keep the feather and leave green and blue flat (not a green→blue "gradient").
    const GREEN: RGB = [168, 198, 134]
    const BLUEF: RGB = [102, 155, 188]
    const img = image(300, 200, (x, y) => {
      if (x >= 20 && x < 110 && y >= 20 && y < 120) return lerp([226, 70, 140], GREEN, (y - 20) / 99)
      if (x >= 20 && x < 280 && y >= 120 && y < 180) return x < 147 ? GREEN : x < 153 ? lerp(GREEN, BLUEF, (x - 147) / 6) : BLUEF
      return CREAM
    })
    const g = findGradients(img)
    // No gradient may span both flat colours (a green→blue staircase); the feather may extend
    // into the green it ends in, which renders the same.
    for (const r of g) {
      const xs = [...r.pixels].filter((p) => Math.floor(p / 300) >= 130 && Math.floor(p / 300) < 170).map((p) => p % 300)
      expect(xs.some((x) => x < 140) && xs.some((x) => x > 160)).toBe(false)
    }
    expect(g.length).toBeGreaterThanOrEqual(1)
  })

  it('tells flat colours in steps from real gradients', () => {
    const channels = (img: ImageData) => {
      const n = img.width * img.height
      const [R, G, B] = [new Float32Array(n), new Float32Array(n), new Float32Array(n)]
      for (let p = 0; p < n; p++) [R[p], G[p], B[p]] = [img.data[p * 4], img.data[p * 4 + 1], img.data[p * 4 + 2]]
      return [R, G, B] as const
    }
    // Three flat teal panels 11 units apart (soft 3 px edges): today read as one gradient.
    const soft = (x: number, edge: number) => Math.max(0, Math.min(1, (x - edge + 1.5) / 3))
    const TEALS: RGB[] = [[42, 157, 143], [52, 168, 154], [63, 179, 165]]
    const panels = image(300, 120, (x) => lerp(lerp(TEALS[0], TEALS[1], soft(x, 100)), TEALS[2], soft(x, 200)))
    const stepped = findGradients(panels)
    expect(stepped).toHaveLength(1)
    expect(isStaircase(stepped[0], 300, ...channels(panels))).toBe(true)
    // Real gradients: a linear blend, and one with JPEG-like grain.
    for (const grain of [false, true]) {
      const img = image(300, 120, (x, y) => lerp(PINK, PURPLE, x / 299).map((v) => v + (grain ? noise(x, y) : 0)) as RGB)
      const g = findGradients(img)
      expect(g).toHaveLength(1)
      expect(isStaircase(g[0], 300, ...channels(img))).toBe(false)
    }
  })

  it('keeps near-identical flat colours side by side flat', () => {
    // Two flat colours 5 units apart join into one region; splitting finds two flat pieces, so no gradient.
    const img = image(240, 120, (x) => (x < 120 ? [200, 80, 120] : [205, 75, 125]))
    expect(findGradients(img)).toHaveLength(0)
  })

  it('leaves flat colours next to a gradient alone', () => {
    const img = image(240, 120, (x, y) => (x < 80 ? [30, 60, 160] : x < 160 ? lerp(PINK, PURPLE, (x - 80) / 79) : y < 60 ? [240, 200, 40] : [40, 160, 90]))
    const g = findGradients(img)
    expect(g).toHaveLength(1)
    expect([...g[0].pixels].every((p) => p % 240 >= 76 && p % 240 < 164)).toBe(true)
  })
})
