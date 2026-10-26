/**
 * Straight edges (behind the straight-edges flag): long straight stretches of an outline that no
 * exact shape replaces are drawn as exact lines, flowing into rounded corners without a kink and
 * meeting at rebuilt corners; circles, letter bowls and gentle arcs stay curves; fidelity is no
 * worse. Off, nothing changes (golden.test.ts). Set REPORT=1 to print the measurements
 * (docs/straight-edges.md).
 */
import { beforeAll, describe, expect, it } from 'vitest'
import type { FlatOptions } from '../pipeline'
import { shapesFromSvg } from '../../export/path'
import { validateShapes } from '../../export/validate'
import { assessFidelity } from '../../quality/fidelity'
import { circle, installImageData, paint, rect, regularPolygon, regularStar, renderSvg, vectorize, type Point, type RGB } from './fidelity/harness'

beforeAll(installImageData)

const SLOW = 120_000
/** The option the straight-edges flag sets (pipeline.ts buildTraceJob). */
const straight = (o: FlatOptions): FlatOptions => ({ ...o, trace: { ...o.trace, straightEdges: true } })
const both = (img: ImageData) => ({ off: vectorize(img).svg, on: vectorize(img, straight).svg })
const report = (s: string) => process.env.REPORT && console.log(s)

const NAVY: RGB = [0, 40, 85]
const WHITE: RGB = [255, 255, 255]
const BLUE: RGB = [40, 70, 160]
const W = 200
const H = 140

const rotate = (pts: Point[], c: Point, a: number): Point[] =>
  pts.map(([x, y]) => [c[0] + (x - c[0]) * Math.cos(a) - (y - c[1]) * Math.sin(a), c[1] + (x - c[0]) * Math.sin(a) + (y - c[1]) * Math.cos(a)])

/**
 * A rectangle with its corners rounded to radii r (top-right, bottom-right, bottom-left, top-left;
 * 0 = sharp), turned by `angle` about its centre. Returns the outline, its four straight sides
 * (between the corner arcs) and its sharp corners.
 */
function roundedRect(x0: number, y0: number, x1: number, y1: number, r: number | number[], angle = 0) {
  const [r0, r1, r2, r3] = typeof r === 'number' ? [r, r, r, r] : r
  const ring: Point[] = []
  const sharp: Point[] = []
  const arc = (cx: number, cy: number, a0: number, rr: number) => {
    if (!rr) return ring.push([cx, cy]), sharp.push([cx, cy])
    for (let i = 0; i <= 24; i++) ring.push([cx + rr * Math.cos(a0 + (i / 24) * (Math.PI / 2)), cy + rr * Math.sin(a0 + (i / 24) * (Math.PI / 2))])
  }
  arc(x1 - r0, y0 + r0, -Math.PI / 2, r0)
  arc(x1 - r1, y1 - r1, 0, r1)
  arc(x0 + r2, y1 - r2, Math.PI / 2, r2)
  arc(x0 + r3, y0 + r3, Math.PI, r3)
  const sides: [Point, Point][] = [
    [[x0 + r3, y0], [x1 - r0, y0]],
    [[x1, y0 + r0], [x1, y1 - r1]],
    [[x1 - r1, y1], [x0 + r2, y1]],
    [[x0, y1 - r2], [x0, y0 + r3]],
  ]
  const c: Point = [(x0 + x1) / 2, (y0 + y1) / 2]
  return { ring: rotate(ring, c, angle), sides: sides.map((s) => rotate(s, c, angle) as [Point, Point]), sharp: rotate(sharp, c, angle) }
}

/** Every path's data in an SVG. */
const pathData = (svg: string) => [...svg.matchAll(/<path\b[^>]*\sd="([^"]*)"/g)].map((m) => m[1])

