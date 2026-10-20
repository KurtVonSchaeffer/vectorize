import type { FidelityReport } from './fidelity'
import type { FidelityRequest, FidelityResponse } from './fidelity-worker'
import type { CheckOutcome } from './readiness'
import { rasterizeSvg } from './render'

/** A check that hasn't answered by then is abandoned (and its worker stopped). */
export const CHECK_TIMEOUT_MS = 10_000
/**
 * Uploads are measured at most this many px on their longest side, as in the calibration
 * (bench/fidelity.ts). Geometry is measured in the upload's own pixels whatever this is.
 */
export const CHECK_MAX_SIDE = 1000

class CheckTimeout extends Error {}

/**
 * Runs a measurement with a time limit and turns every way it can end into a CheckOutcome. Only
 * a report reaches 'checked'; an error, a timeout, a cancellation or anything thrown becomes
 * 'not-checked', which never reads as fine.
 */
export async function runCheck(measure: (signal: AbortSignal) => Promise<FidelityReport>, timeoutMs = CHECK_TIMEOUT_MS): Promise<CheckOutcome> {
  const ac = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ac.abort()
      reject(new CheckTimeout())
    }, timeoutMs)
  })
  try {
    const report = await Promise.race([measure(ac.signal), timeout])
    if (!report || !Array.isArray(report.issues) || !['ready', 'check', 'not-suitable'].includes(report.verdict)) return { state: 'not-checked', reason: 'error' }
    return { state: 'checked', report }
  } catch (err) {
    return { state: 'not-checked', reason: err instanceof CheckTimeout ? 'timeout' : 'error' }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Measures an SVG against the upload in a Web Worker (assessFidelity is one long synchronous
 * computation, so it is stopped by terminating the worker). One check at a time: the latest
 * request wins, and an older one still being prepared never displaces it.
 */
export class FidelityChecker {
  private worker: Worker | null = null
  private nextId = 1
  /** The latest check requested; any other is stale. */
  private latest = 0
  private pending: { id: number; resolve: (r: FidelityReport) => void; reject: (e: Error) => void } | null = null

  check(upload: ImageBitmap, svg: string, timeoutMs = CHECK_TIMEOUT_MS): Promise<CheckOutcome> {
    const id = this.nextId++
    this.latest = id
    return runCheck(async (signal) => {
      const k = Math.min(1, CHECK_MAX_SIDE / Math.max(upload.width, upload.height))
      const w = Math.max(1, Math.round(upload.width * k))
      const h = Math.max(1, Math.round(upload.height * k))
      const c = new OffscreenCanvas(w, h)
      const g = c.getContext('2d', { willReadFrequently: true })!
      g.drawImage(upload, 0, 0, w, h)
      const up = g.getImageData(0, 0, w, h)
      const vec = await rasterizeSvg(svg, w, h)
      // Superseded while the images were prepared: leave the newer check alone.
      if (signal.aborted || id !== this.latest) throw new Error('cancelled')
      return this.measure(id, up, vec, svg, upload.width, signal)
    }, timeoutMs)
  }

  /** Stops the check in progress, if any (its result would no longer be shown). */
  cancel() {
    this.latest = 0
    this.pending?.reject(new Error('cancelled'))
    this.reset()
  }

  private measure(id: number, upload: ImageData, vector: ImageData, svg: string, geometryWidth: number, signal: AbortSignal): Promise<FidelityReport> {
    if (this.pending) {
      this.pending.reject(new Error('cancelled'))
      this.reset()
    }
    const worker = this.ensureWorker()
    return new Promise((resolve, reject) => {
      this.pending = { id, resolve, reject }
      signal.addEventListener('abort', () => {
        if (this.pending?.id !== id) return
        this.pending.reject(new Error('stopped'))
        this.reset()
      })
      // Both images are local to this check, so their pixels are handed over, not copied.
      const req: FidelityRequest = { id, width: upload.width, height: upload.height, upload: upload.data.buffer as ArrayBuffer, vector: vector.data.buffer as ArrayBuffer, svg, geometryWidth }
      worker.postMessage(req, [req.upload, req.vector])
    })
  }

  dispose() {
    this.cancel()
  }

  private ensureWorker(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL('./fidelity-worker.ts', import.meta.url), { type: 'module' })
      this.worker.onmessage = (e: MessageEvent<FidelityResponse>) => {
        const p = this.pending
        if (!p || p.id !== e.data.id) return
        this.pending = null
        if (e.data.ok) p.resolve(e.data.report)
        else p.reject(new Error(e.data.error))
      }
      this.worker.onerror = (e) => {
        this.pending?.reject(new Error(e.message || 'Worker failed'))
        this.reset()
      }
    }
    return this.worker
  }

  private reset() {
    this.worker?.terminate()
    this.worker = null
    this.pending = null
  }
}
