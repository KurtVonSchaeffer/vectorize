/**
 * The WebAssembly SIMD blur (simd-blur.ts) gives the TypeScript blur's values to within float
 * rounding, and a whole trace comes out byte for byte the same either way. The fidelity fixtures
 * are checked the same way against their golden hashes (vectorize/__tests__/fidelity/golden.test.ts).
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
  it('falls back to the TypeScript blur when the module does not load (no WebAssembly SIMD)', async () => {
    const src = field(64, 48)
    const ts = blur(src, 64, 48, 0.7)
    expect(await useSimdBlur(true, new Uint8Array([0, 1, 2, 3]))).toBe(false)
    expect(blur(src, 64, 48, 0.7)).toEqual(ts)
  })

  it('loads the Highway build', async () => {
    expect(await useSimdBlur(true, WASM)).toBe(true)
  })

  it('matches the TypeScript blur, whole image and inside a box, at several widths and strengths', async () => {
    let largest = 0
    for (const [w, h] of [[37, 23], [64, 48], [301, 199]])
      for (const sigma of [0.5, 0.7, 1.6, 3])
        for (const box of [undefined, [5, 4, Math.floor(w / 2), Math.floor(h / 2)]] as const) {
          const src = field(w, h)
          await useSimdBlur(false)
          const ts = blur(src, w, h, sigma, box ? [...box] : undefined)
          await useSimdBlur(true, WASM)
          const simd = blur(src, w, h, sigma, box ? [...box] : undefined)
          let max = 0
          for (let i = 0; i < ts.length; i++) max = Math.max(max, Math.abs(ts[i] - simd[i]))
          expect(max).toBeLessThan(1e-5)
          largest = Math.max(largest, max)
        }
    // 32-bit sums round differently somewhere, which shows the WebAssembly blur really ran.
    expect(largest).toBeGreaterThan(0)
  })

  it('traces the example badge to the same SVG, byte for byte', async () => {
    const img = paint(300, 200, [255, 248, 231], [
      { rings: [regularStar(150, 100, 85, 16, 0.45)], color: [240, 140, 0] as RGB },
      { rings: [circle(150, 100, 60)], color: [43, 45, 66] as RGB },
      { rings: [circle(150, 100, 55), circle(150, 100, 52, true)], color: [255, 248, 231] as RGB },
    ], 3)
    const o = productionOptions(img)
    for (const mode of ['stacked', 'knockout'] as const) {
      const opts = { ...o, trace: { ...o.trace, mode, spread: mode === 'knockout' ? 0.15 : 0 } }
      await useSimdBlur(false)
      const ts = runFlat(img, opts).svg
      await useSimdBlur(true, WASM)
      expect(runFlat(img, opts).svg).toBe(ts)
    }
  }, 120_000)
})
