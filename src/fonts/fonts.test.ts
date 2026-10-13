import { describe, expect, it } from 'vitest'
import { SYSTEM_FONTS, weightOf } from './candidates'

describe('font candidates', () => {
  it('reads weights from style names', () => {
    expect(weightOf('Regular')).toBe(400)
    expect(weightOf('Bold')).toBe(700)
    expect(weightOf('Semibold Italic')).toBe(600)
    expect(weightOf('ExtraBold')).toBe(800)
    expect(weightOf('Black')).toBe(900)
    expect(weightOf('Light')).toBe(300)
    expect(weightOf('Ultra Light')).toBe(200)
  })

  it('checks the common fonts that ship with Mac and Windows', () => {
    expect(new Set(SYSTEM_FONTS).size).toBeGreaterThan(150)
    for (const name of ['Arial Black', 'Helvetica Neue', 'Futura Bold', 'Gill Sans', 'Segoe UI', 'Times New Roman']) expect(SYSTEM_FONTS).toContain(name)
  })
})

describe('main colors for text reading', () => {
  it('finds the distinct colors of flat artwork, ignoring tiny ones', async () => {
    const { mainColors } = await import('./ocr')
    const w = 100, h = 100
    const img = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) } as ImageData
    for (let i = 0; i < w * h; i++) {
      const [r, g, b] = i < 6000 ? [44, 45, 65] : i < 9000 ? [255, 248, 230] : i < 9990 ? [233, 142, 13] : [0, 200, 0]
      img.data.set([r, g, b, 255], i * 4)
    }
    expect(mainColors(img)).toEqual([0x2c2d41, 0xfff8e6, 0xe98e0d])
  })
})

describe('free-font catalog screening', () => {
  it('ranks the style whose letter fingerprints match first', async () => {
    const { screen } = await import('./catalog')
    const CELL = 32, BITS = 16, R = BITS * BITS / 8 + 1
    // Query letter "I": a vertical bar in the middle of the 32×32 cell.
    const mask = new Float32Array(CELL * CELL)
    for (let y = 2; y < 30; y++) for (let x = 12; x < 20; x++) mask[y * CELL + x] = 1
    const bar = new Uint8Array(R), slab = new Uint8Array(R)
    for (let y = 1; y < 15; y++) for (let x = 0; x < BITS; x++) {
      const bit = (y * BITS + x)
      if (x >= 6 && x < 10) bar[bit >> 3] |= 1 << (bit & 7) // same shape
      if (y < 4 || y > 11) slab[bit >> 3] |= 1 << (bit & 7) // a different shape
    }
    bar[R - 1] = slab[R - 1] = 120
    const data = new Uint8Array(R * 2)
    data.set(slab, 0) // style 0: wrong shape
    data.set(bar, R) // style 1: right shape
    const index = { meta: { bits: BITS, cell: CELL, record: R, chars: 'I', fonts: [['a', 'Slab', 400, 'serif'], ['b', 'Bar Sans', 700, 'sans-serif']] as [string, string, number, string][] }, glyphs: new Map([['I', data]]) }
    const words = [{ text: 'II', complete: true, box: { x0: 0, y0: 0, x1: 1, y1: 1 }, glyphs: [{ char: 'I', mask, rel: 1, box: { x0: 0, y0: 0, x1: 1, y1: 1 } }, { char: 'I', mask, rel: 1, box: { x0: 0, y0: 0, x1: 1, y1: 1 } }] }]
    expect(screen(index, words, 2)).toEqual([1, 0])
  })
})
