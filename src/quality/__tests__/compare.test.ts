import { describe, expect, it } from 'vitest'
import { colourFidelity, compareRasters } from '../compare'

type RGBA = [number, number, number, number]
const W = 32
const H = 24

function draw(px: (x: number, y: number) => RGBA, w = W, h = H): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d.set(px(x, y), (y * w + x) * 4)
  return d
}

const WHITE: RGBA = [255, 255, 255, 255]
const NAVY: RGBA = [20, 30, 90, 255]
/** A navy square on white; `shift` moves it right. */
const square = (shift = 0, inset = 0): Uint8ClampedArray => draw((x, y) => (x >= 8 + shift + inset && x < 20 + shift - inset && y >= 6 + inset && y < 18 - inset ? NAVY : WHITE))

describe('compareRasters', () => {
  it('scores identical images as identical', () => {
    const a = square()
    const r = compareRasters(a, a.slice(), W, H)
    expect(r).toMatchObject({ meanError: 0, rmse: 0, wrongShare: 0, tolerantWrongShare: 0, alphaError: 0, alphaFlips: 0, edgePrecision: 1, edgeRecall: 1, edgeF1: 1, missingDetails: [], artefacts: [] })
  })

  it('measures colour differences', () => {
    const r = compareRasters(draw(() => [0, 0, 0, 255]), draw(() => [255, 255, 255, 255]), W, H)
    expect(r.meanError).toBe(255)
    expect(r.rmse).toBe(255)
    expect(r.wrongShare).toBe(1)
    // A slight colour shift is measured but not "wrong".
    const s = compareRasters(square(), draw((x, y) => (x >= 8 && x < 20 && y >= 6 && y < 18 ? [26, 36, 96, 255] : WHITE)), W, H)
    expect(s.meanError).toBeCloseTo((6 * 144) / (W * H), 5)
    expect(s.wrongShare).toBe(0)
  })

  it('ignores the colour of invisible pixels but catches transparency changes', () => {
    const clearRed = draw(() => [255, 0, 0, 0])
    const clearBlue = draw(() => [0, 0, 255, 0])
    expect(compareRasters(clearRed, clearBlue, W, H)).toMatchObject({ meanError: 0, alphaError: 0, alphaFlips: 0 })

    // White ink where the original was transparent looks the same over white, but alpha differs.
    const r = compareRasters(clearRed, draw(() => WHITE), W, H)
    expect(r.meanError).toBe(0)
    expect(r.alphaError).toBe(255)
    expect(r.alphaFlips).toBe(1)
    // Over a dark background, the same difference becomes visible.
    expect(compareRasters(clearRed, draw(() => WHITE), W, H, { background: 0x000000 }).meanError).toBe(255)
  })

  it('rejects invalid dimensions and options', () => {
    const a = square()
    expect(() => compareRasters(a, a, W + 1, H)).toThrow(RangeError)
    expect(() => compareRasters(a, a.subarray(4), W, H)).toThrow(RangeError)
    for (const [w, h] of [[0, 1], [-2, 3], [1.5, 2], [Number.NaN, 2]]) expect(() => compareRasters(new Uint8ClampedArray(0), new Uint8ClampedArray(0), w, h)).toThrow(RangeError)
    expect(() => compareRasters(a, a, W, H, { tolerance: -1 })).toThrow(RangeError)
    expect(() => compareRasters(a, a, W, H, { tolerance: 0.5 })).toThrow(RangeError)
    expect(() => compareRasters(a, a, W, H, { wrongThreshold: Number.NaN })).toThrow(RangeError)
  })

  it('forgives small edge shifts within the tolerance, and only within it', () => {
    const shifted = compareRasters(square(), square(1), W, H)
    expect(shifted.wrongShare).toBeGreaterThan(0)
    expect(shifted.tolerantWrongShare).toBe(0)
    expect(shifted.edgeF1).toBe(1)
    expect(shifted.missingDetails).toEqual([])

    const strict = compareRasters(square(), square(1), W, H, { tolerance: 0 })
    expect(strict.tolerantWrongShare).toBeGreaterThan(0)
    expect(strict.edgeF1).toBeLessThan(1)

    // A 3px shift is more than the default tolerance.
    const far = compareRasters(square(), square(3), W, H)
    expect(far.edgeRecall).toBeLessThan(1)
    expect(far.missingDetails.length).toBeGreaterThan(0)
  })

  it('reports missing detail: a thin line the candidate dropped', () => {
    const withLine = draw((x, y) => (y === 12 && x >= 4 && x < 28 ? NAVY : WHITE))
    const r = compareRasters(withLine, draw(() => WHITE), W, H)
    expect(r.missingDetails).toHaveLength(1)
    expect(r.missingDetails[0]).toEqual({ x: 4, y: 12, w: 24, h: 1, area: 24 })
    expect(r.artefacts).toEqual([])
    expect(r.edgeRecall).toBe(0)
    expect(r.edgePrecision).toBe(1) // the candidate drew no edges at all
  })

  it('reports artefacts: a speck the reference does not have', () => {
    const r = compareRasters(draw(() => WHITE), draw((x, y) => (x >= 3 && x < 6 && y >= 3 && y < 6 ? NAVY : WHITE)), W, H)
    expect(r.artefacts).toEqual([{ x: 3, y: 3, w: 3, h: 3, area: 9 }])
    expect(r.missingDetails).toEqual([])
    // Smaller than minDetailArea: measured, but not reported as a region.
    expect(compareRasters(draw(() => WHITE), draw((x, y) => (x === 3 && y === 3 ? NAVY : WHITE)), W, H).artefacts).toEqual([])
  })

  it('flags a shape drawn too thin on both sides of its misplaced edge', () => {
    // 2px thinner, beyond the 1px tolerance: the outer ring is reference ink that's missing,
    // the inner ring is background showing where the reference had none nearby.
    const r = compareRasters(square(), square(0, 2), W, H)
    expect(r.missingDetails[0]).toMatchObject({ x: 8, y: 6, w: 12, h: 12 })
    expect(r.artefacts[0]).toMatchObject({ x: 9, y: 7, w: 10, h: 10 })
    // One pixel thinner is within tolerance.
    expect(compareRasters(square(), square(0, 1), W, H).missingDetails).toEqual([])
  })
})

