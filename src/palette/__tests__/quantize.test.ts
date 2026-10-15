import { describe, expect, it } from 'vitest'
import { quantize, upscaleLabels, type QuantizeOptions } from '../quantize'

// ImageData isn't available in Node.
class FakeImageData {
  constructor(
    public data: Uint8ClampedArray,
    public width: number,
    public height: number,
  ) {}
}
;(globalThis as unknown as { ImageData: unknown }).ImageData = FakeImageData

const EMPTY = 255
const OPTS: QuantizeOptions = { maxColors: 8, mergeDelta: 10, whiteIsPaper: false, palette: null, overrides: {}, minArea: 9, upscale: 1, smoothing: 0 }

/** An image drawn per pixel: [r, g, b, a]. */
function image(w: number, h: number, px: (x: number, y: number) => [number, number, number, number]): ImageData {
  const d = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d.set(px(x, y), (y * w + x) * 4)
  return new FakeImageData(d, w, h) as unknown as ImageData
}

const mix = (a: number[], b: number[], t: number) => a.map((v, i) => Math.round(v * (1 - t) + b[i] * t))
const RED = [220, 30, 40]
const BLUE = [20, 60, 200]

describe('quantize: transparency', () => {
  it('keeps genuinely transparent pixels transparent through noise cleanup', () => {
    // A red disc on a transparent background, with isolated transparent pinholes inside it.
    const holes = new Set([20 * 40 + 20, 15 * 40 + 22, 24 * 40 + 17])
    const src = image(40, 40, (x, y) => (holes.has(y * 40 + x) || Math.hypot(x - 20, y - 20) > 12 ? [0, 0, 0, 0] : [...RED, 255] as [number, number, number, number]))
    const { map } = quantize(src, OPTS)
    for (const p of holes) expect(map.labels[p]).toBe(EMPTY)
    expect(map.labels[0]).toBe(EMPTY)
    // And no inked pixel was turned transparent.
    for (let p = 0; p < 1600; p++) if (src.data[p * 4 + 3] === 255) expect(map.labels[p]).not.toBe(EMPTY)
  })

  it('never makes ink transparent while smoothing edges, even without blend information', () => {
    const w = 12
    const labels = new Uint8Array(w * w).map((_, p) => (p % w < 6 ? 0 : 1))
    const second = new Uint8Array(w * w).fill(EMPTY)
    // Partial coverage but no second color recorded: the vote must stay with the first color.
    const cov = new Float32Array(w * w).fill(0.3)
    const out = upscaleLabels(labels, w, w, 3, 0.8, second, cov)
    expect(out.every((l) => l === 0 || l === 1)).toBe(true)
  })
})

describe('quantize: colours', () => {
  it('keeps two adjacent colours with an anti-aliased edge as exactly two colours', () => {
    // Blue left, red right, with a soft 2px anti-aliased boundary.
    const src = image(48, 32, (x) => [...mix(BLUE, RED, Math.min(1, Math.max(0, (x - 23) / 2))), 255] as [number, number, number, number])
    const { map } = quantize(src, OPTS)
    expect(new Set(map.labels).size).toBe(2)
    // The boundary stays where it was drawn (between x=23 and x=25).
    const row = Array.from(map.labels.subarray(16 * 48, 17 * 48))
    const edge = row.findIndex((l) => l !== row[0])
    expect(edge).toBeGreaterThanOrEqual(23)
    expect(edge).toBeLessThanOrEqual(25)
  })

  it('keeps the original colours, not their anti-aliased or JPEG-drifted average', () => {
    const src = image(48, 32, (x, y) => {
      const noise = ((x * 7 + y * 13) % 5) - 2
      const c = x < 24 ? BLUE : RED
      return [c[0] + noise, c[1] - noise, c[2] + noise, 255]
    })
    const { map } = quantize(src, OPTS)
    const colors = [...new Set(map.labels)].map((l) => map.colors[l])
    const near = (c: number, t: number[]) => Math.max(Math.abs(((c >> 16) & 255) - t[0]), Math.abs(((c >> 8) & 255) - t[1]), Math.abs((c & 255) - t[2]))
    expect(colors.some((c) => near(c, BLUE) <= 3)).toBe(true)
    expect(colors.some((c) => near(c, RED) <= 3)).toBe(true)
  })

  it('keeps a small but distinct detail instead of erasing it for being small', () => {
    // A 4×4 yellow square: above the speck size, so it stays, though it's tiny.
    const src = image(40, 40, (x, y) => (x >= 18 && x < 22 && y >= 18 && y < 22 ? [250, 210, 20, 255] : [...BLUE, 255] as [number, number, number, number]))
    const { map } = quantize(src, OPTS)
    expect(map.colors[map.labels[20 * 40 + 20]]).not.toBe(map.colors[map.labels[0]])
  })

  it('keeps gradient (fixed) regions out of the colour budget and labelled as given', () => {
    const fixed = new Int16Array(40 * 40).fill(-1)
    for (let y = 5; y < 35; y++) for (let x = 5; x < 20; x++) fixed[y * 40 + x] = 0
    const src = image(40, 40, (x, y) => (fixed[y * 40 + x] >= 0 ? [...mix(RED, BLUE, (y - 5) / 30), 255] : [240, 240, 240, 255]) as [number, number, number, number])
    const { map } = quantize(src, { ...OPTS, maxColors: 1 }, { labels: fixed, colors: [0x7f2f80] })
    const g = map.labels[20 * 40 + 12]
    for (let y = 6; y < 34; y++) for (let x = 6; x < 19; x++) expect(map.labels[y * 40 + x]).toBe(g)
    // The one clustered colour went to the background, not to the gradient's shades.
    expect(map.labels[0]).not.toBe(g)
  })
})