/** Straight segments (`L`) of the paths, leaving out the canvas-sized background rectangle. */
function lines(svg: string): [Point, Point][] {
  const out: [Point, Point][] = []
  for (const d of pathData(svg)) {
    const tok = d.match(/[MLCZ]|-?\d*\.?\d+(?:e-?\d+)?/gi) ?? []
    let at: Point = [0, 0]
    for (let i = 0; i < tok.length; ) {
      const c = tok[i++]
      if (c === 'M') at = [+tok[i++], +tok[i++]]
      else if (c === 'L') {
        const p: Point = [+tok[i++], +tok[i++]]
        const onCanvasEdge = (q: Point) => q[0] === 0 || q[1] === 0 || q[0] === W || q[1] === H
        if (!(onCanvasEdge(at) && onCanvasEdge(p))) out.push([at, p])
        at = p
      } else if (c === 'C') {
        i += 4
        at = [+tok[i++], +tok[i++]]
      }
    }
  }
  return out
}
const curves = (svg: string) => pathData(svg).reduce((s, d) => s + (d.match(/C/g) ?? []).length, 0)

/** The outlines drawn in an SVG, sampled every ~0.1 px (curves 64 steps each). */
function samples(svg: string): Point[] {
  const out: Point[] = []
  for (const d of pathData(svg)) {
    const tok = d.match(/[MLCZ]|-?\d*\.?\d+(?:e-?\d+)?/gi) ?? []
    let at: Point = [0, 0]
    let start: Point = [0, 0]
    const line = (p: Point) => {
      const n = Math.max(1, Math.ceil(Math.hypot(p[0] - at[0], p[1] - at[1]) / 0.1))
      for (let k = 1; k <= n; k++) out.push([at[0] + ((p[0] - at[0]) * k) / n, at[1] + ((p[1] - at[1]) * k) / n])
      at = p
    }
    for (let i = 0; i < tok.length; ) {
      const c = tok[i++]
      if (c === 'M') at = start = [+tok[i++], +tok[i++]]
      else if (c === 'L') line([+tok[i++], +tok[i++]])
      else if (c === 'C') {
        const [x1, y1, x2, y2, x3, y3] = tok.slice(i, i + 6).map(Number)
        i += 6
        for (let k = 1; k <= 64; k++) {
          const t = k / 64, u = 1 - t
          out.push([u * u * u * at[0] + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3, u * u * u * at[1] + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3])
        }
        at = [x3, y3]
      } else if (c === 'Z') line(start)
    }
  }
  return out
}

/**
 * How the drawn outline follows the true straight sides away from their ends (`trim` px): the
 * largest distance from a side, and the waviness (largest minus smallest signed offset along one
 * side, which leaves out a constant shift of the whole edge).
 */
function edgeDeviation(svg: string, sides: [Point, Point][], trim = 3): { max: number; wave: number } {
  const pts = samples(svg)
  let max = 0
  let wave = 0
  for (const [a, b] of sides) {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1])
    const u: Point = [(b[0] - a[0]) / len, (b[1] - a[1]) / len]
    let lo = Infinity, hi = -Infinity
    for (const p of pts) {
      const t = (p[0] - a[0]) * u[0] + (p[1] - a[1]) * u[1]
      const s = (p[0] - a[0]) * u[1] - (p[1] - a[1]) * u[0]
      if (t < trim || t > len - trim || Math.abs(s) > 1.5) continue
      lo = Math.min(lo, s)
      hi = Math.max(hi, s)
      max = Math.max(max, Math.abs(s))
    }
    expect(hi).toBeGreaterThanOrEqual(lo) // the side is drawn
    wave = Math.max(wave, hi - lo)
  }
  return { max, wave }
}

/** Largest distance from the given points to the drawn outlines. */
function pointError(svg: string, pts: Point[]): number {
  const s = samples(svg)
  return Math.max(...pts.map((p) => Math.min(...s.map((q) => Math.hypot(p[0] - q[0], p[1] - q[1])))))
}

/** Mean error and edge recall of an SVG against the upload (assessFidelity). */
function fidelity(img: ImageData, svg: string) {
  const r = assessFidelity(img, renderSvg(svg, img.width, img.height), svg)
  return { meanError: r.meanError, edgeRecall: r.edgeRecall }
}

