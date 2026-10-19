import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LabelMap } from '../../trace'
import { runFlat, type FlatOptions } from '../pipeline'

// An export checker that, when asked, finds one piece too thin to cut on the gap the first time it
// looks (so the gap is undone there), and nothing after that.
const checks = vi.hoisted(() => ({ undo: false, calls: 0 }))
vi.mock('../../export/validate', async (actual) => ({
  ...(await actual<typeof import('../../export/validate')>()),
  validateShapes: () => {
    const where = checks.undo && checks.calls++ === 0 ? [{ x: 100, y: 30, box: [99, 25, 101, 35] as [number, number, number, number] }] : []
    return [{ id: 'sliver', status: where.length ? 'warn' : 'ok', count: where.length, message: '', where }]
  },
}))

class FakeImageData {
  constructor(
    public data: Uint8ClampedArray,
    public width: number,
    public height: number,
  ) {}
}
beforeAll(() => {
  ;(globalThis as unknown as { ImageData: unknown }).ImageData = FakeImageData
})
beforeEach(() => {
  checks.calls = 0
})

const W = 130, H = 60
const NAVY = [43, 45, 66], ORANGE = [240, 140, 0], CREAM = [255, 248, 231]
// A rough navy "I" and a period (lettering), and an orange block touching a navy block (one gap), on cream.
function artwork(): ImageData {
  const d = new Uint8ClampedArray(W * H * 4)
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const c = (x >= 20 && x < 30 && y >= 10 && y < 50) || (x >= 38 && x < 43 && y >= 45 && y < 50) || (x >= 100 && x < 120 && y >= 10 && y < 50) ? NAVY : x >= 60 && x < 100 && y >= 10 && y < 50 ? ORANGE : CREAM
      d.set([...c, 255], (y * W + x) * 4)
    }
  return new FakeImageData(d, W, H) as unknown as ImageData
}
function text(): FlatOptions['text'] {
  const coverage = new Uint8Array(W * H)
  for (let y = 10; y < 50; y++) for (let x = 20; x < 30; x++) coverage[y * W + x] = 255
  return { words: [{ text: 'I.', font: 'Test Sans', letters: [{ char: 'I', d: 'M20 10L30 10L30 50L20 50Z' }], box: [20, 10, 43, 50] }], coverage }
}
const opts = (): FlatOptions => ({
  lineArt: false,
  removeColors: [],
  transparent: true,
  quantize: { maxColors: 12, mergeDelta: 10, whiteIsPaper: false, palette: null, overrides: {}, minArea: 9, upscale: 1, smoothing: 0 },
  trace: { smoothing: 0.8, minArea: 9, error: 0.5, cornerAngle: 60, precision: 2, mode: 'knockout', spread: 0 },
  oneColour: { ink: 0x000000, gapPx: 4, production: true, outputWidthMm: 200 },
  text: text(),
})
/** Where traced ink shapes start (rebuilt letters are drawn separately, in their own group). */
const tracedInkStarts = (svg: string) => [...(svg.match(/<g data-color="#000000">([\s\S]*?)<\/g>/)?.[1] ?? '').matchAll(/d="M\s?([\d.]+)/g)].map((m) => Math.round(Number(m[1])))

describe('one-colour print / cut file: undoing a gap keeps the later steps', () => {
  it('keeps a transparent background and rebuilt lettering when a gap is undone', () => {
    const traced: LabelMap[] = []
    checks.undo = false
    const kept = runFlat(artwork(), opts(), (m) => traced.push(m))
    checks.undo = true
    const undone = runFlat(artwork(), opts(), (m) => traced.push(m))
    // The gap really was undone in one place.
    expect(undone.oneColour?.flags.filter((f) => f.reason === 'cut-limit')).toHaveLength(1)
    for (const r of [kept, undone]) {
      // Transparent: the cream background isn't drawn.
      expect(r.svg).not.toMatch(/#FFF8E7/i)
      expect(r.lettered).toBe(1)
      expect(r.svg).toMatch(/<g id="Text_I"/)
    }
    // The traced "I" stays replaced by the rebuilt one: its pixels aren't ink, and no traced ink shape
    // starts there (the period at x 38 stays traced).
    for (const m of traced) expect(m.colors[m.labels[30 * W + 25]]).not.toBe(0x000000)
    for (const r of [kept, undone]) expect(tracedInkStarts(r.svg).filter((x) => x >= 18 && x <= 32)).toEqual([])
  })
})
