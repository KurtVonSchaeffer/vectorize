import { assessFidelity, type FidelityReport } from './fidelity'

export interface FidelityRequest {
  id: number
  width: number
  height: number
  upload: ArrayBuffer
  vector: ArrayBuffer
  svg: string
}

export type FidelityResponse = { id: number; ok: true; report: FidelityReport } | { id: number; ok: false; error: string }

self.onmessage = (e: MessageEvent<FidelityRequest>) => {
  const { id, width, height, upload, vector, svg } = e.data
  try {
    const report = assessFidelity(new ImageData(new Uint8ClampedArray(upload), width, height), new ImageData(new Uint8ClampedArray(vector), width, height), svg)
    self.postMessage({ id, ok: true, report } satisfies FidelityResponse)
  } catch (err) {
    self.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) } satisfies FidelityResponse)
  }
}
