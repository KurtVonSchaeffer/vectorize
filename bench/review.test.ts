import { describe, expect, it } from 'vitest'
import { compareShapes, finalVerdict } from './review'

/** A white w×h image with black rectangles [x, y, w, h]. */
function image(w: number, h: number, rects: number[][]): ImageData {
  const data = new Uint8ClampedArray(w * h * 4).fill(255)
  for (const [rx, ry, rw, rh] of rects)
    for (let y = ry; y < ry + rh; y++)
      for (let x = rx; x < rx + rw; x++) data.set([0, 0, 0, 255], (y * w + x) * 4)
  return { width: w, height: h, data, colorSpace: 'srgb' } as ImageData
}

describe('compareShapes', () => {
  const letters = [[10, 10, 10, 30], [24, 10, 10, 30], [50, 10, 10, 30]]
  it('matches identical shapes', () => {
    const s = compareShapes(image(80, 50, letters), image(80, 50, letters)).shapes
    expect(s).toEqual({ reference: 3, result: 3, merged: 0, broken: 0, missing: 0, extra: 0 })
  })
  it('finds merged letters', () => {
    const s = compareShapes(image(80, 50, letters), image(80, 50, [[10, 10, 24, 30], [50, 10, 10, 30]])).shapes
    expect(s.merged).toBe(1)
  })
  it('finds broken, missing and extra shapes', () => {
    const s = compareShapes(image(80, 50, letters), image(80, 50, [[10, 10, 10, 13], [10, 27, 10, 13], [24, 10, 10, 30], [65, 40, 6, 6]])).shapes
    expect(s.broken).toBe(1)
    expect(s.missing).toBe(1)
    expect(s.extra).toBe(1)
  })
})

describe('finalVerdict', () => {
  it('needs a manual yes to pass and fails on any failure', () => {
    expect(finalVerdict(true, undefined)).toBe('REVIEW')
    expect(finalVerdict(true, { checks: {}, overall: 'yes', notes: '' })).toBe('PASS')
    expect(finalVerdict(null, { checks: {}, overall: 'yes', notes: '' })).toBe('PASS')
    expect(finalVerdict(true, { checks: { enlarged: 'fail' }, overall: 'yes', notes: '' })).toBe('FAIL')
    expect(finalVerdict(false, { checks: {}, overall: 'yes', notes: '' })).toBe('FAIL')
    expect(finalVerdict(true, { checks: {}, overall: 'minor', notes: '' })).toBe('REVIEW')
  })
})
