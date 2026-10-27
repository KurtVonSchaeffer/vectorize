// Native SIMD shootout baselines (simd/native/README.md): the current TypeScript blur, and the
// Highway WebAssembly build the app already ships behind the simd-blur flag, both in V8 (Node),
// with the same steps as the native drivers. Runs only when asked (simd/native/run.mjs does):
//   BASELINE=1 npx vitest run simd/native/baseline.test.ts
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { it } from 'vitest'
import { blur } from '../../src/trace/index'
import { simdBlur, useSimdBlur } from '../../src/trace/simd-blur'
import { AVAILABLE, DATA, readOutputs, readRecording, writeOutputs, type Recording } from './cases'

const OUT = new URL('./out/', import.meta.url)
const median = (xs: number[]) => xs[xs.length >> 1]

function measure(engine: string, target: string, name: string, rec: Recording, ref: Float32Array[], reps: number, run: (i: number) => Float32Array) {
  let maxDiff = 0, flips = 0, checked = 0
  const outs = rec.calls.map((c, i) => {
    const out = run(i)
    for (let y = c.y0; y <= c.y1; y++)
      for (let x = c.x0; x <= c.x1; x++, checked++) {
        const g = out[y * rec.w + x], want = ref[i][y * rec.w + x]
        maxDiff = Math.max(maxDiff, Math.abs(g - want))
        if (g >= 0.5 !== want >= 0.5) flips++
      }
    return out
  })
  mkdirSync(new URL(`${engine}/`, OUT), { recursive: true })
  writeFileSync(new URL(`${engine}/${name}.out`, OUT), writeOutputs(outs, rec))
  const pass = () => rec.calls.forEach((_, i) => run(i))
  const t0 = performance.now()
  for (let i = 0; i < 10 || performance.now() - t0 < 500; i++) pass()
  const ms: number[] = []
  for (let i = 0; i < reps; i++) {
    const t = performance.now()
    pass()
    ms.push(performance.now() - t)
  }
  ms.sort((a, b) => a - b)
  return { engine, target, case: name, w: rec.w, h: rec.h, calls: rec.calls.length, reps, median_ms: median(ms), min_ms: ms[0], p90_ms: ms[Math.floor(ms.length * 0.9)], max_diff: maxDiff, flips, checked, peak_mb: process.memoryUsage().rss / 1048576 }
}

it.skipIf(!process.env.BASELINE)('times the TypeScript and WebAssembly baselines', { timeout: 3_600_000 }, async () => {
  const round = process.env.ROUND ?? '0'
  const wasm = readFileSync(new URL('../../public/simd/blur-highway.wasm', import.meta.url))
  for (const c of AVAILABLE) {
    if (!existsSync(new URL(`${c.name}.bin`, DATA))) continue
    const rec = readRecording(readFileSync(new URL(`${c.name}.bin`, DATA)))
    const ref = readOutputs(readFileSync(new URL(`${c.name}.ref`, DATA)), rec)
    const reps = rec.w * rec.h > 4e6 ? 15 : 30
    await useSimdBlur(false)
    const ts = measure('typescript', 'V8 scalar', c.name, rec, ref, reps, (i) => blur(rec.calls[i].src, rec.w, rec.h, rec.calls[i].sigma, rec.calls[i].box))
    await useSimdBlur(true, wasm)
    const wa = measure('highway-wasm', 'WebAssembly SIMD128 in V8', c.name, rec, ref, reps, (i) => {
      const k = rec.calls[i]
      return simdBlur(k.src, rec.w, rec.h, k.k, k.r, k.x0, k.x1, k.y0, k.y1, k.by0, k.by1)!
    })
    await useSimdBlur(false)
    for (const row of [ts, wa]) appendFileSync(new URL('results.jsonl', OUT), JSON.stringify({ ...row, round: +round }) + '\n')
  }
})