/** Shapes with long straight sides, and the background they are drawn on. */
const EDGED = {
  'rounded rectangle': { shape: roundedRect(20, 24, 180, 116, 14), bg: WHITE },
  'rounded rectangle turned 17°': { shape: roundedRect(30, 30, 170, 110, 12, (17 * Math.PI) / 180), bg: WHITE },
  'rectangle turned 23° with one rounded corner': { shape: roundedRect(45, 35, 155, 105, [0, 18, 0, 0], (23 * Math.PI) / 180), bg: WHITE },
  'rounded rectangle turned 17°, transparent': { shape: roundedRect(30, 30, 170, 110, 12, (17 * Math.PI) / 180), bg: null },
} as const

describe('straight edges are drawn as exact lines', () => {
  for (const [name, { shape, bg }] of Object.entries(EDGED))
    it(`${name}: a line along every side, straighter and closer to the true edges than with the flag off`, () => {
      const img = paint(W, H, bg, [{ rings: [shape.ring], color: NAVY }])
      const { off, on } = both(img)
      const before = edgeDeviation(off, shape.sides)
      const after = edgeDeviation(on, shape.sides)
      const segs = lines(on)
      const f0 = fidelity(img, off)
      const f1 = fidelity(img, on)
      report(
        `STRAIGHT ${name}: lines ${lines(off).length} → ${segs.length}, curves ${curves(off)} → ${curves(on)}, max deviation ${before.max.toFixed(3)} → ${after.max.toFixed(3)}, ` +
          `waviness ${before.wave.toFixed(3)} → ${after.wave.toFixed(3)}, mean error ${f0.meanError.toFixed(3)} → ${f1.meanError.toFixed(3)}, edge recall ${f0.edgeRecall.toFixed(3)} → ${f1.edgeRecall.toFixed(3)}` +
          (shape.sharp.length ? `, sharp corners ${pointError(off, shape.sharp).toFixed(3)} → ${pointError(on, shape.sharp).toFixed(3)}` : ''),
      )
      for (const [a, b] of shape.sides) {
        const len = Math.hypot(b[0] - a[0], b[1] - a[1])
        const along = segs.some(([p, q]) => {
          const l = Math.hypot(q[0] - p[0], q[1] - p[1])
          return Math.abs(((q[0] - p[0]) * (b[0] - a[0]) + (q[1] - p[1]) * (b[1] - a[1])) / (l * len)) > 0.999 && l > 0.6 * len
        })
        expect(along).toBe(true)
      }
      expect(after.wave).toBeLessThan(before.wave)
      expect(after.max).toBeLessThanOrEqual(before.max + 0.01)
      if (bg) {
        // Opaque edges trace accurately: the lines lie on the true edges.
        expect(after.max).toBeLessThan(0.1)
        expect(f1.meanError).toBeLessThanOrEqual(f0.meanError)
      } else expect(f1.meanError).toBeLessThanOrEqual(f0.meanError * 1.03)
      expect(f1.edgeRecall).toBeGreaterThanOrEqual(f0.edgeRecall - 0.002)
      if (shape.sharp.length) expect(pointError(on, shape.sharp)).toBeLessThanOrEqual(pointError(off, shape.sharp) + 0.05)
    }, SLOW)

  it('a mark like the Barron "B": white rounded shapes on a navy disc, edges straight and joins smooth', () => {
    const stem = roundedRect(70, 30, 90, 110, [0, 0, 6, 6])
    const bar = roundedRect(90, 30, 125, 66, [16, 16, 0, 0])
    const img = paint(W, H, null, [
      { rings: [circle(100, 70, 62)], color: NAVY },
      { rings: [stem.ring, bar.ring, roundedRect(90, 74, 130, 110, [17, 17, 0, 0]).ring], color: WHITE },
    ])
    const { off, on } = both(img)
    const before = edgeDeviation(off, [stem.sides[3]])
    const after = edgeDeviation(on, [stem.sides[3]])
    report(`STRAIGHT mark: lines ${lines(off).length} → ${lines(on).length}, stem waviness ${before.wave.toFixed(3)} → ${after.wave.toFixed(3)}, max ${before.max.toFixed(3)} → ${after.max.toFixed(3)}`)
    expect(lines(on).length).toBeGreaterThan(lines(off).length)
    expect(after.wave).toBeLessThanOrEqual(before.wave)
    expect(after.max).toBeLessThan(0.1)
    expect(fidelity(img, on).meanError).toBeLessThanOrEqual(fidelity(img, off).meanError)
  }, SLOW)
})

