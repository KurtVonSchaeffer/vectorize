import { beforeAll, describe, expect, it } from 'vitest'
import { runFlat, type FlatOptions } from '../vectorize/pipeline'
import { toSourcePixels } from './lettering'
import { readFromSharpened } from './sharpened'

/** Behaves like an ImageBitmap: closing it releases the pixels and reports a size of 0. */
function bitmap(width: number, height: number) {
  const b = { width, height, closed: false, close: () => Object.assign(b, { width: 0, height: 0, closed: true }) }
  return b as typeof b & ImageBitmap
}

describe('reading lettering from a sharpened copy', () => {
  it('keeps the scale in the original image when the sharpened copy is closed', async () => {
    // 420×60 'sans 10px caps' case: the 2× copy is 840 px wide, and OCR upscales it 2× again.
    const original = bitmap(420, 60)
    const sharp = bitmap(840, 120)
    const report = await readFromSharpened(original, sharp, async (b) => {
      expect(b).toBe(sharp)
      return { scale: 2 }
    })
    expect(sharp.closed).toBe(true)
    // OCR canvas px per original px: 2 (OCR) × 2 (sharpening).
    expect(report.scale).toBe(4)
  })

  it('reads the original when there is no sharpened copy', async () => {
    const original = bitmap(420, 60)
    const report = await readFromSharpened(original, null, async (b) => {
      expect(b).toBe(original)
      return { scale: 3 }
    })
    expect(report.scale).toBe(3)
    expect(original.closed).toBe(false)
  })

  it('closes the sharpened copy when reading fails', async () => {
    const sharp = bitmap(840, 120)
    await expect(readFromSharpened(bitmap(420, 60), sharp, () => Promise.reject(new Error('OCR failed')))).rejects.toThrow('OCR failed')
    expect(sharp.closed).toBe(true)
  })
})

class FakeImageData {
  constructor(
    public data: Uint8ClampedArray,
    public width: number,
    public height: number,
  ) {}
}

describe('lettering rebuilt from a sharpened copy, through to the SVG', () => {
  beforeAll(() => {
    ;(globalThis as unknown as { ImageData: unknown }).ImageData = FakeImageData
  })

  // A navy "I" (x 20–30, y 10–50) on cream, 120×60: small enough to be read from the sharpened copy.
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
  // The "I" as placed in the OCR canvas: the 2× sharpened copy, upscaled 2× again for OCR (4× the upload).
  const placedInOcr = { letters: [{ char: 'I', d: 'M80 40L120 40L120 200L80 200Z' }], box: { x0: 80, y0: 40, x1: 120, y1: 200 } }

  it('puts the rebuilt letters over the original ones, at finite coordinates', async () => {
    const report = await readFromSharpened(bitmap(W, H), bitmap(W * 2, H * 2), async () => ({ scale: 2 }))
    const word = toSourcePixels(placedInOcr, report.scale)
    // As the app renders placed letters (pipeline textOptions), at the upload's size.
    const coverage = new Uint8Array(W * H)
    for (let y = word.box.y0; y < word.box.y1; y++) for (let x = word.box.x0; x < word.box.x1; x++) coverage[y * W + x] = 255
    const r = runFlat(upload(), opts({ words: [{ text: 'I', font: 'Test Sans', letters: word.letters, box: [word.box.x0, word.box.y0, word.box.x1, word.box.y1] }], coverage }))
    expect(r.lettered).toBe(1)
    expect(r.svg).not.toMatch(/Infinity|NaN/)
    expect(r.svg).toMatch(/<g id="Text_I" data-text="I" data-font="Test Sans" data-color="#2B2D42">\n<path id="Text_I_1_I" d="M20 10L30 10L30 50L20 50Z"/)
    // The traced "I" was replaced: no navy shape is left outside the lettering.
    expect(r.svg).not.toMatch(/<g data-color="#2B2D42">/)
  })

  it('refuses a zero scale instead of placing letters at Infinity', () => {
    // What production did: report.scale *= closedCopy.width (0) / original.width.
    expect(() => toSourcePixels(placedInOcr, 0)).toThrow('invalid scale')
    expect(() => toSourcePixels(placedInOcr, Number.NaN)).toThrow('invalid scale')
  })
})
