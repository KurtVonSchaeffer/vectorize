// Design-intent prototype (research, docs/design-intent.md): Segment Anything in the browser.
// SlimSAM (a pruned SAM, Xenova/slimsam-77-uniform) via transformers.js, the library the app already
// uses for AI sharpening. The image is encoded once; each point prompt then costs one decoder run.
import { AutoProcessor, RawImage, SamModel, Tensor, env } from '@huggingface/transformers'

env.allowLocalModels = false

export const SAM_MODEL = 'Xenova/slimsam-77-uniform'

/** One object mask at the image's size, with SAM's own estimate of its quality. */
export interface ObjectMask {
  mask: Uint8Array
  /** SAM's predicted IoU (0–1). */
  score: number
  area: number
  box: [number, number, number, number]
  /** The prompt point (image px). */
  point: [number, number]
}

type Embedded = { model: SamModel; processor: Awaited<ReturnType<typeof AutoProcessor.from_pretrained>>; inputs: Record<string, unknown> & { original_sizes: unknown; reshaped_input_sizes: [number, number][] }; embeddings: Record<string, Tensor>; width: number; height: number }

let loaded: Promise<{ model: SamModel; processor: Awaited<ReturnType<typeof AutoProcessor.from_pretrained>> }> | null = null

/** Loads SlimSAM (downloads it on first use) and encodes the image. */
export async function embed(img: ImageData, onProgress?: (msg: string) => void): Promise<Embedded> {
  loaded ??= (async () => {
    const t0 = performance.now()
    const model = (await SamModel.from_pretrained(SAM_MODEL, {
      device: 'wasm',
      dtype: 'fp32',
      progress_callback: (i: { status: string; progress?: number; file?: string }) => i.status === 'progress' && onProgress?.(`Downloading ${i.file}: ${Math.round(i.progress ?? 0)}%`),
    })) as SamModel
    const processor = await AutoProcessor.from_pretrained(SAM_MODEL)
    onProgress?.(`Model ready in ${Math.round(performance.now() - t0)} ms`)
    return { model, processor }
  })()
  const { model, processor } = await loaded
  const raw = new RawImage(new Uint8ClampedArray(img.data), img.width, img.height, 4).rgb()
  const inputs = (await (processor as unknown as (i: RawImage) => Promise<Embedded['inputs']>)(raw)) as Embedded['inputs']
  const embeddings = (await (model as unknown as { get_image_embeddings: (i: unknown) => Promise<Record<string, Tensor>> }).get_image_embeddings(inputs)) as Record<string, Tensor>
  return { model, processor, inputs, embeddings, width: img.width, height: img.height }
}

/**
 * The best of SAM's three masks for a set of points (image px; label 1 = on the object,
 * 0 = not on it).
 */
export async function segment(e: Embedded, points: [number, number][], labels: number[] = points.map(() => 1)): Promise<ObjectMask> {
  const all = await segmentAll(e, points, labels)
  return all.reduce((a, b) => (b.score > a.score ? b : a))
}

