import { describe, expect, it } from 'vitest'
import { contours, type Point } from '../contours'
import { decomposeCirclePolygon, insidePolygon } from '../decompose'

const S = 5
function field(w: number, h: number, inside: (x: number, y: number) => boolean): Float32Array {
  const f = new Float32Array(w * h)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let n = 0
      for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) if (inside(x + (sx + 0.5) / S, y + (sy + 0.5) / S)) n++
      f[y * w + x] = n / (S * S)
    }
  return f
}
const star = (cx: number, cy: number, r: number, n: number, inner: number): Point[] =>
  Array.from({ length: n * 2 }, (_, i) => {
    const a = (Math.PI * i) / n - Math.PI / 2
    const rr = i % 2 ? r * inner : r
    return [cx + rr * Math.cos(a), cy + rr * Math.sin(a)]
  })
const outer = (f: Float32Array, w: number, h: number) =>
  contours(f, w, h).sort((a, b) => b.length - a.length)[0]

describe('decomposeCirclePolygon', () => {
  it('splits a starburst behind a disc into a full star and a circle', () => {
    const burst = star(150, 150, 135, 16, 0.45)
    const f = field(300, 300, (x, y) => insidePolygon([x, y], burst) || Math.hypot(x - 150, y - 150) < 95)
    const d = decomposeCirclePolygon(outer(f, 300, 300))
    expect(d).not.toBeNull()
    expect(d!.circle.r).toBeCloseTo(95, 0)
    expect(d!.circle.cx).toBeCloseTo(150, 0)
    expect(d!.star).toBe(true)
    expect(d!.polygon).toHaveLength(32)
    // The hidden inner points are rebuilt where they really are.
    for (const p of d!.polygon) expect(Math.min(...burst.map((q) => Math.hypot(p[0] - q[0], p[1] - q[1])))).toBeLessThan(1)
  }, 20_000) // traces a full image; slow when the suite runs in parallel

  it('splits a square with a circle over one corner', () => {
    const sq: Point[] = [[40, 40], [160, 40], [160, 160], [40, 160]]
    const f = field(220, 220, (x, y) => insidePolygon([x, y], sq) || Math.hypot(x - 160, y - 160) < 40)
    const d = decomposeCirclePolygon(outer(f, 220, 220))
    expect(d).not.toBeNull()
    expect(d!.circle.r).toBeCloseTo(40, 0)
    expect(d!.polygon).toHaveLength(4)
    for (const c of sq) expect(Math.min(...d!.polygon.map((p) => Math.hypot(p[0] - c[0], p[1] - c[1])))).toBeLessThan(1)
  })

  it('does not split a plain circle or a plain star', () => {
    expect(decomposeCirclePolygon(outer(field(120, 120, (x, y) => Math.hypot(x - 60, y - 60) < 45), 120, 120))).toBeNull()
    const s = star(100, 100, 85, 5, 0.45)
    expect(decomposeCirclePolygon(outer(field(200, 200, (x, y) => insidePolygon([x, y], s)), 200, 200))).toBeNull()
  })

  it('does not split a rounded rectangle (its arcs are four different circles)', () => {
    const r = 18
    const f = field(200, 140, (x, y) => {
      const qx = Math.max(Math.abs(x - 100) - (80 - r), 0)
      const qy = Math.max(Math.abs(y - 70) - (50 - r), 0)
      return Math.hypot(qx, qy) < r
    })
    expect(decomposeCirclePolygon(outer(f, 200, 140))).toBeNull()
  })

  it('does not split an organic blob', () => {
    const f = field(160, 160, (x, y) => {
      const a = Math.atan2(y - 80, x - 80)
      return Math.hypot(x - 80, y - 80) < 50 + 8 * Math.sin(3 * a)
    })
    expect(decomposeCirclePolygon(outer(f, 160, 160))).toBeNull()
  })
})

describe('splitting inside traceLabels', () => {
  it('draws the star under the disc and refills the disc’s holes with the background color', async () => {
    const { traceLabels } = await import('../index')
    const w = 300
    const h = 300
    const burst = star(150, 150, 135, 16, 0.45)
    const labels = new Uint8Array(w * h)
    // 0 = cream background, 1 = navy disc, 2 = orange burst; a cream "letter" cut into the disc.
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const p: Point = [x + 0.5, y + 0.5]
        let l = 0
        if (insidePolygon(p, burst)) l = 2
        if (Math.hypot(p[0] - 150, p[1] - 150) < 95) l = 1
        if (x >= 120 && x < 180 && y >= 135 && y < 165) l = 0
        labels[y * w + x] = l
      }
    // Make orange the smallest area so it stacks on top, as in the badge.
    const map = { w, h, labels, second: new Uint8Array(w * h).fill(255), cov: new Float32Array(w * h).fill(1), colors: [0xfff8e7, 0x2b2d42, 0xf08c00] }
    const out = traceLabels(map, { smoothing: 0.8, minArea: 9, error: 0.5, cornerAngle: 60, precision: 2, exactShapes: true })
    expect(out.shapes.overlaps).toBe(1)
    // Background, full star, cream refill for the hole, then the navy disc.
    expect(out.layers.map((l) => l.color)).toEqual([0xfff8e7, 0xf08c00, 0xfff8e7, 0x2b2d42])
  })
})
