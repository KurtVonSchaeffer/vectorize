import { flatten, parsePath, type Pt } from '../export/path'
import { inkMask } from './match'
import type { Box } from './ocr'

/**
 * Trademark marks next to rebuilt words: ®, ™ and ©. OCR leaves them out (they're symbols, and
 * usually too small to read), so they stayed traced: a 10 px ® came out as a blob beside clean
 * letters. A small separate shape just past a word's last letter is tried as each mark, drawn from
 * the word's font, and replaced only when one of them clearly fits better than the others and than
 * a plain dot.
 */

export const MARKS = ['®', '™', '©'] as const

/** Letter outlines from a font (as lettering.ts loads them). */
export interface MarkFont {
  unitsPerEm: number
  glyph(char: string): { bbox: { x1: number; y1: number; x2: number; y2: number }; path(x: number, y: number, size: number): string } | null
}

/** The mark must match the artwork's ink at least this well (IoU)... */
const MIN_MARK_FIT = 0.5
/** ...and beat every other mark, and a solid dot, by this much (® and © differ only inside the ring). */
const MARK_MARGIN = 0.04
/** Mark height, as a share of the word's height (the ® on the Gorilla logo is 0.11)... */
const MIN_HEIGHT = 0.08
const MAX_HEIGHT = 0.7
/** ...and in canvas pixels: smaller, ® and © can't be told apart. */
const MIN_PIXELS = 8
/** How far past the last letter the mark may start, as a share of the word's height. */
const MAX_GAP = 0.6

/**
 * Finds a ®, ™ or © just after a placed word (canvas pixels, as the word) and returns it drawn
 * from the font, or null when there is none or it isn't clearly one of them.
 */
