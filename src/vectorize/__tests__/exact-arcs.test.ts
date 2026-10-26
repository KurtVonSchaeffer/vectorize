/**
 * Exact arcs (behind the exact-arcs flag): circular stretches of an outline that no exact shape
 * replaces are drawn as exact arcs, one centre and radius each, written as cubics of at most 90°;
 * with straight edges a rounded corner becomes a fillet touching both lines (line–arc–line).
 * Circles stay exact shapes, ellipse stretches and free curves stay curves, fidelity is no worse
 * and no outline gains nodes. Off, nothing changes (golden.test.ts). Set REPORT=1 to print the
 * measurements (docs/exact-arcs.md).
 */
import { beforeAll, describe, expect, it } from 'vitest'
import type { FlatOptions } from '../pipeline'
import { shapesFromSvg } from '../../export/path'
import { validateShapes } from '../../export/validate'
import { assessFidelity } from '../../quality/fidelity'
import { circle, distToOutline, installImageData, paint, rect, regularPolygon, regularStar, renderSvg, vectorize, type Point, type RGB } from './fidelity/harness'

beforeAll(installImageData)

const SLOW = 120_000
/** The options the flags set (pipeline.ts buildTraceJob); the admin panel turns both on. */
const edgesOnly = (o: FlatOptions): FlatOptions => ({ ...o, trace: { ...o.trace, straightEdges: true } })
const arcsOnly = (o: FlatOptions): FlatOptions => ({ ...o, trace: { ...o.trace, exactArcs: true } })
const both = (o: FlatOptions): FlatOptions => ({ ...o, trace: { ...o.trace, straightEdges: true, exactArcs: true } })
const report = (s: string) => process.env.REPORT && console.log(s)

const NAVY: RGB = [0, 40, 85]
const WHITE: RGB = [255, 255, 255]
const BLUE: RGB = [40, 70, 160]
const W = 200
const H = 140

const rotate = (pts: Point[], c: Point, a: number): Point[] =>
  pts.map(([x, y]) => [c[0] + (x - c[0]) * Math.cos(a) - (y - c[1]) * Math.sin(a), c[1] + (x - c[0]) * Math.sin(a) + (y - c[1]) * Math.cos(a)])

/** A rectangle with all four corners rounded to radius r, turned by `angle` about its centre. */
function roundedRect(x0: number, y0: number, x1: number, y1: number, r: number, angle = 0): Point[] {
  const ring: Point[] = []
  const corners: [number, number, number][] = [[x1 - r, y0 + r, -Math.PI / 2], [x1 - r, y1 - r, 0], [x0 + r, y1 - r, Math.PI / 2], [x0 + r, y0 + r, Math.PI]]
  for (const [cx, cy, a0] of corners) for (let i = 0; i <= 48; i++) ring.push([cx + r * Math.cos(a0 + (i / 48) * (Math.PI / 2)), cy + r * Math.sin(a0 + (i / 48) * (Math.PI / 2))])
  return rotate(ring, [(x0 + x1) / 2, (y0 + y1) / 2], angle)
}

/** A letter "b": a stem and a round bowl (outer radius R) with a round counter (radius r). */
function letterB(): Point[][] {
  const cx = 100, cy = 78, R = 38, r = 22
  const dy = Math.sqrt(R * R - (cx - 72) ** 2)
  const a0 = Math.atan2(-dy, 72 - cx) + 2 * Math.PI
  const a1 = Math.atan2(dy, 72 - cx) + 2 * Math.PI
  const outer: Point[] = [[52, 12], [72, 12]]
  // The bowl, from where it leaves the stem at the top round to where it meets it at the bottom.
  for (let i = 0; i <= 200; i++) {
    const a = a0 + (i / 200) * (a1 - a0)
    outer.push([cx + R * Math.cos(a), cy + R * Math.sin(a)])
  }
  outer.push([72, 118], [52, 118])
  return [outer, circle(cx, cy, r, true)]
}

/** Half an ellipse (radii rx, ry) closed by its straight diameter. */
function halfEllipse(cx: number, cy: number, rx: number, ry: number): Point[] {
  return Array.from({ length: 161 }, (_, i) => {
    const a = -Math.PI / 2 + (i / 160) * Math.PI
    return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)] as Point
  })
}

