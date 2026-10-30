import { DEFAULT_BLUR_ENGINE, useBlurEngine } from '../trace/blur-engines'
import { runFlat, type FlatOptions, type FlatResult } from './pipeline'

export interface FlatRequest {
  id: number
  pixels: ArrayBuffer
  width: number
  height: number
  options: FlatOptions
  /** The blur engine (trace/blur-engines.ts); unset: the default, WebAssembly SIMD (Highway). */
  blurEngine?: string
}

export type FlatResponse = { id: number; ok: true; result: FlatResult } | { id: number; ok: false; error: string }

// The blur in WebAssembly SIMD; where it can't load (older browsers), the TypeScript blur runs.
// Traces wait for an engine at most a few seconds, once: a fetch that hangs must not hold them up,
// and if it finishes later, later blurs use it.
const ENGINE_WAIT_MS = 3000
let engine: { id: string; ready: Promise<unknown> } | null = null
function engineReady(id: string): Promise<unknown> {
  if (engine?.id !== id) engine = { id, ready: Promise.race([useBlurEngine(id), new Promise((done) => setTimeout(done, ENGINE_WAIT_MS))]) }
  return engine.ready
}
engineReady(DEFAULT_BLUR_ENGINE) // start loading before the first trace arrives

self.onmessage = async (e: MessageEvent<FlatRequest>) => {
  const { id, pixels, width, height, options, blurEngine } = e.data
  await engineReady(blurEngine ?? DEFAULT_BLUR_ENGINE)
  try {
    const result = runFlat(new ImageData(new Uint8ClampedArray(pixels), width, height), options)
    self.postMessage({ id, ok: true, result } satisfies FlatResponse)
  } catch (err) {
    self.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) } satisfies FlatResponse)
  }
}
