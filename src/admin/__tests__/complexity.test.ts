import { describe, expect, it } from 'vitest'
import { bandOf, complexity, profileKey, type ComplexityInput } from '../complexity'

const input = (more: Partial<ComplexityInput> = {}): ComplexityInput => ({
  detection: { kind: 'flat', gradients: 0, fine: 0.1, ...more.detection },
  colours: 2,
  compression: 0.01,
  width: 1200,
  height: 800,
  ...more,
})

describe('complexity', () => {
  it('a clean two-colour logo is simple', () => {
    const c = complexity(input())
    expect(c.band).toBe('simple')
    expect(c.score).toBe(2)
  })

  it('a small JPEG photo with lettering is complex', () => {
    const c = complexity(input({ detection: { kind: 'photo', gradients: 0, fine: 0.5 }, colours: 0, compression: 0.2, width: 250, height: 200, textLines: 2 }))
    expect(c.band).toBe('complex')
    expect(c.parts).toMatchObject({ kind: 40, compression: 10, resolution: 10, lettering: 10 })
  })

  it('every signal adds to the score, and it never passes 100', () => {
    const base = complexity(input()).score
    expect(complexity(input({ colours: 8 })).score).toBeGreaterThan(base)
    expect(complexity(input({ detection: { kind: 'flat', gradients: 2, fine: 0.1 } })).score).toBeGreaterThan(base)
    expect(complexity(input({ detection: { kind: 'flat', gradients: 0, fine: 0.9 } })).score).toBeGreaterThan(base)
    expect(complexity(input({ detection: { kind: 'flat', gradients: 0, fine: 0.1, texture: 0.4 } })).score).toBeGreaterThan(base)
    expect(complexity(input({ compression: 0.1 })).score).toBeGreaterThan(base)
    expect(complexity(input({ width: 500, height: 400 })).score).toBeGreaterThan(base)
    const worst = complexity(input({ detection: { kind: 'photo', gradients: 9, fine: 1 }, colours: 40, compression: 1, width: 10, height: 10, textLines: 9 }))
    expect(worst.score).toBe(100)
  })

  it('a hatched illustration with lettering is complex (the Gorilla Glue logo scored 17, simple, before texture counted)', () => {
    const c = complexity(input({ detection: { kind: 'flat', illustration: true, gradients: 0, fine: 0.075, texture: 0.43 }, colours: 16, textLines: 2 }))
    expect(c.band).toBe('complex')
    expect(c.parts.texture).toBe(19)
  })

  it('bands split at 30 and 60', () => {
    expect([bandOf(30), bandOf(31), bandOf(60), bandOf(61)]).toEqual(['simple', 'medium', 'medium', 'complex'])
  })

  it('profile keys group by kind, band and compression', () => {
    expect(profileKey('flat', 'medium', 0.2)).toBe('flat/medium/lossy')
    expect(profileKey('lineart', 'simple', 0.01)).toBe('lineart/simple/clean')
  })
})
