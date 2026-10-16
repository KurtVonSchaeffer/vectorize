import { MODELS, type AiTask } from './models'
import type { AiRequest, AiResponse } from './worker'
import { JOB_TIMEOUT_MS, TimeoutError } from '../vectorize/tracer'

export type UpscaleSetting = 'off' | '2x' | '4x'

export interface AiProgress {
  task: AiTask
  phase: 'download' | 'run'
  progress: number
}


interface Pending {
  resolve: (img: ImageData) => void
  reject: (e: Error) => void
  task: AiTask
  onProgress?: (p: AiProgress) => void
  /** Stops a run that never answers (see JOB_TIMEOUT_MS). */
  timer?: ReturnType<typeof setTimeout>
}

/**
 * The worker holds the model and its WASM memory (about 250 MB once it has run) for as long as it
 * lives, and WASM memory can't shrink, so stopping the worker is the only way to give it back. It's
 * stopped after this long without AI work. The model files stay in the browser's cache, so the
 * next use reloads them from disk (about 8 s to set the model up again), not from the network.
 */
export const IDLE_RELEASE_MS = 5 * 60_000

/**
 * Runs the AI upscaler in a worker that's kept while it's in use. Unlike the tracer, the worker
 * is never terminated to cancel work: reloading a model costs more than finishing a stale job, so
 * stale results are simply ignored by the caller. Results are cached per source image, so tweaking
 * tracing settings never re-runs the model.
 */
export class Enhancer {
  private worker: Worker | null = null
  private idle: ReturnType<typeof setTimeout> | undefined
  private nextId = 1
  private pending = new Map<number, Pending>()
  private cache = new Map<string, ImageData>()

  constructor(private idleMs = IDLE_RELEASE_MS) {}

  private connect(): Worker {
    clearTimeout(this.idle)
    if (this.worker) return this.worker
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<AiResponse>) => {
      // A stopped worker's messages are ignored; request ids also never repeat across workers.
      if (worker !== this.worker) return
      const msg = e.data
      const p = this.pending.get(msg.id)
      if (!p) return
      if (msg.type === 'progress') {
        p.onProgress?.({ task: p.task, phase: msg.phase, progress: msg.progress })
        return
      }
      this.pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.type === 'done') p.resolve(new ImageData(new Uint8ClampedArray(msg.pixels), msg.width, msg.height))
      else p.reject(new Error(msg.error))
      this.settle()
    }
    // The worker failed to start or crashed (e.g. out of memory): fail its jobs, and let the next
    // request start a fresh one.
    worker.onerror = (e: ErrorEvent) => {
      e.preventDefault?.()
      if (worker !== this.worker) return
      this.stop(new Error(e.message || 'The sharpening worker stopped unexpectedly'))
    }
    return (this.worker = worker)
  }

  /** Once nothing is running, starts the countdown to stopping the worker. */
  private settle() {
    clearTimeout(this.idle)
    if (!this.pending.size) this.idle = setTimeout(() => this.release(), this.idleMs)
  }

  /** Stops the worker (and frees the model's memory) when nothing is running. */
  private release() {
    if (this.pending.size) return
    this.worker?.terminate()
    this.worker = null
  }

  /** Stops the worker now, failing any jobs it was running. */
  private stop(reason: Error) {
    clearTimeout(this.idle)
    this.worker?.terminate()
    this.worker = null
    const jobs = [...this.pending.values()]
    this.pending.clear()
    for (const p of jobs) {
      clearTimeout(p.timer)
      p.reject(reason)
    }
  }

  /** Returns null when the image is already too large for this upscale factor. */
  async upscale(sourceKey: string, input: ImageData, setting: Exclude<UpscaleSetting, 'off'>, onProgress?: (p: AiProgress) => void): Promise<ImageData | null> {
    const task: AiTask = setting === '2x' ? 'upscale2x' : 'upscale4x'
    if (Math.max(input.width, input.height) > MODELS[task].maxInput) return null
    return this.cached(`${sourceKey}|${task}`, task, input, onProgress)
  }

  dispose() {
    this.stop(new Error('disposed'))
  }

  private async cached(key: string, task: AiTask, input: ImageData, onProgress?: (p: AiProgress) => void): Promise<ImageData> {
    const hit = this.cache.get(key)
    if (hit) return hit
    const out = await this.run(task, input, onProgress)
    this.cache.set(key, out)
    // Keep memory bounded; full-size RGBA buffers add up quickly.
    if (this.cache.size > 12) this.cache.delete(this.cache.keys().next().value!)
    return out
  }

  private run(task: AiTask, input: ImageData, onProgress?: (p: AiProgress) => void): Promise<ImageData> {
    const id = this.nextId++
    const pixels = input.data.slice().buffer
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, task, onProgress })
      // A run that never answers (the first model download included) blocks the worker's queue:
      // stop the worker and fail its jobs, so callers fall back to the original image.
      this.pending.get(id)!.timer = setTimeout(() => this.pending.has(id) && this.stop(new TimeoutError()), JOB_TIMEOUT_MS)
      try {
        this.send({ type: 'run', id, task, pixels, width: input.width, height: input.height }, [pixels])
      } catch (err) {
        // The worker couldn't be started: nothing is running, so the next request tries again.
        clearTimeout(this.pending.get(id)?.timer)
        this.pending.delete(id)
        this.settle()
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  private send(msg: AiRequest, transfer: Transferable[] = []) {
    this.connect().postMessage(msg, transfer)
  }
}
