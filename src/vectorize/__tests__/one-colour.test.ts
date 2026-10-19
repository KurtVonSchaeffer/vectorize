import { beforeAll, describe, expect, it } from 'vitest'
import type { LabelMap } from '../../trace'
import { shapesFromSvg } from '../../export/path'
import { validateShapes } from '../../export/validate'
import { toOneColour, undoGaps } from '../one-colour'
import { runFlat, type FlatOptions } from '../pipeline'

const BLACK = 0x000000
const WHITE = 0xffffff

/** A w×h map of label 0 (the background), painted by `paint` (x, y → label). */
function map(w: number, h: number, colors: number[], paint: (x: number, y: number) => number): LabelMap {
  const labels = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) labels[y * w + x] = paint(x, y)
  return { w, h, labels, second: new Uint8Array(w * h).fill(255), cov: new Float32Array(w * h).fill(1), colors }
}
const inBox = (x: number, y: number, x0: number, y0: number, x1: number, y1: number) => x >= x0 && x < x1 && y >= y0 && y < y1
/** Pixels of `m` drawn in ink (mostly), per label. */
const inkPixels = (m: LabelMap) => {
  let n = 0
  for (let p = 0; p < m.w * m.h; p++) if (m.labels[p] < 254 && m.colors[m.labels[p]] === BLACK && m.cov[p] >= 0.5) n++
  return n
}

