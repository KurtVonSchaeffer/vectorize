/**
 * Print and cut files (behind the print-files flag): a paper background is never a white-ink plate
 * unless asked, white inside the artwork is kept when asked, and every print and cut file has one
 * physical size. Off, nothing changes (golden.test.ts).
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { downloadsFor, printWidthMm, PRINT_LONGEST_MM } from '../../export/files'
import { onePlate, platesOf } from '../../export/plates'
import { paperOutFor, type WhiteInk } from '../paper'
import { runFlat, type FlatOptions } from '../pipeline'
import { circle, colourAt, installImageData, paint, paperPlate, productionOptions, rect, renderSvg, svgPaths, type RGB } from './fidelity/harness'

beforeAll(installImageData)

const SLOW = 120_000
const PAPER: RGB = [252, 253, 251]
const BLUE: RGB = [40, 110, 180]
const WHITE: RGB = [255, 255, 255]

/** The print / cut (knockout) file for an upload, with the paper option. */
function plates(img: ImageData, paper?: FlatOptions['paper'], tweak: (o: FlatOptions) => FlatOptions = (o) => o) {
  const o = productionOptions(img)
  return runFlat(img, tweak({ ...o, trace: { ...o.trace, mode: 'knockout', spread: 0.15 }, ...(paper ? { paper } : {}) }))
}
const isLight = (fill: string | null) => !!fill && fill.startsWith('#') && Math.min(...[1, 3, 5].map((i) => parseInt(fill.slice(i, i + 2), 16))) >= 235

// A badge on paper, as a JPEG would bring it: a blue disc with white lettering inside, on near-white.
const badge = () =>
  paint(120, 120, PAPER, [
    { rings: [circle(60, 60, 40)], color: BLUE },
    { rings: [rect(40, 52, 46, 70), rect(52, 52, 58, 70), rect(64, 52, 70, 70)], color: WHITE },
  ], 3)

describe('paper background', () => {
  it('is printed as a white plate today (no paper option)', () => {
    const r = plates(badge())
    expect(r.paper).toBe(true)
    expect(paperPlate(svgPaths(r.svg), 120, 120)).not.toBeNull()
  }, SLOW)

  it("'border': the background is left out, white lettering inside the artwork stays", () => {
    const P = svgPaths(plates(badge(), 'border').svg)
    expect(paperPlate(P, 120, 120)).toBeNull()
    expect(colourAt(P, 5, 5)).toBeNull() // paper corner: nothing printed
    expect(isLight(colourAt(P, 43, 61))).toBe(true) // white letter: still a white shape
    expect(colourAt(P, 60, 35)).not.toBeNull() // blue disc
  }, SLOW)

  it("'all': no white ink at all, the disc and its holes stay", () => {
    const P = svgPaths(plates(badge(), 'all').svg)
    expect(paperPlate(P, 120, 120)).toBeNull()
    expect(colourAt(P, 43, 61)).toBeNull() // the letters are holes: the material shows
    expect(colourAt(P, 5, 5)).toBeNull()
    expect(isLight(colourAt(P, 60, 35))).toBe(false)
    expect(colourAt(P, 60, 35)).not.toBeNull()
  }, SLOW)

  it('keeps the artwork edge where it was (same disc area within 1%)', () => {
    const area = (paper?: FlatOptions['paper']) => {
      const P = svgPaths(plates(badge(), paper).svg)
      let n = 0
      for (let y = 0.25; y < 120; y += 0.5) for (let x = 0.25; x < 120; x += 0.5) if (colourAt(P, x, y) && !isLight(colourAt(P, x, y))) n++
      return n
    }
    const before = area()
    expect(Math.abs(area('border') - before) / before).toBeLessThan(0.01)
  }, SLOW)
})

describe('white-ink modes', () => {
  it('each choice makes the plates with its paper option; "Print white background too" is today’s files', () => {
    expect(paperOutFor('none')).toBe('all')
    expect(paperOutFor('artwork')).toBe('border')
    expect(paperOutFor('all')).toBeUndefined()
  })

  it('flags white the artwork encloses (the ambiguous case), and only then', () => {
    expect(plates(badge()).enclosedPaper).toBe(true)
    const plain = paint(120, 120, PAPER, [{ rings: [circle(60, 60, 40)], color: BLUE }], 3)
    expect(plates(plain).paper).toBe(true)
    expect(plates(plain).enclosedPaper).toBe(false)
    // Not paper at all: nothing to ask.
    expect(plates(paint(120, 120, null, [{ rings: [circle(60, 60, 40)], color: BLUE }])).enclosedPaper).toBe(false)
  }, SLOW)
})