export function findMark(font: MarkFont, word: { letters: { d: string }[]; box: Box }, img: ImageData): { char: string; d: string; box: Box; fit: number } | null {
  const b = word.box
  const h = b.y1 - b.y0
  if (!(h > 4)) return null
  // Where a mark can be: after the last letter, from above the word's top to its baseline. It can
  // start inside the word's bounds, tucked over a slanted last letter (the ® over the A of GORILLA);
  // shapes touching the letters are left out below. (A ™ is about 1.6 times as wide as it is tall.)
  const area = clamp({ x0: b.x1 - 0.5 * h, y0: b.y0 - 0.45 * h, x1: b.x1 + (MAX_GAP + MAX_HEIGHT * 1.6) * h, y1: b.y1 + 0.05 * h }, img)
  // Ink is judged together with the word, whose letters set the ink and background colors.
  const all = clamp({ x0: Math.min(b.x0, area.x0), y0: Math.min(b.y0, area.y0), x1: Math.max(b.x1, area.x1), y1: Math.max(b.y1, area.y1) }, img)
  const ink = inkMask(img, all)
  if (!ink) return null
  const W = all.x1 - all.x0, H = all.y1 - all.y0
  const letters = dilate(fill(word.letters.map((l) => l.d), all), W, H, 2)

  // Separate shapes in the area, not touching the letters or the area's edge (the rest of the artwork).
  const seen = new Int32Array(W * H).fill(-1)
  const parts: Box[] = []
  const inArea = (x: number, y: number) => x >= area.x0 - all.x0 && x < area.x1 - all.x0 && y >= area.y0 - all.y0 && y < area.y1 - all.y0
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      if (seen[i] >= 0 || ink[i] < 0.5 || !inArea(x, y)) continue
      const id = parts.length
      const part = { x0: x, y0: y, x1: x + 1, y1: y + 1 }
      let edge = false
      const stack = [i]
      seen[i] = id
      while (stack.length) {
        const j = stack.pop()!
        const px = j % W, py = (j - px) / W
        if (letters[j]) edge = true
        part.x0 = Math.min(part.x0, px); part.y0 = Math.min(part.y0, py); part.x1 = Math.max(part.x1, px + 1); part.y1 = Math.max(part.y1, py + 1)
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const nx = px + dx, ny = py + dy
            if (!inArea(nx, ny)) {
              if (nx >= 0 && ny >= 0 && nx < W && ny < H && ink[ny * W + nx] >= 0.5) edge = true
              continue
            }
            const k = ny * W + nx
            if (seen[k] < 0 && ink[k] >= 0.5) {
              seen[k] = id
              stack.push(k)
            }
          }
      }
      parts.push(edge || part.y1 - part.y0 > MAX_HEIGHT * h ? { x0: 0, y0: 0, x1: 0, y1: 0 } : part)
    }

  // The mark: the shape nearest the word's top right corner, with the shapes inside its bounds
  // (the R in a ®) and its neighbours at the same height (the M after the T of a ™).
  const valid = parts.filter((p) => p.x1 > p.x0)
  if (!valid.length) return null
  const corner: Pt = [b.x1 - all.x0, b.y0 - all.y0]
  const near = (p: Box) => Math.hypot(Math.max(0, p.x0 - corner[0]), Math.max(0, corner[1] - p.y1, p.y0 - corner[1]))
  let m = { ...valid.reduce((a, p) => (near(p) < near(a) ? p : a)) }
  const used = new Set<Box>()
  for (let grew = true; grew; ) {
    grew = false
    const mh = m.y1 - m.y0
    const slack = 0.1 * mh
    for (const p of valid) {
      if (used.has(p)) continue
      const inside = p.x0 >= m.x0 - slack && p.x1 <= m.x1 + slack && p.y0 >= m.y0 - slack && p.y1 <= m.y1 + slack
      const level = Math.min(m.y1, p.y1) - Math.max(m.y0, p.y0) > 0.7 * Math.max(mh, p.y1 - p.y0) && Math.max(p.x0 - m.x1, m.x0 - p.x1) < 0.35 * mh
      if (!inside && !level) continue
      used.add(p)
      const next = { x0: Math.min(m.x0, p.x0), y0: Math.min(m.y0, p.y0), x1: Math.max(m.x1, p.x1), y1: Math.max(m.y1, p.y1) }
      if (next.x0 !== m.x0 || next.x1 !== m.x1 || next.y0 !== m.y0 || next.y1 !== m.y1) grew = true
      m = next
    }
  }
  const mh = m.y1 - m.y0
  if (mh < Math.max(MIN_PIXELS, MIN_HEIGHT * h) || mh > MAX_HEIGHT * h) return null
  if (m.x0 + all.x0 - b.x1 > MAX_GAP * h) return null
  if (m.y0 + all.y0 > b.y0 + 0.75 * h) return null // below the word's middle: not a mark on it

  // Which mark, drawn at the shape's height and position, matches its ink best.
  const box: Box = { x0: m.x0 + all.x0, y0: m.y0 + all.y0, x1: m.x1 + all.x0, y1: m.y1 + all.y0 }
  const n = Math.max(1, Math.round(mh * 0.15))
  const cell = clamp({ x0: box.x0 - n, y0: box.y0 - n, x1: box.x1 + n, y1: box.y1 + n }, img)
  const target = new Float32Array((cell.x1 - cell.x0) * (cell.y1 - cell.y0))
  for (let y = cell.y0; y < cell.y1; y++)
    for (let x = cell.x0; x < cell.x1; x++) {
      const i = (y - all.y0) * W + (x - all.x0)
      target[(y - cell.y0) * (cell.x1 - cell.x0) + (x - cell.x0)] = letters[i] ? 0 : ink[i]
    }
  // A small mark in a compressed, upscaled image is soft while the font's is sharp: both are
  // blurred the same way, and each candidate gets its best place within a pixel and size within 10%.
  const cw = cell.x1 - cell.x0, ch = cell.y1 - cell.y0
  const soft = blur(target, cw, ch)
  const tries = [...MARKS.map((c) => ({ char: c, glyph: markGlyph(font, c) })), { char: '•', glyph: dot(font.unitsPerEm) }]
  const scored = tries
    .filter((t) => t.glyph)
    .map((t) => {
      let top = { d: '', fit: -1 }
      for (const k of [0.9, 1, 1.1])
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const cx = (box.x0 + box.x1) / 2 + dx, cy = (box.y0 + box.y1) / 2 + dy
            const hw = ((box.x1 - box.x0) * k) / 2, hh = ((box.y1 - box.y0) * k) / 2
            const d = drawAt(t.glyph!, font.unitsPerEm, { x0: cx - hw, y0: cy - hh, x1: cx + hw, y1: cy + hh })
            const fit = iou(blur(fill([d], cell), cw, ch), soft)
            if (fit > top.fit) top = { d, fit }
          }
      return { char: t.char, ...top }
    })
    .sort((a, c) => c.fit - a.fit)
  const [best, next] = scored
  if (!best || best.char === '•' || best.fit < MIN_MARK_FIT || (next && best.fit - next.fit < MARK_MARGIN)) return null
  return { char: best.char, d: best.d, box, fit: +best.fit.toFixed(3) }
}

