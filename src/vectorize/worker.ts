import init, { to_svg } from 'vtracer-wasm'
import wasmUrl from 'vtracer-wasm/vtracer.wasm?url'
import type { TraceParams } from './params'

export interface TraceRequest {
  id: number
  pixels: ArrayBuffer
  width: number
  height: number
  params: TraceParams
}

export type TraceResponse =
  | { id: number; ok: true; svg: string; ms: number }
  | { id: number; ok: false; error: string }

const ready = init({ module_or_path: wasmUrl })

self.onmessage = async (e: MessageEvent<TraceRequest>) => {
  const { id, pixels, width, height, params } = e.data
  try {
    await ready
    const start = performance.now()
    const svg = to_svg(new Uint8Array(pixels), width, height, params)
    post({ id, ok: true, svg, ms: performance.now() - start })
  } catch (err) {
    post({ id, ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}

function post(msg: TraceResponse) {
  self.postMessage(msg)
}