/**
 * What a printed garment shows at a point: the plates rendered and laid over the garment colour,
 * read back as the garment (nothing prints), white ink or a coloured ink.
 */
const GARMENTS: Record<string, RGB> = { white: [255, 255, 255], coloured: [31, 59, 92] }
const onGarment = (svg: string, w: number, h: number, garment: RGB) => {
  const img = renderSvg(svg, w, h)
  return (x: number, y: number) => {
    const p = (Math.floor(y) * w + Math.floor(x)) * 4
    const a = img.data[p + 3] / 255
    const c = [0, 1, 2].map((i) => img.data[p + i] * a + garment[i] * (1 - a))
    const near = (q: RGB) => Math.max(...c.map((v, i) => Math.abs(v - q[i]))) <= 12
    // On a white garment, white ink and the garment look alike: tell them apart by coverage.
    if (a < 0.5) return 'garment'
    if (near(WHITE) || near(PAPER)) return 'white ink'
    return near(garment) ? 'garment' : 'ink'
  }
}

describe('on white and coloured garments', () => {
  // [mode, background, white lettering inside the badge, blue disc]
  const expected: [WhiteInk, string, string, string][] = [
    ['none', 'garment', 'garment', 'ink'],
    ['artwork', 'garment', 'white ink', 'ink'],
    ['all', 'white ink', 'white ink', 'ink'],
  ]
  for (const [garmentName, garment] of Object.entries(GARMENTS))
    for (const [mode, bg, letter, disc] of expected)
      it(`${garmentName} garment, ${mode}: background ${bg}, white lettering ${letter}, disc ${disc}`, () => {
        const at = onGarment(plates(badge(), paperOutFor(mode)).svg, 120, 120, garment)
        expect(at(5, 5)).toBe(bg)
        expect(at(43, 61)).toBe(letter)
        expect(at(60, 35)).toBe(disc)
      }, SLOW)

  it('transparency and negative space: the hole of a ring and the empty area show the garment in every mode; white artwork prints white', () => {
    // A transparent upload: a blue ring (its hole is real negative space) and a white square.
    const img = paint(140, 120, null, [
      { rings: [circle(50, 60, 40), circle(50, 60, 18, true)], color: BLUE },
      { rings: [rect(105, 50, 125, 70)], color: WHITE },
    ])
    for (const mode of ['none', 'artwork', 'all'] as const) {
      const r = plates(img, paperOutFor(mode))
      expect(r.paper).toBe(false)
      for (const garment of Object.values(GARMENTS)) {
        const at = onGarment(r.svg, 140, 120, garment)
        expect(at(50, 60)).toBe('garment') // the ring's hole
        expect(at(3, 3)).toBe('garment') // outside the artwork
        expect(at(50, 30)).toBe('ink') // the ring
        expect(at(115, 60)).toBe('white ink') // intentional white artwork
      }
    }
  }, SLOW)
})

describe('plate preview', () => {
  it('lists the plates the PDF makes, and shows one plate on its own', () => {
    const svg = plates(badge(), 'border').svg
    const { plates: list, gradients } = platesOf(svg, () => undefined)
    expect(gradients).toBe(0)
    expect(list.length).toBe(2) // blue and the white lettering: no paper plate
    const blue = list.find((pl) => !isLight(pl.name))!
    const single = onePlate(svg, blue.color)
    expect(single).toContain(`path[fill="${blue.name}" i]{display:inline}`)
    expect(single.replace(/<style>.*?<\/style>/, '')).toBe(svg)
    expect(platesOf(plates(badge(), 'all').svg, () => undefined).plates.length).toBe(1)
  }, SLOW)
})

