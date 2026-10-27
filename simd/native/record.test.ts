// Native SIMD shootout, step 1: run the flat pipeline at production settings on each input and keep
// every blur() call it makes (arguments and the TypeScript result) in data/. Runs only when asked:
//   RECORD=1 npx vitest run simd/native/record.test.ts
import { mkdirSync, writeFileSync } from 'node:fs'
import { it, vi } from 'vitest'
import { blur } from '../../src/trace/index'
import { runFlat } from '../../src/vectorize/pipeline'
import { productionOptions } from '../../src/vectorize/__tests__/fidelity/harness'
import { AVAILABLE, DATA, writeOutputs, writeRecording, type Call } from './cases'

// blur() hands every call to simdBlur first; returning null lets the TypeScript run as usual.
const seen: Omit<Call, 'sigma' | 'box'>[] = []
let w = 0
let h = 0
vi.mock('../../src/trace/simd-blur', () => ({
  useSimdBlur: async () => false,
  simdBlur: (src: Float32Array, sw: number, sh: number, k: Float32Array, r: number, x0: number, x1: number, y0: number, y1: number, by0: number, by1: number) => {
    w = sw
    h = sh
    seen.push({ src: src.slice(), k: k.slice(), r, x0, x1, y0, y1, by0, by1 })
    return null
  },
}))

it.skipIf(!process.env.RECORD)('records the tracer\'s blur calls', { timeout: 1_800_000 }, async () => {
  mkdirSync(DATA, { recursive: true })
  const summary: Record<string, unknown>[] = []
  for (const c of AVAILABLE) {
    const img = await c.image()
    const opts = productionOptions(img)
    seen.length = 0
    runFlat(img, opts)
    const sigma = opts.trace.smoothing
    const calls: Call[] = seen.map((s) => {
      // Rebuild a box that gives blur() the same x0..x1 (x0 = max(0, bx0 − r), x1 = min(w − 1, bx1 + r)).
      const bx0 = s.x0 === 0 ? 0 : s.x0 + s.r
      const bx1 = s.x1 === w - 1 ? w - 1 : s.x1 - s.r
      return { ...s, sigma, box: [bx0, s.by0, bx1, s.by1] }
    })
    // The file stores src only inside the box and outputs only inside x0..x1 × y0..y1: check that
    // nothing outside is non-zero, and that the stored sigma and box reproduce each call exactly.
    const refs = calls.map((call) => {
      let outside = 0
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) if (call.src[y * w + x] !== 0 && (y < call.by0 || y > call.by1 || x < call.box[0] || x > call.box[2])) outside++
      if (outside) throw new Error(`${c.name}: ${outside} non-zero source pixels outside the box`)
      seen.length = 0
      const out = blur(call.src, w, h, sigma, call.box)
      const again = seen[0]
      if (!again || again.r !== call.r || again.x0 !== call.x0 || again.x1 !== call.x1 || again.y0 !== call.y0 || again.y1 !== call.y1 || again.k.some((v, i) => v !== call.k[i]))
        throw new Error(`${c.name}: rebuilt box or sigma doesn't reproduce the call`)
      return out
    })
    const rec = { w, h, calls }
    writeFileSync(new URL(`${c.name}.bin`, DATA), writeRecording(rec))
    writeFileSync(new URL(`${c.name}.ref`, DATA), writeOutputs(refs, rec))
    const px = calls.reduce((s, k) => s + (k.x1 - k.x0 + 1) * (k.y1 - k.y0 + 1), 0)
    summary.push({ case: c.name, size: `${w}×${h}`, calls: calls.length, sigma, r: calls[0]?.r, 'blurred px': px })
  }
  writeFileSync(new URL('cases.json', DATA), JSON.stringify(summary, null, 2))
  console.table(summary)
})