/** A free-form blob: radius varying round it. */
const blob = (): Point[] =>
  Array.from({ length: 400 }, (_, i) => {
    const a = (i / 400) * 2 * Math.PI
    const r = 48 + 8 * Math.sin(3 * a) + 3 * Math.cos(4 * a + 1)
    return [100 + r * Math.cos(a), 70 + r * Math.sin(a)] as Point
  })

/** Every path's data in an SVG. */
const pathData = (svg: string) => [...svg.matchAll(/<path\b[^>]*\sd="([^"]*)"/g)].map((m) => m[1])

type Seg = { kind: 'L' | 'C'; p: Point[] }
/** The segments of every subpath (curves with their four points), leaving out the canvas-sized background. */
function segments(svg: string): Seg[][] {
  const out: Seg[][] = []
  for (const d of pathData(svg)) {
    const tok = d.match(/[MLCZ]|-?\d*\.?\d+(?:e-?\d+)?/gi) ?? []
    let at: Point = [0, 0]
    let start: Point = [0, 0]
    let cur: Seg[] = []
    for (let i = 0; i < tok.length; ) {
      const c = tok[i++]
      if (c === 'M') {
        at = start = [+tok[i++], +tok[i++]]
        cur = []
      } else if (c === 'L') {
        const p: Point = [+tok[i++], +tok[i++]]
        cur.push({ kind: 'L', p: [at, p] })
        at = p
      } else if (c === 'C') {
        const q = tok.slice(i, i + 6).map(Number)
        i += 6
        const p3: Point = [q[4], q[5]]
        cur.push({ kind: 'C', p: [at, [q[0], q[1]], [q[2], q[3]], p3] })
        at = p3
      } else if (c === 'Z') {
        if (Math.hypot(at[0] - start[0], at[1] - start[1]) > 1e-6) cur.push({ kind: 'L', p: [at, start] })
        const onCanvas = (q: Point) => q[0] === 0 || q[1] === 0 || q[0] === W || q[1] === H
        if (!cur.every((s) => s.kind === 'L' && s.p.every(onCanvas))) out.push(cur)
      }
    }
  }
  return out
}

const bez = (p: Point[], t: number): Point => {
  const u = 1 - t
  return [u * u * u * p[0][0] + 3 * u * u * t * p[1][0] + 3 * u * t * t * p[2][0] + t * t * t * p[3][0], u * u * u * p[0][1] + 3 * u * u * t * p[1][1] + 3 * u * t * t * p[2][1] + t * t * t * p[3][1]]
}

/** The circle through three points. */
function circleThrough(a: Point, b: Point, c: Point): { c: Point; r: number } | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]))
  if (Math.abs(d) < 1e-9) return null
  const s = (p: Point) => p[0] * p[0] + p[1] * p[1]
  const x = (s(a) * (b[1] - c[1]) + s(b) * (c[1] - a[1]) + s(c) * (a[1] - b[1])) / d
  const y = (s(a) * (c[0] - b[0]) + s(b) * (a[0] - c[0]) + s(c) * (b[0] - a[0])) / d
  return { c: [x, y], r: Math.hypot(a[0] - x, a[1] - y) }
}

/**
 * A cubic that is the standard approximation of a circular arc (its handles tangent, equal and
 * 4/3·tan(θ/4)·r long, its quarter points on the circle), or null. Written coordinates are rounded,
 * hence the tolerances.
 */
function arcOf(p: Point[]): { c: Point; r: number; sweep: number } | null {
  const m = bez(p, 0.5)
  const circ = circleThrough(p[0], m, p[3])
  if (!circ || circ.r > 1e4) return null
  const chord = Math.hypot(p[3][0] - p[0][0], p[3][1] - p[0][1])
  const sweep = 2 * Math.asin(Math.min(1, chord / (2 * circ.r)))
  // An arc over 90° isn't written as one cubic; the shorter-arc sweep is the one meant.
  const h = (4 / 3) * Math.tan(sweep / 4) * circ.r
  const h1 = Math.hypot(p[1][0] - p[0][0], p[1][1] - p[0][1])
  const h2 = Math.hypot(p[3][0] - p[2][0], p[3][1] - p[2][1])
  const tol = 0.012 + 0.002 * h
  if (Math.abs(h1 - h) > tol || Math.abs(h2 - h) > tol) return null
  for (const t of [0.25, 0.75]) {
    const q = bez(p, t)
    if (Math.abs(Math.hypot(q[0] - circ.c[0], q[1] - circ.c[1]) - circ.r) > 0.01 + 1e-4 * circ.r) return null
  }
  return { ...circ, sweep }
}

