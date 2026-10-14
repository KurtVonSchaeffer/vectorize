import { describe, expect, it } from 'vitest'
import { area, contours, type Point } from '../contours'
import { fitClosed, polygonCorners, resample, type Cubic } from '../fit'
import { traceLabels, type LabelMap } from '../index'

/** Anti-aliased disk coverage field (exact area per pixel, approximated by supersampling). */
function disk(w: number, h: number, cx: number, cy: number, r: number): Float32Array {
  const f = new Float32Array(w * h)
  const S = 8
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let inside = 0
      for (let sy = 0; sy < S; sy++)
        for (let sx = 0; sx < S; sx++) if ((x + (sx + 0.5) / S - cx) ** 2 + (y + (sy + 0.5) / S - cy) ** 2 < r * r) inside++
      f[y * w + x] = inside / (S * S)
    }
  return f
}

function bezierAt(b: Cubic, t: number): Point {
  const mt = 1 - t
  return [
    mt ** 3 * b[0][0] + 3 * mt * mt * t * b[1][0] + 3 * mt * t * t * b[2][0] + t ** 3 * b[3][0],
    mt ** 3 * b[0][1] + 3 * mt * mt * t * b[1][1] + 3 * mt * t * t * b[2][1] + t ** 3 * b[3][1],
  ]
}

describe('contours', () => {
  it('traces an anti-aliased disk at sub-pixel accuracy', () => {
    const loops = contours(disk(64, 64, 32, 32, 20), 64, 64)
    expect(loops).toHaveLength(1)
    expect(Math.abs(area(loops[0]))).toBeCloseTo(Math.PI * 400, -1) // within ~±5 px²
    for (const [x, y] of loops[0]) expect(Math.abs(Math.hypot(x - 32, y - 32) - 20)).toBeLessThan(0.15)
  })

  it('closes shapes that touch the image edge', () => {
    const f = new Float32Array(10 * 10).fill(1)
    const loops = contours(f, 10, 10)
    expect(loops).toHaveLength(1)
    // Marching squares clips each square corner by a ⅛ px² triangle; the fitter restores them.
    expect(Math.abs(area(loops[0]))).toBeGreaterThan(99.4)
    expect(Math.abs(area(loops[0]))).toBeLessThanOrEqual(100)
  })

  it('joins a lopsided diagonal saddle the way the bilinear surface does', () => {
    // Corner average 0.475 says "apart", but the bilinear saddle value is 0.514: one shape.
    expect(contours(Float32Array.from([0.004385, 0.757605, 0.725875, 0.412461]), 2, 2)).toHaveLength(1)
    // Clearly separate diagonal pixels stay separate, in both saddle orientations.
    expect(contours(Float32Array.from([0.1, 0.9, 0.9, 0.1]), 2, 2)).toHaveLength(2)
    expect(contours(Float32Array.from([0.9, 0.1, 0.1, 0.9]), 2, 2)).toHaveLength(2)
    // And clearly joined ones stay joined.
    expect(contours(Float32Array.from([0.45, 1, 1, 0.45]), 2, 2)).toHaveLength(1)
  })

  it('keeps a 1px diagonal stroke in one piece', () => {
    const w = 24
    const f = new Float32Array(w * w)
    for (let i = 2; i < w - 2; i++) f[i * w + i] = 1
    expect(contours(f, w, w)).toHaveLength(1)
  })

  it('keeps nested shapes: ring, island inside the hole', () => {
    const outer = disk(64, 64, 32, 32, 25)
    const hole = disk(64, 64, 32, 32, 15)
    const island = disk(64, 64, 32, 32, 6)
    const loops = contours(outer.map((v, i) => v - hole[i] + island[i]), 64, 64)
    // Filled even-odd, so each boundary is its own loop: outline, hole, island.
    const areas = loops.map((l) => Math.abs(area(l))).sort((x, y) => y - x)
    expect(areas).toHaveLength(3)
    ;[25, 15, 6].forEach((r, k) => expect(Math.abs(areas[k] - Math.PI * r * r) / (Math.PI * r * r)).toBeLessThan(0.02))
  })

  it('rejects malformed fields and levels', () => {
    expect(() => contours(new Float32Array(3), 2, 2)).toThrow(RangeError)
    expect(() => contours(new Float32Array(4), 2.5, 2)).toThrow(RangeError)
    for (const level of [0, 1, -1, Number.NaN]) expect(() => contours(new Float32Array(4), 2, 2, level)).toThrow(RangeError)
    expect(contours(new Float32Array(0), 0, 0)).toEqual([])
  })

  it('returns holes as separate loops', () => {
    const outer = disk(64, 64, 32, 32, 25)
    const inner = disk(64, 64, 32, 32, 10)
    const ring = outer.map((v, i) => v - inner[i])
    expect(contours(ring, 64, 64)).toHaveLength(2)
  })
})

