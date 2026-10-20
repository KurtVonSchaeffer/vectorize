/**
 * Reconstruction-fidelity regression suite (audit of main @ 4926f81, October 2026).
 *
 * Each case draws artwork with known geometry and measures the default full-colour result
 * against that geometry. Cases marked `it.fails` reproduce a defect found in the audit: they pass
 * while the defect is present, and start failing once the pipeline is fixed, at which point the
 * `.fails` comes off and the case becomes a guard. The defect ids (RC1…) refer to the root-cause report.
 *
 * Thresholds are the acceptance criteria from the report, in traced pixels at the upload's size.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_CLIENT, traceParamsFor } from '../../client'
import {
  area,
  circle,
  distToOutline,
  duplicateRings,
  installImageData,
  iou,
  paint,
  paperPlate,
  productionOptions,
  rect,
  regularPolygon,
  regularStar,
  ringsOf,
  selfIntersects,
  svgPaths,
  vectorize,
  type Point,
  type RGB,
  type SvgPath,
} from './harness'

beforeAll(installImageData)

const SLOW = 120_000
const BLUE: RGB = [40, 70, 160]
const WHITE: RGB = [255, 255, 255]
const GREEN: RGB = [20, 110, 60]
const PAPER: RGB = [245, 245, 240]

/** The fill closest to `c` among the SVG's flat fills. */
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

/** Largest distance from the drawn vertices of `truth` to the outline drawn in its colour. */
function vertexError(truth: Point[], paths: SvgPath[], color: RGB, ignoreCanvas = true): number {
  const fill = fillNear(paths, color)
  const rings = ringsOf(paths, fill).filter((r) => !ignoreCanvas || Math.abs(area(r)) < 0.9 * 96 * 96)
  return Math.max(...truth.map((v) => distToOutline(v, rings)))
}

/** Shape snapping sometimes rounds a polygon into a circle; this reads the tracer's own count. */
const circles = (r: ReturnType<typeof vectorize>) => (r as unknown as { shapes?: { circle: number } }).shapes?.circle ?? 0

describe('harness', () => {
  it('uses the production defaults for a flat logo', () => {
    const img = paint(96, 96, BLUE, [{ rings: [regularStar(48, 48, 20)], color: WHITE }])
    const t = traceParamsFor('flat', DEFAULT_CLIENT)
    const o = productionOptions(img)
    expect(o.trace.smoothing).toBe(t.smoothing)
    expect(o.trace.error).toBe(t.curveTolerance)
    expect(o.trace.exactShapes).toBe(true)
    expect(o.quantize.mergeDelta).toBe(t.colorMerge)
  })
})

describe('shapes keep their identity (RC5, RC6)', () => {
  // 0.5 px is the curve tolerance the tracer is set to; a star whose points miss by more has been redrawn.
  for (const R of [14, 20, 30])
    it(`keeps every point and notch of a five-point star ${2 * R} px across`, () => {
      const star = regularStar(48, 48, R)
      const r = vectorize(paint(96, 96, BLUE, [{ rings: [star], color: WHITE }]))
      expect(vertexError(star, svgPaths(r.svg), WHITE)).toBeLessThanOrEqual(0.5)
    }, SLOW)

  for (const R of [5, 7, 10])
    it.fails(`keeps every point and notch of a five-point star ${2 * R} px across (RC6, RC5: points cut off, or snapped to a pentagon)`, () => {
      const star = regularStar(48, 48, R)
      const r = vectorize(paint(96, 96, BLUE, [{ rings: [star], color: WHITE }]))
      expect(vertexError(star, svgPaths(r.svg), WHITE)).toBeLessThanOrEqual(0.5)
    }, SLOW)

  for (const [n, R] of [[3, 10], [4, 16], [6, 10], [6, 16], [7, 20]] as const)
    it(`keeps a ${n}-sided polygon ${2 * R} px across with its corners`, () => {
      const poly = regularPolygon(48, 48, R, n)
      const r = vectorize(paint(96, 96, null, [{ rings: [rect(8, 8, 88, 88)], color: BLUE }, { rings: [poly], color: WHITE }]))
      expect(vertexError(poly, svgPaths(r.svg), WHITE, false)).toBeLessThanOrEqual(0.5)
    }, SLOW)

  for (const R of [8, 12])
    it.fails(`keeps a heptagon ${2 * R} px across as a heptagon (RC5: replaced by a circle)`, () => {
      const poly = regularPolygon(48, 48, R, 7)
      const r = vectorize(paint(96, 96, null, [{ rings: [rect(8, 8, 88, 88)], color: BLUE }, { rings: [poly], color: WHITE }]))
      expect(circles(r)).toBe(0)
      expect(vertexError(poly, svgPaths(r.svg), WHITE, false)).toBeLessThanOrEqual(0.5)
    }, SLOW)
})