describe('quantize: similar brand tints', () => {
  const BLUE = [28, 126, 214]
  const BLUE2 = [42, 134, 217] // ΔE 2.9 from BLUE
  const opts = { ...OPTS, minArea: 9 }
  const colours = (src: ImageData) => {
    const { map } = quantize(src, opts)
    return new Set([...map.labels].filter((l) => l < 254).map((l) => map.colors[l])).size
  }

  it('keeps two exact tints side by side apart, however close', () => {
    const src = image(120, 60, (x, y) => (x < 10 || x >= 110 || y < 10 || y >= 50 ? [255, 255, 255, 255] : [...(x < 60 ? BLUE : BLUE2), 255] as [number, number, number, number]))
    expect(colours(src)).toBe(3)
  })

  it('merges one colour split into two shades by noise', () => {
    // The two shades mixed pixel by pixel all through one area, as noise leaves them.
    const src = image(120, 60, (x, y) => (x < 10 || x >= 110 || y < 10 || y >= 50 ? [255, 255, 255, 255] : [...((x * 7 + y * 13) % 3 ? BLUE : BLUE2), 255] as [number, number, number, number]))
    expect(colours(src)).toBe(2)
  })

  it('merges a gradual shade into one colour, not two bands', () => {
    const src = image(120, 60, (x, y) => (x < 10 || x >= 110 || y < 10 || y >= 50 ? [255, 255, 255, 255] : [...mix(BLUE, BLUE2, (x - 10) / 100), 255] as [number, number, number, number]))
    expect(colours(src)).toBe(2)
  })
})

describe('quantize: edge blends go to the colours they blend', () => {
  it('keeps the grey edges of black lettering black or white, not an unrelated purple or magenta', () => {
    // Black bars with wide soft edges (every grey from black to white) on white, next to dark
    // purple and magenta marks: by plain distance, mid greys sit nearer the purples than black/white.
    const INK = [18, 15, 16]
    const PURPLE = [87, 10, 115]
    const MAGENTA = [161, 67, 153]
    const W = 120
    const H = 60
    const src = image(W, H, (x, y) => {
      if (y < 20) return [...(x < 60 ? PURPLE : MAGENTA), 255] as [number, number, number, number]
      // Bars 12 px wide, each edge ramping over 6 px.
      const u = (x % 30) - 9
      const t = u < 0 ? Math.max(0, 1 + u / 6) : u > 12 ? Math.max(0, 1 - (u - 12) / 6) : 1
      return [...mix([255, 255, 255], INK, y >= 28 && y < 52 ? t : 0), 255] as [number, number, number, number]
    })
    const { map } = quantize(src, { ...OPTS, maxColors: 12 })
    const colours = map.colors
    const isPurplish = (c: number) => {
      const r = c >> 16, g = (c >> 8) & 255, b = c & 255
      return b > g + 40 && r > g + 30
    }
    // No pixel of the lettering band is given a purple or magenta label, nor a purple or magenta
    // edge partner (which would place purple slivers along the letters when edges are traced).
    for (let y = 30; y < 50; y++)
      for (let x = 0; x < W; x++) {
        const label = map.labels[y * W + x]
        if (label !== EMPTY) expect(isPurplish(colours[label])).toBe(false)
        const partner = map.second?.[y * W + x] ?? EMPTY
        if (partner !== EMPTY && partner !== label && (map.cov?.[y * W + x] ?? 1) < 0.98) expect(isPurplish(colours[partner])).toBe(false)
      }
  })
})

