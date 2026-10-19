import { beforeAll, describe, expect, it } from 'vitest'
import { colorName, colorNames } from '../../palette/names'
import { COLOR_LIMITS, DEFAULT_CLIENT, detailBoost, traceParamsFor } from '../client'
import { detectArt } from '../detect'
import type { LabelMap } from '../../trace'
import { runFlat, type FlatOptions } from '../pipeline'

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

type RGBA = [number, number, number, number]
function image(w: number, h: number, paint: (x: number, y: number) => RGBA): ImageData {
  const d = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d.set(paint(x, y), (y * w + x) * 4)
  return new FakeImageData(d, w, h) as unknown as ImageData
}

/** Anti-aliased disk coverage at a pixel. */
function cover(x: number, y: number, cx: number, cy: number, r: number) {
  return Math.max(0, Math.min(1, r + 0.5 - Math.hypot(x + 0.5 - cx, y + 0.5 - cy)))
}
const mix = (a: number[], b: number[], t: number): RGBA => [...a.map((v, i) => Math.round(v + (b[i] - v) * t)), 255] as RGBA

// A navy disk with an orange center on cream, anti-aliased: a typical small logo.
const CREAM = [255, 248, 231]
const NAVY = [43, 45, 66]
const ORANGE = [240, 140, 0]
const logo = () =>
  image(240, 160, (x, y) => {
    const base = mix(CREAM, NAVY, cover(x, y, 120, 80, 60))
    return mix(base.slice(0, 3), ORANGE, cover(x, y, 120, 80, 25))
  })

// A pill with a pink → purple gradient and a flat navy disc on cream: a typical modern logo.
const PINK = [236, 72, 153]
const PURPLE = [88, 28, 135]
const gradientLogo = () =>
  image(300, 160, (x, y) => {
    const inPill = Math.max(cover(x, y, 80, 80, 50), cover(x, y, 220, 80, 50), x >= 80 && x < 220 && Math.abs(y + 0.5 - 80) < 50 ? 1 : 0)
    const base = mix(CREAM, mix(PINK, PURPLE, (x - 30) / 240).slice(0, 3), inPill)
    return mix(base.slice(0, 3), NAVY, cover(x, y, 150, 80, 28))
  })

