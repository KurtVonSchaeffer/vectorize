// Every blur engine side by side (src/trace/blur-engines.ts): time per blur and largest difference
// from the TypeScript blur, on the same fields. Runs only when asked:
//   BENCH=1 npx vitest run bench/blur-engines.test.ts
// Node's WebAssembly SIMD is V8's, as in Chrome; other browsers may rank engines differently.
import { readFileSync } from 'node:fs'
import { it } from 'vitest'
import { blur } from '../src/trace/index'
import { blurEngines, useBlurEngine } from '../src/trace/blur-engines'

/** Soft discs and a hard step: what blur() is given in the tracer (anti-aliased coverage). */
function field(w: number, h: number): Float32Array {
  const f = new Float32Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) f[y * w + x] = Math.hypot((x % 97) - 48, (y % 89) - 44) < 30 ? 1 : x > w / 2 ? 0.5 : 0
  return f
}

const median = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)]

it.skipIf(!process.env.BENCH)('blur engines', { timeout: 600000 }, async () => {
  const cases = [[600, 400, 0.7], [2000, 1333, 0.7], [2000, 1333, 1.6]] as const
  const rows: string[] = []
  for (const [w, h, sigma] of cases) {
    const src = field(w, h)
    await useBlurEngine('typescript')
    const ts = blur(src, w, h, sigma)
    for (const engine of blurEngines()) {
      if (!(await useBlurEngine(engine.id, engine.file ? readFileSync(new URL(`../public/simd/${engine.file}`, import.meta.url)) : undefined))) {
        rows.push(`${w}x${h} σ${sigma}  ${engine.label.padEnd(42)} did not load`)
        continue
      }
      let out = blur(src, w, h, sigma) // warm up
      const times: number[] = []
      for (let i = 0; i < 15; i++) {
        const t = performance.now()
        out = blur(src, w, h, sigma)
        times.push(performance.now() - t)
      }
      let diff = 0
      for (let i = 0; i < ts.length; i++) diff = Math.max(diff, Math.abs(ts[i] - out[i]))
      rows.push(`${w}x${h} σ${sigma}  ${engine.label.padEnd(42)} ${median(times).toFixed(2).padStart(7)} ms   max diff ${diff.toExponential(1)}`)
    }
  }
  console.log(`BENCH blur engines (median of 15)\n${rows.join('\n')}`)
})
