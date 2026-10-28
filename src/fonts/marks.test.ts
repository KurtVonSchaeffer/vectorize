import { describe, expect, it } from 'vitest'
import { flatten, parsePath } from '../export/path'
import type { Point, RGB, Shape } from '../vectorize/__tests__/fidelity/harness'
import { fill, findMark, markGlyph, type MarkFont } from './marks'

// A block-letter font with no ®, ™ or © of its own (so the marks are built from R, C, T and M),
// in font units (1000 per em, y up).
const U = 1000
const rects = (...rs: [number, number, number, number][]) => rs.map(([x0, y0, x1, y1]) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] as Point[])
const GLYPHS: Record<string, Point[][]> = {
  // R: stem, three bars around the bowl's counter, leg.
  R: [...rects([0, 0, 160, 700], [160, 560, 520, 700], [160, 300, 520, 440], [400, 440, 520, 560]), [[300, 300], [440, 300], [560, 0], [420, 0]]],
  C: rects([0, 0, 160, 700], [160, 0, 560, 140], [160, 560, 560, 700]),
  T: rects([0, 560, 600, 700], [220, 0, 380, 560]),
  M: [...rects([0, 0, 140, 700], [560, 0, 700, 700]), [[140, 700], [350, 300], [560, 700], [560, 560], [350, 160], [140, 560]]],
  H: rects([0, 0, 160, 700], [440, 0, 600, 700], [160, 280, 440, 420]),
}
const font: MarkFont = {
  unitsPerEm: U,
  glyph(char) {
    const rings = GLYPHS[char]
    if (!rings) return null
    const xs = rings.flat().map((p) => p[0]), ys = rings.flat().map((p) => p[1])
    return {
      bbox: { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) },
      path: (x, y, size) => rings.map((r) => 'M' + r.map(([u, v]) => `${x + (u * size) / U} ${y - (v * size) / U}`).join('L') + 'Z').join(''),
    }
  },
}

const INK: RGB = [20, 20, 25]
const BOARD: RGB = [250, 200, 70]
const toRings = (d: string) => parsePath(d).map((s) => flatten(s, 0.05) as Point[])
const ring = (cx: number, cy: number, r: number, t: number): Point[][] => [
  Array.from({ length: 40 }, (_, i) => [cx + r * Math.cos((i / 40) * 2 * Math.PI), cy + r * Math.sin((i / 40) * 2 * Math.PI)] as Point),
  Array.from({ length: 40 }, (_, i) => [cx + (r - t) * Math.cos((-i / 40) * 2 * Math.PI), cy + (r - t) * Math.sin((-i / 40) * 2 * Math.PI)] as Point),
]

/** "HHH" 36 px tall at (10, 24), and what is drawn after it, as the artwork and the placed word. */
function scene(after: (x: number, top: number) => Shape[], noise = 0) {
  const size = (36 / 700) * U
  const letters = [0, 1, 2].map((i) => ({ d: font.glyph('H')!.path(10 + i * 36, 60, size) }))
  const word = { letters, box: { x0: 10, y0: 24, x1: 10 + 2 * 36 + (600 * size) / U, y1: 60 } }
  const shapes: Shape[] = [{ rings: letters.flatMap((l) => toRings(l.d)), color: INK }, ...after(word.box.x1, 24)]
  return { img: paint(170, 76, shapes, noise), word }
}

/** Anti-aliased shapes over the board (the fidelity harness's painter is too slow for many cases). */
function paint(w: number, h: number, shapes: Shape[], noise: number): ImageData {
  const d = new Uint8ClampedArray(w * h * 4)
  for (let p = 0; p < w * h; p++) d.set([...BOARD, 255], p * 4)
  for (const s of shapes) {
    const cov = fill([s.rings.map((r) => 'M' + r.map((p) => p.join(' ')).join('L') + 'Z').join('')], { x0: 0, y0: 0, x1: w, y1: h })
    for (let p = 0; p < w * h; p++) {
      const a = Math.min(1, cov[p])
      for (let k = 0; k < 3; k++) d[p * 4 + k] = d[p * 4 + k] * (1 - a) + s.color[k] * a
    }
  }
  let seed = 12345
  if (noise) for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) d[i + k] += ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5) * 2 * noise
  return { data: d, width: w, height: h } as ImageData
}

/** A mark drawn independently of the font's construction: a thicker ring and the letter a little smaller. */
function drawnMark(letter: 'R' | 'C', x: number, top: number, d = 13): Shape[] {
  const cx = x + 4 + d / 2, cy = top + d / 2
  const g = font.glyph(letter)!
  const size = ((d * 0.48) / 700) * U
  const lx = cx - ((g.bbox.x2 * size) / U) / 2
  return [{ rings: ring(cx, cy, d / 2, d * 0.1), color: INK }, { rings: toRings(g.path(lx, cy + d * 0.24, size)), color: INK }]
}

describe('trademark marks after rebuilt words', () => {
  it('finds a ® and draws it from the font', () => {
    const { img, word } = scene((x, top) => drawnMark('R', x, top))
    const m = findMark(font, word, img)
    expect(m?.char).toBe('®')
    expect(m!.box.y1 - m!.box.y0).toBeGreaterThan(11)
    expect(m!.fit).toBeGreaterThan(0.5)
  })

  it('tells a © from a ®', () => {
    const { img, word } = scene((x, top) => drawnMark('C', x, top))
    expect(findMark(font, word, img)?.char).toBe('©')
  })

  it('finds a ™', () => {
    const { img, word } = scene((x, top) => [{ rings: toRings(markGlyph(font, '™')!.path(x + 4, top + 11, (11 / 0.4 / 1000) * U)), color: INK }])
    expect(findMark(font, word, img)?.char).toBe('™')
  })

  it('finds a small ® in a noisy image', () => {
    const { img, word } = scene((x, top) => drawnMark('R', x, top, 10), 8)
    expect(findMark(font, word, img)?.char).toBe('®')
  })

  it('leaves a dot, a far shape and nothing alone', () => {
    const dot = (x: number, top: number): Shape[] => [{ rings: ring(x + 9, top + 6, 6, 6).slice(0, 1), color: INK }]
    const far = (x: number, top: number) => drawnMark('R', x + 30, top)
    for (const after of [dot, far, () => []]) {
      const { img, word } = scene(after)
      expect(findMark(font, word, img)).toBeNull()
    }
  })

  it('uses the font’s own mark when it has one', () => {
    const own: MarkFont = { ...font, glyph: (c) => (c === '®' ? font.glyph('H') : font.glyph(c)) }
    expect(markGlyph(own, '®')!.bbox).toEqual(font.glyph('H')!.bbox)
    expect(markGlyph(font, '®')!.bbox).toEqual({ x1: 0, y1: 0, x2: 700, y2: 700 })
  })
})
