/**
 * Colour accuracy (behind the colour-accuracy flag), in the master artwork: thin lines and lettering
 * that the colour reduction gave their background's colour, or read pale from their edge blends,
 * get their own colour, but only where the traced result is closer to the upload with no new
 * crossings, fragments, rougher edges or extra anchors (linecolours.ts). Everywhere else the output
 * is exactly as without the flag. Off, nothing changes (golden.test.ts); print plates, cut files,
 * one colour, spot inks and line art never get the option (pipeline.ts).
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { deltaE2000, rgbToLab } from '../../palette/color'
import { masterOnly, type FlatOptions } from '../pipeline'
import { colourAccuracyOn } from '../../quality/flags'
import { area, circle, colourAt, installImageData, paint, rect, regularPolygon, selfIntersects, svgPaths, vectorize, type Point, type RGB, type SvgPath } from './fidelity/harness'

beforeAll(installImageData)

const SLOW = 120_000
/** The option the colour-accuracy flag sets for a full-colour master (pipeline.ts buildTraceJob). */
const accurate = (o: FlatOptions): FlatOptions => ({ ...o, quantize: { ...o.quantize, thinColours: true } })
const both = (img: ImageData) => ({ off: vectorize(img).svg, on: vectorize(img, accurate).svg })

const WHITE: RGB = [255, 255, 255]
const BLUE: RGB = [40, 70, 160]
const BAND: RGB = [240, 240, 235]
const ORANGE: RGB = [240, 120, 20]
const GREEN: RGB = [30, 140, 70]
const RED: RGB = [200, 30, 40]

