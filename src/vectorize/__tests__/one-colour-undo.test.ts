import { beforeAll, describe, expect, it, vi } from 'vitest'
import { shapesFromSvg } from '../../export/path'
import { runFlat, type FlatOptions } from '../pipeline'

// An export checker that, each time the gap is undone where it complained, finds a piece too thin to
// cut somewhere else on the gap: undoing gaps in places never clears the file. Round 2 also reports
// the first place again with a box that reaches a part of the gap still cut.
type Box = [number, number, number, number]
const checks = vi.hoisted(() => ({
  calls: 0,
  rounds: [
    [{ x: 145, y: 80, box: [143, 76, 147, 84] as Box }],
    [{ x: 95, y: 80, box: [93, 76, 97, 84] as Box }, { x: 145, y: 80, box: [120, 50, 147, 84] as Box }],
    [{ x: 120, y: 105, box: [116, 103, 124, 107] as Box }],
  ],
}))
vi.mock('../../export/validate', async (actual) => ({
  ...(await actual<typeof import('../../export/validate')>()),
  validateShapes: () => {
    const where = checks.rounds[Math.min(checks.calls++, checks.rounds.length - 1)]
    return [{ id: 'sliver', status: 'warn', count: where.length, message: 'too thin', where }]
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
const cover = (x: number, y: number, cx: number, cy: number, r: number) => Math.max(0, Math.min(1, r + 0.5 - Math.hypot(x + 0.5 - cx, y + 0.5 - cy)))
const mix = (a: number[], b: number[], t: number) => [...a.map((v, i) => Math.round(v + (b[i] - v) * t)), 255]
const CREAM = [255, 248, 231], NAVY = [43, 45, 66], ORANGE = [240, 140, 0]

describe('one-colour print / cut file: undoing gaps', () => {
  it('undoes every gap when undoing them in places never clears a problem, and flags each place once', () => {
    // A navy disc with an orange centre on cream: one boundary (r = 25) gets a gap.
    const d = new Uint8ClampedArray(240 * 160 * 4)
    for (let y = 0; y < 160; y++) for (let x = 0; x < 240; x++) d.set(mix(mix(CREAM, NAVY, cover(x, y, 120, 80, 60)).slice(0, 3), ORANGE, cover(x, y, 120, 80, 25)), (y * 240 + x) * 4)
    const o: FlatOptions = {
      lineArt: false,
      removeColors: [],
      transparent: false,
      quantize: { maxColors: 12, mergeDelta: 10, whiteIsPaper: false, palette: null, overrides: {}, minArea: 9, upscale: 1, smoothing: 0 },
      trace: { smoothing: 0.8, minArea: 9, error: 0.5, cornerAngle: 60, precision: 2, mode: 'knockout', spread: 0 },
      oneColour: { ink: 0x000000, gapPx: 4, production: true, outputWidthMm: 200 },
    }
    const r = runFlat(new FakeImageData(d, 240, 160) as unknown as ImageData, o)
    // Checked after every trace: two rounds in places, then every gap undone (and not checked again).
    expect(checks.calls).toBe(3)
    expect(r.oneColour?.gaps).toBe(0)
    // No gap left: the centre is joined to the ring again.
    expect(shapesFromSvg(r.svg).filter((s) => s.color === 0x000000).length).toBe(1)
    expect(r.oneColour?.flags.filter((f) => f.reason === 'cut-limit').map((f) => [f.x, f.y])).toEqual([
      [145, 80],
      [95, 80],
      [120, 105],
    ])
  })
})
