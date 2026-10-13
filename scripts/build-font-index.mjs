// Builds the free-font fingerprint index used to find exact font matches quickly.
//
// For every open font on Fontsource (Google Fonts plus other open fonts) at up to five weights,
// each letter and digit is rendered and normalized exactly as the app normalizes letters cut
// from artwork, then stored as a 16×16 bitmap plus the glyph's height. The app downloads only
// the files for the characters it found, screens every font in milliseconds, and loads just the
// best few dozen for a precise comparison.
//
//   node scripts/build-font-index.mjs            (downloads ~5,000 font files on first run)
//
// Output: public/font-index/meta.json and public/font-index/<charcode>.bin
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import opentype from 'opentype.js'

const OUT = 'public/font-index'
const CACHE = 'node_modules/.cache/font-index'
const CHARS = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789']
const TARGET_WEIGHTS = [300, 400, 500, 700, 900]
const CELL = 32 // same as the app's letter cell
const BITS = 16 // stored resolution (2×2 average of the cell)
const RECORD = BITS * BITS / 8 + 1 // bitmap + height byte
const CONCURRENCY = 24

const catalog = await (await fetch('https://api.fontsource.org/v1/fonts')).json()
const families = catalog.filter((f) => f.subsets?.includes('latin') && f.styles?.includes('normal') && f.category !== 'icons' && f.weights?.length)
const variants = []
for (const f of families) {
  const weights = [...new Set(TARGET_WEIGHTS.map((t) => f.weights.reduce((b, w) => (Math.abs(w - t) < Math.abs(b - t) ? w : b), f.weights[0])))]
  for (const weight of weights) variants.push({ id: f.id, family: f.family, weight, category: f.category, type: f.type })
}
console.log(`${families.length} families, ${variants.length} styles`)

await mkdir(CACHE, { recursive: true })
await mkdir(OUT, { recursive: true })

const records = CHARS.map(() => new Uint8Array(variants.length * RECORD))
const ok = new Uint8Array(variants.length)
let done = 0
let failed = 0

async function fontData(v) {
  const file = path.join(CACHE, `${v.id}-${v.weight}.woff`)
  if (existsSync(file)) return readFile(file)
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`https://cdn.jsdelivr.net/fontsource/fonts/${v.id}@latest/latin-${v.weight}-normal.woff`)
      if (!res.ok) return null
      const buf = Buffer.from(await res.arrayBuffer())
      await writeFile(file, buf)
      return buf
    } catch {
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)))
    }
  }
  return null
}

async function index(i) {
  const v = variants[i]
  const buf = await fontData(v)
  if (!buf) return failed++
  let font
  try {
    font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
  } catch {
    return failed++
  }
  CHARS.forEach((ch, c) => {
    const glyph = font.charToGlyph(ch)
    if (!glyph || glyph.index === 0) return
    const rec = fingerprint(glyph, font.unitsPerEm)
    if (rec) records[c].set(rec, i * RECORD)
  })
  ok[i] = 1
}

const queue = variants.map((_, i) => i)
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) {
      await index(queue.shift())
      if (++done % 250 === 0) console.log(`${done}/${variants.length}`)
    }
  }),
)

// Drop styles whose file couldn't be read, so records line up with meta.
const keep = variants.map((_, i) => i).filter((i) => ok[i])
const meta = { version: 1, bits: BITS, cell: CELL, record: RECORD, chars: CHARS.join(''), fonts: keep.map((i) => [variants[i].id, variants[i].family, variants[i].weight, variants[i].category]) }
await writeFile(path.join(OUT, 'meta.json'), JSON.stringify(meta))
for (let c = 0; c < CHARS.length; c++) {
  const out = new Uint8Array(keep.length * RECORD)
  keep.forEach((i, k) => out.set(records[c].subarray(i * RECORD, (i + 1) * RECORD), k * RECORD))
  await writeFile(path.join(OUT, `${CHARS[c].charCodeAt(0)}.bin`), out)
}
console.log(`indexed ${keep.length} styles (${failed} unavailable) into ${OUT}`)

/**
 * The glyph as the app sees letters: ink bounds scaled to fit (CELL − 4) px, centered in a
 * CELL×CELL square, area-averaged and softened; then 2×2-averaged to 16×16 and thresholded.
 * The last byte is the glyph height as a share of the em (×170), for x-height/cap ratios.
 */
