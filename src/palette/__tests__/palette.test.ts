import { describe, expect, it } from 'vitest'
import { deltaE2000, hexToRgb, labToRgb, rgbToHex, rgbToLab, type Lab } from '../color'
import { parseAse, parseCsv, parseJson } from '../parse'
import { annotateSvg, blendInfo, blendRatio, quantizeToPalette, DEFAULT_INKS } from '../quantize'

// ImageData isn't available in Node.
class FakeImageData {
  constructor(
    public data: Uint8ClampedArray,
    public width: number,
    public height: number,
  ) {}
}
;(globalThis as unknown as { ImageData: unknown }).ImageData = FakeImageData

describe('deltaE2000', () => {
  // Reference pairs from Sharma, Wu & Dalal (2005), "The CIEDE2000 Color-Difference Formula".
  const cases: [Lab, Lab, number][] = [
    [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
    [[50, -1.3802, -84.2814], [50, 0, -82.7485], 1.0],
    [[50, 0, 0], [50, -1, 2], 2.3669],
    [[50, 2.49, -0.001], [50, -2.49, 0.0009], 7.1792],
    [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
    [[22.7233, 20.0904, -46.694], [23.0331, 14.973, -42.5619], 2.0373],
    [[90.8027, -2.0831, 1.441], [91.1528, -1.6435, 0.0447], 1.4441],
  ]
  it.each(cases)('%j vs %j = %f', (a, b, expected) => {
    expect(deltaE2000(a, b)).toBeCloseTo(expected, 3)
  })
})

describe('color conversion', () => {
  it('round-trips sRGB through Lab', () => {
    for (const hex of ['#000000', '#FFFFFF', '#E03C31', '#0085CA', '#7B4A27', '#10069F']) {
      expect(rgbToHex(labToRgb(rgbToLab(hexToRgb(hex)!)))).toBe(hex)
    }
  })
  it('maps white to L=100 in D50', () => {
    const [L, a, b] = rgbToLab([255, 255, 255])
    expect(L).toBeCloseTo(100, 1)
    expect(Math.abs(a)).toBeLessThan(0.1)
    expect(Math.abs(b)).toBeLessThan(0.1)
  })
})

/** Builds a minimal ASE file with the given entries. */
function makeAse(entries: { name: string; model: 'RGB ' | 'LAB ' | 'CMYK'; values: number[] }[]): ArrayBuffer {
  const parts: number[] = []
  const u16 = (v: number) => parts.push((v >> 8) & 255, v & 255)
  const u32 = (v: number) => parts.push((v >>> 24) & 255, (v >> 16) & 255, (v >> 8) & 255, v & 255)
  const f32 = (v: number) => {
    const b = new DataView(new ArrayBuffer(4))
    b.setFloat32(0, v)
    for (let i = 0; i < 4; i++) parts.push(b.getUint8(i))
  }
  ;[65, 83, 69, 70].forEach((c) => parts.push(c))
  u16(1)
  u16(0)
  u32(entries.length + 2)
  // Group start/end around the colors, as Illustrator writes them.
  u16(0xc001)
  u32(0)
  for (const e of entries) {
    const body: number[] = []
    const saved = parts.length
    u16(e.name.length + 1)
    for (const ch of e.name) u16(ch.charCodeAt(0))
    u16(0)
    for (const ch of e.model) parts.push(ch.charCodeAt(0))
    e.values.forEach(f32)
    u16(1) // spot
    body.push(...parts.splice(saved))
    u16(0x0001)
    u32(body.length)
    parts.push(...body)
  }
  u16(0xc002)
  u32(0)
  return new Uint8Array(parts).buffer
}

describe('parseAse', () => {
  it('reads RGB, LAB and CMYK entries and skips group markers', () => {
    const swatches = parseAse(
      makeAse([
        { name: 'Red', model: 'RGB ', values: [1, 0, 0] },
        { name: 'Lab Gray', model: 'LAB ', values: [0.5, 0, 0] },
        { name: 'Cyan', model: 'CMYK', values: [1, 0, 0, 0] },
      ]),
    )
    expect(swatches.map((s) => s.name)).toEqual(['Red', 'Lab Gray', 'Cyan'])
    expect(swatches[0].rgb).toEqual([255, 0, 0])
    expect(swatches[1].lab[0]).toBeCloseTo(50, 3)
    expect(swatches[2].rgb).toEqual([0, 255, 255])
  })
  it('rejects non-ASE data', () => {
    expect(() => parseAse(new ArrayBuffer(16))).toThrow(/Swatch Exchange/)
  })
})

describe('parseCsv', () => {
  it('reads name + hex', () => {
    const s = parseCsv('name,hex\nBrand Red,#E03C31\nBrand Blue,0085CA')
    expect(s.map((x) => [x.name, x.rgb])).toEqual([
      ['Brand Red', [224, 60, 49]],
      ['Brand Blue', [0, 133, 202]],
    ])
  })
  it('reads Lab columns when the header says L,a,b', () => {
    const s = parseCsv('name,L,a,b\nMid Gray,50,0,0')
    expect(s[0].lab).toEqual([50, 0, 0])
  })
  it('reads headerless RGB triples', () => {
    expect(parseCsv('Green\t0\t200\t0')[0].rgb).toEqual([0, 200, 0])
  })
})

describe('parseJson', () => {
  it('accepts arrays and name→hex maps', () => {
    expect(parseJson('[{"name":"A","hex":"#ff0000"},{"name":"B","lab":[50,0,0]}]').map((s) => s.name)).toEqual(['A', 'B'])
    expect(parseJson('{"C":"#00ff00"}')[0].rgb).toEqual([0, 255, 0])
  })
})

describe('quantizeToPalette', () => {
  const palette = {
    name: 'test',
    swatches: [
      { name: 'Ink Red', rgb: [220, 30, 40] as [number, number, number], lab: rgbToLab([220, 30, 40]) },
      { name: 'Ink Blue', rgb: [20, 60, 200] as [number, number, number], lab: rgbToLab([20, 60, 200]) },
      { name: 'Ink Green', rgb: [30, 160, 60] as [number, number, number], lab: rgbToLab([30, 160, 60]) },
    ],
  }
  // Left half noisy red, right half noisy blue, a white strip at the bottom.
  function image() {
    const w = 40
    const h = 20
    const d = new Uint8ClampedArray(w * h * 4)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4
        const n = ((x * 7 + y * 13) % 11) - 5
        const c = y >= 18 ? [255, 255, 255] : x < 20 ? [230 + n, 40 + n, 35 + n] : [25 + n, 55 + n, 190 + n]
        d.set([...c, 255], i)
      }
    return new ImageData(d, w, h)
  }

  it('reduces to the requested number of inks with exact swatch colors', () => {
    const q = quantizeToPalette(image(), palette, { ...DEFAULT_INKS, enabled: true, maxInks: 2 })
    expect(q.inks.map((i) => i.swatch.name).sort()).toEqual(['Ink Blue', 'Ink Red'])
    const colors = new Set<string>()
    for (let i = 0; i < q.image.data.length; i += 4) if (q.image.data[i + 3]) colors.add(q.image.data.slice(i, i + 3).join(','))
    expect([...colors].sort()).toEqual(['20,60,200', '220,30,40'])
  })

  it('leaves white as paper (transparent) when enabled', () => {
    const q = quantizeToPalette(image(), palette, { ...DEFAULT_INKS, enabled: true, maxInks: 2, whiteIsPaper: true })
    const bottom = (19 * 40 + 5) * 4
    expect(q.image.data[bottom + 3]).toBe(0)
  })

  // Red | purple fringe | blue, plus an optional small green accent square.
  function fringed(accent: boolean) {
    const w = 60
    const h = 40
    const d = new Uint8ClampedArray(w * h * 4)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let c = x < 29 ? [220, 30, 40] : x < 31 ? [120, 45, 120] : [20, 60, 200]
        if (accent && x >= 50 && x < 56 && y >= 2 && y < 8) c = [30, 160, 60]
        d.set([...c, 255], (y * w + x) * 4)
      }
    return new ImageData(d, w, h)
  }

  it('folds anti-aliasing fringe into real inks instead of adding one', () => {
    const q = quantizeToPalette(fringed(false), palette, { ...DEFAULT_INKS, enabled: true, maxInks: 4 })
    expect(q.inks.map((i) => i.swatch.name).sort()).toEqual(['Ink Blue', 'Ink Red'])
  })

  it('keeps a small but distinct accent color', () => {
    const q = quantizeToPalette(fringed(true), palette, { ...DEFAULT_INKS, enabled: true, maxInks: 4 })
    expect(q.inks.map((i) => i.swatch.name).sort()).toEqual(['Ink Blue', 'Ink Green', 'Ink Red'])
  })

  it('removes noise specks below minArea but keeps small solid detail and a thin line', () => {
    const w = 60
    const h = 40
    const d = new Uint8ClampedArray(w * h * 4)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let c = [220, 30, 40]
        if (y === 20) c = [20, 60, 200] // 1px line across the whole image
        if (x >= 10 && x < 12 && y >= 5 && y < 7) c = [99, 46, 128] // 2×2 smudge: a half-blend, nearer blue
        if (x >= 30 && x < 32 && y >= 5 && y < 7) c = [20, 60, 200] // 2×2 solid blue dot: real detail
        d.set([...c, 255], (y * w + x) * 4)
      }
    const q = quantizeToPalette(new ImageData(d, w, h), palette, { ...DEFAULT_INKS, enabled: true, maxInks: 2 }, 9)
    const blueAt = (x: number, y: number) => q.image.data[(y * w + x) * 4 + 2] === 200
    expect(blueAt(10, 5)).toBe(false)
    expect(blueAt(30, 5)).toBe(true)
    expect(Array.from({ length: w }, (_, x) => blueAt(x, 20)).every(Boolean)).toBe(true)
  })

  it('applies user overrides', () => {
    const q = quantizeToPalette(image(), palette, { ...DEFAULT_INKS, enabled: true, maxInks: 2, overrides: { 'Ink Red': 'Ink Green' } })
    expect(q.inks.map((i) => i.swatch.name).sort()).toEqual(['Ink Blue', 'Ink Green'])
    expect(q.inks.find((i) => i.swatch.name === 'Ink Green')!.auto.name).toBe('Ink Red')
  })

  it('annotates SVG paths with ink names', () => {
    const q = quantizeToPalette(image(), palette, { ...DEFAULT_INKS, enabled: true, maxInks: 2 })
    const svg = annotateSvg('<svg width="1"><path d="M0 0" fill="#DC1E28"/><path d="M0 0" fill="#143CC8"/></svg>', q.inks)
    expect(svg).toContain('id="Ink_Red_1" data-ink="Ink Red"')
    expect(svg).toContain('id="Ink_Blue_1"')
    expect(svg).toMatch(/<desc>Inks: .*Ink Red/)
  })
})

describe('blendRatio', () => {
  const navy = [43, 45, 66]
  const orange = [240, 140, 0]
  it('recognizes a linear (anti-aliased) mix and its ratio', () => {
    const mid = navy.map((v, i) => v + (orange[i] - v) * 0.3)
    expect(blendRatio(mid, navy, orange, 14)).toBeCloseTo(0.3, 2)
  })
  it('recognizes a JPEG chroma-subsampled edge pixel (dark, but orange-tinted)', () => {
    // Observed in a q=0.75 JPEG between navy and orange.
    expect(blendRatio([82, 52, 21], navy, orange, 14)).not.toBeNull()
  })
  it('recognizes JPEG hue bleed: navy brightness with an orange tint', () => {
    // Observed as a surviving "brown" color in a q=0.6 JPEG of a navy disc on an orange burst.
    const info = blendInfo([67, 38, 15], navy, orange, 14)
    expect(info).not.toBeNull()
    expect(info!.t).toBeLessThan(0.05) // by brightness it looks like pure navy
    expect(info!.mix).toBeGreaterThan(0.15) // but its hue is clearly a mix
  })
  it('rejects a genuinely different color', () => {
    expect(blendRatio([30, 160, 60], navy, orange, 14)).toBeNull()
  })
})
