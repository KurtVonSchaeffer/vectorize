import { beforeAll, describe, expect, it } from 'vitest'
import { fontNames } from '../../fonts/textlayout'
import { runFlat, type FlatOptions } from '../../vectorize/pipeline'
import { withEditableText } from '../editable-text'

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

// A navy "I" (x 20–30, y 10–50) on cream, rebuilt from a font as the app places it.
const W = 120, H = 60
const upload = () => {
  const d = new Uint8ClampedArray(W * H * 4)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) d.set(x >= 20 && x < 30 && y >= 10 && y < 50 ? [43, 45, 66, 255] : [255, 248, 231, 255], (y * W + x) * 4)
  return new FakeImageData(d, W, H) as unknown as ImageData
}
const opts = (text: FlatOptions['text']): FlatOptions => ({
  lineArt: false,
  removeColors: [],
  transparent: false,
  quantize: { maxColors: 12, mergeDelta: 10, whiteIsPaper: false, palette: null, overrides: {}, minArea: 9, upscale: 1, smoothing: 0 },
  trace: { smoothing: 0.8, minArea: 9, error: 0.5, cornerAngle: 60, precision: 2 },
  text,
})
const coverage = () => {
  const c = new Uint8Array(W * H)
  for (let y = 10; y < 50; y++) for (let x = 20; x < 30; x++) c[y * W + x] = 255
  return c
}
const letter = { char: 'I', d: 'M20 10L30 10L30 50L20 50Z' }
const layout = { families: ['Arial Bold', 'Arial'], weight: 700, style: 'normal' as const, size: 55.2, baseline: 50, xs: [17.3], chars: ['I'] }

describe('editable text', () => {
  it('writes a word rebuilt from a font as SVG text, set where its outlines are', () => {
    const r = runFlat(upload(), opts({ words: [{ text: 'I', font: 'Arial Bold', letters: [letter], box: [20, 10, 30, 50], layout }], coverage: coverage() }))
    // The ordinary download stays outlines.
    expect(r.svg).not.toMatch(/<text/)
    expect(r.svg).toMatch(/<path id="Text_I_1_I" d="M20 10L30 10L30 50L20 50Z"/)
    const e = withEditableText(r.svg)
    expect(e.words).toBe(1)
    expect(e.fonts).toEqual(['Arial Bold'])
    expect(e.svg).toMatch(/<text x="17\.3" y="50" font-family="'Arial Bold', 'Arial'" font-weight="700" font-style="normal" font-size="55\.2" fill="#2B2D42" xml:space="preserve">I<\/text>/)
    // The text replaces the word's outlines; the group (name, word, font) is kept.
    expect(e.svg).not.toMatch(/Text_I_1_I/)
    expect(e.svg).toMatch(/<g id="Text_I" data-text="I" data-font="Arial Bold"/)
  })

  it('keeps a word without a complete layout as outlines', () => {
    const noLayout = runFlat(upload(), opts({ words: [{ text: 'I', font: 'Arial Bold', letters: [letter], box: [20, 10, 30, 50] }], coverage: coverage() }))
    expect(withEditableText(noLayout.svg)).toMatchObject({ words: 0, svg: noLayout.svg })
    // One position for two letters: not written as text.
    const broken = runFlat(upload(), opts({ words: [{ text: 'I', font: 'Arial Bold', letters: [letter], box: [20, 10, 30, 50], layout: { ...layout, chars: ['I', 'I'] } }], coverage: coverage() }))
    expect(withEditableText(broken.svg).words).toBe(0)
  })

  it('leaves traced artwork alone', () => {
    const r = runFlat(upload(), opts(undefined))
    expect(withEditableText(r.svg)).toEqual({ svg: r.svg, words: 0, fonts: [] })
  })
})

describe('font names for exported text', () => {
  it('splits a face name into its family and weight', () => {
    expect(fontNames({ family: 'sys-Arial Bold', label: 'Arial Bold', ref: 'Arial Bold', weight: 400, style: 'normal', source: 'system' })).toEqual({ families: ['Arial Bold', 'Arial'], weight: 700 })
    expect(fontNames({ family: 'sys-Avenir Next Demi Bold', label: 'Avenir Next Demi Bold', ref: 'x', weight: 400, style: 'normal', source: 'system' })).toEqual({ families: ['Avenir Next Demi Bold', 'Avenir Next'], weight: 600 })
  })

  it('keeps a face that is its own family first ("Arial Black", "Impact")', () => {
    expect(fontNames({ family: 'sys-Arial Black', label: 'Arial Black', ref: 'Arial Black', weight: 400, style: 'normal', source: 'system' })).toEqual({ families: ['Arial Black', 'Arial'], weight: 900 })
    expect(fontNames({ family: 'sys-Impact', label: 'Impact', ref: 'Impact', weight: 400, style: 'normal', source: 'system' })).toEqual({ families: ['Impact'], weight: 400 })
  })

  it('uses the catalog weight for free fonts', () => {
    expect(fontNames({ family: 'fs-montserrat-800', label: 'Montserrat ExtraBold', ref: 'montserrat', weight: 800, style: 'normal', source: 'google' })).toEqual({ families: ['Montserrat ExtraBold', 'Montserrat'], weight: 800 })
  })
})
