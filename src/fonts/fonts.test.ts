import { describe, expect, it } from 'vitest'
import { GOOGLE_FAMILIES, weightOf } from './candidates'

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

  it('has a broad free catalog', () => {
    expect(new Set(GOOGLE_FAMILIES).size).toBeGreaterThan(120)
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