describe('fitClosed', () => {
  it('fits a circle with few smooth curves', () => {
    const loop = contours(disk(64, 64, 32, 32, 20), 64, 64)[0]
    const curves = fitClosed(loop, { error: 0.5, cornerAngle: 60 })
    expect(curves.length).toBeLessThanOrEqual(8)
    for (const c of curves)
      for (let t = 0; t <= 1; t += 0.1) {
        const [x, y] = bezierAt(c, t)
        expect(Math.abs(Math.hypot(x - 32, y - 32) - 20)).toBeLessThan(0.6)
      }
  })

  it('keeps square corners sharp and in place', () => {
    // Pixel-aligned square from (10,10) to (40,40), slightly blurred like real input.
    const w = 50
    const f = new Float32Array(w * w)
    for (let y = 10; y < 40; y++) for (let x = 10; x < 40; x++) f[y * w + x] = 1
    const loop = contours(f, w, w)[0]
    const curves = fitClosed(loop, { error: 0.5, cornerAngle: 60 })
    const ends = curves.map((c) => c[3])
    for (const corner of [
      [10, 10],
      [40, 10],
      [40, 40],
      [10, 40],
    ] as Point[]) {
      const nearest = Math.min(...ends.map((e) => Math.hypot(e[0] - corner[0], e[1] - corner[1])))
      expect(nearest).toBeLessThan(0.75)
    }
  })
})

describe('traceLabels', () => {
  it('stacks layers so shapes have no gaps between them', () => {
    // Left half label 0, right half label 1, hard edge at x = 20.
    const w = 40
    const h = 20
    const labels = new Uint8Array(w * h)
    for (let y = 0; y < h; y++) for (let x = 20; x < w; x++) labels[y * w + x] = 1
    const map: LabelMap = { w, h, labels, second: new Uint8Array(w * h).fill(255), cov: new Float32Array(w * h).fill(1), colors: [0xff0000, 0x0000ff] }
    const { svg, paths } = traceLabels(map, { smoothing: 0.8, minArea: 1, error: 0.5, cornerAngle: 60, precision: 2 })
    expect(paths).toBe(2)
    // The bottom layer covers the whole image, so nothing shows through at the seam.
    const fills = [...svg.matchAll(/fill="(#\w+)"/g)].map((m) => m[1])
    expect(fills).toHaveLength(2)
    const bottom = svg.match(/<path d="([^"]+)"/)![1]
    const nums = bottom.match(/-?[\d.]+/g)!.map(Number)
    const xs = nums.filter((_, i) => i % 2 === 0)
    expect(Math.min(...xs)).toBeLessThan(0.5)
    expect(Math.max(...xs)).toBeGreaterThan(39.5)
  })

  it('skips labels with no color (paper)', () => {
    const map: LabelMap = { w: 4, h: 4, labels: new Uint8Array(16), second: new Uint8Array(16).fill(255), cov: new Float32Array(16).fill(1), colors: [-1] }
    expect(traceLabels(map, { smoothing: 0.8, minArea: 1, error: 0.5, cornerAngle: 60, precision: 2 }).paths).toBe(0)
  })
})