describe('not paper: left exactly as before', () => {
  const same = (img: ImageData) => {
    expect(plates(img, 'border').svg).toBe(plates(img).svg)
    expect(plates(img, 'all').svg).toBe(plates(img).svg)
  }
  it('a white stripe that touches only two edges (a flag) is artwork', () => {
    const flag = paint(150, 100, null, [{ rings: [rect(0, 0, 50, 100)], color: [0, 104, 71] }, { rings: [rect(50, 0, 100, 100)], color: WHITE }, { rings: [rect(100, 0, 150, 100)], color: [206, 17, 38] }])
    expect(plates(flag).paper).toBe(false)
    same(flag)
  }, SLOW)

  it('artwork running off one edge: the background does not frame it', () => {
    const img = paint(120, 120, PAPER, [{ rings: [rect(10, 60, 110, 120)], color: BLUE }])
    expect(plates(img).paper).toBe(false)
    same(img)
  }, SLOW)

  it('a coloured background', () => {
    const img = paint(120, 120, [210, 230, 250], [{ rings: [circle(60, 60, 40)], color: BLUE }])
    expect(plates(img).paper).toBe(false)
    same(img)
  }, SLOW)

  it('a transparent upload', () => {
    const img = paint(120, 120, null, [{ rings: [circle(60, 60, 40)], color: BLUE }])
    expect(plates(img).paper).toBe(false)
    same(img)
  }, SLOW)

  it('one colour: its own paper handling is unchanged', () => {
    const one = (o: FlatOptions): FlatOptions => ({ ...o, oneColour: { ink: null, gapPx: 2, production: true, outputWidthMm: 200 } })
    expect(plates(badge(), 'border', one).svg).toBe(plates(badge(), undefined, one).svg)
    expect(plates(badge(), 'all', one).svg).toBe(plates(badge(), undefined, one).svg)
  }, SLOW)
})

describe('one physical size for print and cut files', () => {
  const svg = '<svg version="1.1" xmlns="http://www.w3.org/2000/svg" width="600" height="450" viewBox="0 0 300 225"><path d="M10 10L290 10L290 215L10 215Z" fill="#2846A0"/></svg>'
  const base = { svg, plateSvg: async () => svg, width: 300, height: 225, baseName: 'x', names: new Map(), spotNames: null, flat: true }
  const sizes = async (input: Parameters<typeof downloadsFor>[1]) => {
    const [pdf, printSvg] = downloadsFor('print', input)
    const [cutSvg, dxf] = downloadsFor('cut', input)
    const pdfText = new TextDecoder('latin1').decode(await (await pdf.make()).arrayBuffer())
    const box = pdfText.match(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)/)!
    const dxfText = await (await dxf.make()).text()
    const ext = dxfText.split('\n')
    const i = ext.indexOf('$EXTMAX')
    const svgW = (s: string) => s.match(/<svg\b[^>]*\swidth="([\d.]+)mm"/)?.[1]
    return {
      pdfMm: (Number(box[1]) * 25.4) / 72,
      dxfMm: Number(ext[i + 2]),
      printSvgMm: svgW(await (await printSvg.make()).text()),
      cutSvgMm: svgW(await (await cutSvg.make()).text()),
    }
  }

  it('today: the PDF is 254 mm long, the DXF 200 mm wide, the SVG has no units', async () => {
    const s = await sizes(base)
    expect(s.pdfMm).toBeCloseTo(PRINT_LONGEST_MM, 2)
    expect(s.dxfMm).toBeCloseTo(200, 2)
    expect(s.printSvgMm).toBeUndefined()
  })

  it('with the flag: PDF, DXF and both SVGs share the PDF’s 254 mm (long side)', async () => {
    const w = printWidthMm(300, 225)
    expect(w).toBeCloseTo(254, 6) // landscape: the width is the long side
    const s = await sizes({ ...base, cutSvgFromPlates: true, printWidthMm: w })
    expect(s.pdfMm).toBeCloseTo(254, 2)
    expect(s.dxfMm).toBeCloseTo(254, 2)
    expect(Number(s.printSvgMm)).toBeCloseTo(254, 2)
    expect(Number(s.cutSvgMm)).toBeCloseTo(254, 2)
    // Portrait: the height is the long side.
    expect(printWidthMm(225, 300)).toBeCloseTo(190.5, 6)
  })

  it('one colour keeps its chosen width everywhere, flag or not', async () => {
    const s = await sizes({ ...base, cutSvgFromPlates: true, outputWidthMm: 150, printWidthMm: printWidthMm(300, 225) })
    expect(s.pdfMm).toBeCloseTo(150, 2)
    expect(s.dxfMm).toBeCloseTo(150, 2)
    expect(Number(s.printSvgMm)).toBeCloseTo(150, 2)
  })
})
