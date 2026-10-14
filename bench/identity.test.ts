// Output identity check for performance work: traces a varied set of images and writes (or
// compares against) their SVGs. Runs only when asked:
//   IDENTITY=save  npx vitest run bench/identity.test.ts   (record the current outputs)
//   IDENTITY=check npx vitest run bench/identity.test.ts   (fail on any byte that changed)
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { runFlat, type FlatOptions } from '../src/vectorize/pipeline'

class FakeImageData {
  constructor(
    public data: Uint8ClampedArray,
    public width: number,
    public height: number,
  ) {}
}
;(globalThis as unknown as { ImageData: unknown }).ImageData = FakeImageData

const FILE = process.env.IDENTITY_FILE ?? 'node_modules/.cache/identity.json'
const cover = (x: number, y: number, cx: number, cy: number, r: number) => Math.max(0, Math.min(1, r + 0.5 - Math.hypot(x + 0.5 - cx, y + 0.5 - cy)))
const image = (w: number, h: number, f: (x: number, y: number) => number[]) => {
  const d = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d.set([...f(x, y), 255].slice(0, 4), (y * w + x) * 4)
  return new FakeImageData(d, w, h) as unknown as ImageData
}
const mix = (a: number[], b: number[], t: number) => a.map((v, i) => v + (b[i] - v) * t)
let seed = 11
const noise = (amp: number) => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * amp

const IMAGES: Record<string, () => ImageData> = {
  'noisy badge 800': () => image(800, 533, (x, y) => {
    let c = mix([255, 248, 231], [43, 45, 66], cover(x, y, 400, 266, 160))
    c = mix(c, [240, 140, 0], cover(x, y, 400, 266, 64))
    if (Math.abs(Math.hypot(x - 400, y - 266) - 133) < 0.6) c = [255, 248, 231]
    return c.map((v) => v + noise(10))
  }),
  'lettering 600': () => image(600, 400, (x, y) => ((x % 14 < 3 || y % 18 < 2) && x % 140 < 120 && y % 36 < 26 ? [31, 42, 92] : [255, 255, 255])),
  'similar tints': () => image(400, 120, (x, y) => (y < 20 || y >= 100 ? [255, 255, 255] : x < 100 ? [28, 126, 214] : x < 180 ? [42, 134, 217] : x < 280 ? [232, 64, 47] : [240, 96, 63])),
  'gradient pill': () => image(420, 160, (x, y) => {
    const inPill = Math.max(cover(x, y, 80, 80, 50), cover(x, y, 340, 80, 50), x >= 80 && x < 340 && Math.abs(y + 0.5 - 80) < 50 ? 1 : 0)
    return mix([255, 255, 255], mix([236, 72, 153], [88, 28, 135], (x - 30) / 360), inPill).map((v) => v + noise(4))
  }),
  'thin lines': () => image(300, 150, (x, y) => (Math.abs(y - 30) < 0.5 || Math.abs(y - 130 + (x - 20) * 0.66) < 0.6 ? [31, 42, 92] : [255, 255, 255])),
  'dots and counters': () => image(120, 60, (x, y) => {
    if (x >= 10 && x < 21 && y >= 10 && y < 21) return x >= 14 && x < 17 && y >= 14 && y < 17 ? [255, 255, 255] : [31, 42, 92]
    return (x >= 30 && x < 33 && y >= 18 && y < 21) || cover(x, y, 80, 30, 2) > 0.5 ? [31, 42, 92] : [255, 255, 255]
  }),
}

const OPTS: FlatOptions[] = [
  {
    lineArt: false,
    removeColors: [],
    transparent: false,
    quantize: { maxColors: 12, mergeDelta: 10, whiteIsPaper: false, palette: null, overrides: {}, minArea: 16, upscale: 1, smoothing: 0 },
    trace: { smoothing: 0.7, minArea: 2, detailArea: 16, error: 0.5, cornerAngle: 60, precision: 2 },
  },
  {
    lineArt: false,
    removeColors: [],
    transparent: false,
    quantize: { maxColors: 12, mergeDelta: 10, whiteIsPaper: false, palette: null, overrides: {}, minArea: 16, upscale: 1, smoothing: 0 },
    trace: { smoothing: 0.7, minArea: 2, detailArea: 16, error: 0.5, cornerAngle: 60, precision: 2, mode: 'knockout', spread: 0.15 },
  },
]

it.skipIf(!process.env.IDENTITY)('flat tracer output identity', { timeout: 600000 }, () => {
  const out: Record<string, string> = {}
  for (const [name, make] of Object.entries(IMAGES)) {
    seed = 11
    const img = make()
    OPTS.forEach((o, i) => (out[`${name} #${i}`] = runFlat(img, o).svg))
  }
  if (process.env.IDENTITY === 'save') {
    writeFileSync(FILE, JSON.stringify(out))
    return
  }
  expect(existsSync(FILE)).toBe(true)
  const saved = JSON.parse(readFileSync(FILE, 'utf8')) as Record<string, string>
  for (const k of Object.keys(out)) expect(out[k], k).toBe(saved[k])
})
