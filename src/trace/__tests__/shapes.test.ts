import { describe, expect, it } from 'vitest'
import { contours, type Point } from '../contours'
import { detectShape } from '../shapes'
import { parsePath } from '../../export/path'
import { blur } from '../index'

const S = 6 // supersampling per axis

/** Anti-aliased coverage field of any shape given an inside test. */
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

function inPolygon(poly: Point[]) {
  return (x: number, y: number) => {
    let inside = false
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i]
      const [xj, yj] = poly[j]
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
    }
    return inside
  }
}

const starPoints = (cx: number, cy: number, r: number, n: number, inner = 0.45, rot = -Math.PI / 2): Point[] =>
  Array.from({ length: n * 2 }, (_, i) => {
    const a = (Math.PI * i) / n + rot
    const rr = i % 2 ? r * inner : r
    return [cx + rr * Math.cos(a), cy + rr * Math.sin(a)]
  })

const detect = (f: Float32Array, w: number, h: number) => detectShape(contours(f, w, h)[0], { cornerAngle: 60, precision: 3 })

/** Corner points of a straight-edged path. */
const vertices = (d: string) => {
  const [s] = parsePath(d)
  return [s.start, ...s.segs.map((g) => g.p)]
}

describe('detectShape', () => {
  it('turns a circle into an exact 4-segment circle', () => {
    const shape = detect(field(80, 80, (x, y) => Math.hypot(x - 40.3, y - 39.6) < 25), 80, 80)
    expect(shape?.kind).toBe('circle')
    const [s] = parsePath(shape!.d)
    expect(s.segs).toHaveLength(4)
    // The start point lies on the true circle.
    expect(Math.hypot(s.start[0] - 40.3, s.start[1] - 39.6)).toBeCloseTo(25, 0)
  })

  it('recognizes a rotated ellipse', () => {
    const t = 0.5
    const shape = detect(
      field(120, 100, (x, y) => {
        const dx = x - 60, dy = y - 50
        const u = dx * Math.cos(t) + dy * Math.sin(t)
        const v = -dx * Math.sin(t) + dy * Math.cos(t)
        return (u / 40) ** 2 + (v / 22) ** 2 < 1
      }),
      120,
      100,
    )
    expect(shape?.kind).toBe('ellipse')
  })

  it('snaps a 5-point star to a perfect regular star', () => {
    const truth = starPoints(60, 62, 45, 5)
    const shape = detect(field(120, 120, inPolygon(truth)), 120, 120)
    expect(shape?.kind).toBe('star')
    const pts = vertices(shape!.d)
    expect(pts).toHaveLength(10)
    // Every vertex is within a fraction of a pixel of the true star.
    for (const p of pts) expect(Math.min(...truth.map((q) => Math.hypot(p[0] - q[0], p[1] - q[1])))).toBeLessThan(0.6)
  })

  it('recognizes a 16-point burst', () => {
    const shape = detect(field(240, 240, inPolygon(starPoints(120, 120, 110, 16, 0.78))), 240, 240)
    expect(shape?.kind).toBe('star')
    expect(vertices(shape!.d)).toHaveLength(32)
  })

  it('rebuilds sharp star tips that blur has blunted', () => {
    const truth = starPoints(150, 150, 140, 16, 0.45)
    const soft = blur(field(300, 300, inPolygon(truth)), 300, 300, 1.0)
    const shape = detect(soft, 300, 300)
    expect(shape?.kind).toBe('star')
    const pts = vertices(shape!.d)
    expect(pts).toHaveLength(32)
    for (const p of pts) expect(Math.min(...truth.map((q) => Math.hypot(p[0] - q[0], p[1] - q[1])))).toBeLessThan(1.5)
  })

  it('keeps a square as a 4-corner polygon with exact corners', () => {
    const shape = detect(field(60, 60, (x, y) => x >= 10 && x < 50 && y >= 10 && y < 50), 60, 60)
    expect(shape?.kind).toBe('polygon')
    const pts = vertices(shape!.d)
    expect(pts).toHaveLength(4)
    for (const c of [[10, 10], [50, 10], [50, 50], [10, 50]] as Point[]) {
      expect(Math.min(...pts.map((p) => Math.hypot(p[0] - c[0], p[1] - c[1])))).toBeLessThan(0.5)
    }
  })

  it('keeps an irregular triangle as a polygon without regularizing it', () => {
    const tri: Point[] = [[10, 70], [40, 8], [90, 60]]
    const shape = detect(field(100, 80, inPolygon(tri)), 100, 80)
    expect(shape?.kind).toBe('polygon')
    const pts = vertices(shape!.d)
    for (const c of tri) expect(Math.min(...pts.map((p) => Math.hypot(p[0] - c[0], p[1] - c[1])))).toBeLessThan(0.8)
  })

  it('leaves organic shapes alone', () => {
    const blob = field(100, 100, (x, y) => {
      const a = Math.atan2(y - 50, x - 50)
      return Math.hypot(x - 50, y - 50) < 30 + 6 * Math.sin(3 * a) + 3 * Math.cos(5 * a)
    })
    expect(detect(blob, 100, 100)).toBeNull()
  })

  it('leaves a thick "C" alone', () => {
    const c = field(100, 100, (x, y) => {
      const r = Math.hypot(x - 50, y - 50)
      return r > 22 && r < 34 && !(x > 55 && Math.abs(y - 50) < 12)
    })
    expect(detect(c, 100, 100)).toBeNull()
  })

  it('ignores circles too small to matter (letter dots, counters)', () => {
    expect(detect(field(16, 16, (x, y) => Math.hypot(x - 8, y - 8) < 4.5), 16, 16)).toBeNull()
  })

  it('leaves a D-shaped letter counter alone', () => {
    const dShape = field(30, 30, (x, y) => (x >= 8 && x < 15 && y >= 6 && y < 24) || Math.hypot(x - 15, y - 15) < 9 && x >= 15)
    expect(detect(dShape, 30, 30)).toBeNull()
  })
})