describe('a straight edge flows into a rounded corner without a kink', () => {
  it('the curve leaving each line starts in the line’s direction', () => {
    const shape = roundedRect(30, 30, 170, 110, 12, (17 * Math.PI) / 180)
    const img = paint(W, H, WHITE, [{ rings: [shape.ring], color: NAVY }])
    const { on } = both(img)
    const d = pathData(on).find((p) => p.includes('C'))!
    const tok = d.match(/[MLCZ]|-?\d*\.?\d+(?:e-?\d+)?/gi)!
    let at: Point = [0, 0]
    let lineDir: Point | null = null
    let joins = 0
    for (let i = 0; i < tok.length; ) {
      const c = tok[i++]
      if (c === 'M') at = [+tok[i++], +tok[i++]]
      else if (c === 'L') {
        const p: Point = [+tok[i++], +tok[i++]]
        const l = Math.hypot(p[0] - at[0], p[1] - at[1])
        lineDir = [(p[0] - at[0]) / l, (p[1] - at[1]) / l]
        at = p
      } else if (c === 'C') {
        const c1: Point = [+tok[i], +tok[i + 1]]
        if (lineDir) {
          const l = Math.hypot(c1[0] - at[0], c1[1] - at[1])
          const turn = Math.asin(Math.abs((lineDir[0] * (c1[1] - at[1]) - lineDir[1] * (c1[0] - at[0])) / l)) * (180 / Math.PI)
          expect(turn).toBeLessThan(1.5) // within rounding of the written coordinates
          joins++
        }
        lineDir = null
        at = [+tok[i + 4], +tok[i + 5]]
        i += 6
      }
    }
    expect(joins).toBe(4)
  }, SLOW)
})

/** A ring sector: the letter "C" (outer and inner radius, opening in degrees, facing right). */
function letterC(cx: number, cy: number, R: number, r: number, open: number): Point[] {
  const a0 = (open / 2) * (Math.PI / 180)
  const pts: Point[] = []
  for (let i = 0; i <= 120; i++) {
    const a = a0 + (i / 120) * (2 * Math.PI - 2 * a0)
    pts.push([cx + R * Math.cos(a), cy + R * Math.sin(a)])
  }
  for (let i = 120; i >= 0; i--) {
    const a = a0 + (i / 120) * (2 * Math.PI - 2 * a0)
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)])
  }
  return pts
}

/** The letter "D": a straight stem and a half-elliptical bowl, with its counter. */
function letterD(): Point[][] {
  const half = (cx: number, cy: number, rx: number, ry: number): Point[] =>
    Array.from({ length: 81 }, (_, i) => {
      const a = -Math.PI / 2 + (i / 80) * Math.PI
      return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)] as Point
    })
  const outer: Point[] = [[60, 22], ...half(90, 70, 55, 48), [60, 118]]
  const counter: Point[] = [[76, 36], ...half(90, 70, 38, 34), [76, 104]]
  return [outer, counter.reverse()]
}

/** The region under an arc of radius R spanning the chord y = 120, x 20…180. */
function arcSegment(R: number): Point[] {
  const cy = 120 + Math.sqrt(R * R - 80 * 80)
  const a = Math.asin(80 / R)
  return Array.from({ length: 201 }, (_, i) => {
    const t = -a + (i / 200) * 2 * a
    return [100 + R * Math.sin(t), cy - R * Math.cos(t)] as Point
  })
}

