/**
 * SIMD blur (behind the simd-blur flag): the Highway build in public/simd gives the TypeScript blur's
 * values to within float rounding, and a whole trace comes out the same either way.
 */
import { readFileSync } from 'node:fs'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { blur } from '../index'
import { useSimdBlur } from '../simd-blur'
import { runFlat } from '../../vectorize/pipeline'
import { circle, installImageData, paint, productionOptions, regularStar, type RGB } from '../../vectorize/__tests__/fidelity/harness'

const WASM = readFileSync(new URL('../../../public/simd/blur-highway.wasm', import.meta.url))

beforeAll(installImageData)
afterEach(() => useSimdBlur(false))

/** A field with soft edges and a hard step, so both passes and the clamped borders are exercised. */
function field(w: number, h: number): Float32Array {
  const f = new Float32Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) f[y * w + x] = (Math.hypot(x - w / 3, y - h / 2) < h / 3 ? 1 : 0) * (0.5 + 0.5 * Math.sin(x / 7))
  return f
}

describe('simd blur', () => {
  it('loads the Highway build', async () => {
    expect(await useSimdBlur(true, WASM)).toBe(true)
  })

  it('matches the TypeScript blur, whole image and inside a box, at several widths and strengths', async () => {
    for (const [w, h] of [[37, 23], [64, 48], [301, 199]])
      for (const sigma of [0.5, 0.7, 1.6, 3])
        for (const box of [undefined, [5, 4, Math.floor(w / 2), Math.floor(h / 2)]] as const) {
          const src = field(w, h)
          await useSimdBlur(false)
          const ts = blur(src, w, h, sigma, box ? [...box] : undefined)
          await useSimdBlur(true, WASM)
          const simd = blur(src, w, h, sigma, box ? [...box] : undefined)
          expect(simd).not.toBe(ts)
          let max = 0
          for (let i = 0; i < ts.length; i++) max = Math.max(max, Math.abs(ts[i] - simd[i]))
          expect(max).toBeLessThan(1e-5)
        }
  })

  it('traces the example badge to the same shapes, every point within rounding', async () => {
    const img = paint(300, 200, [255, 248, 231], [
      { rings: [regularStar(150, 100, 85, 16, 0.45)], color: [240, 140, 0] as RGB },
      { rings: [circle(150, 100, 60)], color: [43, 45, 66] as RGB },
      { rings: [circle(150, 100, 55), circle(150, 100, 52, true)], color: [255, 248, 231] as RGB },
    ], 3)
    const o = productionOptions(img)
    const numbers = (svg: string) => svg.match(/-?\d+(\.\d+)?/g)!.map(Number)
    for (const mode of ['stacked', 'knockout'] as const) {
      const opts = { ...o, trace: { ...o.trace, mode, spread: mode === 'knockout' ? 0.15 : 0 } }
      await useSimdBlur(false)
      const ts = runFlat(img, opts).svg
      await useSimdBlur(true, WASM)
      const simd = runFlat(img, opts).svg
      // Same paths and commands; coordinates may differ in the last printed digit.
      expect(simd.replace(/-?\d+(\.\d+)?/g, '#')).toBe(ts.replace(/-?\d+(\.\d+)?/g, '#'))
      const a = numbers(ts), b = numbers(simd)
      expect(Math.max(...a.map((v, i) => Math.abs(v - b[i])))).toBeLessThanOrEqual(0.02)
    }
  }, 120_000)
})
