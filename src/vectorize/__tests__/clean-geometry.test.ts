/**
 * Clean geometry (behind the clean-geometry flag): in stacked output no shape is drawn twice, and
 * nothing else changes: holes, overlapping colours, shared boundaries, lettering and gradients
 * render as before, without gaps, seams or new transparency. Off, nothing changes (golden.test.ts).
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { runFlat, type FlatOptions } from '../pipeline'
import { circle, colourAt, duplicateRings, installImageData, paint, rect, renderSvg, svgPaths, vectorize, type RGB } from './fidelity/harness'

beforeAll(installImageData)

const SLOW = 120_000
const clean = (o: FlatOptions): FlatOptions => ({ ...o, trace: { ...o.trace, connectedStacking: true } })
const both = (img: ImageData) => ({ before: vectorize(img).svg, after: vectorize(img, clean).svg })

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

/** Pixels opaque in the upload that the vector leaves see-through (a gap or a lost shape). */
function opened(img: ImageData, svg: string) {
  const r = renderSvg(svg, img.width, img.height)
  let n = 0
  for (let i = 3; i < r.data.length; i += 4) if (img.data[i] > 250 && r.data[i] < 200) n++
  return n
}

/** Each case keeps every colour, adds no transparency, and is no further from the upload. */
function same(img: ImageData, before: string, after: string) {
  expect(opened(img, after)).toBe(opened(img, before))
  expect(error(img, after)).toBeLessThanOrEqual(error(img, before) + 0.05)
  const fills = (svg: string) => [...new Set(svgPaths(svg).map((p) => p.fill))].sort()
  expect(fills(after)).toEqual(fills(before))
}

type Pt = [number, number]
const inside = ([x, y]: Pt, r: Pt[]) => {
  let c = false
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) if (r[i][1] > y !== r[j][1] > y && x < ((r[j][0] - r[i][0]) * (y - r[i][1])) / (r[j][1] - r[i][1]) + r[i][0]) c = !c
  return c
}
/**
 * Filled outlines drawn twice: as duplicateRings, but without holes (a ring inside an odd number of
 * its own path's rings). Two layers with a hole in the same place share an edge and draw nothing twice.
 */
function filledCopies(svg: string) {
  const paths = svgPaths(svg)
  const filled = paths.map((p) => ({ ...p, rings: p.rings.filter((r) => p.rings.filter((o) => o !== r && inside(r[0] as Pt, o as Pt[])).length % 2 === 0) }))
  return duplicateRings(filled)
}

const LIGHT: RGB = [2, 157, 236]
const DARK: RGB = [1, 108, 165]
const WHITE: RGB = [255, 255, 255]
const GREEN: RGB = [0, 156, 59]
const BLUE: RGB = [40, 70, 160]

describe('no shape drawn twice', () => {
  it('separate lettering is not copied under the larger shape (RC8, Docker)', () => {
    const img = paint(120, 120, null, [
      { rings: [circle(60, 40, 30)], color: LIGHT },
      { rings: [rect(20, 85, 28, 105), rect(35, 85, 43, 105)], color: DARK },
      { rings: [circle(65, 95, 9), circle(65, 95, 5, true)], color: DARK },
    ])
    const { before, after } = both(img)
    expect(filledCopies(before).length).toBeGreaterThan(0)
    expect(filledCopies(after)).toEqual([])
    same(img, before, after)
    expect(colourAt(svgPaths(after), 24, 95)).toBe(colourAt(svgPaths(before), 24, 95))
    expect(colourAt(svgPaths(after), 65, 95)).toBeNull() // the "o"'s counter is still a hole
  }, SLOW)

  it('a counter inside a letter is not copied under the layers around it (flag lettering)', () => {
    // Brazil's motto: green letters with white counters on a white band across a blue disc, on a
    // green field. Green is the largest colour (the bottom layer), so the letters are holes in the
    // layers above and their counters islands, which those layers used to draw again.
    const img = paint(160, 100, GREEN, [
      { rings: [circle(75, 50, 48)], color: BLUE },
      { rings: [rect(25, 38, 125, 62)], color: WHITE },
      { rings: [circle(40, 50, 9), circle(40, 50, 5, true)], color: GREEN },
      { rings: [circle(70, 50, 9), circle(70, 50, 5, true)], color: GREEN },
      { rings: [rect(95, 41, 99, 59), rect(99, 41, 108, 45), rect(99, 55, 108, 59), rect(105, 45, 109, 55)], color: GREEN },
    ])
    const { before, after } = both(img)
    expect(filledCopies(before).length).toBeGreaterThan(0)
    expect(filledCopies(after)).toEqual([])
    same(img, before, after)
    for (const [x, y] of [[40, 50], [70, 50], [101, 50]]) expect(colourAt(svgPaths(after), x, y)).toBe('#FFFFFF')
    for (const [x, y] of [[33, 50], [70, 42]]) expect(colourAt(svgPaths(after), x, y)).toBe(colourAt(svgPaths(before), x, y))
  }, SLOW)
})

