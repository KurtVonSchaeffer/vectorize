import { beforeAll, describe, expect, it } from 'vitest'
import type { LabelMap } from '../../trace'
import { compactPath, composeIllustration, fillTexture, maskShare, onlyTexture, simplifyTexture, texturedMask } from '../illustration'

class FakeImageData {
  constructor(
    public data: Uint8ClampedArray,
    public width: number,
    public height: number,
  ) {}
}
beforeAll(() => {
  ;(globalThis as unknown as { ImageData: unknown }).ImageData = FakeImageData
})

type RGB = [number, number, number]
function image(w: number, h: number, paint: (x: number, y: number) => RGB): ImageData {
  const d = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d.set([...paint(x, y), 255], (y * w + x) * 4)
  return new FakeImageData(d, w, h) as unknown as ImageData
}

// Fur in pen strokes: browns, oranges and black changing every few pixels, with varying pressure.
const FUR: RGB[] = [[90, 45, 20], [150, 70, 25], [200, 110, 40], [20, 12, 8], [120, 60, 30], [230, 200, 140]]
const fur = (x: number, y: number): RGB => {
  const stroke = Math.floor((x * 3 + y * 2 + ((x * y) % 7)) / 4) % FUR.length
  const shade = ((x * 13 + y * 29) % 41) - 20
  return FUR[stroke].map((v) => Math.max(0, Math.min(255, v + shade))) as RGB
}
// Black lettering (vertical bars) on an orange-to-yellow gradient, as on a badge's ring.
const ring = (x: number, y: number): RGB => (y > 20 && y < 60 && x % 14 < 5 ? [15, 10, 5] : [245, Math.round(140 + (y / 80) * 70), 30])

describe('texturedMask', () => {
  it('marks hatched fur and leaves lettering on a gradient beside it flat', () => {
    // Left half fur, right half lettering on a gradient.
    const img = image(240, 80, (x, y) => (x < 120 ? fur(x, y) : ring(x, y)))
    const m = texturedMask(img)
    const share = (x0: number, x1: number) => {
      let on = 0
      for (let y = 0; y < 80; y++) for (let x = x0; x < x1; x++) on += m[y * 240 + x]
      return on / ((x1 - x0) * 80)
    }
    expect(share(0, 100)).toBeGreaterThan(0.9)
    expect(share(140, 240)).toBe(0)
  })

  it('marks nothing on a flat logo', () => {
    const img = image(200, 120, (x, y) => (Math.hypot(x - 100, y - 60) < 45 ? [200, 30, 40] : [255, 255, 255]))
    expect(maskShare(texturedMask(img))).toBe(0)
  })
})

describe('fillTexture', () => {
  it('fills the texture with its most common colour but keeps a band along its edge', () => {
    const w = 40
    const h = 20
    const labels = new Uint8Array(w * h).map((_, p) => ((p % w) + Math.floor(p / w)) % 3)
    const map: LabelMap = { w, h, labels, second: new Uint8Array(w * h).fill(255), cov: new Float32Array(w * h).fill(1), colors: [0x111111, 0x884422, 0xcc7733] }
    const mask = new Uint8Array(w * h).map((_, p) => (p % w < 30 ? 1 : 0))
    const out = fillTexture(map, mask)
    const at = (x: number, y: number) => out.labels[y * w + x]
    // Inside: one colour. Within 3 px of the edge (x 27–29, and the image border): unchanged.
    const inside = new Set<number>()
    for (let y = 4; y < 16; y++) for (let x = 4; x < 26; x++) inside.add(at(x, y))
    expect(inside.size).toBe(1)
    for (let y = 0; y < h; y++) expect(at(29, y)).toBe(labels[y * w + 29])
    for (let y = 0; y < h; y++) for (let x = 30; x < w; x++) expect(at(x, y)).toBe(labels[y * w + x])
  })
})

describe('simplifyTexture', () => {
  it('redraws black-and-orange hatching as a few solid tones, with no specks', () => {
    // Left half: black and orange strokes (1 px apart, as engraved fur); right half: cream.
    const w = 120
    const h = 80
    const BLACK: RGB = [10, 8, 5]
    const ORANGE: RGB = [220, 120, 40]
    const CREAM: RGB = [240, 205, 125]
    const img = image(w, h, (x, y) => (x < 60 ? ((x + y) % 3 ? BLACK : ORANGE) : CREAM))
    const pal = [BLACK, ORANGE, CREAM].map(([r, g, b]) => (r << 16) | (g << 8) | b)
    const labels = new Uint8Array(w * h).map((_, p) => {
      const x = p % w, y = Math.floor(p / w)
      return x < 60 ? ((x + y) % 3 ? 0 : 1) : 2
    })
    const map: LabelMap = { w, h, labels, second: new Uint8Array(w * h).fill(255), cov: new Float32Array(w * h).fill(1), colors: pal }
    const out = simplifyTexture(map, new Uint8Array(w * h).fill(1), img)
    // The hatching is one tone now: its average (dark brown), a new colour; the cream stays cream.
    const hatch = new Set<number>()
    for (let y = 8; y < h - 8; y++) for (let x = 8; x < 52; x++) hatch.add(out.labels[y * w + x])
    expect(hatch.size).toBe(1)
    const tone = out.colors[[...hatch][0]]
    const [r, g, b] = [(tone >> 16) & 255, (tone >> 8) & 255, tone & 255]
    expect(r).toBeGreaterThan(60) // not black
    expect(r).toBeLessThan(160) // not orange
    expect(g).toBeLessThan(r)
    expect(b).toBeLessThan(g)
    expect(out.labels[40 * w + 100]).toBe(2)
    // No shapes smaller than the minimum area are left.
    const seen = new Uint8Array(w * h)
    for (let s = 0; s < w * h; s++) {
      if (seen[s]) continue
      const l = out.labels[s]
      const stack = [s]
      seen[s] = 1
      let size = 0
      while (stack.length) {
        const p = stack.pop()!
        size++
        const x = p % w
        for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w]) if (q >= 0 && q < w * h && !seen[q] && out.labels[q] === l) (seen[q] = 1), stack.push(q)
      }
      expect(size).toBeGreaterThanOrEqual(16)
    }
  })
})

