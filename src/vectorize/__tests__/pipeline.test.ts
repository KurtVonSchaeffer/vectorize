import { beforeAll, describe, expect, it } from 'vitest'
import { colorName, colorNames } from '../../palette/names'
import { detectArt } from '../detect'
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

  it('recognizes small hard-edged images as pixel art', () => {
    const d = detectArt(image(32, 32, (x, y) => ((x >> 2) + (y >> 2)) % 3 === 0 ? [224, 49, 49, 255] : (x >> 3) % 2 ? [122, 74, 18, 255] : [255, 192, 120, 255]))
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

  it('splits gradients into solid colors for print and cut files', () => {
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

  it('writes font letters into print plates instead of overlapping them', () => {
    const r = runFlat(lettered(), opts({ text: textFor(), trace: { ...opts().trace, mode: 'knockout' } }))
    expect(r.lettered).toBe(1)
    expect(r.svg).not.toMatch(/Text_/)
    const navy = r.svg.match(/<g data-color="#2B2D42">([\s\S]*?)<\/g>/)?.[1] ?? ''
    expect((navy.match(/<path/g) ?? []).length).toBe(2) // the rebuilt "I" and the period
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
