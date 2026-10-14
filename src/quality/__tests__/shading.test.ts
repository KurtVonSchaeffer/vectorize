import { describe, expect, it } from 'vitest'
import { lostShading, shadingLoss } from '../shading'

/** A w×h image on white with a block (x0..x1) filled by `fill(x)`. */
function image(w: number, h: number, fill: (x: number) => [number, number, number]): ImageData {
  const data = new Uint8ClampedArray(w * h * 4).fill(255)
  for (let y = 10; y < h - 10; y++)
    for (let x = 10; x < w - 10; x++) data.set([...fill(x), 255], (y * w + x) * 4)
  return { width: w, height: h, data, colorSpace: 'srgb' } as ImageData
}

describe('shadingLoss', () => {
  const ramp = (x: number): [number, number, number] => [200, Math.round(30 + x * 1.5), Math.round(100 + x)]
  it('is zero for a vector that matches the upload', () => {
    const a = image(120, 60, ramp)
    expect(shadingLoss(a, a).share).toBe(0)
    expect(lostShading(shadingLoss(a, a))).toBe(false)
  })
  it('flags a gradient flattened into two flat bands', () => {
    const up = image(120, 60, ramp)
    const bands = image(120, 60, (x) => ramp(x < 60 ? 30 : 90))
    const s = shadingLoss(up, bands)
    expect(s.share).toBeGreaterThan(0.25)
    expect(lostShading(s)).toBe(true)
  })
  it('ignores flat colour and the background', () => {
    const flat = image(120, 60, () => [11, 79, 156])
    expect(shadingLoss(flat, flat)).toEqual({ share: 0, meanDeltaE: 0 })
  })
})