describe('corners and concave points survive curve fitting (RC9)', () => {
  const notched = (notch: number): Point[] => [[20, 20], [60, 20], [60, 60], [42 + notch / 2, 60], [42 + notch / 2, 60 - notch * 2], [38 - notch / 2, 60 - notch * 2], [38 - notch / 2, 60], [20, 60]]
  for (const notch of [4, 6])
    it(`keeps the inner corners of a ${notch} px notch`, () => {
      const shape = notched(notch)
      const r = vectorize(paint(80, 80, null, [{ rings: [shape], color: [180, 30, 40] }]))
      const P = svgPaths(r.svg)
      expect(Math.max(...shape.map((v) => distToOutline(v, ringsOf(P, P[0].fill))))).toBeLessThanOrEqual(0.5)
    }, SLOW)

  it.fails('keeps the inner corners of a 3 px notch (RC9: rounded off)', () => {
    const shape = notched(3)
    const r = vectorize(paint(80, 80, null, [{ rings: [shape], color: [180, 30, 40] }]))
    const P = svgPaths(r.svg)
    expect(Math.max(...shape.map((v) => distToOutline(v, ringsOf(P, P[0].fill))))).toBeLessThanOrEqual(0.5)
  }, SLOW)
})

describe('fine detail and lettering survive (RC1)', () => {
  const strokes = (wd: number) => {
    const bars = [0, 1, 2, 3, 4].map((k) => rect(10 + k * 12, 20, 10 + k * 12 + wd, 40))
    const ring = [circle(80, 30, 6), circle(80, 30, 6 - wd, true)]
    const r = vectorize(paint(100, 60, PAPER, [{ rings: bars, color: GREEN }, { rings: ring, color: GREEN }]))
    const P = svgPaths(r.svg)
    const g = fillNear(P, GREEN)
    return { bars: Math.min(...bars.map((b) => iou(P, g, [b], [b[0][0] - 2, 18, b[1][0] + 2, 42]))), ring: iou(P, g, ring, [72, 22, 88, 38]) }
  }

  it('keeps 3 px strokes', () => expect(strokes(3).bars).toBeGreaterThanOrEqual(0.85), SLOW)

  it.fails('keeps 1 px strokes and a 1 px ring (RC1: thinned or lost)', () => {
    const s = strokes(1)
    expect(s.bars).toBeGreaterThanOrEqual(0.7)
    expect(s.ring).toBeGreaterThanOrEqual(0.7)
  }, SLOW)

  it.fails('keeps 1.2 px lettering strokes on a light band (RC1: the strokes are lost entirely)', () => {
    const shapes = [{ rings: [rect(0, 30, 110, 40)], color: [240, 240, 235] as RGB }]
    const strokesAt = Array.from({ length: 12 }, (_, k) => rect(6 + k * 8, 31.5, 6 + k * 8 + 1.2, 38.5))
    shapes.push({ rings: strokesAt, color: [30, 140, 70] })
    const r = vectorize(paint(110, 70, BLUE, shapes))
    const P = svgPaths(r.svg)
    const g = fillNear(P, [30, 140, 70])
    expect(g).not.toBe('')
    for (const s of strokesAt) expect(iou(P, g, [s], [s[0][0] - 1, 30, s[1][0] + 1, 40])).toBeGreaterThanOrEqual(0.5)
  }, SLOW)
})

