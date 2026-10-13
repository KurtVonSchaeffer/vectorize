import { beforeAll, describe, expect, it } from 'vitest'
import type { LabelMap } from '../../trace'
import { detectArt } from '../detect'
import { runFlat, type FlatOptions } from '../pipeline'

// Known causes of quality loss, found with bench/diagnose.html (see docs/v6-diagnosis.md).
// Each test states the correct behaviour and is marked `it.fails` because the engine doesn't
// do it yet. When a fix lands, its test starts "failing" — switch it to a plain `it`.

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

type RGBA = [number, number, number, number]
function image(w: number, h: number, paint: (x: number, y: number) => RGBA): ImageData {
  const d = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d.set(paint(x, y), (y * w + x) * 4)
  return new FakeImageData(d, w, h) as unknown as ImageData
}

const WHITE: RGBA = [255, 255, 255, 255]
const CREAM: RGBA = [255, 248, 231, 255]
const DARK_NAVY: RGBA = [43, 45, 66, 255] // channel spread 23: counts as "gray"
const NAVY: RGBA = [31, 42, 92, 255]
const ORANGE: RGBA = [240, 140, 0, 255]

/** The app's defaults for flat art (Detail 0.5, Corners 0.75): 16 px² specks, σ 0.7 smoothing. */
const opts = (): FlatOptions => ({
  lineArt: false,
  removeColors: [],
  transparent: false,
  quantize: { maxColors: 12, mergeDelta: 10, whiteIsPaper: false, palette: null, overrides: {}, minArea: 16, upscale: 1, smoothing: 0 },
  trace: { smoothing: 0.7, minArea: 16, error: 0.5, cornerAngle: 61, precision: 2 },
})

describe('known issue: artwork misread as line art', () => {
  it.fails('a dark navy badge with a small orange accent is flat colour, not line art', () => {
    // Line art is reduced to black ink, so the orange disappears and the navy turns black.
    const badge = image(300, 200, (x, y) => (Math.hypot(x - 150, y - 100) < 70 ? DARK_NAVY : x > 20 && x < 46 && y > 20 && y < 46 ? ORANGE : CREAM))
    expect(detectArt(badge).kind).toBe('flat')
  })

  it.fails('navy lettering on white is flat colour, not line art', () => {
    // Thin navy strokes covering ~3% of a white image.
    const text = image(400, 100, (x, y) => (y > 40 && y < 60 && x % 12 < 2 ? NAVY : WHITE))
    expect(detectArt(text).kind).toBe('flat')
  })
})

describe('known issue: small detail removed as specks', () => {
  it.fails('keeps a 3×3 letter counter and a 3×3 dot', () => {
    // An "o" 11 px wide with a 3×3 counter, and a full stop 3 px wide: normal at 10–12 px text.
    const art = image(60, 30, (x, y) => {
      if (x >= 10 && x < 21 && y >= 10 && y < 21) return x >= 14 && x < 17 && y >= 14 && y < 17 ? WHITE : NAVY
      return x >= 30 && x < 33 && y >= 18 && y < 21 ? NAVY : WHITE
    })
    let map: LabelMap | null = null
    runFlat(art, opts(), (m) => (map = m))
    const m = map as unknown as LabelMap
    const at = (x: number, y: number) => m.colors[m.labels[y * m.w + x]]
    expect(at(15, 15)).toBe(at(0, 0)) // counter stays open
    expect(at(31, 19)).toBe(at(12, 12)) // dot stays
  })
})

describe('known issue: thin lines erased by edge smoothing', () => {
  it.fails('keeps a 1 px anti-aliased line', () => {
    // A solid navy block, and a 1 px navy line between two pixel rows: each row is a 50% blend
    // of navy and white, which is how a thin rule or hairline usually arrives.
    const half: RGBA = [143, 149, 174, 255]
    const art = image(160, 60, (x, y) => (x >= 120 && x < 150 && y >= 15 && y < 45 ? NAVY : x >= 10 && x < 110 && (y === 29 || y === 30) ? half : WHITE))
    const r = runFlat(art, opts())
    const navy = r.svg.split('\n').find((l) => /fill="#1F2A5C"/i.test(l)) ?? ''
    // The navy layer must cover the line too: two shapes, block and line.
    expect((navy.match(/M/g) ?? []).length).toBeGreaterThanOrEqual(2)
  })
})