type Glyph = NonNullable<ReturnType<MarkFont['glyph']>>

/** The font's own mark, or one built from a ring and the font's R or C (or T and M) when it has none. */
export function markGlyph(font: MarkFont, char: string): Glyph | null {
  const own = font.glyph(char)
  if (own) return own
  const U = font.unitsPerEm
  if (char === '™') {
    const t = font.glyph('T'), mm = font.glyph('M')
    if (!t || !mm) return null
    // T and M at the same height, side by side.
    const H = 0.4 * U, gap = 0.04 * U
    const k1 = H / (t.bbox.y2 - t.bbox.y1), k2 = H / (mm.bbox.y2 - mm.bbox.y1)
    const w1 = k1 * (t.bbox.x2 - t.bbox.x1), w2 = k2 * (mm.bbox.x2 - mm.bbox.x1)
    return {
      bbox: { x1: 0, y1: 0, x2: w1 + gap + w2, y2: H },
      path: (x, y, size) => {
        const k = size / U
        const at = (g: Glyph, kk: number, left: number) => g.path(x + (left - kk * g.bbox.x1) * k, y + kk * g.bbox.y1 * k, size * kk)
        return at(t, k1, 0) + at(mm, k2, w1 + gap)
      },
    }
  }
  const inner = font.glyph(char === '®' ? 'R' : char === '©' ? 'C' : '')
  if (!inner) return null
  // A ring 0.7 em across, the letter 0.36 em tall in its middle.
  const D = 0.7 * U, LH = 0.36 * U
  const kl = LH / (inner.bbox.y2 - inner.bbox.y1)
  return {
    bbox: { x1: 0, y1: 0, x2: D, y2: D },
    path: (x, y, size) => {
      const k = size / U
      const cx = x + (D / 2) * k, cy = y - (D / 2) * k
      const ks = kl * k
      const letter = inner.path(cx - (ks * (inner.bbox.x1 + inner.bbox.x2)) / 2, cy + (LH * k) / 2 + ks * inner.bbox.y1, size * kl)
      return circle(cx, cy, (D / 2) * k, false) + circle(cx, cy, (D / 2 - 0.06 * U) * k, true) + letter
    },
  }
}

/** A solid dot: what a mark is mistaken for when it's really a bullet or a period. */
function dot(U: number): Glyph {
  return { bbox: { x1: 0, y1: 0, x2: U, y2: U }, path: (x, y, size) => circle(x + size / 2, y - size / 2, size / 2, false) }
}

/** A glyph scaled to the box's height, centered on it. */
function drawAt(g: Glyph, U: number, box: Box): string {
  const s = (box.y1 - box.y0) / (g.bbox.y2 - g.bbox.y1)
  const x = (box.x0 + box.x1) / 2 - (s * (g.bbox.x1 + g.bbox.x2)) / 2
  return g.path(x, box.y0 + s * g.bbox.y2, s * U)
}

