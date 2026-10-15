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

describe('quantize: thin lettering in its own colour (grey-tagline regression)', () => {
  // A navy wordmark over a 10 px grey tagline, as in bench/cases.ts "wordmark with tiny tagline".
  // The tagline's strokes are 1 px wide with anti-aliased sides, so its grey cluster is small
  // and has almost no interior; dropBlendClusters used to treat it as navy→white edge fringe,
  // through blendInfo's JPEG chroma-subsampling test (brightness near navy, neutral hue near
  // white), although it is 29–31 sRGB units from any navy–white mix, and the grey became navy.
  // See docs/defects/grey-tagline.md; fixed by the spatial checks in dropBlendClusters
  // (docs/defects/grey-tagline-fix.md). This was it.fails while the defect was open.
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
  it('the grey survives with blend clusters kept (the blend filter is where it was lost)', () => {
    expect(colours(quantize(wordmark(), { ...TAGLINE_OPTS, keepBlends: true })).some((c) => near(c, GREY, 24))).toBe(true)
  })
  it('keeps the tagline grey as its own colour', () => {
    expect(colours(quantize(wordmark(), TAGLINE_OPTS)).some((c) => near(c, GREY, 24))).toBe(true)
  })
})

describe('quantize: thin artwork versus edge fringes', () => {
  // dropBlendClusters folds away small colours that look like a mix of two others. It must also
  // check where they are: a fringe lies between the colours it blends; thin lettering or an
  // outline in its own colour doesn't, or is a consistent band of its own.
  const NAVY = [31, 42, 92]
  const GREY = [73, 80, 87]
  const WHITE = [255, 255, 255]
  const ORANGE = [235, 120, 30]
  const PURPLE = [120, 45, 120]
  const O = { ...OPTS, maxColors: 12, minArea: 16 }
  const px = (c: number[]) => [...c.map((v) => Math.max(0, Math.min(255, Math.round(v)))), 255] as [number, number, number, number]
  const rgbList = (q: ReturnType<typeof quantize>) => q.map.colors.map((c) => [(c >> 16) & 255, (c >> 8) & 255, c & 255])
  const has = (q: ReturnType<typeof quantize>, c: number[], d = 24) => rgbList(q).some((x) => Math.hypot(x[0] - c[0], x[1] - c[1], x[2] - c[2]) < d)
  let seed = 7
  const noise = (amp: number) => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * amp

  /** Navy wordmark over a 10 px grey tagline: 1 px grey letter outlines, sides blended 60% into white. */
  const tagline = () =>
    image(240, 80, (x, y) => {
      for (const x0 of [10, 60, 110, 160]) {
        if (y >= 8 && y < 40 && x >= x0 && x < x0 + 40) return px(NAVY)
        if (y >= 8 && y < 40 && (x === x0 - 1 || x === x0 + 40)) return px(mix(NAVY, WHITE, 0.5))
      }
      if (y >= 55 && y < 64 && x >= 12 && x < 228) {
        const i = (x - 12) % 9
        if (i < 6 && (y === 55 || y === 63 || i === 0 || i === 5)) return px(GREY)
        if (i === 6 || i === 8 || ((y === 56 || y === 62) && i > 0 && i < 5)) return px(mix(GREY, WHITE, 0.6))
      }
      return px(WHITE)
    })

  it('keeps a thin grey tagline beside navy lettering as its own colour, and adds nothing else', () => {
    const q = quantize(tagline(), O)
    expect(has(q, GREY)).toBe(true)
    expect(has(q, NAVY, 12)).toBe(true)
    expect(q.map.colors.length).toBe(3)
  })

  it('still folds anti-aliased edge colours into the colours they blend', () => {
    const q = quantize(tagline(), O)
    // The navy→white and grey→white edge mixes are gone.
    expect(has(q, mix(NAVY, WHITE, 0.5), 12)).toBe(false)
    expect(has(q, mix(GREY, WHITE, 0.6), 12)).toBe(false)
  })

  it('still folds JPEG chroma fringes (dark like navy, tinted like orange), with noise', () => {
    const toYcc = (c: number[]) => [0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2], -0.1687 * c[0] - 0.3313 * c[1] + 0.5 * c[2], 0.5 * c[0] - 0.4187 * c[1] - 0.0813 * c[2]]
    const fromYcc = ([y, cb, cr]: number[]) => [y + 1.402 * cr, y - 0.344136 * cb - 0.714136 * cr, y + 1.772 * cb]
    const [yn] = toYcc(NAVY)
    const [yo, cbo, cro] = toYcc(ORANGE)
    const fringe = fromYcc([yn + 0.3 * (yo - yn), cbo * 0.7, cro * 0.7])
    seed = 7
    const src = image(200, 80, (x, y) => {
      const n = noise(8)
      const c = y < 10 || y >= 70 ? WHITE : x < 60 ? NAVY : x === 60 ? fringe : x < 140 ? ORANGE : WHITE
      return px(c.map((v) => v + n))
    })
    const q = quantize(src, O)
    expect(has(q, NAVY, 16)).toBe(true)
    expect(has(q, ORANGE, 16)).toBe(true)
    expect(q.map.colors.length).toBe(3)
  })

  it('keeps a 2 px outline in its own colour between two colours it happens to mix', () => {
    // Purple is exactly half red, half blue, and touches both, but it's a consistent band.
    const src = image(120, 60, (x) => px(x < 50 ? RED : x < 52 ? PURPLE : BLUE))
    const q = quantize(src, O)
    expect(has(q, PURPLE, 12)).toBe(true)
    expect(q.map.colors.length).toBe(3)
  })

  it('still treats a thin line drawn across pixel boundaries as anti-aliasing, not a new colour', () => {
    // A 1 px navy line between two pixel rows: each row is an exact 50% navy/white mix, far from
    // the navy block. An exact anti-aliasing mix like this is the line's own colour, blended.
    const src = image(160, 60, (x, y) => px(x >= 120 && x < 150 && y >= 15 && y < 45 ? NAVY : x >= 10 && x < 110 && (y === 29 || y === 30) ? mix(NAVY, WHITE, 0.5) : WHITE))
    expect(quantize(src, O).map.colors.length).toBe(2)
  })

  it('still folds a blurred two-pixel edge between two colours', () => {
    const src = image(120, 60, (x) => px(x < 50 ? RED : x === 50 ? mix(RED, BLUE, 1 / 3) : x === 51 ? mix(RED, BLUE, 2 / 3) : BLUE))
    const q = quantize(src, O)
    expect(q.map.colors.length).toBe(2)
  })
})
