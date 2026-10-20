/**
 * Fine detail (behind the fine-detail flag), in the master artwork: thin lines keep their width and
 * length, and nothing else changes: solid shapes and gradients trace as before, with no new
 * crossings or fragments. Off, nothing changes (golden.test.ts); print plates, cut files, one colour
 * and spot inks never get the options (pipeline.ts), checked in the app.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import type { FlatOptions } from '../pipeline'
import { area, circle, colourAt, distToOutline, installImageData, iou, paint, rect, regularPolygon, regularStar, renderSvg, ringsOf, selfIntersects, svgPaths, vectorize, type Point, type RGB, type SvgPath } from './fidelity/harness'

beforeAll(installImageData)

const SLOW = 120_000
/** The options the fine-detail flag sets for a full-colour master (pipeline.ts buildTraceJob). */
const fine = (o: FlatOptions): FlatOptions => ({ ...o, quantize: { ...o.quantize, keepSolidDetail: true }, trace: { ...o.trace, crossSection: true, straightRuns: true } })
const both = (img: ImageData) => ({ off: vectorize(img), on: vectorize(img, fine) })

const BLUE: RGB = [40, 70, 160]
const WHITE: RGB = [255, 255, 255]
const GREEN: RGB = [20, 110, 60]
const PAPER: RGB = [245, 245, 240]

/** Mean difference from the upload (colour premultiplied by alpha, and alpha), 0–255 per pixel. */
function error(img: ImageData, svg: string) {
  const r = renderSvg(svg, img.width, img.height)
  let d = 0
  for (let i = 0; i < r.data.length; i += 4) {
    const a = img.data[i + 3] / 255, b = r.data[i + 3] / 255
    for (let c = 0; c < 3; c++) d += Math.abs(img.data[i + c] * a - r.data[i + c] * b)
    d += Math.abs(img.data[i + 3] - r.data[i + 3])
  }
  return d / (img.width * img.height)
}

/** Pixels opaque in the upload that the vector leaves see-through. */
function opened(img: ImageData, svg: string) {
  const r = renderSvg(svg, img.width, img.height)
  let n = 0
  for (let i = 3; i < r.data.length; i += 4) if (img.data[i] > 250 && r.data[i] < 200) n++
  return n
}

function fillNear(paths: SvgPath[], c: RGB): string {
  let best = ''
  let bd = Infinity
  for (const p of paths) {
    if (!p.fill.startsWith('#')) continue
    const n = parseInt(p.fill.slice(1), 16)
    const d = Math.hypot(((n >> 16) & 255) - c[0], ((n >> 8) & 255) - c[1], (n & 255) - c[2])
    if (d < bd) [best, bd] = [p.fill, d]
  }
  return bd < 60 ? best : ''
}

/** Drawn width of a vertical bar at height y (px). */
function width(paths: SvgPath[], fill: string, x0: number, x1: number, y: number): number {
  let first = -1
  let last = -1
  for (let x = x0; x < x1; x += 0.01) if (colourAt(paths, x, y) === fill) (first < 0 && (first = x)), (last = x)
  return first < 0 ? 0 : last - first
}

/** Drawn length of a vertical bar along x (px). */
function length(paths: SvgPath[], fill: string, x: number): number {
  let first = -1
  let last = -1
  for (let y = 15; y < 45; y += 0.05) if (colourAt(paths, x, y) === fill) (first < 0 && (first = y)), (last = y)
  return first < 0 ? 0 : last - first
}