/** The arcs drawn: runs of arc cubics on one circle merged into one, with their radius and sweep (degrees). */
function arcs(svg: string): { c: Point; r: number; sweep: number }[] {
  const out: { c: Point; r: number; sweep: number }[] = []
  for (const sub of segments(svg)) {
    const found: ({ c: Point; r: number; sweep: number } | null)[] = sub.map((s) => (s.kind === 'C' ? arcOf(s.p) : null))
    const runs: { c: Point; r: number; sweep: number }[] = []
    let prev: { c: Point; r: number; sweep: number } | null = null
    for (const a of found) {
      if (a && prev && Math.hypot(a.c[0] - prev.c[0], a.c[1] - prev.c[1]) < 0.05 && Math.abs(a.r - prev.r) < 0.05) prev.sweep += a.sweep
      else if (a) runs.push((prev = { ...a }))
      else prev = null
    }
    // The run closing the outline may continue the first.
    if (runs.length > 1 && found[0] && found[found.length - 1]) {
      const a = runs[0]
      const b = runs[runs.length - 1]
      if (Math.hypot(a.c[0] - b.c[0], a.c[1] - b.c[1]) < 0.05 && Math.abs(a.r - b.r) < 0.05) {
        b.sweep += a.sweep
        runs.shift()
      }
    }
    // Straight curves and slivers aren't arcs.
    out.push(...runs.filter((r) => r.r < 1000 && r.sweep > Math.PI / 18).map((r) => ({ ...r, sweep: (r.sweep * 180) / Math.PI })))
  }
  return out
}
const lineCount = (svg: string) => segments(svg).reduce((s, sub) => s + sub.filter((x) => x.kind === 'L' && Math.hypot(x.p[1][0] - x.p[0][0], x.p[1][1] - x.p[0][1]) > 1).length, 0)
/** Nodes: the segments drawn. */
const nodes = (svg: string) => segments(svg).reduce((s, sub) => s + sub.length, 0)

/** The outline drawn, sampled every ~0.1 px. */
function samples(svg: string): Point[] {
  const out: Point[] = []
  for (const sub of segments(svg))
    for (const s of sub) {
      if (s.kind === 'L') {
        const [a, b] = s.p
        const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.1))
        for (let k = 1; k <= n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n])
      } else for (let k = 1; k <= 64; k++) out.push(bez(s.p, k / 64))
    }
  return out
}

/** Largest distance from the drawn outline to the true one. */
const deviation = (svg: string, truth: Point[][]) => Math.max(...samples(svg).map((p) => distToOutline(p, truth)))

/** Mean error and edge recall of an SVG against the upload (assessFidelity). */
function fidelity(img: ImageData, svg: string) {
  const r = assessFidelity(img, renderSvg(svg, img.width, img.height), svg)
  return { meanError: r.meanError, edgeRecall: r.edgeRecall }
}

const describeArcs = (a: { r: number; sweep: number }[]) => a.map((x) => `r ${x.r.toFixed(2)} ${x.sweep.toFixed(0)}°`).join(', ')
const img1 = (rings: Point[][], bg: RGB | null = WHITE) => paint(W, H, bg, [{ rings, color: NAVY }])
const ident = (o: FlatOptions) => o

/** The same image off (no flags), with straight edges only, and with exact arcs too (the admin panel). */
function three(img: ImageData) {
  return { off: vectorize(img).svg, edges: vectorize(img, edgesOnly).svg, on: vectorize(img, both).svg }
}

/** Shapes made of straight sides and true circular arcs: their radius, how many lines and arcs, and the arcs' sweep. */
const ROUNDED = {
  'rounded rectangle': { rings: [roundedRect(20, 24, 180, 116, 14)], r: 14, lines: 4, arcs: 4, sweep: 90 },
  'rounded rectangle turned 17°': { rings: [roundedRect(30, 30, 170, 110, 12, (17 * Math.PI) / 180)], r: 12, lines: 4, arcs: 4, sweep: 90 },
  'stroke with round caps, turned 11°': { rings: [roundedRect(30, 55, 170, 85, 15, (11 * Math.PI) / 180)], r: 15, lines: 2, arcs: 2, sweep: 180 },
}

