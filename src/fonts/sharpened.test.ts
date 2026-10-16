import { describe, expect, it } from 'vitest'
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