/** SAM's three masks for the points (whole, part and sub-part, roughly), each with its score. */
export async function segmentAll(e: Embedded, points: [number, number][], labels: number[] = points.map(() => 1)): Promise<ObjectMask[]> {
  const [rh, rw] = e.inputs.reshaped_input_sizes[0]
  const sx = rw / e.width
  const sy = rh / e.height
  const input_points = new Tensor('float32', points.flatMap(([x, y]) => [x * sx, y * sy]), [1, 1, points.length, 2])
  const input_labels = new Tensor('int64', BigInt64Array.from(labels.map((l) => BigInt(l))), [1, 1, labels.length])
  const out = (await (e.model as unknown as (i: unknown) => Promise<{ pred_masks: Tensor; iou_scores: Tensor }>)({ ...e.embeddings, input_points, input_labels })) as { pred_masks: Tensor; iou_scores: Tensor }
  const masks = (await (e.processor as unknown as { post_process_masks: (m: Tensor, o: unknown, r: unknown) => Promise<Tensor[]> }).post_process_masks(out.pred_masks, e.inputs.original_sizes, e.inputs.reshaped_input_sizes))[0]
  const scores = out.iou_scores.data as Float32Array
  const n = e.width * e.height
  const data = masks.data as Uint8Array | boolean[]
  return [...scores].map((score, k) => {
    const mask = new Uint8Array(n)
    let area = 0
    let x0 = e.width, y0 = e.height, x1 = -1, y1 = -1
    for (let p = 0; p < n; p++) {
      if (!data[k * n + p]) continue
      mask[p] = 1
      area++
      const x = p % e.width, y = (p - x) / e.width
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
    return { mask, score, area, box: [x0, y0, x1, y1] as [number, number, number, number], point: points[0] }
  })
}

/** Pixels in the largest 4-connected piece of a mask (searched within its box). */
export function largestPiece(mask: Uint8Array, w: number, box: [number, number, number, number]): number {
  const seen = new Uint8Array(mask.length)
  let best = 0
  for (let y = box[1]; y <= box[3]; y++)
    for (let x = box[0]; x <= box[2]; x++) {
      const s = y * w + x
      if (!mask[s] || seen[s]) continue
      seen[s] = 1
      const stack = [s]
      let size = 0
      while (stack.length) {
        const p = stack.pop()!
        size++
        const px = p % w
        for (const q of [px > 0 ? p - 1 : -1, px < w - 1 ? p + 1 : -1, p - w, p + w]) if (q >= 0 && q < mask.length && mask[q] && !seen[q]) (seen[q] = 1), stack.push(q)
      }
      if (size > best) best = size
    }
  return best
}

/** Intersection over union of two masks. */
export function iou(a: ObjectMask, b: ObjectMask): number {
  if (a.box[0] > b.box[2] || b.box[0] > a.box[2] || a.box[1] > b.box[3] || b.box[1] > a.box[3]) return 0
  let inter = 0
  for (let p = 0; p < a.mask.length; p++) if (a.mask[p] && b.mask[p]) inter++
  return inter / (a.area + b.area - inter)
}

/**
 * The objects inside an area (the texture of an illustration): SAM prompted at a grid of points
 * in it, all three masks of each, kept when confident (score ≥ minScore), between minShare and
 * maxShare of the image, and mostly inside the area; near-duplicates (IoU ≥ 0.85) keep the best.
 * Largest first, so parents come before their parts.
 */
export async function discover(
  e: Embedded,
  area: Uint8Array,
  opts: { step?: number; minScore?: number; minShare?: number; maxShare?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<ObjectMask[]> {
  const { step = 32, minScore = 0.86, minShare = 0.0003, maxShare = 0.2 } = opts
  const n = e.width * e.height
  const points: [number, number][] = []
  for (let y = step / 2; y < e.height; y += step) for (let x = step / 2; x < e.width; x += step) if (area[Math.floor(y) * e.width + Math.floor(x)]) points.push([Math.floor(x), Math.floor(y)])
  const kept: ObjectMask[] = []
  for (let i = 0; i < points.length; i++) {
    opts.onProgress?.(i, points.length)
    for (const m of await segmentAll(e, [points[i]])) {
      if (m.score < minScore || m.area < n * minShare || m.area > n * maxShare) continue
      let inside = 0
      for (let p = 0; p < n; p++) if (m.mask[p] && area[p]) inside++
      if (inside < m.area * 0.7) continue
      // An object is mostly one piece; scattered fragments (bits of a ring's edge) are not one.
      if (largestPiece(m.mask, e.width, m.box) < m.area * 0.85) continue
      const twin = kept.findIndex((k) => iou(k, m) >= 0.85)
      if (twin < 0) kept.push(m)
      else if (m.score > kept[twin].score) kept[twin] = m
    }
  }
  return kept.sort((a, b) => b.area - a.area)
}
