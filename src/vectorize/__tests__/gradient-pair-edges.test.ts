/**
 * Edges where two gradients meet (behind the clean-geometry flag): each edge pixel pairs with the
 * neighbouring colour that best explains it, so the shared edge lands where the upload's is.
 * Without clean geometry the edge is drawn as before (golden.test.ts keeps that byte-identical).
 */
import { beforeAll, describe, expect, it } from 'vitest'
import type { FlatOptions } from '../pipeline'
import { installImageData, renderSvg, svgPaths, vectorize } from './fidelity/harness'

beforeAll(installImageData)

const SLOW = 120_000
const clean = (o: FlatOptions): FlatOptions => ({ ...o, trace: { ...o.trace, connectedStacking: true } })
type RGB = [number, number, number]
const lerp = (a: RGB, b: RGB, t: number): RGB => a.map((v, i) => v + (b[i] - v) * Math.max(0, Math.min(1, t))) as RGB

/**
 * Two gradient feathers in a box on white, split by a slanted edge, 4×4 supersampled: left of it
 * orange → pink left to right, right of it violet → blue top to bottom. Black bars below stand in
 * for lettering (a large flat layer that must never show between the feathers).
 */
function feathers(): { img: ImageData; edge: (x: number, y: number) => number } {
  const w = 220, h = 170
  const edge = (x: number, y: number) => x - (110 + (y - 20) * 0.35) // < 0: left feather
  const d = new Uint8ClampedArray(w * h * 4)
  const S = 4
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0
      for (let sy = 0; sy < S; sy++)
        for (let sx = 0; sx < S; sx++) {
          const px = x + (sx + 0.5) / S, py = y + (sy + 0.5) / S
          let c: RGB = [255, 255, 255]
          if (px >= 20 && px < 200 && py >= 20 && py < 120) c = edge(px, py) < 0 ? lerp([244, 150, 70], [226, 70, 140], (px - 20) / 120) : lerp([150, 60, 200], [40, 110, 200], (py - 20) / 100)
          else if (py >= 135 && py < 160 && ((px - 20) % 30) < 18 && px > 20 && px < 200) c = [18, 15, 16]
          r += c[0]; g += c[1]; b += c[2]
        }
      d.set([r / 16, g / 16, b / 16, 255], (y * w + x) * 4)
    }
  return { img: new ImageData(d, w, h), edge }
}

/** Mean colour error (0–255) of the pixels within 1.5 px of the shared edge, and dark pixels inside the box. */
function edgeError(img: ImageData, svg: string, edge: (x: number, y: number) => number) {
  const r = renderSvg(svg, img.width, img.height)
  let e = 0, n = 0, dark = 0
  for (let y = 22; y < 118; y++)
    for (let x = 22; x < 198; x++) {
      const i = (y * img.width + x) * 4
      if (r.data[i] < 60 && r.data[i + 1] < 60 && r.data[i + 2] < 60) dark++
      if (Math.abs(edge(x + 0.5, y + 0.5)) > 1.5) continue
      for (let c = 0; c < 3; c++) e += Math.abs(img.data[i + c] - r.data[i + c])
      n += 3
    }
  return { error: e / n, dark }
}

describe('edges between two gradients (clean geometry)', () => {
  it('lands the shared edge where the upload has it, with nothing showing through', () => {
    const { img, edge } = feathers()
    const before = vectorize(img).svg
    const after = vectorize(img, clean).svg
    const grads = (svg: string) => (svg.match(/<linearGradient/g) ?? []).length
    expect(grads(before)).toBe(2)
    expect(grads(after)).toBe(2)
    const b = edgeError(img, before, edge), a = edgeError(img, after, edge)
    expect(a.error).toBeLessThan(b.error * 0.8)
    expect(a.dark).toBe(0)
    // Same colours drawn.
    const fills = (svg: string) => [...new Set(svgPaths(svg).map((p) => p.fill))].sort()
    expect(fills(after)).toEqual(fills(before))
  }, SLOW)
})
