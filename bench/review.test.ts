import { describe, expect, it } from 'vitest'
import { compareShapes, finalVerdict, missingColours, recommendation, type ReportRow, type Visual } from './review'

/** A white w×h image with black rectangles [x, y, w, h]. */
function image(w: number, h: number, rects: number[][]): ImageData {
  const data = new Uint8ClampedArray(w * h * 4).fill(255)
  for (const [rx, ry, rw, rh] of rects)
    for (let y = ry; y < ry + rh; y++)
      for (let x = rx; x < rx + rw; x++) data.set([0, 0, 0, 255], (y * w + x) * 4)
  return { width: w, height: h, data, colorSpace: 'srgb' } as ImageData
}

describe('compareShapes', () => {
  const letters = [[10, 10, 10, 30], [24, 10, 10, 30], [50, 10, 10, 30]]
  it('matches identical shapes', () => {
    const s = compareShapes(image(80, 50, letters), image(80, 50, letters)).shapes
    expect(s).toEqual({ reference: 3, result: 3, merged: 0, broken: 0, missing: 0, extra: 0 })
  })
  it('finds merged letters', () => {
    const s = compareShapes(image(80, 50, letters), image(80, 50, [[10, 10, 24, 30], [50, 10, 10, 30]])).shapes
    expect(s.merged).toBe(1)
  })
  it('finds broken, missing and extra shapes', () => {
    const s = compareShapes(image(80, 50, letters), image(80, 50, [[10, 10, 10, 13], [10, 27, 10, 13], [24, 10, 10, 30], [65, 40, 6, 6]])).shapes
    expect(s.broken).toBe(1)
    expect(s.missing).toBe(1)
    expect(s.extra).toBe(1)
  })
})

describe('finalVerdict', () => {
  it('needs a manual yes to pass and fails on any failure', () => {
    expect(finalVerdict(true, undefined)).toBe('REVIEW')
    expect(finalVerdict(true, { checks: {}, overall: 'yes', notes: '' })).toBe('PASS')
    expect(finalVerdict(null, { checks: {}, overall: 'yes', notes: '' })).toBe('PASS')
    expect(finalVerdict(true, { checks: { enlarged: 'fail' }, overall: 'yes', notes: '' })).toBe('FAIL')
    expect(finalVerdict(false, { checks: {}, overall: 'yes', notes: '' })).toBe('FAIL')
    expect(finalVerdict(true, { checks: {}, overall: 'minor', notes: '' })).toBe('REVIEW')
  })
})

describe('recommendation', () => {
  const visual = { file: 'x', width: 10, height: 10, upload: '', first: '', offer: null, original: null, originalIsVector: false, boxes: [], focus: { x: 0.5, y: 0.5 } } as Visual
  const passing = (i: number): ReportRow => ({ file: `print__${i}.png`, category: 'print', verdict: 'PASS', auto: true, notes: [], flags: [], metrics: [], review: { checks: {}, overall: 'yes', notes: '' }, visual, blocking: [] })
  const ten = Array.from({ length: 10 }, (_, i) => passing(i))
  it('releases when every logo passes', () => {
    expect(recommendation(ten, { print: 'Print' }).decision).toBe('RELEASE')
  })
  it('never releases when a logo could not be tested', () => {
    const failed: ReportRow = { file: 'print__crash.png', category: 'print', verdict: 'FAIL', auto: false, notes: ['failed'], flags: [], metrics: [], review: undefined, visual: null, blocking: ['could not be tested: boom'] }
    const r = recommendation([...ten, failed], { print: 'Print' })
    expect(r.decision).toBe('REVISE')
    expect(r.reasons.join(' ')).toContain('print__crash.png')
  })
  it('lists photos and pixel art without counting them', () => {
    const photo: ReportRow = { file: 'complex__photo.jpg', category: 'complex', verdict: 'REVIEW', auto: null, notes: [], flags: [], metrics: [], review: undefined, visual: null, blocking: [], excluded: 'photo: not covered' }
    const r = recommendation([...ten, photo], { print: 'Print', complex: 'Complex' })
    expect(r.decision).toBe('RELEASE')
    expect(r.reasons.join(' ')).toContain('complex__photo.jpg')
  })
})

describe('missingColours', () => {
  const NAVY = [31, 42, 92]
  const GREY = [73, 80, 87]
  const WHITE = [255, 255, 255]
  const mix = (a: number[], b: number[], t: number) => a.map((v, i) => Math.round(v * (1 - t) + b[i] * t))
  /** A 240×80 image drawn per pixel. */
  const draw = (px: (x: number, y: number) => number[]) => {
    const data = new Uint8ClampedArray(240 * 80 * 4)
    for (let y = 0; y < 80; y++) for (let x = 0; x < 240; x++) data.set([...px(x, y), 255], (y * 240 + x) * 4)
    return { width: 240, height: 80, data, colorSpace: 'srgb' } as ImageData
  }
  /** Navy blocks with half-blended edge columns, and 1 px grey letter outlines below. */
  const wordmark = (x: number, y: number) => {
    if (y >= 8 && y < 40 && x >= 10 && x < 150) return NAVY
    if (y >= 8 && y < 40 && (x === 9 || x === 150)) return mix(NAVY, WHITE, 0.5)
    const i = (x - 12) % 9
    if (y >= 55 && y < 64 && x >= 12 && x < 228 && i < 6 && (y === 55 || y === 63 || i === 0 || i === 5)) return GREY
    return WHITE
  }
  const svg = (...fills: string[]) => `<svg>${fills.map((f) => `<path d="M0 0" fill="${f}"/>`).join('')}</svg>`

  it('reports thin lettering whose colour was lost', () => {
    const m = missingColours(draw(wordmark), svg('#FFFFFF', '#1F2A5C'))
    expect(m.map((c) => c.colour)).toEqual(['#495057'])
    expect(m[0].nearest).toBe('#1F2A5C')
  })
  it('passes when the colour is kept, even slightly shifted', () => {
    expect(missingColours(draw(wordmark), svg('#FFFFFF', '#1F2A5C', '#4A5158'))).toEqual([])
  })
  it("doesn't report anti-aliased edge colours between kept colours", () => {
    // The 50% navy/white edge columns cover 0.33% of the image: above the share threshold.
    expect(missingColours(draw((x, y) => (y >= 55 ? WHITE : wordmark(x, y))), svg('#FFFFFF', '#1F2A5C'))).toEqual([])
  })
  it("doesn't report the steps of a gradient whose end colours are kept", () => {
    const red = [220, 30, 40]
    const blue = [20, 60, 200]
    const grad = draw((x, y) => (y >= 20 && y < 60 ? mix(red, blue, x / 239) : WHITE))
    expect(missingColours(grad, '<svg><linearGradient id="g"><stop stop-color="#DC1E28"/><stop stop-color="#143CC8"/></linearGradient><path fill="url(#g)"/><path fill="#FFFFFF"/></svg>')).toEqual([])
  })
  it("doesn't report a near-identical shade merged into its neighbour", () => {
    const navy2 = [36, 48, 98] // ΔE ≈ 2 from NAVY
    expect(missingColours(draw((x, y) => (y >= 8 && y < 40 ? (x < 120 ? NAVY : navy2) : WHITE)), svg('#FFFFFF', '#1F2A5C'))).toEqual([])
  })
})
