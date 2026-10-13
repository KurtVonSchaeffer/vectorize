import { MODELS, type AiTask } from './models'
import type { AiRequest, AiResponse } from './worker'

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
}

/**
 * Runs the AI upscaler in a long-lived worker. Unlike the tracer, the worker is never terminated
 * to cancel work: reloading a model costs more than finishing a stale job, so stale results are
 * simply ignored by the caller. Results are cached per source image, so tweaking tracing
 * settings never re-runs the model.
 */
export class Enhancer {
  private worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
  private nextId = 1
  private pending = new Map<number, Pending>()
  private cache = new Map<string, ImageData>()

  constructor() {
    this.worker.onmessage = (e: MessageEvent<AiResponse>) => {
      const msg = e.data
      const p = this.pending.get(msg.id)
      if (!p) return
      if (msg.type === 'progress') {
        p.onProgress?.({ task: p.task, phase: msg.phase, progress: msg.progress })
      } else if (msg.type === 'done') {
        this.pending.delete(msg.id)
        p.resolve(new ImageData(new Uint8ClampedArray(msg.pixels), msg.width, msg.height))
      } else {
        this.pending.delete(msg.id)
        p.reject(new Error(msg.error))
      }
    }
  }

  /** Returns null when the image is already too large for this upscale factor. */
  async upscale(sourceKey: string, input: ImageData, setting: Exclude<UpscaleSetting, 'off'>, onProgress?: (p: AiProgress) => void): Promise<ImageData | null> {
    const task: AiTask = setting === '2x' ? 'upscale2x' : 'upscale4x'
    if (Math.max(input.width, input.height) > MODELS[task].maxInput) return null
    return this.cached(`${sourceKey}|${task}`, task, input, onProgress)
  }

  dispose() {
    this.worker.terminate()
    for (const p of this.pending.values()) p.reject(new Error('disposed'))
    this.pending.clear()
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
      this.send({ type: 'run', id, task, pixels, width: input.width, height: input.height }, [pixels])
    })
  }

  private send(msg: AiRequest, transfer: Transferable[] = []) {
    this.worker.postMessage(msg, transfer)
  }
}