describe('thin lines (RC1)', () => {
  // Five 20 px bars and a ring, all `wd` wide, in green on paper; bar k sits k·offset off the grid.
  const strokes = (wd: number, offset = 0) => {
    const bars = [0, 1, 2, 3, 4].map((k) => rect(10 + k * 12 + k * offset, 20, 10 + k * 12 + k * offset + wd, 40))
    const ring = [circle(80, 30, 6), circle(80, 30, 6 - wd, true)]
    return { img: paint(100, 60, PAPER, [{ rings: bars, color: GREEN }, { rings: ring, color: GREEN }]), bars, ring }
  }
  const score = (svg: string, bars: Point[][], ring: Point[][]) => {
    const P = svgPaths(svg)
    const g = fillNear(P, GREEN)
    return { bars: Math.min(...bars.map((b) => iou(P, g, [b], [b[0][0] - 2, 18, b[1][0] + 2, 42]))), ring: iou(P, g, ring, [72, 22, 88, 38]) }
  }

  it('1 px lines keep their width and length (off: 1.17 px wide, 14 px of 20 long)', () => {
    const { img, bars, ring } = strokes(1)
    const { off, on } = both(img)
    const P = svgPaths(on.svg)
    const g = fillNear(P, GREEN)
    for (const b of bars) {
      expect(Math.abs(width(P, g, b[0][0] - 2, b[1][0] + 2, 30) - 1)).toBeLessThanOrEqual(0.1)
      expect(length(P, g, b[0][0] + 0.5)).toBeGreaterThanOrEqual(19)
    }
    expect(score(on.svg, bars, ring).bars).toBeGreaterThanOrEqual(0.9)
    expect(score(off.svg, bars, ring).bars).toBeLessThan(0.7)
    // This ring is anti-aliased all round, with no solid core: it keeps the ordinary rule, and is
    // no worse for it.
    expect(score(on.svg, bars, ring).ring).toBeGreaterThanOrEqual(score(off.svg, bars, ring).ring)
  }, SLOW)

  it('a thin ring is not snapped to a polygon', () => {
    // A 1.2 px ring's inner edge, traced by the fine-detail rule, once passed as a polygon (straight
    // sides). (Some small rings snap with the flag off too: shape recognition is separate work.)
    const img = paint(40, 40, PAPER, [{ rings: [circle(20.3, 20.2, 6), circle(20.3, 20.2, 4.8, true)], color: GREEN }])
    const ring = (svg: string) => svg.split('\n').find((l) => /Z\s*M/.test(l))
    const { off, on } = both(img)
    expect(ring(off.svg)).not.toMatch(/\dL\d/)
    expect(ring(on.svg)).toBeDefined()
    expect(ring(on.svg)).not.toMatch(/\dL\d/)
  }, SLOW)

  it('1 px lines off the pixel grid, and a 1 px ring, meet the audit threshold of 0.7', () => {
    // Offsets 0, 0.2, 0.4, 0.6 and 0.8 px. A line split evenly over two pixels has no solid core
    // and keeps the ordinary rule (drawn wider), which still meets the threshold.
    const { img, bars, ring } = strokes(1, 0.2)
    const s = score(vectorize(img, fine).svg, bars, ring)
    expect(s.bars).toBeGreaterThanOrEqual(0.7)
    expect(s.ring).toBeGreaterThanOrEqual(0.8)
  }, SLOW)

  it('2 px lines stay 2 px wide (off: about 2.3 px)', () => {
    const { img } = strokes(2)
    const P = svgPaths(vectorize(img, fine).svg)
    const g = fillNear(P, GREEN)
    expect(Math.abs(width(P, g, 8, 14, 30) - 2)).toBeLessThanOrEqual(0.15)
  }, SLOW)

  it('1.2 px lettering strokes on a light band are kept, and drawn without crossings', () => {
    const shapes = [{ rings: [rect(0, 30, 110, 40)], color: [240, 240, 235] as RGB }]
    const strokesAt = Array.from({ length: 12 }, (_, k) => rect(6 + k * 8, 31.5, 6 + k * 8 + 1.2, 38.5))
    shapes.push({ rings: strokesAt, color: [30, 140, 70] })
    const img = paint(110, 70, BLUE, shapes)
    const kept = (svg: string) => {
      const P = svgPaths(svg)
      const g = fillNear(P, [30, 140, 70])
      return g ? Math.min(...strokesAt.map((s) => iou(P, g, [s], [s[0][0] - 1, 30, s[1][0] + 1, 40]))) : 0
    }
    const crossings = (svg: string) => svgPaths(svg).flatMap((p) => p.rings).filter(selfIntersects).length
    const { off, on } = both(img)
    // Below the audit's 0.5: these strokes' colour is read lighter than it is, so their edge
    // pixels count for less (colour accuracy is separate work).
    expect(kept(off.svg)).toBeLessThan(0.2)
    expect(kept(on.svg)).toBeGreaterThanOrEqual(0.3)
    expect(crossings(on.svg)).toBeLessThanOrEqual(crossings(off.svg))
  }, SLOW)
})

