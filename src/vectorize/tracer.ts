import type { TraceParams } from './params'
import type { TraceRequest, TraceResponse } from './worker'

export class CancelledError extends Error {
  constructor() {
    super('cancelled')
  }
}

/**
 * A job that hasn't answered in this long is treated as stuck (a pathological input, or a worker
 * the browser stopped without an error) and its worker is replaced, so the page never waits
 * forever. The largest images (6000 px) normally take seconds.
 */
export const JOB_TIMEOUT_MS = 120_000

export class TimeoutError extends Error {
  constructor() {
    super('timed out')
  }
}

/**
 * Runs VTracer in a Web Worker. Tracing is a single blocking WASM call, so the only way to
 * cancel a stale job is to terminate the worker; a fresh one is spun up for the next request.
 * The worker is also replaced after an error, since a Rust panic leaves the WASM instance unusable.
 */
export class Tracer {
  private worker: Worker | null = null
  private nextId = 1
  private pending: { id: number; resolve: (r: { svg: string; ms: number }) => void; reject: (e: Error) => void } | null = null
  private timer: ReturnType<typeof setTimeout> | undefined

  trace(image: ImageData, params: TraceParams): Promise<{ svg: string; ms: number }> {
    if (this.pending) {
      this.pending.reject(new CancelledError())
      this.reset()
    }
    const worker = this.ensureWorker()
    const id = this.nextId++
    // Copy so the caller's ImageData survives the transfer and can be re-traced.
    const pixels = image.data.slice().buffer
    return new Promise((resolve, reject) => {
      this.pending = { id, resolve, reject }
      this.timer = setTimeout(() => {
        if (this.pending?.id !== id) return
        this.pending.reject(new TimeoutError())
        this.reset()
      }, JOB_TIMEOUT_MS)
      const req: TraceRequest = { id, pixels, width: image.width, height: image.height, params }
      worker.postMessage(req, [pixels])
    })
  }

  dispose() {
    this.pending?.reject(new CancelledError())
    this.reset()
  }

  private ensureWorker(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
      this.worker.onmessage = (e: MessageEvent<TraceResponse>) => this.onMessage(e.data)
      this.worker.onerror = (e) => {
        this.pending?.reject(new Error(e.message || 'Worker failed'))
        this.reset()
      }
    }
    return this.worker
  }

  private onMessage(res: TraceResponse) {
    const p = this.pending
    if (!p || p.id !== res.id) return
    clearTimeout(this.timer)
    this.pending = null
    if (res.ok) {
      p.resolve({ svg: res.svg, ms: res.ms })
    } else {
      p.reject(new Error(res.error))
      this.reset()
    }
  }

  private reset() {
    clearTimeout(this.timer)
    this.worker?.terminate()
    this.worker = null
    this.pending = null
  }
}