describe('resample', () => {
  const gaps = (pts: Point[]) => pts.map((p, i) => Math.hypot(p[0] - pts[(i + 1) % pts.length][0], p[1] - pts[(i + 1) % pts.length][1]))

  it('spaces points evenly, the closing edge included', () => {
    // Perimeter 40.2: carry-based sampling would leave a 0.2 px gap at the seam.
    const pts = resample([[0, 0], [10.05, 0], [10.05, 10.05], [0, 10.05]], 0.5)
    expect(pts).toHaveLength(81)
    const g = gaps(pts)
    expect(Math.max(...g)).toBeLessThanOrEqual(0.5)
    // Gaps only shrink where a sample straddles a corner (chord shorter than arc).
    expect(g.filter((x) => x < 0.49).length).toBeLessThanOrEqual(4)
    expect(Math.min(...g)).toBeGreaterThan(0.3)
  })

  it('samples a circle uniformly', () => {
    const circle: Point[] = Array.from({ length: 360 }, (_, i) => [50 + 20 * Math.cos((i * Math.PI) / 180), 50 + 20 * Math.sin((i * Math.PI) / 180)])
    const g = gaps(resample(circle, 0.5))
    expect(Math.max(...g) - Math.min(...g)).toBeLessThan(1e-3)
  })

  it('ignores repeated, closing and non-finite vertices', () => {
    const clean = resample([[0, 0], [10, 0], [10, 10], [0, 10]], 0.5)
    expect(resample([[0, 0], [0, 0], [10, 0], [Number.NaN, 3], [10, 10], [0, 10], [0, 10], [0, 0]], 0.5)).toEqual(clean)
  })

  it('handles degenerate contours without NaN', () => {
    expect(resample([], 0.5)).toEqual([])
    expect(resample([[2, 3], [2, 3], [2, 3]], 0.5)).toEqual([[2, 3]])
    const line = resample([[0, 0], [4, 0]], 0.5)
    expect(line.every((p) => p.every(Number.isFinite))).toBe(true)
    for (const step of [0, -1, Number.NaN, Infinity]) expect(() => resample([[0, 0], [1, 0]], step)).toThrow(RangeError)
  })

  it('still fits squares with sharp corners and irregular shapes without NaN', () => {
    const square = contours(new Float32Array(30 * 30).map((_, i) => (i % 30 >= 5 && i % 30 < 25 && i / 30 >= 5 && i / 30 < 25 ? 1 : 0)), 30, 30)[0]
    const corners = polygonCorners(square, 60)
    expect(corners).toHaveLength(4)
    for (const [x, y] of corners!) expect(Math.min(Math.abs(x - 5), Math.abs(x - 25)) + Math.min(Math.abs(y - 5), Math.abs(y - 25))).toBeLessThan(0.3)
    let seed = 7
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    const blob: Point[] = Array.from({ length: 50 }, (_, i) => {
      const a = (i / 50) * 2 * Math.PI
      const r = 15 + rand() * 6
      return [30 + r * Math.cos(a), 30 + r * Math.sin(a)]
    })
    const curves = fitClosed(blob, { error: 0.5, cornerAngle: 60 })
    expect(curves.length).toBeGreaterThan(0)
    expect(curves.flat(2).every(Number.isFinite)).toBe(true)
  })
})

describe('fitClosed robustness', () => {
  it('never shoots control points far outside a tiny, thin outline', () => {
    // A real outline from 8 px serif text (JPEG): a small hook whose short runs used to solve to
    // Bézier handles over 300 px long.
    const sliver: Point[] = [[25.997, 21.5], [26.5, 21.162], [26.802, 21.5], [26.904, 22.5], [26.888, 23.5], [27.056, 24.5], [27.379, 25.5], [26.5, 25.844], [25.5, 25.508], [24.5, 25.693], [23.5, 25.81], [23.166, 25.5], [22.952, 24.5], [23.387, 23.5], [23.5, 23.387], [23.838, 23.5], [24.223, 24.5], [24.5, 25.034], [25.5, 25.467], [25.803, 24.5], [25.72, 23.5], [25.5, 22.662], [25.465, 22.5], [25.5, 22.422]]
    for (const curve of fitClosed(sliver, { error: 0.5, cornerAngle: 60 }))
      for (const [x, y] of curve) {
        expect(x).toBeGreaterThan(20)
        expect(x).toBeLessThan(30)
        expect(y).toBeGreaterThan(19)
        expect(y).toBeLessThan(28)
      }
  })
})
