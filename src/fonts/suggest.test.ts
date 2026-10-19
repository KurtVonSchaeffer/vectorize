import { describe, expect, it } from 'vitest'
import type { FontReport } from './identify'
import type { LineLettering, PlacedWord } from './lettering'
import type { FontCandidate } from './match'
import { placeSuggestion, SUGGEST_MIN_SCORE, worthSuggesting } from './suggest'

const report = { lines: [{ text: 'EST 1998' }, { text: 'Prism' }], chars: '', scale: 2 } as unknown as FontReport
const match = { label: 'Arial Bold', score: 0.89 } as FontCandidate & { score: number }
const word = (text: string, doubtful = false): PlacedWord =>
  ({ text, font: 'Arial Bold', letters: [], box: { x0: 0, y0: 0, x1: 1, y1: 1 }, ...(doubtful ? { doubts: [{ at: 1, char: '9', rival: '8', fit: 0.5, rivalFit: 0.6 }] } : {}) }) as PlacedWord
const placing = (words: PlacedWord[]) => async (): Promise<LineLettering> => ({ font: 'Arial Bold', words, skipped: 0 })

describe('font suggestions', () => {
  it('suggests only close matches, by name', () => {
    expect(SUGGEST_MIN_SCORE).toBe(0.85)
    expect(worthSuggesting({ score: 0.85 })).toBe(true)
    expect(worthSuggesting({ score: 0.84 })).toBe(false)
    expect(worthSuggesting(undefined)).toBe(false)
  })

  it('keeps only words whose text the image supports', async () => {
    const s = await placeSuggestion(report, 0, match, placing([word('EST'), word('1998', true)]))
    expect(s?.placed.words.map((w) => w.text)).toEqual(['EST'])
    expect(s).toMatchObject({ line: 0, text: 'EST 1998', font: 'Arial Bold', score: 0.89 })
  })

  it('suggests nothing when no word can be placed or every word is doubtful', async () => {
    expect(await placeSuggestion(report, 1, match, placing([word('1898', true)]))).toBeNull()
    expect(await placeSuggestion(report, 1, match, placing([]))).toBeNull()
    expect(await placeSuggestion(report, 1, match, () => Promise.reject(new Error('font unavailable offline')))).toBeNull()
  })
})