describe('quantize: edge colours come from around the edge', () => {
  it('never pairs a darker shade inside a violet-to-purple blend with the black of lettering elsewhere', () => {
    // A smooth violet → dark purple blend (the inner feathers of a bird logo), flattened into the
    // two colours, and black lettering bars far away. Mid-blend pixels (about 121,37,133) look like
    // violet mixed with black: choosing the partner from every colour in the image paired them with
    // black and drew a dark seam along the boundary; dark purple is the colour actually there.
    const VIOLET = [164, 56, 169]
    const PURPLE = [73, 15, 118]
    const INK = [18, 15, 16]
    const W = 200
    const H = 120
    const src = image(W, H, (x, y) => {
      if (y >= 10 && y < 60 && x >= 10 && x < 190) return [...mix(VIOLET, PURPLE, Math.max(0, Math.min(1, (x - 60) / 80))), 255] as [number, number, number, number]
      const bar = y >= 85 && y < 105 && x % 40 < 14
      return [...(bar ? INK : [255, 255, 255]), 255] as [number, number, number, number]
    })
    const { map } = quantize(src, { ...OPTS, maxColors: 8 })
    const black = map.colors.findIndex((c) => (c >> 16) < 40 && ((c >> 8) & 255) < 40 && (c & 255) < 40)
    expect(black).toBeGreaterThanOrEqual(0)
    for (let y = 14; y < 56; y++)
      for (let x = 14; x < 186; x++) {
        const p = y * W + x
        expect(map.labels[p]).not.toBe(black)
        if ((map.cov?.[p] ?? 1) < 1) expect(map.second?.[p]).not.toBe(black)
      }
describe('quantize: thin lettering in its own colour (known defect)', () => {
  // A navy wordmark over a 10 px grey tagline, as in bench/cases.ts "wordmark with tiny tagline".
  // The tagline's strokes are 1 px wide with anti-aliased sides, so its grey cluster is small
  // and has almost no interior; dropBlendClusters then treats it as navy→white edge fringe,
  // through blendInfo's JPEG chroma-subsampling test (brightness near navy, neutral hue near
  // white), although it is 29–31 sRGB units from any navy–white mix. The grey becomes navy.
  // See docs/defects/grey-tagline.md. Flip `it.fails` to `it` once fixed.
  const NAVY = [31, 42, 92]
  const GREY = [73, 80, 87]
  const WHITE = [255, 255, 255]
  const TAGLINE_OPTS: QuantizeOptions = { ...OPTS, maxColors: 12, minArea: 16 }
  function wordmark(): ImageData {
    return image(240, 80, (x, y) => {
      // Wordmark: solid navy blocks with a half-blended edge column, like anti-aliased glyphs.
      for (const x0 of [10, 60, 110, 160]) {
        if (y >= 8 && y < 40 && x >= x0 && x < x0 + 40) return [...NAVY, 255] as [number, number, number, number]
        if (y >= 8 && y < 40 && (x === x0 - 1 || x === x0 + 40)) return [...mix(NAVY, WHITE, 0.5), 255] as [number, number, number, number]
      }
      // Tagline: 1 px grey letter outlines (6×9), each side blended 60% into white.
      if (y >= 55 && y < 64) {
        const i = (x - 12) % 9
        if (x >= 12 && x < 228 && i >= 0 && i < 6) {
          const edge = y === 55 || y === 63 || i === 0 || i === 5
          if (edge) return [...GREY, 255] as [number, number, number, number]
        }
        if (x >= 12 && x < 228 && (i === 6 || i === 8 || ((y === 56 || y === 62) && i > 0 && i < 5))) return [...mix(GREY, WHITE, 0.6), 255] as [number, number, number, number]
      }
      return [...WHITE, 255] as [number, number, number, number]
    })
  }
  const colours = (q: ReturnType<typeof quantize>) => q.map.colors.map((c) => [(c >> 16) & 255, (c >> 8) & 255, c & 255])
  const near = (a: number[], b: number[], d: number) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < d

  it('keeps navy and white', () => {
    const cs = colours(quantize(wordmark(), TAGLINE_OPTS))
    expect(cs.some((c) => near(c, NAVY, 12))).toBe(true)
    expect(cs.some((c) => near(c, WHITE, 12))).toBe(true)
  })
  it('the grey survives with blend clusters kept, so it is the blend filter that drops it', () => {
    expect(colours(quantize(wordmark(), { ...TAGLINE_OPTS, keepBlends: true })).some((c) => near(c, GREY, 24))).toBe(true)
  })
  it.fails('keeps the tagline grey as its own colour', () => {
    expect(colours(quantize(wordmark(), TAGLINE_OPTS)).some((c) => near(c, GREY, 24))).toBe(true)
  })
})
