import type { FontCandidate, WordShapes } from './match'

/**
 * The full free-font catalog (every open font on Fontsource, ~5,000 styles), screened with
 * precomputed letter fingerprints (scripts/build-font-index.mjs): only the fingerprint files for
 * the characters found are downloaded, every style is scored in milliseconds, and just the best
 * few dozen are loaded as real fonts for the precise comparison.
 */

interface Meta {
  bits: number
  cell: number
  record: number
  chars: string
  /** [fontsource id, family, weight, category] per style. */
  fonts: [string, string, number, string][]
}

export interface FontIndex {
  meta: Meta
  /** Fingerprints per character (all styles, `record` bytes each). */
  glyphs: Map<string, Uint8Array>
}

const BASE = '/font-index'
let metaPromise: Promise<Meta> | null = null
const charFiles = new Map<string, Promise<Uint8Array | null>>()

export async function loadIndex(chars: string): Promise<FontIndex> {
  metaPromise ??= fetch(`${BASE}/meta.json`).then((r) => {
    if (!r.ok) throw new Error('The font catalog is unavailable.')
    return r.json()
  })
  metaPromise.catch(() => (metaPromise = null))
  const meta = await metaPromise
  const wanted = [...new Set(chars)].filter((c) => meta.chars.includes(c))
  const glyphs = new Map<string, Uint8Array>()
  await Promise.all(
    wanted.map(async (c) => {
      let p = charFiles.get(c)
      if (!p) {
        p = fetch(`${BASE}/${c.charCodeAt(0)}.bin`).then((r) => (r.ok ? r.arrayBuffer().then((b) => new Uint8Array(b)) : null)).catch(() => null)
        charFiles.set(c, p)
      }
      const data = await p
      if (data) glyphs.set(c, data)
    }),
  )
  return { meta, glyphs }
}

const POP = new Uint8Array(256).map((_, i) => {
  let n = 0
  for (let v = i; v; v >>= 1) n += v & 1
  return n
})

/** The artwork letter (32×32 soft mask) at fingerprint resolution: 2×2 average, thresholded. */
function bitsOf(mask: Float32Array, cell: number, bits: number): Uint8Array {
  const out = new Uint8Array((bits * bits) / 8)
  for (let y = 0; y < bits; y++)
    for (let x = 0; x < bits; x++) {
      const v = (mask[2 * y * cell + 2 * x] + mask[2 * y * cell + 2 * x + 1] + mask[(2 * y + 1) * cell + 2 * x] + mask[(2 * y + 1) * cell + 2 * x + 1]) / 4
      if (v > 0.5) out[(y * bits + x) >> 3] |= 1 << ((y * bits + x) & 7)
    }
  return out
}

/**
 * Scores every catalog style against a line's letters, the way the precise comparison does
 * (shape overlap discounted by height-ratio differences), and returns the best `top` styles.
 */
export function screen(index: FontIndex, words: WordShapes[], top = 48): number[] {
  const { meta, glyphs } = index
  const n = meta.fonts.length
  const R = meta.record
  const B = R - 1
  const letters = words.map((w) => w.glyphs.filter((g) => glyphs.has(g.char)).map((g) => ({ char: g.char, rel: g.rel, bits: bitsOf(g.mask, meta.cell, meta.bits) }))).filter((w) => w.length)
  if (!letters.length) return []
  const scores = new Float32Array(n)
  for (let v = 0; v < n; v++) {
    let total = 0
    let count = 0
    for (const word of letters) {
      let maxH = 0
      for (const g of word) maxH = Math.max(maxH, glyphs.get(g.char)![v * R + B])
      for (const g of word) {
        count++
        const data = glyphs.get(g.char)!
        const h = data[v * R + B]
        if (!h || !maxH) continue // the style lacks this character
        let inter = 0
        let union = 0
        for (let k = 0; k < B; k++) {
          const a = g.bits[k]
          const b = data[v * R + k]
          inter += POP[a & b]
          union += POP[a | b]
        }
        const iou = union ? inter / union : 0
        total += iou * Math.max(0, 1 - 2 * Math.abs(g.rel - h / maxH))
      }
    }
    scores[v] = count ? total / count : 0
  }
  return Array.from(scores.keys())
    .sort((a, b) => scores[b] - scores[a])
    .slice(0, top)
}

const WEIGHT_NAME: Record<number, string> = { 100: 'Thin', 200: 'ExtraLight', 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold', 900: 'Black' }
const loaded = new Map<string, Promise<FontCandidate | null>>()

/** Loads catalog styles as real fonts (Fontsource, full Latin set), for rendering and comparing. */
export async function loadStyles(index: FontIndex, styles: number[], onProgress?: (done: number, total: number) => void): Promise<FontCandidate[]> {
  let done = 0
  const one = (v: number) => {
    const [id, family, weight] = index.meta.fonts[v]
    const key = `${id}-${weight}`
    let p = loaded.get(key)
    if (!p) {
      p = (async () => {
        const alias = `fs-${key}`
        const face = new FontFace(alias, `url(https://cdn.jsdelivr.net/fontsource/fonts/${id}@latest/latin-${weight}-normal.woff2)`, { weight: String(weight) })
        await face.load()
        document.fonts.add(face)
        // Families with a single style (e.g. "Archivo Black") read better without "Regular".
        const single = index.meta.fonts.filter((f) => f[0] === id).length === 1
        return { family: alias, label: single ? family : `${family} ${WEIGHT_NAME[weight] ?? weight}`, ref: id, weight, style: 'normal', source: 'google' } satisfies FontCandidate
      })().catch(() => null)
      loaded.set(key, p)
    }
    return p.finally(() => onProgress?.(++done, styles.length))
  }
  const out: (FontCandidate | null)[] = []
  const queue = [...styles]
  await Promise.all(
    Array.from({ length: 12 }, async () => {
      while (queue.length) out.push(await one(queue.shift()!))
    }),
  )
  return out.filter((c): c is FontCandidate => !!c)
}
