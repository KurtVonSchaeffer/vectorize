// CPU profile of the flat-colour pipeline: where does processing time go?
// Runs only when asked:  PROFILE=1 npx vitest run bench/profile.test.ts
// Prints self time per function (top entries) and per pipeline file for three typical images.
import { Session } from 'node:inspector/promises'
import { it } from 'vitest'
import { runFlat, type FlatOptions } from '../src/vectorize/pipeline'

class FakeImageData {
  constructor(
    public data: Uint8ClampedArray,
    public width: number,
    public height: number,
  ) {}
}
;(globalThis as unknown as { ImageData: unknown }).ImageData = FakeImageData

const cover = (x: number, y: number, cx: number, cy: number, r: number) => Math.max(0, Math.min(1, r + 0.5 - Math.hypot(x + 0.5 - cx, y + 0.5 - cy)))

/** A JPEG-like three-colour badge with a thin ring and small strokes. */
function badge(w: number, h: number): ImageData {
  const d = new Uint8ClampedArray(w * h * 4)
  let s = 7
  const noise = () => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5) * 10
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const a = cover(x, y, w / 2, h / 2, h * 0.3)
      const b = cover(x, y, w / 2, h / 2, h * 0.12)
      let c = [255, 248, 231].map((v, i) => v * (1 - a) + [43, 45, 66][i] * a)
      c = c.map((v, i) => v * (1 - b) + [240, 140, 0][i] * b)
      if (Math.abs(Math.hypot(x - w / 2, y - h / 2) - h * 0.25) < 0.6) c = [255, 248, 231]
      if (x % 23 < 2 && y > h * 0.8 && y < h * 0.9) c = [31, 42, 92]
      d.set([...c.map((v) => v + noise()), 255], (y * w + x) * 4)
    }
  return new FakeImageData(d, w, h) as unknown as ImageData
}

/** Many small shapes, as text-heavy logos have. */
function lettering(w: number, h: number): ImageData {
  const d = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const on = (x % 14 < 3 || y % 18 < 2) && x % 140 < 120 && y % 36 < 26
      d.set(on ? [31, 42, 92, 255] : [255, 255, 255, 255], (y * w + x) * 4)
    }
  return new FakeImageData(d, w, h) as unknown as ImageData
}

const opts: FlatOptions = {
  lineArt: false,
  removeColors: [],
  transparent: false,
  quantize: { maxColors: 12, mergeDelta: 10, whiteIsPaper: false, palette: null, overrides: {}, minArea: 16, upscale: 1, smoothing: 0 },
  trace: { smoothing: 0.7, minArea: 2, detailArea: 16, error: 0.5, cornerAngle: 60, precision: 2 },
}

it.skipIf(!process.env.PROFILE)('profile runFlat', { timeout: 600000 }, async () => {
  const session = new Session()
  session.connect()
  await session.post('Profiler.enable')
  await session.post('Profiler.setSamplingInterval', { interval: 200 })
  const images = { 'badge 1200×800': badge(1200, 800), 'badge 2000×1333': badge(2000, 1333), 'lettering 1200×800': lettering(1200, 800) }
  for (const [name, img] of Object.entries(images)) {
    runFlat(img, opts) // warm up the JIT
    await session.post('Profiler.start')
    const t0 = performance.now()
    for (let i = 0; i < 3; i++) runFlat(img, opts)
    const ms = (performance.now() - t0) / 3
    const { profile } = await session.post('Profiler.stop')
    // Self time per function and per source file.
    const byFn = new Map<string, number>()
    const byFile = new Map<string, number>()
    const dt = new Map<number, number>()
    profile.samples!.forEach((id, i) => dt.set(id, (dt.get(id) ?? 0) + (profile.timeDeltas![i] ?? 0)))
    let total = 0
    for (const node of profile.nodes) {
      const t = dt.get(node.id) ?? 0
      if (!t) continue
      total += t
      const file = node.callFrame.url.split('/src/').pop()?.split('?')[0] || node.callFrame.url || '(native)'
      const fn = `${node.callFrame.functionName || '(anonymous)'} ${file}:${node.callFrame.lineNumber + 1}`
      byFn.set(fn, (byFn.get(fn) ?? 0) + t)
      byFile.set(file, (byFile.get(file) ?? 0) + t)
    }
    const top = (m: Map<string, number>, n: number) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `  ${((v / total) * 100).toFixed(1).padStart(5)}%  ${k}`)
    console.log(`PROFILE ${name}: ${ms.toFixed(0)} ms per run\n by file:\n${top(byFile, 8).join('\n')}\n by function:\n${top(byFn, 14).join('\n')}`)
  }
  session.disconnect()
})
