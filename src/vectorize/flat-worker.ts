import { runFlat, type FlatOptions, type FlatResult } from './pipeline'

export interface FlatRequest {
  id: number
  pixels: ArrayBuffer
  width: number
  height: number
  options: FlatOptions
}

export type FlatResponse = { id: number; ok: true; result: FlatResult } | { id: number; ok: false; error: string }

self.onmessage = (e: MessageEvent<FlatRequest>) => {
  const { id, pixels, width, height, options } = e.data
  try {
    const result = runFlat(new ImageData(new Uint8ClampedArray(pixels), width, height), options)
    self.postMessage({ id, ok: true, result } satisfies FlatResponse)
  } catch (err) {
    self.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) } satisfies FlatResponse)
  }
}
