import { describe, expect, it } from 'vitest'
import { SMALL_TEXT_PX, smallestTextLine } from './textsize'

const line = (y0: number, y1: number, text = 'COFFEE') => ({ text, box: { x0: 0, y0, x1: 100, y1 } })

describe('smallestTextLine', () => {
  it('measures the shortest line in source pixels, undoing the OCR upscale', () => {
    // Read at 4×: a 160 px wordmark line and a 32 px tagline are 40 px and 8 px in the upload.
    expect(smallestTextLine({ lines: [line(0, 160), line(200, 232)], scale: 4 })).toBe(8)
    expect(8).toBeLessThan(SMALL_TEXT_PX)
  })

  it('ignores shapes misread as text', () => {
    // Measured on an illustration: "[v4" (5.3 px) and "AA" were shapes; "CAMP" (14.7 px) is the lettering.
    expect(smallestTextLine({ lines: [line(0, 21, '[v4'), line(40, 120, 'AA'), line(200, 259, 'CAMP')], scale: 4 })).toBeCloseTo(14.75)
    expect(smallestTextLine({ lines: [line(0, 21, 'EST.')], scale: 4 })).toBeCloseTo(5.25)
  })

  it('reports no size when there is no text', () => {
    expect(smallestTextLine({ lines: [], scale: 2 })).toBeNull()
  })
})