describe('detectArt', () => {
  it('treats flat art with a gradient as a logo, not a photo', () => {
    const d = detectArt(gradientLogo())
    expect(d.kind).toBe('flat')
    expect(d.gradients).toBe(1)
  })

  it('recognizes a flat logo with a plain background', () => {
    const d = detectArt(logo())
    expect(d.kind).toBe('flat')
    expect(d.hasAlpha).toBe(false)
    expect(d.background).not.toBeNull()
  })

  it('recognizes a photo-like gradient', () => {
    const d = detectArt(image(300, 200, (x, y) => [x % 256, (y * 3) % 256, ((x + y) * 2) % 256, 255]))
    expect(d.kind).toBe('photo')
  })

  it('recognizes black ink on paper as line art', () => {
    const d = detectArt(image(300, 200, (x, y) => (Math.abs(y - 100 - 40 * Math.sin(x / 30)) < 4 ? [20, 20, 20, 255] : [245, 243, 238, 255])))
    expect(d.kind).toBe('lineart')
  })

  it('keeps a dark navy badge with a small orange accent as flat colour', () => {
    // #2b2d42 is nearly gray by channel spread, and the orange covers ~4%: both used to read as line art.
    const d = detectArt(image(300, 200, (x, y) => (Math.hypot(x - 150, y - 100) < 70 ? [43, 45, 66, 255] : x > 20 && x < 46 && y > 20 && y < 46 ? [240, 140, 0, 255] : [255, 248, 231, 255])))
    expect(d.kind).toBe('flat')
  })

  it('keeps navy lettering on white as flat colour', () => {
    const d = detectArt(image(400, 100, (x, y) => (y > 40 && y < 60 && x % 12 < 2 ? [31, 42, 92, 255] : [255, 255, 255, 255])))
    expect(d.kind).toBe('flat')
  })

  it('keeps a uniform slate-gray logo as flat colour, so it is not turned black', () => {
    const d = detectArt(image(300, 200, (x, y) => (Math.abs(y - 100 - 40 * Math.sin(x / 30)) < 6 ? [60, 64, 72, 255] : [255, 255, 255, 255])))
    expect(d.kind).toBe('flat')
  })

  it('still recognizes a pencil sketch, whose gray tone varies, as line art', () => {
    const d = detectArt(
      image(300, 200, (x, y) => {
        const on = Math.abs(y - 100 - 40 * Math.sin(x / 30)) < 4 || Math.abs(x - 60 - 20 * Math.cos(y / 25)) < 3
        const tone = 60 + ((x * 37 + y * 91) % 90) // graphite: 60–150
        return on ? [tone, tone, tone - 4, 255] : [236, 233, 226, 255]
      }),
    )
    expect(d.kind).toBe('lineart')
  })

  it('measures how much of the artwork is fine strokes', () => {
    const hairlines = detectArt(image(300, 200, (x, y) => (y % 20 === 10 || (x + y) % 37 === 0 ? [31, 42, 92, 255] : [255, 255, 255, 255])))
    expect(hairlines.fine).toBeGreaterThan(0.95)
    expect(detectArt(logo()).fine).toBeLessThan(0.2)
  })

  it('tightens curves for fine-stroke artwork and specks for tiny images, never colour merging', () => {
    const fine = detectArt(image(300, 200, (_, y) => (y % 20 === 10 ? [31, 42, 92, 255] : [255, 255, 255, 255])))
    expect(detailBoost(fine, 300, 200)).toEqual({ curves: 0.25, specks: 0 })
    const bold = detectArt(logo())
    expect(detailBoost(bold, 240, 160)).toEqual({ curves: 0, specks: 0 })
    expect(detailBoost(bold, 120, 80)).toEqual({ curves: 0, specks: 0.25 })
    const plain = traceParamsFor('flat', DEFAULT_CLIENT)
    const boosted = traceParamsFor('flat', DEFAULT_CLIENT, { curves: 0.25, specks: 0.25 })
    expect(boosted.curveTolerance).toBeLessThan(plain.curveTolerance)
    expect(boosted.filterSpeckle).toBeLessThan(plain.filterSpeckle)
    expect(boosted.colorMerge).toBe(plain.colorMerge)
  })

  it('never limits flat artwork to one colour, which merged artwork and background into one blob', () => {
    expect(COLOR_LIMITS).not.toContain(1)
    expect(traceParamsFor('flat', { ...DEFAULT_CLIENT, maxColors: 1 }).colors).toBe(2)
    expect(traceParamsFor('flat', { ...DEFAULT_CLIENT, maxColors: 3 }).colors).toBe(3)
    expect(traceParamsFor('flat', DEFAULT_CLIENT).colors).toBe(12)
    // At the lowest limit a navy mark on cream still traces as a dark mark, not a pale silhouette.
    const lowest = traceParamsFor('flat', { ...DEFAULT_CLIENT, maxColors: 1 }).colors
    const r = runFlat(logo(), {
      lineArt: false,
      removeColors: [],
      transparent: false,
      quantize: { maxColors: lowest, mergeDelta: 10, whiteIsPaper: false, palette: null, overrides: {}, minArea: 9, upscale: 1, smoothing: 0 },
      trace: { smoothing: 0.8, minArea: 9, error: 0.5, cornerAngle: 60, precision: 2 },
    })
    const fills = [...r.svg.matchAll(/fill="#([0-9a-f]{6})"/gi)].map((m) => parseInt(m[1], 16))
    const luma = (c: number) => 0.299 * (c >> 16) + 0.587 * ((c >> 8) & 255) + 0.114 * (c & 255)
    expect(fills.length).toBeGreaterThanOrEqual(2)
    expect(Math.min(...fills.map(luma))).toBeLessThan(100)
  })

  it('recognizes small hard-edged images as pixel art', () => {
    const d = detectArt(image(32, 32, (x, y) => ((x >> 2) + (y >> 2)) % 3 === 0 ? [224, 49, 49, 255] : (x >> 3) % 2 ? [122, 74, 18, 255] : [255, 192, 120, 255]))
    expect(d.kind).toBe('pixel')
  })

  it('keeps crisp flat logos flat when their straight edges sit on pixel boundaries', () => {
    // A shield at 240 px: straight sides exactly on pixel boundaries (hard), an anti-aliased
    // round base. Every left–right edge is hard, but the curve says it's a logo, not pixel art.
    const navy = [31, 42, 92]
    const shield = detectArt(
      image(240, 240, (x, y) => {
        if (x >= 56 && x < 184 && y >= 40 && y < 140) return [navy[0], navy[1], navy[2], 255]
        const c = y >= 140 ? cover(x, y, 120, 140, 64) : 0
        const [r, g, b] = navy.map((v) => Math.round(v * c + 255 * (1 - c)))
        return [r, g, b, 255]
      }),
    )
    expect(shield.kind).toBe('flat')
    // Colours side by side as crisp rectangles: nothing diagonal to judge by, so it stays flat.
    // (Four tints and a small square, as bench/cases.ts "similar colours side by side": hard
    // corner pixels at every corner, but few of them for the edge length.)
    const rects: [number, number, number, number, number[]][] = [[12, 12, 48, 48, [28, 126, 214]], [60, 12, 48, 48, [42, 134, 217]], [120, 12, 48, 48, [232, 64, 47]], [168, 12, 48, 48, [240, 96, 63]], [222, 33, 4, 4, [245, 159, 0]]]
    const blocks = detectArt(image(240, 72, (x, y) => {
      const hit = rects.find(([rx, ry, rw, rh]) => x >= rx && x < rx + rw && y >= ry && y < ry + rh)
      return hit ? [hit[4][0], hit[4][1], hit[4][2], 255] : [255, 255, 255, 255]
    }))
    expect(blocks.kind).toBe('flat')
  })

  it('still treats a small staircase-edged drawing without anti-aliasing as pixel art', () => {
    const d = detectArt(image(64, 64, (x, y) => (Math.hypot(x - 32, y - 32) < 22 ? [224, 49, 49, 255] : [255, 255, 255, 255])))
    expect(d.kind).toBe('pixel')
  })

  it('notices existing transparency', () => {
    const d = detectArt(image(100, 100, (x, y) => (cover(x, y, 50, 50, 30) > 0.5 ? [200, 30, 30, 255] : [0, 0, 0, 0])))
    expect(d.hasAlpha).toBe(true)
  })
})