describe('circular stretches are drawn as exact arcs', () => {
  for (const [name, s] of Object.entries(ROUNDED))
    it(`${name}: ${s.lines} lines and ${s.arcs} arcs of the true radius, closer to the true shape, no more nodes`, () => {
      const img = img1(s.rings)
      const { off, edges, on } = three(img)
      const found = arcs(on)
      const dev = { off: deviation(off, s.rings), edges: deviation(edges, s.rings), on: deviation(on, s.rings) }
      const f = { off: fidelity(img, off), edges: fidelity(img, edges), on: fidelity(img, on) }
      report(
        `ARCS ${name}: lines ${lineCount(off)}/${lineCount(edges)} → ${lineCount(on)}, arcs ${arcs(edges).length} → ${found.length} (${describeArcs(found)}), ` +
          `radius error ${Math.max(...found.map((a) => Math.abs(a.r - s.r))).toFixed(3)}, max deviation ${dev.off.toFixed(3)}/${dev.edges.toFixed(3)} → ${dev.on.toFixed(3)}, ` +
          `nodes ${nodes(off)}/${nodes(edges)} → ${nodes(on)}, mean error ${f.off.meanError.toFixed(3)}/${f.edges.meanError.toFixed(3)} → ${f.on.meanError.toFixed(3)}`,
      )
      expect(lineCount(on)).toBe(s.lines)
      expect(found.length).toBe(s.arcs)
      for (const a of found) {
        expect(Math.abs(a.r - s.r)).toBeLessThan(0.5)
        expect(Math.abs(a.sweep - s.sweep)).toBeLessThan(3)
      }
      expect(dev.on).toBeLessThan(dev.edges)
      expect(dev.on).toBeLessThan(dev.off)
      expect(dev.on).toBeLessThan(0.1)
      expect(nodes(on)).toBeLessThanOrEqual(nodes(edges))
      expect(nodes(on)).toBeLessThanOrEqual(nodes(off))
      expect(f.on.meanError).toBeLessThanOrEqual(f.edges.meanError)
      expect(f.on.edgeRecall).toBeGreaterThanOrEqual(f.edges.edgeRecall - 0.002)
    }, SLOW)

  it('without straight edges the arcs are the same (the lines are found as their ends)', () => {
    const s = ROUNDED['rounded rectangle turned 17°']
    const img = img1(s.rings)
    const alone = vectorize(img, arcsOnly).svg
    expect(arcs(alone).map((a) => a.r.toFixed(2))).toEqual(arcs(vectorize(img, both).svg).map((a) => a.r.toFixed(2)))
    expect(deviation(alone, s.rings)).toBeLessThan(deviation(vectorize(img).svg, s.rings))
  }, SLOW)

  it('a rounded corner is a fillet: each arc starts and ends in its lines’ directions', () => {
    const { on } = three(img1(ROUNDED['rounded rectangle turned 17°'].rings))
    let joins = 0
    for (const sub of segments(on))
      sub.forEach((s, k) => {
        const next = sub[(k + 1) % sub.length]
        const dir = (a: Point, b: Point) => {
          const l = Math.hypot(b[0] - a[0], b[1] - a[1])
          return [(b[0] - a[0]) / l, (b[1] - a[1]) / l]
        }
        // Line into arc, and arc into line: the curve's handle runs along the line.
        const turn = (u: number[], v: number[]) => Math.asin(Math.min(1, Math.abs(u[0] * v[1] - u[1] * v[0]))) * (180 / Math.PI)
        if (s.kind === 'L' && next.kind === 'C' && arcOf(next.p)) {
          expect(Math.hypot(next.p[0][0] - s.p[1][0], next.p[0][1] - s.p[1][1])).toBeLessThan(1e-9)
          expect(turn(dir(s.p[0], s.p[1]), dir(next.p[0], next.p[1]))).toBeLessThan(1)
          joins++
        }
        if (s.kind === 'C' && arcOf(s.p) && next.kind === 'L') {
          expect(turn(dir(s.p[2], s.p[3]), dir(next.p[0], next.p[1]))).toBeLessThan(1)
          joins++
        }
      })
    expect(joins).toBe(8)
  }, SLOW)

  it('a letter "b": its bowl is one arc of the true radius; its counter stays an exact circle', () => {
    const rings = letterB()
    const img = img1(rings)
    const { off, edges, on } = three(img)
    const bowl = arcs(on).filter((a) => Math.abs(a.r - 38) < 1)
    report(
      `ARCS letter b: arcs ${describeArcs(arcs(edges))} → ${describeArcs(arcs(on))}, max deviation ${deviation(off, rings).toFixed(3)}/${deviation(edges, rings).toFixed(3)} → ${deviation(on, rings).toFixed(3)}, ` +
        `nodes ${nodes(off)}/${nodes(edges)} → ${nodes(on)}, mean error ${fidelity(img, off).meanError.toFixed(3)}/${fidelity(img, edges).meanError.toFixed(3)} → ${fidelity(img, on).meanError.toFixed(3)}`,
    )
    expect(bowl.length).toBe(1)
    expect(Math.abs(bowl[0].r - 38)).toBeLessThan(0.5)
    expect(bowl[0].sweep).toBeGreaterThan(240)
    expect(arcs(on).filter((a) => Math.abs(a.r - 22) < 0.5 && a.sweep > 359).length).toBe(1)
    expect(deviation(on, rings)).toBeLessThan(deviation(edges, rings))
    expect(nodes(on)).toBeLessThanOrEqual(nodes(edges))
    expect(fidelity(img, on).meanError).toBeLessThanOrEqual(fidelity(img, edges).meanError)
  }, SLOW)
})