describe('nothing else changes', () => {
  it('solid shapes keep their corners and points as before', () => {
    for (const shape of [regularPolygon(48, 48, 10, 6), regularPolygon(48, 48, 12, 7), regularStar(48, 48, 20)]) {
      const img = paint(96, 96, null, [{ rings: [rect(8, 8, 88, 88)], color: BLUE }, { rings: [shape], color: WHITE }])
      const err = (svg: string) => {
        const P = svgPaths(svg)
        return Math.max(...shape.map((v) => distToOutline(v, ringsOf(P, fillNear(P, WHITE)))))
      }
      const { off, on } = both(img)
      expect(err(on.svg)).toBeLessThanOrEqual(err(off.svg) + 0.05)
    }
  }, SLOW)

  it('wide shapes are no further from the upload, with no new transparency', () => {
    // A rectangle and an overlapping circle: only the narrow wedge where they meet is thin.
    const img = paint(100, 80, null, [{ rings: [rect(10, 10, 60, 70)], color: BLUE }, { rings: [circle(75, 40, 18)], color: GREEN }])
    const { off, on } = both(img)
    expect(error(img, on.svg)).toBeLessThanOrEqual(error(img, off.svg) + 0.05)
    expect(opened(img, on.svg)).toBeLessThanOrEqual(opened(img, off.svg))
  }, SLOW)

  it('a gradient keeps its gradient fill', () => {
    const img = paint(120, 80, null, [{ rings: [rect(10, 10, 110, 70)], color: BLUE }])
    for (let y = 10; y < 70; y++)
      for (let x = 10; x < 110; x++) {
        const i = (y * 120 + x) * 4
        const t = (x - 10) / 100
        img.data[i] = 40 + t * 180
        img.data[i + 1] = 70 + t * 100
        img.data[i + 2] = 160 - t * 100
      }
    expect(vectorize(img, fine).svg).toMatch(/linearGradient/)
  }, SLOW)

  it('noisy small artwork gets no new crossings or fragments (RC10 case)', () => {
    const shapes: { rings: Point[][]; color: RGB }[] = []
    for (let k = 0; k < 30; k++) shapes.push({ rings: [regularStar(12 + (k % 6) * 16, 12 + Math.floor(k / 6) * 14, 2 + (k % 3) * 0.8)], color: [250, 250, 250] })
    shapes.push({ rings: [rect(0, 70, 110, 76)], color: [240, 240, 235] })
    for (let k = 0; k < 12; k++) shapes.push({ rings: [rect(6 + k * 8, 71.5, 6 + k * 8 + 1.2, 74.5)], color: [30, 140, 70] })
    const img = paint(110, 84, BLUE, shapes, 8)
    const count = (svg: string) => {
      const rings = svgPaths(svg).flatMap((p) => p.rings)
      return { crossing: rings.filter(selfIntersects).length, tiny: rings.filter((g) => Math.abs(area(g)) < 4).length }
    }
    const { off, on } = both(img)
    expect(count(on.svg).crossing).toBeLessThanOrEqual(count(off.svg).crossing)
    expect(count(on.svg).tiny).toBeLessThanOrEqual(count(off.svg).tiny)
  }, SLOW)
})

describe('flag', () => {
  it('is off in production builds, whatever the address says', async () => {
    const { fineDetailOn } = await import('../../quality/flags')
    expect(fineDetailOn('?fine-detail=on', { value: undefined, dev: false })).toBe(false)
    expect(fineDetailOn('?fine-detail=on', { value: 'off', dev: false })).toBe(false)
    expect(fineDetailOn('?fine-detail=on', { value: 'preview', dev: false })).toBe(true)
    expect(fineDetailOn('', { value: 'preview', dev: false })).toBe(false)
    expect(fineDetailOn('', { value: 'on', dev: false })).toBe(true)
  })
})