function fingerprint(glyph, unitsPerEm) {
  const polys = flatten(glyph.getPath(0, 0, unitsPerEm).commands)
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const poly of polys) for (const [x, y] of poly) {
    if (x < x0) x0 = x
    if (x > x1) x1 = x
    if (y < y0) y0 = y
    if (y > y1) y1 = y
  }
  const w = x1 - x0, h = y1 - y0
  if (!(w > 0 && h > 0)) return null
  const s = (CELL - 4) / Math.max(w, h)
  const ox = (CELL - w * s) / 2, oy = (CELL - h * s) / 2
  const edges = []
  for (const poly of polys)
    for (let k = 0; k < poly.length; k++) {
      const [ax, ay] = poly[k], [bx, by] = poly[(k + 1) % poly.length]
      edges.push([(ax - x0) * s + ox, (ay - y0) * s + oy, (bx - x0) * s + ox, (by - y0) * s + oy])
    }
  const cover = rasterize(edges, CELL, 4)
  const soft = soften(cover, CELL)
  const rec = new Uint8Array(RECORD)
  for (let y = 0; y < BITS; y++)
    for (let x = 0; x < BITS; x++) {
      const v = (soft[2 * y * CELL + 2 * x] + soft[2 * y * CELL + 2 * x + 1] + soft[(2 * y + 1) * CELL + 2 * x] + soft[(2 * y + 1) * CELL + 2 * x + 1]) / 4
      if (v > 0.5) rec[(y * BITS + x) >> 3] |= 1 << ((y * BITS + x) & 7)
    }
  rec[RECORD - 1] = Math.min(255, Math.round((h / unitsPerEm) * 170))
  return rec
}

/** Path commands → closed polygons (curves split into short lines). */
function flatten(cmds) {
  const polys = []
  let cur = null, px = 0, py = 0
  for (const c of cmds) {
    if (c.type === 'M') {
      if (cur?.length > 2) polys.push(cur)
      cur = [[c.x, c.y]]
    } else if (c.type === 'L') cur.push([c.x, c.y])
    else if (c.type === 'Q') for (let t = 1; t <= 8; t++) {
      const u = t / 8, m = 1 - u
      cur.push([m * m * px + 2 * m * u * c.x1 + u * u * c.x, m * m * py + 2 * m * u * c.y1 + u * u * c.y])
    }
    else if (c.type === 'C') for (let t = 1; t <= 10; t++) {
      const u = t / 10, m = 1 - u
      cur.push([m ** 3 * px + 3 * m * m * u * c.x1 + 3 * m * u * u * c.x2 + u ** 3 * c.x, m ** 3 * py + 3 * m * m * u * c.y1 + 3 * m * u * u * c.y2 + u ** 3 * c.y])
    } else if (c.type === 'Z') {
      if (cur?.length > 2) polys.push(cur)
      cur = null
    }
    if (c.type !== 'Z') [px, py] = [c.x, c.y]
  }
  if (cur?.length > 2) polys.push(cur)
  return polys
}

/** Coverage per cell with ss×ss samples, nonzero winding (as fonts are filled). */
function rasterize(edges, size, ss) {
  const out = new Float32Array(size * size)
  const n = size * ss
  for (let sy = 0; sy < n; sy++) {
    const y = (sy + 0.5) / ss
    const xs = []
    for (const [ax, ay, bx, by] of edges) {
      if ((ay <= y) === (by <= y)) continue
      xs.push([ax + ((y - ay) / (by - ay)) * (bx - ax), by > ay ? 1 : -1])
    }
    xs.sort((a, b) => a[0] - b[0])
    let wind = 0
    for (let k = 0; k < xs.length - 1; k++) {
      wind += xs[k][1]
      if (!wind) continue
      const from = Math.max(0, Math.ceil(xs[k][0] * ss - 0.5)), to = Math.min(n - 1, Math.floor(xs[k + 1][0] * ss - 0.5))
      for (let sx = from; sx <= to; sx++) out[Math.floor(sy / ss) * size + Math.floor(sx / ss)] += 1 / (ss * ss)
    }
  }
  return out
}

/** The app's 3×3 soften (center weighted 2). */
function soften(m, size) {
  const out = new Float32Array(m.length)
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let s = 0, n = 0
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy
          if (xx < 0 || yy < 0 || xx >= size || yy >= size) continue
          const wgt = dx === 0 && dy === 0 ? 2 : 1
          s += m[yy * size + xx] * wgt
          n += wgt
        }
      out[y * size + x] = s / n
    }
  return out
}
