import { describe, expect, it } from 'vitest'
import { dedupe, type OcrWord } from './ocr'

const word = (text: string, confidence: number, x0 = 100, w = 40): OcrWord => ({ line: 1, text, confidence, box: { x0, y0: 10, x1: x0 + w, y1: 30 }, glyphs: [] })

describe('OCR readings across passes', () => {
  it('keeps the most confident reading and records a different reading of the same word', () => {
    // The "1998" read as "1898" case: one pass misreads a digit.
    const kept = dedupe([word('1898', 88), word('1998', 80)])
    expect(kept).toHaveLength(1)
    expect(kept[0].text).toBe('1898')
    expect(kept[0].readings).toEqual(['1998'])
  })
  it('records nothing when every pass agrees (agreement is not treated as proof elsewhere)', () => {
    expect(dedupe([word('1998', 90), word('1998', 70)])[0].readings).toBeUndefined()
  })
  it("doesn't mistake a different word split for a different reading", () => {
    // "EST" alone vs "EST 1998": overlapping, but not the same word.
    const kept = dedupe([word('EST 1998', 85, 100, 80), word('EST', 75, 100, 30)])
    expect(kept[0].readings).toBeUndefined()
  })
})