describe('clean, non-duplicated geometry (RC8, RC10)', () => {
  it.fails('draws every outline once (RC8: shapes repeated under another colour in stacked output)', () => {
    // A large light-blue shape, and lettering in a darker blue that doesn't touch it (Docker's logo).
    const img = paint(120, 120, null, [
      { rings: [circle(60, 40, 30)], color: [2, 157, 236] },
      { rings: [rect(20, 85, 28, 105), rect(35, 85, 43, 105)], color: [1, 108, 165] },
      { rings: [circle(65, 95, 9), circle(65, 95, 5, true)], color: [1, 108, 165] },
    ])
    expect(duplicateRings(svgPaths(vectorize(img).svg))).toEqual([])
  }, SLOW)

  it.fails('writes no self-intersecting outlines and no fragments under 4 px² (RC10)', () => {
    // Small stars and a lettered band with compression-like noise (the 240 px web copy of a flag).
    const shapes: { rings: Point[][]; color: RGB }[] = []
    for (let k = 0; k < 30; k++) shapes.push({ rings: [regularStar(12 + (k % 6) * 16, 12 + Math.floor(k / 6) * 14, 2 + (k % 3) * 0.8)], color: [250, 250, 250] })
    shapes.push({ rings: [rect(0, 70, 110, 76)], color: [240, 240, 235] })
    for (let k = 0; k < 12; k++) shapes.push({ rings: [rect(6 + k * 8, 71.5, 6 + k * 8 + 1.2, 74.5)], color: [30, 140, 70] })
    const rings = svgPaths(vectorize(paint(110, 84, BLUE, shapes, 8)).svg).flatMap((p) => p.rings)
    expect(rings.filter(selfIntersects)).toHaveLength(0)
    expect(rings.filter((g) => Math.abs(area(g)) < 4)).toHaveLength(0)
  }, SLOW)
})

describe('gradients (RC7)', () => {
  it('keeps a single linear gradient as one gradient fill', () => {
    const w = 160, h = 100
    const img = paint(w, h, null, [{ rings: [rect(10, 10, 150, 90)], color: [0, 0, 0] }])
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const p = (y * w + x) * 4
        if (!img.data[p + 3]) continue
        const t = (x - 10) / 140
        img.data[p] = 236 + (88 - 236) * t; img.data[p + 1] = 72 + (28 - 72) * t; img.data[p + 2] = 153 + (135 - 153) * t
      }
    expect(vectorize(img).svg.match(/<linearGradient/g)).toHaveLength(1)
  }, SLOW)

  it.fails('keeps the colour transitions of two overlapping gradients in one shape (RC7: one flat colour)', () => {
    const w = 160, h = 160
    const img = paint(w, h, null, [{ rings: [circle(80, 80, 70)], color: [0, 0, 0] }])
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const p = (y * w + x) * 4
        if (!img.data[p + 3]) continue
        const t1 = Math.min(1, Math.hypot(x - 50, y - 50) / 90)
        const k = Math.max(0, 1 - Math.min(1, Math.hypot(x - 120, y - 120) / 70))
        const a = [255 - 25 * t1, 200 - 160 * t1, 40 + 50 * t1]
        img.data[p] = a[0] * (1 - k) + 140 * k; img.data[p + 1] = a[1] * (1 - k) + 60 * k; img.data[p + 2] = a[2] * (1 - k) + 230 * k
      }
    const svg = vectorize(img).svg
    const gradients = (svg.match(/<(linear|radial)Gradient/g) ?? []).length
    const flat = new Set(svgPaths(svg).map((p) => p.fill)).size
    // Either real gradient fills, or enough flat steps to follow the transition (not one colour).
    expect(gradients >= 2 || flat >= 6).toBe(true)
  }, SLOW)
})

describe('background (RC2)', () => {
  it.fails('does not print an opaque paper background as a near-white plate', () => {
    const img = paint(120, 120, [252, 253, 251], [{ rings: [circle(60, 60, 35)], color: [40, 110, 180] }, { rings: [rect(40, 50, 80, 70)], color: [250, 220, 80] }], 3)
    expect(paperPlate(svgPaths(vectorize(img).svg), 120, 120)).toBeNull()
  }, SLOW)
})

// Readiness (RC3) is covered in src/quality/__tests__/readiness.test.ts: no result reads as
// production-approved from an automatic check, and none claims "clean edges" or "ready for print".