describe('colourFidelity', () => {
  const BLUE: RGBA = [28, 126, 214, 255]
  const BLUE2: RGBA = [42, 134, 217, 255] // a tint ΔE 2.9 from BLUE
  const twoBlues = draw((x) => (x < 16 ? BLUE : BLUE2))

  it('scores exact colours as exact', () => {
    const f = colourFidelity(twoBlues, twoBlues.slice(), W, H)
    expect(f.colours).toHaveLength(2)
    expect(f.meanDeltaE).toBe(0)
    expect(f.merged).toBe(0)
  })

  it('detects two distinct tints merged into one', () => {
    const merged = draw(() => BLUE)
    const f = colourFidelity(twoBlues, merged, W, H)
    expect(f.merged).toBe(1)
    expect(f.maxDeltaE).toBeGreaterThan(2.5)
  })

  it('ignores anti-aliased edge pixels and tiny colours', () => {
    // A 1 px blend column between the halves isn't a colour of its own.
    const soft = draw((x) => (x < 15 ? BLUE : x === 15 ? [35, 130, 215, 255] : BLUE2))
    expect(colourFidelity(soft, soft, W, H).colours).toHaveLength(2)
  })

  it('reports a colour shift', () => {
    const f = colourFidelity(square(), draw((x, y) => (x >= 8 && x < 20 && y >= 6 && y < 18 ? [0, 0, 0, 255] : WHITE)), W, H)
    const navy = f.colours.find((c) => c.reference === '#141E5A')!
    expect(navy.candidate).toBe('#000000')
    expect(navy.deltaE).toBeGreaterThan(10)
  })
})