describe('toOneColour', () => {
  it('draws the artwork in the ink and keeps the background, never an empty result', () => {
    const m = map(40, 40, [WHITE, 0xe2231a], (x, y) => (inBox(x, y, 10, 10, 30, 30) ? 1 : 0))
    const r = toOneColour(m, 0, { ink: BLACK, gapPx: 0 })
    expect(r.map.colors).toEqual([WHITE, BLACK])
    expect(r.ink).toEqual([1])
    expect(inkPixels(r.map)).toBe(400)
  })

  it('keeps negative space open: a white star on a teal badge stays paper', () => {
    const m = map(40, 40, [WHITE, 0x0f8a7e, WHITE], (x, y) => (inBox(x, y, 16, 16, 24, 24) ? 2 : inBox(x, y, 8, 8, 32, 32) ? 1 : 0))
    const r = toOneColour(m, 0, { ink: BLACK, gapPx: 0 })
    expect(r.paper).toEqual([2])
    expect(r.map.colors[2]).toBe(-1)
    expect(inkPixels(r.map)).toBe(24 * 24 - 8 * 8)
  })

  it('still draws artwork that is all close to the paper colour', () => {
    const m = map(40, 40, [WHITE, 0xf4f4f4], (x, y) => (inBox(x, y, 10, 10, 30, 30) ? 1 : 0))
    expect(toOneColour(m, 0, { ink: BLACK, gapPx: 0 }).ink).toEqual([1])
  })

  it('keeps each former colour as its own region in the master (no gap)', () => {
    const m = map(60, 40, [WHITE, 0x3a86ff, 0xffbe0b], (x, y) => (inBox(x, y, 10, 10, 30, 30) ? 1 : inBox(x, y, 30, 10, 50, 30) ? 2 : 0))
    const r = toOneColour(m, 0, { ink: BLACK, gapPx: 0 })
    expect(r.map.labels).toEqual(m.labels)
    expect(r.gaps).toBe(0)
    expect(inkPixels(r.map)).toBe(800)
  })

  it('cuts a gap of the chosen width along the boundary between former colours', () => {
    const m = map(60, 40, [WHITE, 0x3a86ff, 0xffbe0b], (x, y) => (inBox(x, y, 10, 10, 30, 30) ? 1 : inBox(x, y, 30, 10, 50, 30) ? 2 : 0))
    const r = toOneColour(m, 0, { ink: BLACK, gapPx: 4 })
    expect(r.gaps).toBe(1)
    // 4 px gap: 2 px each side of x = 30, across the 20 px tall boundary.
    expect(800 - inkPixels(r.map)).toBe(80)
    for (let y = 10; y < 30; y++) for (const x of [28, 29, 30, 31]) expect(r.map.labels[y * 60 + x]).toBe(0)
    // Outer edges are untouched.
    expect(r.map.labels[20 * 60 + 10]).toBe(1)
  })

  it('cuts a sub-pixel gap as partial coverage', () => {
    const m = map(60, 40, [WHITE, 0x3a86ff, 0xffbe0b], (x, y) => (inBox(x, y, 10, 10, 30, 30) ? 1 : inBox(x, y, 30, 10, 50, 30) ? 2 : 0))
    const r = toOneColour(m, 0, { ink: BLACK, gapPx: 0.5 })
    const p = 20 * 60 + 29
    expect(r.map.labels[p]).toBe(1)
    expect(r.map.cov[p]).toBeCloseTo(0.75)
  })

  it('print / cut file: a gap under 1.5 px is widened to 1.5 px, so it clears whole pixels', () => {
    const m = map(60, 40, [WHITE, 0x3a86ff, 0xffbe0b], (x, y) => (inBox(x, y, 10, 10, 30, 30) ? 1 : inBox(x, y, 30, 10, 50, 30) ? 2 : 0))
    const r = toOneColour(m, 0, { ink: BLACK, gapPx: 0.5, production: true })
    // Both pixels along the boundary are mostly paper: the two sides no longer touch through ink.
    for (const x of [29, 30]) expect(r.map.labels[20 * 60 + x]).toBe(0)
    // The master's gap (none) and a non-production sub-pixel gap are unchanged.
    expect(toOneColour(m, 0, { ink: BLACK, gapPx: 0.5 }).map.labels[20 * 60 + 29]).toBe(1)
  })

  it('never cuts into a thin detail or its neighbour: the boundary stays joined and is flagged', () => {
    // A 3 px stripe (detail) between two wide regions; a 4 px gap would eat it.
    const m = map(60, 40, [WHITE, 0x3a86ff, 0xe63946, 0xffbe0b], (x, y) =>
      inBox(x, y, 10, 10, 30, 30) ? 1 : inBox(x, y, 30, 10, 33, 30) ? 2 : inBox(x, y, 33, 10, 53, 30) ? 3 : 0,
    )
    const r = toOneColour(m, 0, { ink: BLACK, gapPx: 4 })
    expect(r.map.labels).toEqual(m.labels)
    expect(r.gaps).toBe(0)
    expect(r.flags.map((f) => f.reason)).toEqual(['gap-skipped', 'gap-skipped'])
  })

  it('skips the gap between two thin details, and flags it', () => {
    const m = map(40, 40, [WHITE, 0x3a86ff, 0xffbe0b], (x, y) => (inBox(x, y, 10, 5, 13, 35) ? 1 : inBox(x, y, 13, 5, 16, 35) ? 2 : 0))
    const r = toOneColour(m, 0, { ink: BLACK, gapPx: 4 })
    expect(r.map.labels).toEqual(m.labels)
    expect(r.flags.map((f) => f.reason)).toEqual(['gap-skipped'])
  })

  it('judges thinness per piece: a thin stroke of a colour also used for a big shape is kept', () => {
    // Label 1 is a big block on the left and also half of a thin two-colour letter stroke on the right.
    const m = map(80, 40, [WHITE, 0x120f10, 0xa14399], (x, y) => (inBox(x, y, 5, 5, 35, 35) ? 1 : inBox(x, y, 50, 5, 52, 35) ? 1 : inBox(x, y, 52, 5, 54, 35) ? 2 : 0))
    const r = toOneColour(m, 0, { ink: BLACK, gapPx: 2 })
    for (let y = 5; y < 35; y++) for (const x of [50, 51, 52, 53]) expect(r.map.labels[y * 80 + x]).toBe(m.labels[y * 80 + x])
    expect(r.flags.map((f) => f.reason)).toEqual(['gap-skipped'])
  })

  it('print / cut file: touching ink is one piece, separate pieces keep their own label', () => {
    // Labels 1 and 2 touch (one piece); label 3 is a separate shape.
    const m = map(80, 40, [WHITE, 0x3a86ff, 0xffbe0b, 0xe63946], (x, y) => (inBox(x, y, 5, 5, 20, 35) ? 1 : inBox(x, y, 20, 5, 25, 35) ? 2 : inBox(x, y, 40, 5, 60, 35) ? 3 : 0))
    const r = toOneColour(m, 0, { ink: BLACK, gapPx: 0, production: true })
    const at = (x: number, y: number) => r.map.labels[y * 80 + x]
    expect(at(10, 10)).toBe(at(22, 10))
    expect(at(50, 10)).toBe(3)
    // The master keeps every former colour.
    expect(toOneColour(m, 0, { ink: BLACK, gapPx: 0 }).map.labels).toEqual(m.labels)
  })

  it('print / cut file: a 1 px stroke whose ink is the smaller share of its pixels stays with its piece', () => {
    // A block of label 1 with a faint stroke of label 2 off its edge (paper pixels, 40% label 2);
    // label 2 is also a block of its own elsewhere.
    const m = map(40, 40, [WHITE, 0x3a86ff, 0xffbe0b], (x, y) => (inBox(x, y, 5, 5, 20, 35) ? 1 : inBox(x, y, 30, 5, 35, 35) ? 2 : 0))
    for (let y = 5; y < 35; y++) [m.second[y * 40 + 20], m.cov[y * 40 + 20]] = [2, 0.6]
    const r = toOneColour(m, 0, { ink: BLACK, gapPx: 0, production: true })
    for (let y = 5; y < 35; y++) expect(r.map.second[y * 40 + 20]).toBe(r.map.labels[y * 40 + 19])
  })

  it('undoes the gap in a given area only', () => {
    const m = map(60, 40, [WHITE, 0x3a86ff, 0xffbe0b], (x, y) => (inBox(x, y, 10, 10, 30, 30) ? 1 : inBox(x, y, 30, 10, 50, 30) ? 2 : 0))
    const r = toOneColour(m, 0, { ink: BLACK, gapPx: 4, production: true })
    const back = undoGaps(r.undo!, [[28, 10, 32, 15]], 0).map
    // Rows 10–15 are joined again; rows below keep the gap.
    expect(back.labels[12 * 60 + 29]).not.toBe(0)
    expect(back.labels[20 * 60 + 29]).toBe(0)
  })

  it('a hairline sliver of a third colour along a gapped boundary becomes part of the gap, flagged', () => {
    // Blue | 1 px yellow sliver | green, the sliver running the whole boundary (anti-aliasing).
    const m = map(60, 40, [WHITE, 0x3a86ff, 0xffbe0b, 0x2d6a4f], (x, y) => (inBox(x, y, 10, 10, 30, 30) ? 1 : inBox(x, y, 30, 10, 31, 30) ? 2 : inBox(x, y, 31, 10, 51, 30) ? 3 : 0))
    const r = toOneColour(m, 0, { ink: BLACK, gapPx: 2 })
    for (let y = 10; y < 30; y++) expect([29, 30, 31].map((x) => r.map.labels[y * 60 + x])).toEqual([0, 0, 0])
    expect(r.flags.map((f) => f.reason)).toEqual(['gap-sliver'])
  })

  it('ignores a few pixels of contact (noise, not a boundary)', () => {
    const m = map(60, 40, [WHITE, 0x3a86ff, 0xffbe0b], (x, y) => (inBox(x, y, 10, 10, 30, 30) ? 1 : inBox(x, y, 30, 28, 50, 38) ? 2 : 0))
    const r = toOneColour(m, 0, { ink: BLACK, gapPx: 2 })
    expect(r.gaps).toBe(0)
  })
})