describe('holes, overlapping colours and shared boundaries', () => {
  it('rings keep their holes, on transparency and over another colour', () => {
    const img = paint(140, 100, null, [
      { rings: [circle(35, 50, 30), circle(35, 50, 15, true)], color: DARK },
      { rings: [rect(75, 15, 135, 85)], color: LIGHT },
      { rings: [circle(105, 50, 25), circle(105, 50, 12, true)], color: GREEN },
    ])
    const { before, after } = both(img)
    same(img, before, after)
    const P = svgPaths(after)
    expect(colourAt(P, 35, 50)).toBeNull() // hole onto transparency
    expect(colourAt(P, 105, 50)).toBe(colourAt(svgPaths(before), 105, 50)) // hole shows the block below
    expect(colourAt(P, 105, 50)).not.toBeNull()
  }, SLOW)

  it('touching colours keep their underlay: no seam opens along a shared boundary', () => {
    const img = paint(120, 80, null, [
      { rings: [rect(10, 10, 60, 70)], color: BLUE },
      { rings: [rect(60, 10, 110, 70)], color: GREEN },
      { rings: [circle(60, 40, 12)], color: WHITE },
    ])
    const { before, after } = both(img)
    same(img, before, after)
    const r = renderSvg(after, 120, 80)
    // Along the shared edge x = 60 (away from the disc), the vector stays opaque.
    for (const y of [14, 20, 60, 66]) expect(r.data[(y * 120 + 60) * 4 + 3]).toBeGreaterThanOrEqual(250)
  }, SLOW)

  it('a shape that touches nothing of the layer below is drawn once, in its own colour', () => {
    const img = paint(120, 60, null, [
      { rings: [rect(5, 5, 70, 55)], color: LIGHT },
      { rings: [circle(95, 30, 15)], color: DARK },
    ])
    const { before, after } = both(img)
    same(img, before, after)
    expect(svgPaths(after).filter((p) => colourAt([p], 95, 30))).toHaveLength(1)
  }, SLOW)
})

describe('lettering and gradients unchanged', () => {
  it('a single gradient stays one gradient fill', () => {
    const img = paint(120, 80, null, [{ rings: [rect(10, 10, 110, 70)], color: BLUE }])
    for (let y = 10; y < 70; y++)
      for (let x = 10; x < 110; x++) {
        const i = (y * 120 + x) * 4
        const t = (x - 10) / 100
        img.data[i] = 40 + t * 180
        img.data[i + 1] = 70 + t * 100
        img.data[i + 2] = 160 - t * 100
      }
    const { before, after } = both(img)
    expect(after).toBe(before)
  }, SLOW)

  it('letters rebuilt from a font stay, with the traced punctuation beside them', () => {
    // A navy "I" and full stop on cream; the "I" is rebuilt from a font outline (as pipeline.test.ts).
    const NAVY: RGB = [43, 45, 66]
    const img = paint(120, 60, [255, 248, 231], [{ rings: [rect(20, 10, 30, 50), rect(38, 45, 43, 50)], color: NAVY }])
    const coverage = new Uint8Array(120 * 60)
    for (let y = 10; y < 50; y++) for (let x = 20; x < 30; x++) coverage[y * 120 + x] = 255
    const text: FlatOptions['text'] = { words: [{ text: 'I.', font: 'Test Sans', letters: [{ char: 'I', d: 'M20 10L30 10L30 50L20 50Z' }], box: [20, 10, 43, 50] }], coverage }
    const o: FlatOptions = {
      lineArt: false, removeColors: [], transparent: false, text,
      quantize: { maxColors: 12, mergeDelta: 10, whiteIsPaper: false, palette: null, overrides: {}, minArea: 9, upscale: 1, smoothing: 0 },
      trace: { smoothing: 0.8, minArea: 9, error: 0.5, cornerAngle: 60, precision: 2 },
    }
    const before = runFlat(img, o)
    const after = runFlat(img, clean(o))
    expect(after.lettered).toBe(1)
    expect(after.svg).toMatch(/<path id="Text_I_1_I" d="M20 10L30 10L30 50L20 50Z"/)
    expect(colourAt(svgPaths(after.svg), 40, 47)).toBe(colourAt(svgPaths(before.svg), 40, 47)) // the full stop
    expect(colourAt(svgPaths(after.svg), 25, 30)).toBe('#2B2D42')
    same(img, before.svg, after.svg)
  }, SLOW)

  it('a gradient beside flat colours keeps its gradient fill and its look', () => {
    const img = paint(140, 80, null, [{ rings: [rect(10, 10, 80, 70)], color: BLUE }, { rings: [circle(110, 40, 20)], color: DARK }])
    for (let y = 10; y < 70; y++)
      for (let x = 10; x < 80; x++) {
        const i = (y * 140 + x) * 4
        const t = (x - 10) / 70
        img.data[i] = 40 + t * 180
        img.data[i + 1] = 70 + t * 100
        img.data[i + 2] = 160 - t * 100
      }
    const { before, after } = both(img)
    expect(before).toMatch(/linearGradient/)
    expect(after).toMatch(/linearGradient/)
    same(img, before, after)
  }, SLOW)

  it('shapes without separate stacked parts are byte-identical', () => {
    const img = paint(100, 100, null, [{ rings: [circle(50, 50, 40), circle(50, 50, 20, true)], color: BLUE }])
    const { before, after } = both(img)
    expect(after).toBe(before)
  }, SLOW)
})
