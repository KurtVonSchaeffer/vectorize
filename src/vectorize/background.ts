export interface BackgroundOptions {
  /** Max color distance (0–100) from the background color still treated as background. */
  tolerance: number
  /** Also clear background-colored areas not connected to the edge (e.g. inside an "O"). */
  enclosed: boolean
}

export const DEFAULT_BACKGROUND: BackgroundOptions = { tolerance: 20, enclosed: false }

/**
 * Removes a flat background: estimates the dominant edge color, flood-fills from the image
 * border through pixels close to it, and makes them transparent. Anti-aliased edge pixels get
 * partial alpha with the background color unmixed, so tracing doesn't leave a halo.
 * Returns null when the image has no clear flat background.
 */
export function removeFlatBackground(src: ImageData, opts: BackgroundOptions): ImageData | null {
  const { width: w, height: h } = src
  const d = src.data
  const bg = edgeColor(d, w, h)
  if (!bg) return null

  // Tolerance 0–100 maps to RGB distance; 100 ≈ a third of the way across the color cube.
  const tol = (opts.tolerance / 100) * 150
  const soft = tol * 1.5 + 12 // distances up to here are treated as anti-aliased edge
  const n = w * h
  const dist = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const r = d[i * 4] - bg[0]
    const g = d[i * 4 + 1] - bg[1]
    const b = d[i * 4 + 2] - bg[2]
    // Weighted RGB distance (cheap approximation of perceptual difference).
    dist[i] = d[i * 4 + 3] === 0 ? 0 : Math.sqrt(2 * r * r + 4 * g * g + 3 * b * b) / 3
  }

  const isBg = new Uint8Array(n)
  if (opts.enclosed) {
    for (let i = 0; i < n; i++) if (dist[i] <= tol) isBg[i] = 1
  } else {
    const queue = new Int32Array(n)
    let head = 0
    let tail = 0
    const push = (i: number) => {
      if (!isBg[i] && dist[i] <= tol) {
        isBg[i] = 1
        queue[tail++] = i
      }
    }
    for (let x = 0; x < w; x++) {
      push(x)
      push((h - 1) * w + x)
    }
    for (let y = 0; y < h; y++) {
      push(y * w)
      push(y * w + w - 1)
    }
    while (head < tail) {
      const i = queue[head++]
      const x = i % w
      if (x > 0) push(i - 1)
      if (x < w - 1) push(i + 1)
      if (i >= w) push(i - w)
      if (i < n - w) push(i + w)
    }
  }

  const out = new Uint8ClampedArray(d)
  for (let i = 0; i < n; i++) {
    const p = i * 4
    if (isBg[i]) {
      out[p + 3] = 0
      continue
    }
    if (dist[i] >= soft || !touchesBg(isBg, i, w, h)) continue
    // Edge pixel: a blend of foreground and background. Recover alpha from how close it is to
    // the background, then unmix the background color out of it.
    const a = Math.max(0.05, (dist[i] - tol) / (soft - tol))
    for (let c = 0; c < 3; c++) out[p + c] = (d[p + c] - (1 - a) * bg[c]) / a
    out[p + 3] = Math.round(d[p + 3] * a)
  }
  return new ImageData(out, w, h)
}

function touchesBg(isBg: Uint8Array, i: number, w: number, h: number): boolean {
  const x = i % w
  return (x > 0 && isBg[i - 1] === 1) || (x < w - 1 && isBg[i + 1] === 1) || (i >= w && isBg[i - w] === 1) || (i < w * (h - 1) && isBg[i + w] === 1)
}

/** Most common opaque color along the border, or null if there isn't a dominant one. */
function edgeColor(d: Uint8ClampedArray, w: number, h: number): [number, number, number] | null {
  const buckets = new Map<number, { count: number; r: number; g: number; b: number }>()
  let total = 0
  const add = (x: number, y: number) => {
    const p = (y * w + x) * 4
    if (d[p + 3] < 250) return
    const key = ((d[p] >> 3) << 10) | ((d[p + 1] >> 3) << 5) | (d[p + 2] >> 3)
    const e = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0 }
    e.count++
    e.r += d[p]
    e.g += d[p + 1]
    e.b += d[p + 2]
    buckets.set(key, e)
    total++
  }
  for (let x = 0; x < w; x++) {
    add(x, 0)
    add(x, h - 1)
  }
  for (let y = 1; y < h - 1; y++) {
    add(0, y)
    add(w - 1, y)
  }
  let best: { count: number; r: number; g: number; b: number } | null = null
  for (const e of buckets.values()) if (!best || e.count > best.count) best = e
  // Require the edge to be reasonably uniform; otherwise this isn't a flat background.
  if (!best || best.count < total * 0.25) return null
  return [best.r / best.count, best.g / best.count, best.b / best.count]
}