/** A circle as four cubics; `reverse` winds it the other way (a hole under nonzero fill). */
function circle(cx: number, cy: number, r: number, reverse: boolean): string {
  const c = 0.5523 * r
  const f = (v: number) => +v.toFixed(2)
  const pts = reverse
    ? [[cx + r, cy], [cx + r, cy - c, cx + c, cy - r, cx, cy - r], [cx - c, cy - r, cx - r, cy - c, cx - r, cy], [cx - r, cy + c, cx - c, cy + r, cx, cy + r], [cx + c, cy + r, cx + r, cy + c, cx + r, cy]]
    : [[cx + r, cy], [cx + r, cy + c, cx + c, cy + r, cx, cy + r], [cx - c, cy + r, cx - r, cy + c, cx - r, cy], [cx - r, cy - c, cx - c, cy - r, cx, cy - r], [cx + c, cy - r, cx + r, cy - c, cx + r, cy]]
  return `M${f(pts[0][0])} ${f(pts[0][1])}` + pts.slice(1).map((p) => `C${p.map(f).join(' ')}`).join('') + 'Z'
}

/** Coverage (0–1) of filled paths (nonzero, as fonts are) over a box, 4×4 samples per pixel. */
export function fill(paths: string[], b: Box): Float32Array {
  const W = b.x1 - b.x0, H = b.y1 - b.y0
  const out = new Float32Array(Math.max(0, W * H))
  const edges: [number, number, number, number][] = []
  for (const d of paths)
    for (const sub of parsePath(d)) {
      const pts = flatten(sub, 0.05)
      for (let i = 0; i < pts.length; i++) {
        const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % pts.length]
        if (ay !== by) edges.push([ax - b.x0, ay - b.y0, bx - b.x0, by - b.y0])
      }
    }
  const S = 4
  const xs: { x: number; w: number }[] = []
  for (let sy = 0; sy < H * S; sy++) {
    const y = (sy + 0.5) / S
    xs.length = 0
    for (const [ax, ay, bx, by] of edges) if (ay <= y !== by <= y) xs.push({ x: ax + ((y - ay) * (bx - ax)) / (by - ay), w: by > ay ? 1 : -1 })
    xs.sort((p, q) => p.x - q.x)
    let wind = 0
    for (let i = 0; i < xs.length - 1; i++) {
      wind += xs[i].w
      if (!wind) continue
      for (let sx = Math.max(0, Math.ceil(xs[i].x * S - 0.5)); sx < Math.min(W * S, Math.ceil(xs[i + 1].x * S - 0.5)); sx++) out[Math.floor(sy / S) * W + Math.floor(sx / S)] += 1 / (S * S)
    }
  }
  return out
}

function iou(a: Float32Array, b: Float32Array): number {
  let inter = 0, union = 0
  for (let i = 0; i < a.length; i++) {
    inter += Math.min(a[i], b[i])
    union += Math.max(a[i], b[i])
  }
  return union ? inter / union : 0
}

/** A 3×3 box blur (edges average what's inside the box). */
function blur(m: Float32Array, W: number, H: number): Float32Array {
  const out = new Float32Array(W * H)
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      let s = 0, n = 0
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy
          if (nx >= 0 && ny >= 0 && nx < W && ny < H) [s, n] = [s + m[ny * W + nx], n + 1]
        }
      out[y * W + x] = s / n
    }
  return out
}

/** Pixels within `r` of any covered pixel. */
function dilate(m: Float32Array, W: number, H: number, r: number): Uint8Array {
  const out = new Uint8Array(W * H)
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (m[y * W + x] < 0.25) continue
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          const nx = x + dx, ny = y + dy
          if (nx >= 0 && ny >= 0 && nx < W && ny < H) out[ny * W + nx] = 1
        }
    }
  return out
}

function clamp(b: Box, img: ImageData): Box {
  return { x0: Math.max(0, Math.floor(b.x0)), y0: Math.max(0, Math.floor(b.y0)), x1: Math.min(img.width, Math.ceil(b.x1)), y1: Math.min(img.height, Math.ceil(b.y1)) }
}