describe('curves stay curves', () => {
  it('a circle gains no straight segments', () => {
    const img = paint(W, H, WHITE, [{ rings: [circle(100, 70, 55)], color: NAVY }])
    const { off, on } = both(img)
    expect(lines(on)).toEqual([])
    expect(on).toBe(off)
  }, SLOW)

  it('a letter "C": only its two cut ends are straight; the arcs stay curves', () => {
    const img = paint(W, H, WHITE, [{ rings: [letterC(100, 70, 58, 38, 70)], color: NAVY }])
    const { on } = both(img)
    report(`LETTER C: lines ${lines(on).map(([p, q]) => `${p.join(',')}→${q.join(',')}`).join(' ')}`)
    for (const [p, q] of lines(on)) {
      // Each line must run radially (a cut end), not around the bowl.
      const m: Point = [(p[0] + q[0]) / 2 - 100, (p[1] + q[1]) / 2 - 70]
      const l = Math.hypot(q[0] - p[0], q[1] - p[1])
      expect(Math.abs(((q[0] - p[0]) * m[0] + (q[1] - p[1]) * m[1]) / (l * Math.hypot(...m)))).toBeGreaterThan(0.95)
    }
  }, SLOW)

  it('a letter "D": its stem is straight, its bowl stays curved', () => {
    const img = paint(W, H, WHITE, [{ rings: letterD(), color: NAVY }])
    const { on } = both(img)
    const segs = lines(on)
    report(`LETTER D: lines ${segs.map(([p, q]) => `${p.join(',')}→${q.join(',')}`).join(' ')}`)
    expect(segs.length).toBeGreaterThanOrEqual(2) // the stem's two sides
    // No line lies wholly on the bowl (right of the stem's flat top and bottom).
    for (const [p, q] of segs) expect(Math.min(p[0], q[0])).toBeLessThan(92)
  }, SLOW)

  for (const R of [150, 300])
    it(`a gentle arc (radius ${R} px) stays a curve while its chord becomes a line`, () => {
      const img = paint(W, H, WHITE, [{ rings: [arcSegment(R)], color: NAVY }])
      const { on } = both(img)
      const segs = lines(on)
      report(`ARC ${R}: lines ${segs.map(([p, q]) => `${p.join(',')}→${q.join(',')}`).join(' ')}`)
      expect(segs.length).toBeGreaterThanOrEqual(1)
      for (const [p, q] of segs) expect(Math.max(Math.abs(p[1] - 120), Math.abs(q[1] - 120))).toBeLessThan(1)
    }, SLOW)
})

const FIXTURES: Record<string, () => ImageData> = {
  stars: () => paint(96, 96, BLUE, [{ rings: [regularStar(30, 30, 7), regularStar(66, 60, 20)], color: WHITE }]),
  polygons: () => paint(96, 96, null, [{ rings: [rect(8, 8, 88, 88)], color: BLUE }, { rings: [regularPolygon(48, 48, 12, 7), regularPolygon(25, 70, 8, 6)], color: WHITE }]),
  lettering: () => paint(110, 70, BLUE, [{ rings: [rect(0, 30, 110, 40)], color: [240, 240, 235] }, { rings: Array.from({ length: 12 }, (_, k) => rect(6 + k * 8, 31.5, 6 + k * 8 + 1.2, 38.5)), color: [30, 140, 70] }]),
  stacked: () =>
    paint(120, 120, null, [
      { rings: [circle(60, 40, 30)], color: [2, 157, 236] },
      { rings: [rect(20, 85, 28, 105), rect(35, 85, 43, 105), circle(65, 95, 9), circle(65, 95, 5, true)], color: [1, 108, 165] },
    ]),
  paper: () => paint(120, 120, [252, 253, 251], [{ rings: [circle(60, 60, 35)], color: [40, 110, 180] }, { rings: [rect(40, 50, 80, 70)], color: [250, 220, 80] }], 3),
  notches: () => paint(96, 96, null, [{ rings: [[[10, 10], [86, 10], [86, 86], [56, 86], [56, 56], [40, 56], [40, 86], [10, 86]]], color: BLUE }]),
  'letter D': () => paint(W, H, WHITE, [{ rings: letterD(), color: NAVY }]),
}

