import type { FlatRequest, FlatResponse } from './flat-worker'
import type { FlatOptions, FlatResult } from './pipeline'
import { CancelledError } from './tracer'

/**
 * Runs the flat-color pipeline in a Web Worker. Like the VTracer worker, a stale job is
 * cancelled by terminating the worker, since the work is one long synchronous computation.
 */
export class FlatTracer {
  private worker: Worker | null = null
  private nextId = 1
  private pending: { id: number; resolve: (r: FlatResult) => void; reject: (e: Error) => void } | null = null

  run(image: ImageData, options: FlatOptions): Promise<FlatResult> {
    if (this.pending) {
      this.pending.reject(new CancelledError())
      this.reset()
    }
    const worker = this.ensureWorker()
    const id = this.nextId++
    const pixels = image.data.slice().buffer
    return new Promise((resolve, reject) => {
      this.pending = { id, resolve, reject }
      const req: FlatRequest = { id, pixels, width: image.width, height: image.height, options }
      worker.postMessage(req, [pixels])
    })
  }

  dispose() {
    this.pending?.reject(new CancelledError())
    this.reset()
  }

  private ensureWorker(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL('./flat-worker.ts', import.meta.url), { type: 'module' })
      this.worker.onmessage = (e: MessageEvent<FlatResponse>) => {
        const p = this.pending
        if (!p || p.id !== e.data.id) return
        this.pending = null
        if (e.data.ok) p.resolve(e.data.result)
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
