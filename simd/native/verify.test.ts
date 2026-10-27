// Native SIMD shootout, output equivalence (simd/native/README.md): each engine's saved blur outputs
// are fed back into the tracer in place of the TypeScript blur, and the SVG compared with the plain
// TypeScript run: same paths and commands, coordinates within 0.02 px. Runs only when asked:
//   VERIFY=1 npx vitest run simd/native/verify.test.ts
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import { runFlat } from '../../src/vectorize/pipeline'
import { productionOptions } from '../../src/vectorize/__tests__/fidelity/harness'
import { AVAILABLE, DATA, readOutputs, readRecording } from './cases'

const OUT = new URL('./out/', import.meta.url)

// Outputs handed back in call order, or null for the TypeScript blur.
let queue: Float32Array[] | null = null
vi.mock('../../src/trace/simd-blur', () => ({
  useSimdBlur: async () => false,
  simdBlur: () => (queue ? (queue.shift() ?? null) : null),
}))

const shape = (svg: string) => svg.replace(/-?\d+(\.\d+)?/g, '#')
const numbers = (svg: string) => svg.match(/-?\d+(\.\d+)?/g)?.map(Number) ?? []

it.skipIf(!process.env.VERIFY)('traces the same shapes with every engine\'s blur', { timeout: 3_600_000 }, async () => {
  const engines = readdirSync(OUT, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  const rows: Record<string, unknown>[] = []
  for (const c of AVAILABLE) {
    if (!existsSync(new URL(`${c.name}.bin`, DATA))) continue
    const rec = readRecording(readFileSync(new URL(`${c.name}.bin`, DATA)))
    const img = await c.image()
    const opts = productionOptions(img)
    queue = null
    const ts = runFlat(img, opts).svg
    for (const e of engines) {
      const file = new URL(`${e}/${c.name}.out`, OUT)
      if (!existsSync(file)) continue
      queue = readOutputs(readFileSync(file), rec)
      const svg = runFlat(img, opts).svg
      const left = queue.length
      queue = null
      const same = shape(svg) === shape(ts)
      const a = numbers(ts), b = numbers(svg)
      // A loop, not Math.max(...): large SVGs have more numbers than fit in the call stack.
      let maxMove = same ? 0 : NaN
      if (same) for (let i = 0; i < a.length; i++) maxMove = Math.max(maxMove, Math.abs(a[i] - b[i]))
      rows.push({ case: c.name, engine: e, 'same paths': same, 'max coordinate change (px)': maxMove, 'unused outputs': left })
    }
  }
  writeFileSync(new URL('verify.json', OUT), JSON.stringify(rows, null, 2))
  console.table(rows)
  for (const r of rows) {
    expect(r['unused outputs'], `${r.case} ${r.engine}`).toBe(0)
    expect(r['same paths'], `${r.case} ${r.engine}`).toBe(true)
    expect(r['max coordinate change (px)'] as number, `${r.case} ${r.engine}`).toBeLessThanOrEqual(0.02)
  }
})
