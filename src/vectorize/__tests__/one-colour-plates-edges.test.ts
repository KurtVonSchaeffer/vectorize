import { beforeAll, describe, expect, it } from 'vitest'
import type { LabelMap } from '../../trace'
import { downloadsFor } from '../../export/files'
import { shapesFromSvg } from '../../export/path'
import { edgeKind } from '../one-colour'
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
const cover = (x: number, y: number, cx: number, cy: number, r: number) => Math.max(0, Math.min(1, r + 0.5 - Math.hypot(x + 0.5 - cx, y + 0.5 - cy)))
const mix = (a: number[], b: number[], t: number) => a.map((v, i) => Math.round(v + (b[i] - v) * t))
const rgba = (c: number[], a = 255): RGBA => [c[0], c[1], c[2], a]

const opts = (gapPx: number, production: boolean, patch: Partial<FlatOptions> = {}): FlatOptions => ({
  lineArt: false,
  removeColors: [],
  transparent: false,
  quantize: { maxColors: 12, mergeDelta: 10, whiteIsPaper: false, palette: null, overrides: {}, minArea: 9, upscale: 1, smoothing: 0 },
  trace: { smoothing: 0.8, minArea: 9, error: 0.5, cornerAngle: 60, precision: 2, mode: production ? 'knockout' : 'stacked', spread: 0 },
  oneColour: { ink: null, gapPx, production, outputWidthMm: 200 },
  ...patch,
})
/** The print PDF's spot plates, as made from the one-colour master and its print / cut file. */
async function plates(img: ImageData, patch: Partial<FlatOptions> = {}) {
  const master = runFlat(img, opts(0, false, patch))
  const file = runFlat(img, { ...opts(4, true, patch), oneColour: { ...opts(4, true, patch).oneColour!, ink: patch.oneColour?.ink ?? null } })
  const names = new Map(master.palette.map((e) => [e.color, 'Ink'] as [number, string]))
  const [pdf] = downloadsFor('print', { svg: master.svg, plateSvg: async () => file.svg, cutSvgFromPlates: true, width: img.width, height: img.height, baseName: 'x', names, spotNames: null, flat: true })
  const text = new TextDecoder('latin1').decode(await (await pdf.make()).arrayBuffer())
  return { master, plates: [...text.matchAll(/\/Separation \/(\S+) \/DeviceRGB .*?\/C1 \[([\d. ]+)\]/g)].map((m) => m[2].trim()) }
}

describe('one-colour print PDF: exactly one ink plate', () => {
  const ORANGE = [240, 140, 0], RED = [200, 30, 40]
  // A red disc with an orange centre on the given background.
  const logo = (bg: RGBA) => image(240, 160, (x, y) => {
    const c = mix(mix(bg.slice(0, 3), RED, cover(x, y, 120, 80, 60)), ORANGE, cover(x, y, 120, 80, 25))
    return rgba(c, cover(x, y, 120, 80, 60) > 0 ? 255 : bg[3])
  })

  for (const [name, bg] of [
    ['white', [255, 255, 255, 255]],
    ['cream', [255, 248, 231, 255]],
    ['near-white', [248, 249, 247, 255]],
    ['coloured (navy)', [29, 53, 87, 255]],
  ] as [string, RGBA][])
    it(`${name} background: one plate, and the colour list shows one ink`, async () => {
      const r = await plates(logo(bg))
      expect(r.plates).toHaveLength(1)
      expect(r.master.palette).toHaveLength(1)
    })

  it('transparent background: one plate', async () => {
    const r = await plates(logo([255, 255, 255, 0]), { transparent: true })
    expect(r.plates).toHaveLength(1)
    expect(r.master.palette).toHaveLength(1)
  })

  it('white chosen as the ink (artwork on a navy garment): one white plate, the navy not printed', async () => {
    const r = await plates(logo([29, 53, 87, 255]), { oneColour: { ink: 0xffffff, gapPx: 0 } })
    expect(r.plates).toEqual(['1 1 1'])
  })
})

