import { useSimdBlur } from '../trace/simd-blur'
import { runFlat, type FlatOptions, type FlatResult } from './pipeline'

export interface FlatRequest {
  id: number
  pixels: ArrayBuffer
  width: number
  height: number
  options: FlatOptions
}

export type FlatResponse = { id: number; ok: true; result: FlatResult } | { id: number; ok: false; error: string }

// The blur in WebAssembly SIMD; where it can't load (older browsers), the TypeScript blur runs.
// Traces wait for it at most a few seconds, once: a fetch that hangs must not hold them up, and
// if it finishes later, later blurs use it.
const SIMD_WAIT_MS = 3000
const simd = Promise.race([useSimdBlur(true), new Promise((done) => setTimeout(done, SIMD_WAIT_MS))])

self.onmessage = async (e: MessageEvent<FlatRequest>) => {
  const { id, pixels, width, height, options } = e.data
  await simd
  try {
    const result = runFlat(new ImageData(new Uint8ClampedArray(pixels), width, height), options)
    self.postMessage({ id, ok: true, result } satisfies FlatResponse)
  } catch (err) {
    self.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) } satisfies FlatResponse)
  }
}
