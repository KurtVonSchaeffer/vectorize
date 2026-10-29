/**
 * A thin grey tagline kept in its own colour (palette/quantize.ts, dropBlendClusters) must reach
 * every file once: the print and cut files (knockout plates, which the PDF and DXF are built from)
 * draw each outline once, so nothing is printed or cut twice. The stacked master copies each
 * tagline letter under the navy layer (RC8, `main`'s stacked design) unless clean geometry is on,
 * which drops those hidden copies (docs/clean-geometry.md).
 */
import { beforeAll, describe, expect, it } from 'vitest'
import type { FlatOptions } from '../pipeline'
import { duplicateRings, installImageData, svgPaths, vectorize } from './fidelity/harness'

beforeAll(installImageData)

const SLOW = 120_000
const NAVY = [31, 42, 92]
const GREY = [73, 80, 87]
const WHITE = [255, 255, 255]
const mix = (a: number[], b: number[], t: number) => a.map((v, i) => Math.round(v * (1 - t) + b[i] * t))

/** Navy blocks (the wordmark) over a tagline of 1 px grey letter outlines, each edge blended 60% into white. */
function wordmark(): ImageData {
  const w = 240, h = 80
  const d = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let c = WHITE
      for (const x0 of [10, 60, 110, 160]) {
        if (y >= 8 && y < 40 && x >= x0 && x < x0 + 40) c = NAVY
        else if (y >= 8 && y < 40 && (x === x0 - 1 || x === x0 + 40)) c = mix(NAVY, WHITE, 0.5)
      }
      if (y >= 55 && y < 64 && x >= 12 && x < 228) {
        const i = (x - 12) % 9
        if (i < 6 && (y === 55 || y === 63 || i === 0 || i === 5)) c = GREY
        else if (i === 6 || i === 8 || ((y === 56 || y === 62) && i > 0 && i < 5)) c = mix(GREY, WHITE, 0.6)
      }
      d.set([...c, 255], (y * w + x) * 4)
    }
  return new ImageData(d, w, h)
}

const knockout = (o: FlatOptions): FlatOptions => ({ ...o, trace: { ...o.trace, mode: 'knockout' } })
const clean = (o: FlatOptions): FlatOptions => ({ ...o, trace: { ...o.trace, connectedStacking: true } })
const near = (hex: string, c: number[], d: number) => {
  const v = parseInt(hex.slice(1), 16)
  return Math.hypot(((v >> 16) & 255) - c[0], ((v >> 8) & 255) - c[1], (v & 255) - c[2]) < d
}
const grey = (svg: string) => svgPaths(svg).some((p) => near(p.fill, GREY, 24))

type Pt = [number, number]
const inside = ([x, y]: Pt, r: Pt[]) => {
  let c = false
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) if (r[i][1] > y !== r[j][1] > y && x < ((r[j][0] - r[i][0]) * (y - r[i][1])) / (r[j][1] - r[i][1]) + r[i][0]) c = !c
  return c
}
/**
 * Filled outlines drawn twice (as in clean-geometry.test.ts): a letter's hole and the counter that
 * fills it share an edge but draw nothing twice, so holes are left out.
 */
function filledCopies(svg: string) {
  const paths = svgPaths(svg)
  return duplicateRings(paths.map((p) => ({ ...p, rings: p.rings.filter((r) => p.rings.filter((o) => o !== r && inside(r[0] as Pt, o as Pt[])).length % 2 === 0) })))
}

describe('grey tagline in every file, each outline once', () => {
  it('print and cut plates keep the grey and draw nothing twice', () => {
    const svg = vectorize(wordmark(), knockout).svg
    expect(grey(svg)).toBe(true)
    expect(filledCopies(svg)).toEqual([])
  }, SLOW)

  it('the stacked master keeps the grey; with clean geometry, no hidden copies under it', () => {
    const plain = vectorize(wordmark()).svg
    const tidy = vectorize(wordmark(), clean).svg
    expect(grey(plain)).toBe(true)
    expect(grey(tidy)).toBe(true)
    // Known (RC8): without clean geometry the navy layer copies the tagline letters.
    expect(filledCopies(plain).length).toBeGreaterThan(0)
    expect(filledCopies(tidy)).toEqual([])
  }, SLOW)
})
