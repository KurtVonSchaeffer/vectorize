/**
 * Every blur engine (blur-engines.ts) gives the TypeScript blur's values to within float rounding,
 * and a whole trace comes out byte for byte the same with each. The fidelity fixtures are checked
 * the same way against their golden hashes (vectorize/__tests__/fidelity/golden.test.ts).
 */
import { readFileSync } from 'node:fs'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { blur } from '../index'
import { activeBlurEngine, blurEngine, blurEngines, combinedBlurEngine, DEFAULT_BLUR_ENGINE, registerBlurEngine, useBlurEngine, wasmBlurEngine, type BlurEngine } from '../blur-engines'
import { blurEngineChoice } from '../../quality/flags'
import { runFlat } from '../../vectorize/pipeline'
import { circle, installImageData, paint, productionOptions, regularStar, type RGB } from '../../vectorize/__tests__/fidelity/harness'

const bytes = (e: BlurEngine) => readFileSync(new URL(`../../../public/simd/${e.file}`, import.meta.url))
const WASM = blurEngines().filter((e) => e.file)

beforeAll(installImageData)
afterEach(() => useBlurEngine('typescript'))

/** A field with soft edges and a hard step, so both passes and the clamped borders are exercised. */
function field(w: number, h: number): Float32Array {
  const f = new Float32Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) f[y * w + x] = (Math.hypot(x - w / 3, y - h / 2) < h / 3 ? 1 : 0) * (0.5 + 0.5 * Math.sin(x / 7))
  return f
}

describe('blur engines', () => {
  it('the built-in engines are registered, Highway the default', () => {
    expect(blurEngines().map((e) => e.id)).toEqual(['typescript', 'highway', 'rust-wide', 'rust-fearless'])
    expect(DEFAULT_BLUR_ENGINE).toBe('highway')
  })

  it('an engine that does not load (no WebAssembly SIMD) leaves the TypeScript blur running', async () => {
    const src = field(64, 48)
    const ts = blur(src, 64, 48, 0.7)
    registerBlurEngine(wasmBlurEngine('broken', 'Not a module', 'blur-highway.wasm'))
    expect(await useBlurEngine('broken', new Uint8Array([0, 1, 2, 3]))).toBe(false)
    expect(activeBlurEngine()).toBe('typescript')
    expect(blur(src, 64, 48, 0.7)).toEqual(ts)
  })

  it('an unknown engine leaves the TypeScript blur running', async () => {
    expect(await useBlurEngine('no-such-engine')).toBe(false)
    expect(activeBlurEngine()).toBe('typescript')
  })

  for (const engine of WASM) {
    it(`${engine.label}: matches the TypeScript blur, whole image and inside a box, at several widths and strengths`, async () => {
      let largest = 0
      for (const [w, h] of [[37, 23], [64, 48], [301, 199]])
        for (const sigma of [0.5, 0.7, 1.6, 3])
          for (const box of [undefined, [5, 4, Math.floor(w / 2), Math.floor(h / 2)]] as const) {
            const src = field(w, h)
            await useBlurEngine('typescript')
            const ts = blur(src, w, h, sigma, box ? [...box] : undefined)
            expect(await useBlurEngine(engine.id, bytes(engine))).toBe(true)
            const fast = blur(src, w, h, sigma, box ? [...box] : undefined)
            let max = 0
            for (let i = 0; i < ts.length; i++) max = Math.max(max, Math.abs(ts[i] - fast[i]))
            expect(max).toBeLessThan(1e-5)
            largest = Math.max(largest, max)
          }
      // 32-bit sums round differently somewhere, which shows the WebAssembly blur really ran.
      expect(largest).toBeGreaterThan(0)
    })

    it(`${engine.label}: traces the example badge to the same SVG, byte for byte`, async () => {
      const img = paint(300, 200, [255, 248, 231], [
        { rings: [regularStar(150, 100, 85, 16, 0.45)], color: [240, 140, 0] as RGB },
        { rings: [circle(150, 100, 60)], color: [43, 45, 66] as RGB },
        { rings: [circle(150, 100, 55), circle(150, 100, 52, true)], color: [255, 248, 231] as RGB },
      ], 3)
      const o = productionOptions(img)
      for (const mode of ['stacked', 'knockout'] as const) {
        const opts = { ...o, trace: { ...o.trace, mode, spread: mode === 'knockout' ? 0.15 : 0 } }
        await useBlurEngine('typescript')
        const ts = runFlat(img, opts).svg
        await useBlurEngine(engine.id, bytes(engine))
        expect(runFlat(img, opts).svg).toBe(ts)
      }
    }, 120_000)
  }

  it('a combined engine runs the engine its rule picks for each blur', async () => {
    for (const e of WASM) await blurEngine(e.id)!.load(bytes(e))
    const calls: string[] = []
    const spy = (id: string) => registerBlurEngine({ ...blurEngine(id)!, id: `spy-${id}`, blur: (...a) => (calls.push(id), blurEngine(id)!.blur(...a)) })
    spy('highway')
    spy('rust-wide')
    registerBlurEngine(combinedBlurEngine('by-size', 'Highway for large, Rust + wide for small', ['spy-highway', 'spy-rust-wide'], (w, h) => (w * h >= 10_000 ? 'spy-highway' : 'spy-rust-wide')))
    expect(await useBlurEngine('by-size')).toBe(true)
    const small = field(40, 30), large = field(200, 100)
    await useBlurEngine('typescript')
    const ts = [blur(small, 40, 30, 0.7), blur(large, 200, 100, 0.7)]
    await useBlurEngine('by-size')
    const got = [blur(small, 40, 30, 0.7), blur(large, 200, 100, 0.7)]
    expect(calls).toEqual(['rust-wide', 'highway'])
    for (const i of [0, 1]) for (let j = 0; j < ts[i].length; j++) expect(Math.abs(ts[i][j] - got[i][j])).toBeLessThan(1e-5)
  })

  it('a load that finishes after another engine was chosen changes nothing', async () => {
    let finish: (ok: boolean) => void = () => {}
    registerBlurEngine({ id: 'slow', label: 'slow', load: () => new Promise((done) => (finish = done)), blur: () => new Float32Array(0) })
    const slow = useBlurEngine('slow')
    expect(await useBlurEngine('highway', bytes(blurEngine('highway')!))).toBe(true)
    finish(true)
    await slow
    expect(activeBlurEngine()).toBe('highway')
  })
})

describe('choosing the engine (quality/flags.ts)', () => {
  const prod = { value: undefined, dev: false }
  it('production ignores the address: the default engine', () => {
    expect(blurEngineChoice('?blur=rust-wide', prod)).toBeUndefined()
  })
  it('a build can set the engine, and still ignores the address', () => {
    expect(blurEngineChoice('?blur=rust-wide', { value: 'typescript', dev: false })).toBe('typescript')
  })
  it('the dev server and a preview build take ?blur=', () => {
    expect(blurEngineChoice('?blur=rust-wide', { value: undefined, dev: true })).toBe('rust-wide')
    expect(blurEngineChoice('?blur=rust-wide', { value: 'preview', dev: false })).toBe('rust-wide')
    expect(blurEngineChoice('', { value: 'preview', dev: false })).toBeUndefined()
  })
})
