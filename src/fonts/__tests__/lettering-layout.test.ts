import { describe, expect, it } from 'vitest'
import { withLayout, type PlacedWord } from '../lettering'
import type { TextLayout } from '../textlayout'

const layout: TextLayout = { families: ['Arial'], weight: 700, style: 'normal', size: 20, baseline: 40, xs: [10, 22, 34], chars: ['C', 'A', 'T'] }
const word = (more: Partial<PlacedWord> = {}): PlacedWord => ({ text: 'CAT', font: 'Arial Bold', letters: [], box: [10, 20, 46, 40], ...more }) as PlacedWord

describe('editable text only for words the image supports', () => {
  it('a word without doubts carries how it is set', () => {
    expect(withLayout(word(), layout).layout).toEqual(layout)
  })

  it('a word with doubts (a look-alike letter, or OCR passes that disagree) stays outlines only', () => {
    const doubted = word({ doubts: [{ at: 1, char: 'A', rival: '4', fit: 0.61, rivalFit: 0.63 }] })
    expect(withLayout(doubted, layout).layout).toBeUndefined()
    expect(withLayout(doubted, layout).doubts).toHaveLength(1)
  })
})