class FakeImageData {
  constructor(
    public data: Uint8ClampedArray,
    public width: number,
    public height: number,
  ) {}
}
beforeAll(() => {
  ;(globalThis as unknown as { ImageData: unknown }).ImageData = FakeImageData
})
type RGBA = [number, number, number, number]
function image(w: number, h: number, paint: (x: number, y: number) => RGBA): ImageData {
  const d = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d.set(paint(x, y), (y * w + x) * 4)
  return new FakeImageData(d, w, h) as unknown as ImageData
}
const cover = (x: number, y: number, cx: number, cy: number, r: number) => Math.max(0, Math.min(1, r + 0.5 - Math.hypot(x + 0.5 - cx, y + 0.5 - cy)))
const mix = (a: number[], b: number[], t: number): RGBA => [...a.map((v, i) => Math.round(v + (b[i] - v) * t)), 255] as RGBA
const CREAM = [255, 248, 231], NAVY = [43, 45, 66], ORANGE = [240, 140, 0], PINK = [236, 72, 153], PURPLE = [88, 28, 135]

describe('runFlat in one colour', () => {
  const opts = (gapPx: number, patch: Partial<FlatOptions> = {}): FlatOptions => ({
    lineArt: false,
    removeColors: [],
    transparent: false,
    quantize: { maxColors: 12, mergeDelta: 10, whiteIsPaper: false, palette: null, overrides: {}, minArea: 9, upscale: 1, smoothing: 0 },
    trace: { smoothing: 0.8, minArea: 9, error: 0.5, cornerAngle: 60, precision: 2, mode: gapPx ? 'knockout' : 'stacked' },
    oneColour: { ink: BLACK, gapPx },
    ...patch,
  })
  // A navy disc with an orange centre on cream.
  const logo = () => image(240, 160, (x, y) => mix(mix(CREAM, NAVY, cover(x, y, 120, 80, 60)).slice(0, 3), ORANGE, cover(x, y, 120, 80, 25)))

  it('master: one ink, both former colours kept as shapes, background kept', () => {
    const r = runFlat(logo(), opts(0))
    expect(r.palette.map((p) => p.color).filter((c) => c !== r.background)).toEqual([BLACK])
    expect(r.oneColour).toMatchObject({ inkRegions: 2, gaps: 0 })
    expect((r.svg.match(/fill="#000000"/g) ?? []).length).toBeGreaterThanOrEqual(1)
  })

  it('production: a gap rings the former orange centre', () => {
    let m: LabelMap | null = null
    const r = runFlat(logo(), opts(4), (x) => (m = x))
    expect(r.oneColour?.gaps).toBe(1)
    // On the old navy / orange boundary (r = 25) there is paper; well inside each side, ink.
    const at = (x: number, y: number) => m!.colors[m!.labels[y * 240 + x]] ?? -1
    expect(at(120 + 25, 80)).not.toBe(BLACK)
    expect(at(120 + 10, 80)).toBe(BLACK)
    expect(at(120 + 45, 80)).toBe(BLACK)
  })

  it('print / cut file: a gap never leaves a piece the export checker rejects', () => {
    // Thin stripes of other colours across a block: at this size a 0.5 mm gap is under a pixel,
    // so traced gaps pinch into hairline slits. Those are undone and flagged.
    const R = [179, 18, 46], Y = [245, 197, 24]
    const img = image(150, 150, (x, y) => (x >= 25 && x < 125 && y >= 25 && y < 125 ? (y >= 50 && y < 52 ? [...Y, 255] : [...R, 255]) : [255, 255, 255, 255]) as RGBA)
    const o = (gapPx: number) => ({ ...opts(gapPx), oneColour: { ink: BLACK, gapPx, production: true, outputWidthMm: 200 }, trace: { ...opts(gapPx).trace, mode: 'knockout' as const, spread: 0 } })
    const problems = (svg: string) => validateShapes(shapesFromSvg(svg), { width: 150, outputWidthMm: 200 }).filter((k) => ['open', 'zero-area', 'self-intersection', 'sliver', 'small'].includes(k.id) && k.status !== 'ok')
    const off = runFlat(img, o(0)), on = runFlat(img, o(0.375))
    expect(problems(on.svg).length).toBeLessThanOrEqual(problems(off.svg).length)
    expect(problems(on.svg)).toEqual([])
  })

  // Print / cut file options for the disc logo: 240 px traced at 200 mm wide.
  const cutOpts = (gapPx: number): FlatOptions => ({
    ...opts(gapPx),
    oneColour: { ink: BLACK, gapPx, production: true, outputWidthMm: 200 },
    trace: { ...opts(gapPx).trace, mode: 'knockout', spread: 0 },
  })
  const inkPieces = (svg: string) => shapesFromSvg(svg).filter((s) => s.color === BLACK).length

  it('print / cut file: a sub-pixel gap still cuts the centre free of the ring', () => {
    // 0.5 mm at this size is 0.6 px: before the 1.5 px minimum, the ink stayed one piece joined by bridges.
    expect(inkPieces(runFlat(logo(), cutOpts(0)).svg)).toBe(1)
    for (const gapPx of [0.5, 0.75, 1.25, 1.5, 4]) {
      const r = runFlat(logo(), cutOpts(gapPx))
      expect(r.oneColour?.gaps).toBe(1)
      expect(inkPieces(r.svg)).toBe(2)
      // The gap reported is the one cut (at 200 mm over 240 px), so a widened gap isn't hidden.
      expect(r.oneColour?.gapMm).toBeCloseTo((Math.max(1.5, gapPx) * 200) / 240, 5)
    }
  })

  it('print / cut file: the gap never adds cutting problems, and each undone place is flagged once', () => {
    const R = [179, 18, 46], Y = [245, 197, 24]
    // Thin stripes and a stripe one gap wide: places where gaps leave pieces the checker rejects.
    const img = image(150, 150, (x, y) => (x >= 25 && x < 125 && y >= 25 && y < 125 ? ((y >= 50 && y < 52) || (y >= 80 && y < 83) || (x >= 90 && x < 92) ? [...Y, 255] : [...R, 255]) : [255, 255, 255, 255]) as RGBA)
    const o = (gapPx: number): FlatOptions => ({ ...opts(gapPx), oneColour: { ink: BLACK, gapPx, production: true, outputWidthMm: 200 }, trace: { ...opts(gapPx).trace, mode: 'knockout', spread: 0 } })
    const problems = (svg: string) => validateShapes(shapesFromSvg(svg), { width: 150, outputWidthMm: 200 }).filter((k) => ['open', 'zero-area', 'self-intersection', 'sliver', 'small'].includes(k.id) && k.status !== 'ok')
    const off = problems(runFlat(img, o(0)).svg).length
    for (const gapPx of [0.375, 1.5, 3]) {
      const r = runFlat(img, o(gapPx))
      expect(problems(r.svg).length).toBeLessThanOrEqual(off)
      const places = r.oneColour!.flags.filter((f) => f.reason === 'cut-limit').map((f) => `${f.x},${f.y}`)
      expect(new Set(places).size).toBe(places.length)
    }
  })

  it('a gradient is one region: no gaps inside it', () => {
    const pill = () =>
      image(300, 160, (x, y) => {
        const inPill = Math.max(cover(x, y, 80, 80, 50), cover(x, y, 220, 80, 50), x >= 80 && x < 220 && Math.abs(y + 0.5 - 80) < 50 ? 1 : 0)
        return mix(mix(CREAM, mix(PINK, PURPLE, (x - 30) / 240).slice(0, 3), inPill).slice(0, 3), NAVY, cover(x, y, 150, 80, 28))
      })
    const r = runFlat(pill(), opts(3, { gradients: 'apply' }))
    expect(r.gradients.kept).toBe(1)
    // Only the gradient / navy disc boundary gets a gap.
    expect(r.oneColour?.gaps).toBe(1)
    expect(r.svg).not.toMatch(/Gradient/)
  })
})
