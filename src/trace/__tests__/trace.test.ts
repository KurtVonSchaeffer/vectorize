import { describe, expect, it } from 'vitest'
import { area, contours, type Point } from '../contours'
import { fitClosed, type Cubic } from '../fit'
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