describe('colorName', () => {
  it('names common colors', () => {
    expect(colorName(0x2b2d42)).toBe('Navy')
    expect(colorName(0xf08c00)).toBe('Orange')
    expect(colorName(0xfff8e7)).toBe('Cream')
  })
  it('disambiguates duplicates', () => {
    expect(colorNames([0x1c6ed6, 0x2277dd])).toEqual(['Blue', 'Blue 2'])
  })
})

describe('runFlat', () => {
  const opts = (patch: Partial<FlatOptions> = {}): FlatOptions => ({
    lineArt: false,
    removeColors: [],
    transparent: false,
    quantize: { maxColors: 12, mergeDelta: 10, whiteIsPaper: false, palette: null, overrides: {}, minArea: 9, upscale: 1, smoothing: 0 },
    trace: { smoothing: 0.8, minArea: 9, error: 0.5, cornerAngle: 60, precision: 2 },
    ...patch,
  })

  it('keeps a gradient smooth, separate from the flat colors', () => {
    const r = runFlat(gradientLogo(), opts({ gradients: 'apply' }))
    expect(r.gradients).toEqual({ found: 1, kept: 1 })
    expect(r.svg).toMatch(/<linearGradient id="gradient-1" gradientUnits="userSpaceOnUse"/)
    expect(r.svg).toMatch(/<g id="Gradient_1" data-gradient="gradient-1">\n<path id="Gradient_1_1" d="[^"]+" fill="url\(#gradient-1\)"/)
    // The chips show only the flat colors; the gradient doesn't use up the color budget.
    expect(r.palette.map((p) => colorName(p.color))).toEqual(['Cream', 'Navy'])
  })

  it('splits gradients into color bands when the client turns them off', () => {
    const r = runFlat(gradientLogo(), opts({ gradients: 'report', trace: { ...opts().trace, mode: 'knockout' } }))
    expect(r.gradients).toEqual({ found: 1, kept: 0 })
    expect(r.svg).not.toMatch(/Gradient/)
    expect(r.palette.length).toBeGreaterThan(3)
  })

  // A rough "I" and a period in navy on cream; the "I" is rebuilt from a font outline.
  const lettered = () => image(120, 60, (x, y) => (x >= 20 && x < 30 && y >= 10 && y < 50) || (x >= 38 && x < 43 && y >= 45 && y < 50) ? [43, 45, 66, 255] : [255, 248, 231, 255])
  const textFor = (): FlatOptions['text'] => {
    const coverage = new Uint8Array(120 * 60)
    for (let y = 10; y < 50; y++) for (let x = 20; x < 30; x++) coverage[y * 120 + x] = 255
    return { words: [{ text: 'I.', font: 'Test Sans', letters: [{ char: 'I', d: 'M20 10L30 10L30 50L20 50Z' }], box: [20, 10, 43, 50] }], coverage }
  }

  it('replaces traced letters with font outlines and keeps nearby punctuation', () => {
    const r = runFlat(lettered(), opts({ text: textFor() }))
    expect(r.lettered).toBe(1)
    expect(r.svg).toMatch(/<g id="Text_I" data-text="I\." data-font="Test Sans" data-color="#2B2D42">\n<path id="Text_I_1_I" d="M20 10L30 10L30 50L20 50Z"/)
    // The period is still traced in navy; the traced "I" is gone (one navy shape left).
    const navy = r.svg.match(/<g data-color="#2B2D42">([\s\S]*?)<\/g>/)?.[1] ?? ''
    expect((navy.match(/<path/g) ?? []).length).toBe(1)
    expect(r.palette.map((p) => colorName(p.color))).toEqual(['Cream', 'Navy'])
  })

  it('removes colour slivers along the rebuilt letters, but keeps other artwork of that colour', () => {
    // A 2 px pink fringe along the "I" (as anti-aliasing next to a gradient leaves) and a pink square well away from it.
    const fringed = () =>
      image(120, 60, (x, y) =>
        x >= 20 && x < 30 && y >= 10 && y < 50
          ? [43, 45, 66, 255]
          : (x >= 30 && x < 32 && y >= 10 && y < 50) || (x >= 80 && x < 100 && y >= 20 && y < 40)
            ? [236, 72, 153, 255]
            : [255, 248, 231, 255],
      )
    const before = runFlat(fringed(), opts())
    expect(before.svg).toMatch(/data-color="#EC4899"/)
    const r = runFlat(fringed(), opts({ text: textFor() }))
    expect(r.lettered).toBe(1)
    // Only the square is left in pink: one shape, well away from the letter.
    const pink = r.svg.match(/<g [^>]*data-color="#EC4899">([\s\S]*?)<\/g>/)?.[1] ?? ''
    expect((pink.match(/<path/g) ?? []).length).toBe(1)
    expect(pink).toMatch(/M\s?(8\d|9\d|100)/)
  })

  it('keeps a small solid mark of another colour right next to the rebuilt letters', () => {
    // A 4×4 pink mark touching the "I": real artwork, not an edge sliver.
    const marked = () =>
      image(120, 60, (x, y) =>
        x >= 20 && x < 30 && y >= 10 && y < 50 ? [43, 45, 66, 255] : x >= 30 && x < 34 && y >= 20 && y < 24 ? [236, 72, 153, 255] : [255, 248, 231, 255],
      )
    const r = runFlat(marked(), opts({ text: textFor(), quantize: { ...opts().quantize, minArea: 4 }, trace: { ...opts().trace, minArea: 4 } }))
    expect(r.lettered).toBe(1)
    expect(r.svg).toMatch(/data-color="#EC4899"/)
  })

  it('keeps font letters as outlines in print plates, cut exactly out of the background', () => {
    const r = runFlat(lettered(), opts({ text: textFor(), trace: { ...opts().trace, mode: 'knockout' } }))
    expect(r.lettered).toBe(1)
    expect(r.svg).toMatch(/<path id="Text_I_1_I" d="M20 10L30 10L30 50L20 50Z"/)
    // The cream background has the letter's exact outline as a hole, so plates don't overlap.
    const cream = r.svg.match(/<g data-color="#FFF8E7">([\s\S]*?)<\/g>/)?.[1] ?? ''
    expect(cream).toContain('M20 10L30 10L30 50L20 50Z')
    // The period is still traced; the traced "I" is gone.
    const navy = r.svg.match(/<g data-color="#2B2D42">([\s\S]*?)<\/g>/)?.[1] ?? ''
    expect((navy.match(/<path/g) ?? []).length).toBe(1)
  })

  it('finds exactly the three real colors and the background', () => {
    const r = runFlat(logo(), opts())
    expect(r.palette.map((p) => colorName(p.color))).toEqual(['Cream', 'Navy', 'Orange'])
    expect(r.palette[0].background).toBe(true)
    expect(colorName(r.background!)).toBe('Cream')
    expect(r.paths).toBe(3)
  })

  it('leaves the background out when transparent', () => {
    const r = runFlat(logo(), opts({ transparent: true }))
    expect(r.paths).toBe(2)
    expect(r.svg).not.toMatch(/fill="#F[EF]F/i)
  })

  it('merges a removed color into the nearest remaining one', () => {
    const first = runFlat(logo(), opts())
    const orange = first.palette.find((p) => colorName(p.color) === 'Orange')!.color
    const r = runFlat(logo(), opts({ removeColors: [orange] }))
    expect(r.palette.map((p) => colorName(p.color))).toEqual(['Cream', 'Navy'])
  })

  it('never removes the last color', () => {
    const first = runFlat(logo(), opts({ transparent: true }))
    const all = first.palette.map((p) => p.color)
    expect(runFlat(logo(), opts({ removeColors: all })).paths).toBeGreaterThan(0)
  })

  it('traces knockout shapes that do not overlap', () => {
    const r = runFlat(logo(), opts({ trace: { ...opts().trace, mode: 'knockout' } }))
    // The navy ring in knockout mode has a hole where the orange center is.
    const navy = r.svg.split('\n').find((l) => /fill="#2[A-C]2[C-E]4/i.test(l))!
    expect((navy.match(/M/g) ?? []).length).toBeGreaterThanOrEqual(2)
  })

  it('makes black ink on transparent paper for line art', () => {
    const ink = image(200, 120, (x, y) => (Math.abs(y - 60 - 20 * Math.sin(x / 20)) < 3 ? [25, 25, 25, 255] : [244, 241, 234, 255]))
    const r = runFlat(ink, opts({ lineArt: true, transparent: true }))
    expect(r.paths).toBe(1)
    expect(r.svg).toContain('fill="#000000"')
  })

  it('keeps small real detail: a 3×3 letter counter and a 3×3 full stop', () => {
    // An "o" 11 px wide with a 3×3 counter, and a full stop 3 px wide: normal at 10–12 px text.
    // Default settings: specks under 16 px² are removed, but these are enclosed, solid and contrasting.
    const NAVY: RGBA = [31, 42, 92, 255]
    const WHITE: RGBA = [255, 255, 255, 255]
    const art = image(60, 30, (x, y) => {
      if (x >= 10 && x < 21 && y >= 10 && y < 21) return x >= 14 && x < 17 && y >= 14 && y < 17 ? WHITE : NAVY
      return x >= 30 && x < 33 && y >= 18 && y < 21 ? NAVY : WHITE
    })
    let map: LabelMap | null = null
    runFlat(art, opts({ quantize: { ...opts().quantize, minArea: 16 }, trace: { ...opts().trace, minArea: 2 } }), (m) => (map = m))
    const m = map as unknown as LabelMap
    const at = (x: number, y: number) => m.colors[m.labels[y * m.w + x]]
    expect(at(15, 15)).toBe(at(0, 0))
    expect(at(31, 19)).toBe(at(12, 12))
  })

  it('keeps the counter and full stop in print plates too', () => {
    const NAVY: RGBA = [31, 42, 92, 255]
    const WHITE: RGBA = [255, 255, 255, 255]
    const art = image(60, 30, (x, y) => {
      if (x >= 10 && x < 21 && y >= 10 && y < 21) return x >= 14 && x < 17 && y >= 14 && y < 17 ? WHITE : NAVY
      return x >= 30 && x < 33 && y >= 18 && y < 21 ? NAVY : WHITE
    })
    const r = runFlat(art, opts({ quantize: { ...opts().quantize, minArea: 16 }, trace: { ...opts().trace, minArea: 2, detailArea: 16, mode: 'knockout', spread: 0.15 } }))
    const navy = r.svg.split('\n').filter((l) => /fill="#1F2A5C"/i.test(l)).join('')
    // Outline of the "o", its counter, and the full stop.
    expect((navy.match(/M/g) ?? []).length).toBe(3)
  })

  it('still removes a compression smudge below the speck size', () => {
    // A 3×3 half-blend of navy and white inside the white area, as JPEG ringing leaves.
    const art = image(60, 30, (x, y) => (x >= 10 && x < 30 && y >= 5 && y < 25 ? [31, 42, 92, 255] : x >= 40 && x < 43 && y >= 12 && y < 15 ? [150, 155, 178, 255] : [255, 255, 255, 255]))
    let map: LabelMap | null = null
    runFlat(art, opts({ quantize: { ...opts().quantize, minArea: 16 } }), (m) => (map = m))
    const m = map as unknown as LabelMap
    expect(m.colors[m.labels[13 * m.w + 41]]).toBe(m.colors[m.labels[0]])
  })

  it('keeps a 1 px anti-aliased line, at its true position', () => {
    // A solid navy block, and a 1 px navy line between two pixel rows (each row a 50% blend):
    // smoothing used to flatten the line below the contour level.
    const art = image(160, 60, (x, y) => (x >= 120 && x < 150 && y >= 15 && y < 45 ? [31, 42, 92, 255] : x >= 10 && x < 110 && (y === 29 || y === 30) ? [143, 149, 174, 255] : [255, 255, 255, 255]))
    const r = runFlat(art, opts({ quantize: { ...opts().quantize, minArea: 16 }, trace: { ...opts().trace, smoothing: 0.7, minArea: 2 } }))
    const navy = r.svg.split('\n').filter((l) => /fill="#1F2A5C"/i.test(l))
    expect(navy).toHaveLength(2)
    // The line's outline stays within half a pixel of the true stroke (y 29.5–30.5 in pixel coordinates 29–31).
    const line = navy.find((l) => !l.includes('M120'))!
    // On-curve points: the start, and every third point of each curve (the rest are controls).
    const pts = [...line.matchAll(/(-?[\d.]+) (-?[\d.]+)/g)].map((m) => Number(m[2]))
    const ys = pts.filter((_, i) => i === 0 || i % 3 === 0)
    expect(Math.min(...ys)).toBeGreaterThan(29)
    expect(Math.max(...ys)).toBeLessThan(31.2)
  })

  it('does not turn a faint smudge into a line', () => {
    // Two rows at 15% navy: too faint to be a stroke.
    const art = image(160, 60, (x, y) => (x >= 120 && x < 150 && y >= 15 && y < 45 ? [31, 42, 92, 255] : x >= 10 && x < 110 && (y === 29 || y === 30) ? [221, 223, 231, 255] : [255, 255, 255, 255]))
    const r = runFlat(art, opts({ quantize: { ...opts().quantize, minArea: 16 }, trace: { ...opts().trace, smoothing: 0.7, minArea: 2 } }))
    expect(r.svg.split('\n').filter((l) => /fill="#1F2A5C"/i.test(l))).toHaveLength(1)
  })

  it('copes with a single-color image', () => {
    const r = runFlat(image(50, 50, () => [30, 120, 200, 255]), opts())
    expect(r.paths).toBe(1)
  })
})

describe('brand colors', () => {
  const opts = (patch: Partial<FlatOptions> = {}): FlatOptions => ({
    lineArt: false,
    removeColors: [],
    transparent: false,
    quantize: { maxColors: 12, mergeDelta: 10, whiteIsPaper: false, palette: null, overrides: {}, minArea: 9, upscale: 1, smoothing: 0 },
    trace: { smoothing: 0.8, minArea: 9, error: 0.5, cornerAngle: 60, precision: 2, exactShapes: true },
    ...patch,
  })
  const BRAND_BLUE = 0x0057b8 // a brand blue far from the traced navy
  const BRAND_ORANGE = 0xff8200

  it('snaps close colors to the exact brand color and names them', () => {
    const r = runFlat(logo(), opts({ brand: { mode: 'snap', colors: [{ name: 'Brand Orange', color: BRAND_ORANGE, tolerance: 10 }] } }))
    expect(r.palette.map((p) => p.color)).toContain(BRAND_ORANGE)
    expect(r.named).toEqual([[BRAND_ORANGE, 'Brand Orange']])
    // Navy and cream are outside the tolerance and stay as traced.
    expect(r.palette.map((p) => colorName(p.color))).toEqual(['Cream', 'Navy', 'Orange'])
  })

  it('leaves colors outside the tolerance alone', () => {
    const r = runFlat(logo(), opts({ brand: { mode: 'snap', colors: [{ name: 'Brand Blue', color: BRAND_BLUE, tolerance: 5 }] } }))
    expect(r.named).toEqual([])
  })

  it('"only brand colors" snaps everything except a background with no close brand color', () => {
    const r = runFlat(logo(), opts({ brand: { mode: 'only', colors: [{ name: 'Brand Blue', color: BRAND_BLUE, tolerance: 8 }, { name: 'Brand Orange', color: BRAND_ORANGE, tolerance: 8 }] } }))
    const colors = r.palette.map((p) => p.color)
    expect(colors).toContain(BRAND_BLUE)
    expect(colors).toContain(BRAND_ORANGE)
    expect(colors.filter((c) => c !== BRAND_BLUE && c !== BRAND_ORANGE).map(colorName)).toEqual(['Cream'])
  })

  it('merges two traced colors that snap to the same brand color into one', () => {
    const r = runFlat(logo(), opts({ brand: { mode: 'only', colors: [{ name: 'Ink', color: 0x222222, tolerance: 8 }, { name: 'Paper', color: 0xfff8e7, tolerance: 8 }] } }))
    expect(r.palette.map((p) => p.color).sort()).toEqual([0x222222, 0xfff8e7].sort())
  })

  it('writes one named group per color with separate named shapes', async () => {
    const { nameSvg } = await import('../../palette/quantize')
    const r = runFlat(logo(), opts({ brand: { mode: 'snap', colors: [{ name: 'Brand Orange', color: BRAND_ORANGE, tolerance: 10 }] } }))
    const svg = nameSvg(r.svg, new Map(r.named))
    expect(svg).toContain('<g id="Brand_Orange" data-name="Brand Orange"')
    expect(svg).toContain('id="Brand_Orange_1" data-ink="Brand Orange"')
    expect(svg).toMatch(/<desc>Inks: .*Brand Orange \(#FF8200\)/)
  })
})

describe('full-colour fidelity', () => {
  // A multicolour mark (anti-aliased, overlapping feathers) above near-black lettering, like a
  // typical gradient bird logo: every colour must survive with the default settings.
  const FEATHERS: [number, number, number][] = [
    [244, 164, 84], // orange
    [188, 30, 90], // magenta
    [87, 49, 173], // purple
    [23, 52, 133], // dark blue
    [20, 118, 179], // blue
    [225, 88, 148], // pink
    [229, 107, 94], // coral
  ]
  const INK = [18, 15, 16]
  const WHITE = [255, 255, 255]
  const art = () =>
    image(200, 120, (x, y) => {
      let px: number[] = WHITE
      FEATHERS.forEach((c, i) => {
        const t = cover(x, y, 26 + i * 24, 40 + (i % 2) * 24, 26)
        if (t > 0) px = mix(px, c, t).slice(0, 3)
      })
      // Lettering: three bold bars with soft (anti-aliased) edges.
      for (let k = 0; k < 3; k++) {
        const x0 = 20 + k * 60, x1 = x0 + 30, y0 = 92, y1 = 116
        const t = Math.max(0, Math.min(1, x + 1 - x0)) * Math.max(0, Math.min(1, x1 - x)) * Math.max(0, Math.min(1, y + 1 - y0)) * Math.max(0, Math.min(1, y1 - y))
        if (t > 0) px = mix(px, INK, t).slice(0, 3)
      }
      return [...px.slice(0, 3), 255] as RGBA
    })
  const params = traceParamsFor('flat', DEFAULT_CLIENT)
  const opts: FlatOptions = {
    lineArt: false,
    removeColors: [],
    transparent: false,
    quantize: { maxColors: params.colors, mergeDelta: params.colorMerge, whiteIsPaper: false, palette: null, overrides: {}, minArea: 9, upscale: 1, smoothing: 0 },
    trace: { smoothing: 0.8, minArea: 9, error: 0.5, cornerAngle: 60, precision: 2 },
  }
  const fills = (svg: string) => [...new Set([...svg.matchAll(/fill="#([0-9a-f]{6})"/gi)].map((m) => parseInt(m[1], 16)))]
  const near = (c: number, [r, g, b]: number[], tol = 24) => Math.abs((c >> 16) - r) + Math.abs(((c >> 8) & 255) - g) + Math.abs((c & 255) - b) <= tol * 3

  it('keeps every colour of a multicolour mark and its dark lettering with default settings', () => {
    const got = fills(runFlat(art(), opts).svg)
    for (const c of [...FEATHERS, INK]) expect(got.some((f) => near(f, c))).toBe(true)
  })
})