describe('fidelity is no worse on the fidelity fixtures', () => {
  for (const [name, make] of Object.entries(FIXTURES))
    it(name, () => {
      const img = make()
      const { off, on } = both(img)
      const f0 = fidelity(img, off)
      const f1 = fidelity(img, on)
      report(`FIDELITY ${name}: mean error ${f0.meanError.toFixed(3)} → ${f1.meanError.toFixed(3)}, edge recall ${f0.edgeRecall.toFixed(3)} → ${f1.edgeRecall.toFixed(3)}, lines ${lines(off).length} → ${lines(on).length}`)
      expect(f1.meanError).toBeLessThanOrEqual(f0.meanError + 0.005)
      expect(f1.edgeRecall).toBeGreaterThanOrEqual(f0.edgeRecall - 0.002)
    }, SLOW)
})

describe('flag', () => {
  it('is off in production builds, whatever the address says', async () => {
    const { straightEdgesOn } = await import('../../quality/flags')
    expect(straightEdgesOn('?straight-edges=on', { value: undefined, dev: false })).toBe(false)
    expect(straightEdgesOn('?straight-edges=on', { value: 'off', dev: false })).toBe(false)
    expect(straightEdgesOn('?straight-edges=on', { value: 'preview', dev: false })).toBe(true)
    expect(straightEdgesOn('', { value: 'preview', dev: false })).toBe(false)
    expect(straightEdgesOn('', { value: 'on', dev: false })).toBe(true)
  })
})

describe('print plates, cut files and one colour', () => {
  /** Failed and warned export checks (count per check) of a knockout SVG. */
  const problems = (svg: string, w: number) => {
    const checks = validateShapes(shapesFromSvg(svg), { width: w, outputWidthMm: 200, plates: true })
    return Object.fromEntries(checks.filter((c) => c.status !== 'ok').map((c) => [c.id, c.count]))
  }
  const cases: Record<string, () => ImageData> = {
    ...FIXTURES,
    'rounded rectangle turned 17°': () => paint(W, H, WHITE, [{ rings: [EDGED['rounded rectangle turned 17°'].shape.ring], color: NAVY }]),
    'letter D': () => paint(W, H, WHITE, [{ rings: letterD(), color: NAVY }]),
  }
  for (const [name, make] of Object.entries(cases))
    it(`${name}: no new export problems, no worse fidelity`, () => {
      const img = make()
      const knockout = (o: FlatOptions): FlatOptions => ({ ...o, trace: { ...o.trace, mode: 'knockout', spread: 0.15 } })
      const one = (o: FlatOptions): FlatOptions => ({ ...o, gradients: 'apply', oneColour: { ink: null, gapPx: 2, production: true, outputWidthMm: 200 } })
      for (const tweak of [knockout, one]) {
        const off = vectorize(img, tweak).svg
        const on = vectorize(img, (o) => straight(tweak(o))).svg
        const p0 = problems(off, img.width)
        const p1 = problems(on, img.width)
        for (const [id, count] of Object.entries(p1)) expect(count).toBeLessThanOrEqual(p0[id] ?? 0)
        report(`PROD ${name} ${tweak === knockout ? 'knockout' : 'one colour'}: ${fidelity(img, off).meanError.toFixed(3)} → ${fidelity(img, on).meanError.toFixed(3)}`)
        // Plates are spread (0.15 px) so neighbouring inks overlap; a line lies exactly on the spread
        // outline where the wavy curves sat partly inside it, so the overlap, which counts as error
        // against the upload, can grow a little (0.52 → 0.62 on the turned rectangle).
        expect(fidelity(img, on).meanError).toBeLessThanOrEqual(fidelity(img, off).meanError + (tweak === knockout ? 0.1 : 0.01))
      }
    }, SLOW)
})