const hex = (s: string): RGB => {
  const n = parseInt(s.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
const fills = (svg: string) => [...new Set(svgPaths(svg).map((p) => p.fill).filter((f) => f.startsWith('#')))]
/** The drawn colour nearest a true colour, and how far it is (CIEDE2000). */
function nearest(svg: string, truth: RGB) {
  return fills(svg)
    .map((f) => ({ f, de: deltaE2000(rgbToLab(truth), rgbToLab(hex(f))) }))
    .sort((a, b) => a.de - b.de)[0]
}
/** Overlap (intersection over union) of the shapes drawn in `fill` with the true shapes. */
function overlap(P: SvgPath[], fill: string, truth: Point[][], w: number, h: number) {
  let both = 0, either = 0
  const inTruth = (x: number, y: number) => truth.some((r) => {
    let c = false
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) if (r[i][1] > y !== r[j][1] > y && x < ((r[j][0] - r[i][0]) * (y - r[i][1])) / (r[j][1] - r[i][1]) + r[i][0]) c = !c
    return c
  })
  for (let y = 0.125; y < h; y += 0.25)
    for (let x = 0.125; x < w; x += 0.25) {
      const t = inTruth(x, y), d = colourAt(P, x, y) === fill
      if (t && d) both++
      if (t || d) either++
    }
  return either ? both / either : 0
}
const defects = (svg: string) => {
  const rings = svgPaths(svg).flatMap((p) => p.rings)
  return { crossing: rings.filter(selfIntersects).length, tiny: rings.filter((r) => !selfIntersects(r) && Math.abs(area(r)) < 4).length }
}
const strokes = (x0: number, y0: number, n: number, wd: number, len: number, gap: number) => Array.from({ length: n }, (_, k) => rect(x0 + k * gap, y0, x0 + k * gap + wd, y0 + len))
const hlines = (x0: number, y0: number, n: number, wd: number, len: number, gap: number) => Array.from({ length: n }, (_, k) => rect(x0, y0 + k * gap, x0 + len, y0 + k * gap + wd))

describe('thin lettering keeps its colour', () => {
  it('1.6 px lettering is drawn in its real colour, in one colour, no thinner', () => {
    const letters = [...strokes(10.3, 10.2, 10, 1.6, 14, 6), ...hlines(10.3, 10.2, 3, 1.6, 56, 6)]
    const img = paint(120, 50, WHITE, [{ rings: letters, color: ORANGE }])
    const { off, on } = both(img)
    expect(nearest(off, ORANGE).de).toBeGreaterThan(4) // read pale from its edges
    expect(nearest(on, ORANGE).de).toBeLessThan(1.5)
    expect(fills(on)).toHaveLength(2) // white and one orange: never lettering in two shades
    expect(overlap(svgPaths(on), nearest(on, ORANGE).f, letters, 120, 50)).toBeGreaterThanOrEqual(overlap(svgPaths(off), nearest(off, ORANGE).f, letters, 120, 50))
    expect(defects(on).crossing).toBeLessThanOrEqual(defects(off).crossing)
    expect(defects(on).tiny).toBeLessThanOrEqual(defects(off).tiny)
  }, SLOW)

  it('1.2 px strokes on a band are no worse (recovering them would add fragments, so they stay)', () => {
    // Their own colour would draw each stroke under 4 px²: production's self-crossing squiggles
    // swapped for fragments. The judge refuses that swap (as fine detail does), so the output is
    // production's. Recovering strokes this thin is tracing work, not colour.
    const lines = strokes(6, 31.5, 12, 1.2, 7, 8)
    const img = paint(110, 70, BLUE, [{ rings: [rect(0, 30, 110, 40)], color: BAND }, { rings: lines, color: GREEN }])
    const { off, on } = both(img)
    expect(defects(on).crossing).toBeLessThanOrEqual(defects(off).crossing)
    expect(defects(on).tiny).toBeLessThanOrEqual(defects(off).tiny)
    expect(overlap(svgPaths(on), nearest(on, GREEN).f, lines, 110, 70)).toBeGreaterThanOrEqual(overlap(svgPaths(off), nearest(off, GREEN).f, lines, 110, 70))
  }, SLOW)
})

describe('no extra colours, artefacts or new defects', () => {
  it('small dots keep their soft edges: their anti-aliased ring is not a colour', () => {
    const img = paint(100, 40, WHITE, [{ rings: Array.from({ length: 10 }, (_, k) => circle(8 + k * 9, 20, 1.5)), color: RED }])
    const { off, on } = both(img)
    expect(on).toBe(off)
  }, SLOW)

  it('artwork without thin lines is byte-identical', () => {
    const img = paint(120, 90, null, [{ rings: [rect(10, 10, 70, 80)], color: BLUE }, { rings: [circle(90, 45, 20)], color: GREEN }, { rings: [regularPolygon(40, 45, 12, 6)], color: WHITE }])
    const { off, on } = both(img)
    expect(on).toBe(off)
  }, SLOW)

  it('noisy, compressed-looking strokes add nothing that traces worse', () => {
    const lines = strokes(6, 31.5, 12, 1.2, 7, 8)
    const img = paint(110, 70, BLUE, [{ rings: [rect(0, 30, 110, 40)], color: BAND }, { rings: lines, color: GREEN }], 6)
    const { off, on } = both(img)
    expect(defects(on).crossing).toBeLessThanOrEqual(defects(off).crossing)
    expect(defects(on).tiny).toBeLessThanOrEqual(defects(off).tiny)
    expect(fills(on).length).toBeLessThanOrEqual(fills(off).length + 1)
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
    expect(vectorize(img, accurate).svg).toMatch(/linearGradient/)
  }, SLOW)
})

describe('where it applies', () => {
  it('the master only: never print plates or cut files, one colour, spot inks or line art', () => {
    const job = { oneColour: false, spotInks: false, lineArt: false }
    expect(masterOnly({ colourAccuracy: true }, job).colours).toBe(true)
    expect(masterOnly({ colourAccuracy: true, knockout: true }, job).colours).toBe(false)
    expect(masterOnly({ colourAccuracy: true }, { ...job, oneColour: true }).colours).toBe(false)
    expect(masterOnly({ colourAccuracy: true }, { ...job, spotInks: true }).colours).toBe(false)
    expect(masterOnly({ colourAccuracy: true }, { ...job, lineArt: true }).colours).toBe(false)
    expect(masterOnly({}, job).colours).toBe(false)
  })
  it('is off in production builds, whatever the address says', () => {
    expect(colourAccuracyOn('?colour-accuracy=on', { value: undefined, dev: false })).toBe(false)
    expect(colourAccuracyOn('?colour-accuracy=on', { value: 'off', dev: false })).toBe(false)
    expect(colourAccuracyOn('?colour-accuracy=on', { value: 'preview', dev: false })).toBe(true)
    expect(colourAccuracyOn('', { value: 'on', dev: false })).toBe(true)
  })
})
