import { describe, expect, it } from 'vitest'
import { isPaperColour } from '../paper'

describe('isPaperColour', () => {
  it('white and near-white neutrals are paper', () => {
    expect(isPaperColour(0xffffff)).toBe(true)
    expect(isPaperColour(0xf4f4f2)).toBe(true)
  })
  it('coloured or darker backgrounds are not', () => {
    expect(isPaperColour(0xfff3c4)).toBe(false) // cream: too much chroma
    expect(isPaperColour(0xd0d0d0)).toBe(false) // light grey: too dark
    expect(isPaperColour(0x191d63)).toBe(false)
  })
})
