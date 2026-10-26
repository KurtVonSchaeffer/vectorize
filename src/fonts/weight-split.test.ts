import { describe, expect, it } from 'vitest'
import { weightSplitRange, type TextDoubt } from './lettering'

const poor = (...at: number[]): TextDoubt[] => at.map((a) => ({ at: a, char: '?', rival: '?', fit: 0.38, rivalFit: 0 }))

describe('a wordmark in two weights of one family', () => {
  it('splits off a lighter ending, with the punctuation before it ("barron" + ".com")', () => {
    expect(weightSplitRange('barron.com', poor(7, 8, 9))).toEqual({ from: 6, to: 9 })
  })
  it('splits off a different first part', () => {
    expect(weightSplitRange('THEstudio', poor(0, 1, 2))).toEqual({ from: 0, to: 2 })
  })
  it('splits at punctuation when only some letters of the other weight are flagged (small, blurry uploads)', () => {
    // "barron.com" at 560 px: only the "c" fails the bold match.
    expect(weightSplitRange('barron.com', poor(7))).toEqual({ from: 6, to: 9 })
    expect(weightSplitRange('barron.com', poor(7, 9))).toEqual({ from: 6, to: 9 })
    // Before the punctuation, which stays with the letters that fit.
    expect(weightSplitRange('acme.store', poor(1, 2))).toEqual({ from: 0, to: 3 })
  })
  it('never splits for a look-alike, a disputed reading, a gap with no punctuation, or too little left', () => {
    expect(weightSplitRange('barron.com', [{ at: 8, char: 'o', rival: '0', fit: 0.6, rivalFit: 0.62 }])).toBeNull()
    expect(weightSplitRange('barron.com', [{ at: -1, char: 'barron.com', rival: 'baron.com', fit: 0, rivalFit: 0 }])).toBeNull()
    expect(weightSplitRange('barroncom', poor(3, 4))).toBeNull()
    expect(weightSplitRange('a.bc', poor(2))).toBeNull()
    expect(weightSplitRange('ab', poor(1))).toBeNull()
    expect(weightSplitRange('barron', [])).toBeNull()
  })
})