describe('one-colour cut gaps: real edges only', () => {
  it('classifies a boundary by the step in the image, not by the colour difference alone', () => {
    expect(edgeKind(40, 45)).toBe('edge') // a shape's outline: the image steps the whole way
    expect(edgeKind(1.5, 12)).toBe('shading') // bands of a gradient: the image barely changes
    expect(edgeKind(9, 40)).toBe('unsure') // a soft edge: some step, but not the full change
    expect(edgeKind(9, 10)).toBe('edge') // two close colours with a crisp edge are still separate shapes
  })

  // Feathers: smooth gradients along their length (flattened into bands by the quantizer).
  const PINK = [236, 72, 153], ORANGE = [255, 170, 60], BLUE = [40, 70, 200], VIOLET = [140, 40, 190]
  const inFeather = (x: number, y: number, x0: number, x1: number, cy: number, half: number) => x >= x0 && x < x1 && Math.abs(y - cy) < half * Math.sin((Math.PI * (x - x0)) / (x1 - x0)) ** 0.6
  const feather = (x: number, x0: number, x1: number, a: number[], b: number[]) => mix(a, b, (x - x0) / (x1 - x0))
  const oneFeather = () => image(320, 140, (x, y) => rgba(inFeather(x, y, 20, 300, 70, 50) ? feather(x, 20, 300, ORANGE, PINK) : [255, 255, 255]))
  // A blue-violet feather drawn over an orange-pink one: a real edge where they cross.
  const twoFeathers = () =>
    image(320, 200, (x, y) =>
      rgba(inFeather(x, y, 60, 300, 120, 40) ? feather(x, 60, 300, BLUE, VIOLET) : inFeather(x, y, 20, 300, 80, 50) ? feather(x, 20, 300, ORANGE, PINK) : [255, 255, 255]),
    )
  const inkAt = (m: LabelMap, x: number, y: number) => m.labels[y * m.w + x] < 254 && m.colors[m.labels[y * m.w + x]] >= 0 && m.cov[y * m.w + x] >= 0.5

  it('a single gradient feather is not cut into bands; the master keeps the bands', () => {
    const master = runFlat(oneFeather(), opts(0, false))
    expect(master.oneColour!.inkRegions).toBeGreaterThanOrEqual(3)
    let m: LabelMap | null = null
    const file = runFlat(oneFeather(), opts(4, true), (x) => (m = x))
    expect(file.oneColour!.gaps).toBe(0)
    // Along the feather's length, every pixel is ink: no gap between bands.
    for (let x = 40; x < 280; x++) expect(inkAt(m!, x, 70)).toBe(true)
    expect(shapesFromSvg(file.svg).filter((s) => s.color === file.oneColour!.ink)).toHaveLength(1)
  })

  it('two overlapping feathers: a gap where one crosses the other, none inside either', () => {
    let m: LabelMap | null = null
    const file = runFlat(twoFeathers(), opts(4, true), (x) => (m = x))
    expect(file.oneColour!.gaps).toBeGreaterThanOrEqual(1)
    // Inside each feather, along its length, no gap.
    for (let x = 90; x < 270; x++) expect(inkAt(m!, x, 120)).toBe(true)
    for (let x = 40; x < 60; x++) expect(inkAt(m!, x, 80)).toBe(true)
    // Where the blue feather's edge crosses the orange one (y = 80 + ~40 … the blue starts below), paper.
    const column = Array.from({ length: 80 }, (_, i) => inkAt(m!, 180, 60 + i))
    expect(column.includes(false)).toBe(true)
  })

  it('an unclear (blurred) boundary stays joined and is flagged, not cut', () => {
    // Two colour blocks whose boundary is a 12 px blend: neither a crisp edge nor smooth shading.
    const blend = (x: number) => Math.min(1, Math.max(0, (x - 114) / 12))
    const img = image(240, 120, (x, y) => rgba(x >= 20 && x < 220 && y >= 20 && y < 100 ? mix([200, 30, 40], [30, 60, 160], blend(x)) : [255, 255, 255]))
    const file = runFlat(img, opts(4, true))
    expect(file.oneColour!.gaps).toBe(0)
    expect(file.oneColour!.flags.map((f) => f.reason)).toEqual(['gap-unsure'])
    // Preserved: the two blocks stay one connected piece.
    expect(shapesFromSvg(file.svg).filter((s) => s.color === file.oneColour!.ink)).toHaveLength(1)
  })
})
