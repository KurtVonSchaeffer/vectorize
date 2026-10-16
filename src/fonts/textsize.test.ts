import { describe, expect, it } from 'vitest'
import { SMALL_TEXT_PX, smallestTextLine } from './textsize'

const line = (y0: number, y1: number) => ({ box: { x0: 0, y0, x1: 100, y1 } })

describe('smallestTextLine', () => {
  it('measures the shortest line in source pixels, undoing the OCR upscale', () => {
    // Read at 4×: a 160 px wordmark line and a 32 px tagline are 40 px and 8 px in the upload.
    expect(smallestTextLine({ lines: [line(0, 160), line(200, 232)], scale: 4 })).toBe(8)
    expect(8).toBeLessThan(SMALL_TEXT_PX)
  })

  it('reports no size when there is no text', () => {
    expect(smallestTextLine({ lines: [], scale: 2 })).toBeNull()
  })
})
