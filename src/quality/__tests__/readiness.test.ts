import { beforeAll, describe, expect, it } from 'vitest'
import { assessFidelity, type FidelityReport } from '../fidelity'
import { autoCheckOf, isReviewed, readiness, type CheckOutcome, type ReadinessInput } from '../readiness'
import { circle, installImageData, paint, rect, regularPolygon, renderSvg, vectorize, type RGB } from '../../vectorize/__tests__/fidelity/harness'

beforeAll(installImageData)

const SLOW = 120_000
const BLUE: RGB = [40, 70, 160]

function measuredReport(upload: ImageData): FidelityReport {
  const svg = vectorize(upload).svg
  return assessFidelity(upload, renderSvg(svg, upload.width, upload.height), svg)
}
const input = (check: CheckOutcome | null, more: Partial<ReadinessInput> = {}): ReadinessInput => ({ status: 'ready', counted: '3 colors', purpose: 'print', warnings: [], oneInk: false, check, reviewed: false, ...more })

/** Claims nothing in the app has verified: readiness for print and production approval. */
const UNSUPPORTED_CLAIMS = /ready for print|ready for the web|clean edges|production[- ]ready|approved/i

describe('the automatic check never stands in for a person', () => {
  it('a known false negative (a heptagon drawn as a circle) reads as "no known problems", not reviewed', () => {
    const img = paint(96, 96, null, [{ rings: [rect(8, 8, 88, 88)], color: BLUE }, { rings: [regularPolygon(48, 48, 12, 7)], color: [255, 255, 255] }])
    const report = measuredReport(img)
    expect(report.verdict).toBe('ready') // the documented false negative
    const r = readiness(input({ state: 'checked', report }))
    expect(r.autoCheck).toBe('no-known-problems')
    expect(r.reviewed).toBe(false)
    expect(r.summary).toMatch(/can miss small changes, so review it/)
    expect(r.summary).not.toMatch(UNSUPPORTED_CLAIMS)
  }, SLOW)

  it('only a person marks a result as reviewed, for the exact result they looked at', () => {
    const report = { verdict: 'ready', issues: [] } as unknown as FidelityReport
    expect(readiness(input({ state: 'checked', report })).reviewed).toBe(false)
    expect(readiness(input({ state: 'checked', report }, { reviewed: true })).reviewed).toBe(true)
    // A new result (different SVG) is not reviewed until a person looks at it again.
    expect(isReviewed({ svg: '<svg>a</svg>' }, '<svg>a</svg>')).toBe(true)
    expect(isReviewed({ svg: '<svg>a</svg>' }, '<svg>b</svg>')).toBe(false)
    expect(isReviewed(null, '<svg>a</svg>')).toBe(false)
    // Nothing is reviewed while it is still being made or after an error.
    expect(readiness(input(null, { status: 'working', reviewed: true })).reviewed).toBe(false)
    expect(readiness(input(null, { status: 'error', reviewed: true })).reviewed).toBe(false)
  })

  it('a reviewed result still reports what the check found, and is not called approved', () => {
    const report = { verdict: 'check', issues: [{ message: '3 outlines cross themselves.' }] } as unknown as FidelityReport
    const r = readiness(input({ state: 'checked', report }, { reviewed: true }))
    expect(r.summary).toBe('3 colors. Automatic checks found problems. You marked this version as reviewed.')
    expect(r.findings).toEqual(['3 outlines cross themselves.'])
  })

  it('keeps generated, automatically checked and reviewed as separate facts', () => {
    const r = readiness(input({ state: 'checking' }))
    expect(r).toMatchObject({ generated: true, autoCheck: 'checking', reviewed: false })
    expect(readiness(input(null, { status: 'working' }))).toMatchObject({ generated: false, autoCheck: 'not-checked', reviewed: false })
  })
})

describe('a check that fails or times out never reads as fine', () => {
  for (const reason of ['error', 'timeout', 'unsupported'] as const)
    it(`not checked (${reason})`, () => {
      const r = readiness(input({ state: 'not-checked', reason }))
      expect(r.autoCheck).toBe('not-checked')
      expect(r.reviewed).toBe(false)
      expect(r.summary).toMatch(/couldn't be checked automatically/)
      expect(r.summary).not.toMatch(/no known problems/)
    })

  it('no outcome at all (the check never started) is "not checked"', () => expect(autoCheckOf(null)).toBe('not-checked'))
})

describe('problems found in the result are reported', () => {
  it('degraded artwork: lost lettering strokes', () => {
    const img = paint(110, 70, BLUE, [
      { rings: [rect(0, 30, 110, 40)], color: [240, 240, 235] },
      { rings: Array.from({ length: 12 }, (_, k) => rect(6 + k * 8, 31.5, 6 + k * 8 + 1.2, 38.5)), color: [30, 140, 70] },
    ])
    const r = readiness(input({ state: 'checked', report: measuredReport(img) }))
    expect(r.autoCheck).toBe('problems-found')
    expect(r.findings.join(' ')).toMatch(/small details are missing/)
    expect(r.summary).toMatch(/found problems/)
  }, SLOW)

  it('incorrect geometry: outlines drawn twice', () => {
    const img = paint(120, 120, null, [
      { rings: [circle(60, 40, 30)], color: [2, 157, 236] },
      { rings: [rect(20, 85, 28, 105), rect(35, 85, 43, 105), circle(65, 95, 9), circle(65, 95, 5, true)], color: [1, 108, 165] },
    ])
    const r = readiness(input({ state: 'checked', report: measuredReport(img) }))
    expect(r.autoCheck).toBe('problems-found')
    expect(r.findings.join(' ')).toMatch(/drawn twice/)
  }, SLOW)
})

describe('no unsupported claims in any state', () => {
  const report = (verdict: FidelityReport['verdict']) => ({ verdict, issues: verdict === 'ready' ? [] : [{ message: 'x' }] }) as unknown as FidelityReport
  const checks: (CheckOutcome | null)[] = [null, { state: 'checking' }, { state: 'not-checked', reason: 'timeout' }, { state: 'checked', report: report('ready') }, { state: 'checked', report: report('check') }, { state: 'checked', report: report('not-suitable') }]
  for (const purpose of ['print', 'web', 'cut'] as const)
    it(`for ${purpose}`, () => {
      for (const check of checks)
        for (const reviewed of [false, true])
          for (const warnings of [[], ['Photos become thousands of small shapes.']])
            for (const oneInk of [false, true]) expect(readiness(input(check, { purpose, reviewed, warnings, oneInk })).summary).not.toMatch(UNSUPPORTED_CLAIMS)
    })
})