/** The letter "D": a straight stem and a half-elliptical bowl (55 × 48), with its counter. */
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

/** A ring sector: the letter "C" (outer and inner radius, opening in degrees, facing right). */
function letterC(cx: number, cy: number, R: number, r: number, open: number): Point[] {
  const a0 = (open / 2) * (Math.PI / 180)
  const pts: Point[] = []
  for (let i = 0; i <= 120; i++) pts.push([cx + R * Math.cos(a0 + (i / 120) * (2 * Math.PI - 2 * a0)), cy + R * Math.sin(a0 + (i / 120) * (2 * Math.PI - 2 * a0))])
  for (let i = 120; i >= 0; i--) pts.push([cx + r * Math.cos(a0 + (i / 120) * (2 * Math.PI - 2 * a0)), cy + r * Math.sin(a0 + (i / 120) * (2 * Math.PI - 2 * a0))])
  return pts
}

describe('other curves stay as they are', () => {
  it('a full circle is still an exact circle, unchanged', () => {
    const img = img1([circle(100, 70, 55)])
    const { off, edges, on } = three(img)
    expect(on).toBe(off)
    expect(on).toBe(edges)
  }, SLOW)

  const CURVES: Record<string, Point[][]> = {
    'half an ellipse (110 × 50)': [halfEllipse(60, 70, 110, 50)],
    'a letter "D" (elliptical bowl, 55 × 48)': letterD(),
    'a free-form blob': [blob()],
  }
  for (const [name, rings] of Object.entries(CURVES))
    it(`${name} gains no arcs`, () => {
      const img = img1(rings)
      const { off, edges, on } = three(img)
      report(`ARCS ${name}: arcs ${arcs(off).length}/${arcs(edges).length} → ${arcs(on).length}, nodes ${nodes(off)}/${nodes(edges)} → ${nodes(on)}`)
      expect(arcs(on).length).toBe(arcs(edges).length)
      expect(arcs(on).length).toBe(arcs(off).length)
      expect(on).toBe(edges)
    }, SLOW)
})

/** The fidelity fixtures (straight-edges.test.ts), and more lettering and rounded marks. */
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
  'letter D': () => img1(letterD()),
  'letter C': () => img1([letterC(100, 70, 58, 38, 70)]),
  'rounded rectangle, transparent': () => img1([roundedRect(30, 30, 170, 110, 12, (17 * Math.PI) / 180)], null),
  'mark like the Barron "B"': () =>
    paint(W, H, null, [
      { rings: [circle(100, 70, 62)], color: NAVY },
      { rings: [roundedRect(70, 30, 90, 110, 6), roundedRect(84, 30, 125, 66, 16), roundedRect(84, 74, 130, 110, 17)], color: WHITE },
    ]),
}