describe('onlyTexture', () => {
  it('makes the shading image transparent outside the texture, with a margin', () => {
    // Flat map 10×10 with texture at x 0–3; shading image at 2× (20×20).
    const mask = new Uint8Array(100).map((_, p) => (p % 10 < 4 ? 1 : 0))
    const img = image(20, 20, () => [100, 50, 20])
    const out = onlyTexture(img, mask, 10, 10, 2)
    const alpha = (X: number, Y: number) => out.data[(Y * 20 + X) * 4 + 3]
    expect(alpha(2, 10)).toBe(255) // texture
    expect(alpha(11, 10)).toBe(255) // flat x 5: within the 2 px margin
    expect(alpha(12, 10)).toBe(0) // flat x 6: outside
    expect(alpha(19, 10)).toBe(0)
  })
})

describe('compactPath', () => {
  // Points along a path in absolute coordinates, from its commands.
  function points(d: string): number[][] {
    const pts: number[][] = []
    let cx = 0, cy = 0, sx = 0, sy = 0
    for (const [, c, args] of d.matchAll(/([a-zA-Z])([^a-zA-Z]*)/g)) {
      const n = (args.match(/-?\d*\.?\d+/g) ?? []).map(Number)
      if (c === 'M') [cx, cy] = [sx, sy] = [n[0], n[1]]
      else if (c === 'm') [cx, cy] = [sx, sy] = [cx + n[0], cy + n[1]]
      else if (c === 'C') [cx, cy] = [n[4], n[5]]
      else if (c === 'c') [cx, cy] = [cx + n[4], cy + n[5]]
      else if (c === 'h') cx += n[0]
      else if (c === 'v') cy += n[0]
      else if (c === 'l') [cx, cy] = [cx + n[0], cy + n[1]]
      else if (c === 'z' || c === 'Z') [cx, cy] = [sx, sy]
      pts.push([cx, cy])
    }
    return pts
  }

  it("writes VTracer's straight curves as lines, relative, without spare characters", () => {
    expect(compactPath('M0 0 C1 0 2 0 3 0 C3 1 3 2 3 3 C4 4 5 4 6 3 Z')).toBe('m0 0h3v3c1 1 2 1 3 0z')
    expect(compactPath('M10 10 C10.5 10.5 11 11 12 12 Z')).toBe('m10 10l2 2z')
    expect(compactPath('M0 0 C-0.26 0.5 -0.5 0.76 -0.5 1.26 Z')).toBe('m0 0c-.3.5-.5.8-.5 1.3z')
  })

  it('keeps every point where it was, to the precision, however long the path', () => {
    let d = 'M0.04 0.04'
    for (let k = 1; k <= 200; k++) d += ` C${k * 1.04} ${k * 0.53 + 1} ${k * 1.04} ${k * 0.53 + 2} ${k * 1.04} ${k * 0.53}`
    const before = points(d + ' Z')
    const after = points(compactPath(d + ' Z'))
    expect(after).toHaveLength(before.length)
    after.forEach((p, i) => {
      expect(Math.abs(p[0] - before[i][0])).toBeLessThanOrEqual(0.05 + 1e-9)
      expect(Math.abs(p[1] - before[i][1])).toBeLessThanOrEqual(0.05 + 1e-9)
    })
  })

  it('leaves other path data alone', () => {
    expect(compactPath('M0 0H10V10Z')).toBe('M0 0H10V10Z')
    expect(compactPath('M0 0 10 10 Z')).toBe('M0 0 10 10 Z')
  })
})

describe('composeIllustration', () => {
  const flat = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50" viewBox="0 0 100 50"><path d="M0 0H100V50H0Z" fill="#111111"/></svg>'
  const photo = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50" viewBox="0 0 200 100"><path d="M0 0H200V100H0Z" fill="#884422"/></svg>'

  it('draws the shading over the flat art as plain paths, scaled to its viewBox and compacted', () => {
    const traced = photo.replace('M0 0H200V100H0Z', 'M0 0 C10 0 20 0 30 0 C30 10 30 20 30 30 Z')
    const svg = composeIllustration(flat, traced)
    expect(svg.startsWith(flat.replace('</svg>', ''))).toBe(true)
    expect(svg.endsWith('<g id="Shading" transform="scale(0.5 0.5)"><path d="m0 0h30v30z" fill="#884422"/></g></svg>')).toBe(true)
    // No clip paths, masks or other constructs that cutters and the self-check don't read as vector.
    expect(svg).not.toMatch(/clip|mask/i)
  })

  it('leaves the flat art alone when nothing is texture', () => {
    expect(composeIllustration(flat, '<svg viewBox="0 0 200 100"></svg>')).toBe(flat)
  })
})
