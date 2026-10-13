import { env, pipeline, RawImage } from '@huggingface/transformers'
import { MODELS, type AiTask } from './models'

export type AiRequest = { type: 'run'; id: number; task: AiTask; pixels: ArrayBuffer; width: number; height: number }

export type AiResponse =
  | { type: 'progress'; id: number; phase: 'download' | 'run'; progress: number }
  | { type: 'done'; id: number; pixels: ArrayBuffer; width: number; height: number }
  | { type: 'error'; id: number; error: string }

env.allowLocalModels = false

// Swin2SR runs on tiles: bounds WASM memory and lets us report progress. Every tile fed to the
// model is exactly TILE + 2*OVERLAP px square (edge tiles are padded by replicating border
// pixels), because onnxruntime's WASM backend can fail when the input shape changes between
// runs. The overlap is cropped away to hide seams.
const TILE = 112
const OVERLAP = 8
const INPUT = TILE + OVERLAP * 2

type Pipe = (input: RawImage) => Promise<RawImage | RawImage[]>
const pipes = new Map<AiTask, Promise<Pipe>>()

function getPipe(task: AiTask, id: number): Promise<Pipe> {
  let p = pipes.get(task)
  if (!p) {
    p = (async () => {
      const pipe = await pipeline('image-to-image', MODELS[task].id, {
        device: 'wasm',
        dtype: 'fp32',
        // Memory-pattern buffer reuse can fail when input shapes change between runs.
        session_options: { enableMemPattern: false },
        progress_callback: (info: { status: string; progress?: number }) => {
          if (info.status === 'progress_total' && info.progress != null) {
            post({ type: 'progress', id, phase: 'download', progress: info.progress / 100 })
          }
        },
      })
      return pipe as unknown as Pipe
    })()
    // Don't cache a failed load (e.g. network error); let the next request retry.
    p.catch(() => pipes.delete(task))
    pipes.set(task, p)
  }
  return p
}

// Requests run one at a time; models are too heavy to run concurrently.
let queue: Promise<void> = Promise.resolve()

self.onmessage = (e: MessageEvent<AiRequest>) => {
  const req = e.data
  queue = queue.then(() => run(req))
}

async function run(req: AiRequest) {
  const { id, task, width, height } = req
  try {
    const rgba = new Uint8ClampedArray(req.pixels)
    const pipe = await getPipe(task, id)
    post({ type: 'progress', id, phase: 'run', progress: 0 })
    const out = await upscale(pipe, rgba, width, height, MODELS[task].factor, id)
    post({ type: 'done', id, pixels: out.data.buffer as ArrayBuffer, width: out.width, height: out.height }, [out.data.buffer as ArrayBuffer])
  } catch (err) {
    post({ type: 'error', id, error: err instanceof Error ? err.message : String(err) })
  }
}

async function upscale(pipe: Pipe, rgba: Uint8ClampedArray, width: number, height: number, factor: number, id: number): Promise<ImageData> {
  const rgb = new Uint8ClampedArray(width * height * 3)
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    rgb[j] = rgba[i]
    rgb[j + 1] = rgba[i + 1]
    rgb[j + 2] = rgba[i + 2]
  }
  const ow = width * factor
  const oh = height * factor
  const out = new Uint8ClampedArray(ow * oh * 4)

  const cols = Math.ceil(width / TILE)
  const rows = Math.ceil(height / TILE)
  const tile = new Uint8ClampedArray(INPUT * INPUT * 3)
  let done = 0
  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      // Core region this tile is responsible for; the model input starts OVERLAP px before it.
      const cx0 = tx * TILE
      const cy0 = ty * TILE
      const cx1 = Math.min(width, cx0 + TILE)
      const cy1 = Math.min(height, cy0 + TILE)
      const ix0 = cx0 - OVERLAP
      const iy0 = cy0 - OVERLAP

      for (let y = 0; y < INPUT; y++) {
        const sy = Math.min(height - 1, Math.max(0, iy0 + y))
        for (let x = 0; x < INPUT; x++) {
          const sx = Math.min(width - 1, Math.max(0, ix0 + x))
          const s = (sy * width + sx) * 3
          const d = (y * INPUT + x) * 3
          tile[d] = rgb[s]
          tile[d + 1] = rgb[s + 1]
          tile[d + 2] = rgb[s + 2]
        }
      }
      const res = await pipe(new RawImage(tile, INPUT, INPUT, 3))
      const up = Array.isArray(res) ? res[0] : res
      const uw = up.width
      const ch = up.channels
      for (let y = cy0 * factor; y < cy1 * factor; y++) {
        const sy = y - iy0 * factor
        for (let x = cx0 * factor; x < cx1 * factor; x++) {
          const s = (sy * uw + (x - ix0 * factor)) * ch
          const d = (y * ow + x) * 4
          out[d] = up.data[s]
          out[d + 1] = up.data[s + 1]
          out[d + 2] = up.data[s + 2]
        }
      }
      done++
      post({ type: 'progress', id, phase: 'run', progress: done / (cols * rows) })
    }
  }

  // The model only sees RGB; scale the original alpha smoothly to match.
  const alpha = scaledAlpha(rgba, width, height, ow, oh)
  for (let i = 3, j = 0; i < out.length; i += 4, j++) out[i] = alpha[j]
  return new ImageData(out, ow, oh)
}

function scaledAlpha(rgba: Uint8ClampedArray, w: number, h: number, ow: number, oh: number): Uint8ClampedArray {
  let opaque = true
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) { opaque = false; break }
  const alpha = new Uint8ClampedArray(ow * oh)
  if (opaque) return alpha.fill(255)
  const src = new OffscreenCanvas(w, h)
  src.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(rgba), w, h), 0, 0)
  const dst = new OffscreenCanvas(ow, oh)
  const ctx = dst.getContext('2d')!
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(src, 0, 0, ow, oh)
  const d = ctx.getImageData(0, 0, ow, oh).data
  for (let i = 0; i < alpha.length; i++) alpha[i] = d[i * 4 + 3]
  return alpha
}

function post(msg: AiResponse, transfer: Transferable[] = []) {
  self.postMessage(msg, transfer)
}