describe('fidelity and node count are no worse', () => {
  for (const [name, make] of Object.entries(FIXTURES))
    it(name, () => {
      const img = make()
      const { off, edges, on } = three(img)
      const alone = vectorize(img, arcsOnly).svg
      const f = { off: fidelity(img, off), edges: fidelity(img, edges), on: fidelity(img, on), alone: fidelity(img, alone) }
      report(
        `FIDELITY ${name}: mean error ${f.edges.meanError.toFixed(3)} → ${f.on.meanError.toFixed(3)} (no flags ${f.off.meanError.toFixed(3)} → ${f.alone.meanError.toFixed(3)}), ` +
          `edge recall ${f.edges.edgeRecall.toFixed(3)} → ${f.on.edgeRecall.toFixed(3)}, nodes ${nodes(edges)} → ${nodes(on)} (${nodes(off)} → ${nodes(alone)}), arcs ${arcs(edges).length} → ${arcs(on).length} ${describeArcs(arcs(on))}`,
      )
      expect(f.on.meanError).toBeLessThanOrEqual(f.edges.meanError + 0.005)
      expect(f.on.edgeRecall).toBeGreaterThanOrEqual(f.edges.edgeRecall - 0.002)
      expect(nodes(on)).toBeLessThanOrEqual(nodes(edges))
      // Exact arcs alone find the straight edges too (an arc ends where a line begins): the same
      // geometry as with both, so against no flags at all they differ by what straight edges do.
      expect(arcs(alone).length).toBe(arcs(on).length)
      expect(f.alone.meanError).toBeLessThanOrEqual(f.edges.meanError + 0.005)
    }, SLOW)
})

describe('print plates, cut files and one colour', () => {
  /** Failed and warned export checks (count per check) of a knockout SVG. */
  const problems = (svg: string, w: number) => {
    const checks = validateShapes(shapesFromSvg(svg), { width: w, outputWidthMm: 200, plates: true })
    return Object.fromEntries(checks.filter((c) => c.status !== 'ok').map((c) => [c.id, c.count]))
  }
  const cases: Record<string, () => ImageData> = {
    'rounded rectangle turned 17°': () => img1(ROUNDED['rounded rectangle turned 17°'].rings),
    'stroke with round caps': () => img1(ROUNDED['stroke with round caps, turned 11°'].rings),
    'letter b': () => img1(letterB()),
  }
  for (const [name, make] of Object.entries(cases))
    it(`${name}: no new export problems, no worse fidelity`, () => {
      const img = make()
      const knockout = (o: FlatOptions): FlatOptions => ({ ...o, trace: { ...o.trace, mode: 'knockout', spread: 0.15 } })
      const one = (o: FlatOptions): FlatOptions => ({ ...o, gradients: 'apply', oneColour: { ink: null, gapPx: 2, production: true, outputWidthMm: 200 } })
      for (const tweak of [knockout, one]) {
        const before = vectorize(img, (o) => edgesOnly(tweak(o))).svg
        const after = vectorize(img, (o) => both(tweak(o))).svg
        const p0 = problems(before, img.width)
        const p1 = problems(after, img.width)
        for (const [id, count] of Object.entries(p1)) expect(count).toBeLessThanOrEqual(p0[id] ?? 0)
        report(`PROD ${name} ${tweak === knockout ? 'knockout' : 'one colour'}: ${fidelity(img, before).meanError.toFixed(3)} → ${fidelity(img, after).meanError.toFixed(3)}`)
        // Plates are spread (0.15 px) so neighbouring inks overlap; an exact arc lies on the spread
        // outline where the free curve sat partly inside it, so the overlap, which counts as error
        // against the upload, can grow a little (as with straight edges, docs/straight-edges.md).
        expect(fidelity(img, after).meanError).toBeLessThanOrEqual(fidelity(img, before).meanError + (tweak === knockout ? 0.05 : 0.01))
      }
    }, SLOW)
})

describe('flag', () => {
  it('is off in production builds, whatever the address says', async () => {
    const { exactArcsOn } = await import('../../quality/flags')
    expect(exactArcsOn('?exact-arcs=on', { value: undefined, dev: false })).toBe(false)
    expect(exactArcsOn('?exact-arcs=on', { value: 'off', dev: false })).toBe(false)
    expect(exactArcsOn('?exact-arcs=on', { value: 'preview', dev: false })).toBe(true)
    expect(exactArcsOn('', { value: 'preview', dev: false })).toBe(false)
    expect(exactArcsOn('', { value: 'on', dev: false })).toBe(true)
  })

  it('off, the trace is exactly as before', () => {
    const img = img1(ROUNDED['rounded rectangle'].rings)
    expect(vectorize(img, (o) => ({ ...o, trace: { ...o.trace, exactArcs: false } })).svg).toBe(vectorize(img, ident).svg)
  }, SLOW)
})
