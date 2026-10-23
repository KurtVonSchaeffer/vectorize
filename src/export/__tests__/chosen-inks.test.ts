/**
 * Print files (behind the print-files flag): only the inks the customer chose for print become spot
 * plates (PDF Separations). Colours that merely appear in the image, white included, print in full
 * colour. The master artwork, every coordinate and every colour value stay as they are.
 * Off, the PDF is made exactly as before (every flat colour a plate).
 */
import { describe, expect, it } from 'vitest'
import { downloadsFor, type DownloadInput } from '../files'
import { chosenPrintInks, platesOf, WHITE_INK_PLATE } from '../plates'

const WHITE = 0xffffff
const NAVY = 0x1d1e56
const ORANGE = 0xe4572e

// A knockout print file: a white box, a navy panel inside it, an orange square inside that.
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="60" viewBox="0 0 100 60">' +
  '<path fill="#FFFFFF" d="M0 0L100 0L100 60L0 60ZM20 10L80 10L80 50L20 50Z"/>' +
  '<path fill="#1D1E56" d="M20 10L80 10L80 50L20 50ZM30 20L40 20L40 30L30 30Z"/>' +
  '<path fill="#E4572E" d="M30 20L40 20L40 30L30 30Z"/>' +
  '</svg>'

const NAMES = new Map([
  [WHITE, 'White'],
  [NAVY, 'Navy'],
  [ORANGE, 'Burnt orange'],
])

const input = (o: Partial<DownloadInput>): DownloadInput => ({
  svg: SVG,
  plateSvg: async () => SVG,
  width: 100,
  height: 60,
  baseName: 'logo',
  names: NAMES,
  spotNames: null,
  flat: true,
  ...o,
})

async function pdfOf(o: Partial<DownloadInput>) {
  const [pdf] = downloadsFor('print', input(o))
  const text = new TextDecoder('latin1').decode(await (await pdf.make()).arrayBuffer())
  const content = text.slice(text.indexOf('stream\n') + 7, text.indexOf('endstream'))
  return {
    detail: pdf.detail,
    separations: [...text.matchAll(/\/Separation \/(\S+)/g)].map((m) => m[1]),
    // Colour of each fill, in order: a spot plate (cs/scn) or a full-colour fill (rg).
    fills: content.split('\n').filter((l) => / (rg|scn)$/.test(l)),
    // Everything but the colour operators: the geometry.
    geometry: content.split('\n').filter((l) => !/ (rg|scn)$/.test(l)).join('\n'),
    // The colour value written for each Separation (its on-screen equivalent).
    separationColours: [...text.matchAll(/\/C1 \[([^\]]+)\]/g)].map((m) => m[1]),
  }
}

describe('print PDF with chosen inks only (print-files flag)', () => {
  it('no inks chosen: no Separation at all, white included, and the label says so', async () => {
    const p = await pdfOf({ chosenInksOnly: true, spotNames: new Map() })
    expect(p.separations).toEqual([])
    expect(p.fills).toEqual(['1 1 1 rg', '0.114 0.118 0.337 rg', '0.894 0.341 0.18 rg'])
    expect(p.detail).toBe('Full-color vector PDF, no spot plates')
  })

  it('chosen inks: exactly those are Separations, named as chosen; the rest print in full colour', async () => {
    const p = await pdfOf({ chosenInksOnly: true, spotNames: new Map([[NAVY, 'PANTONE 2766 C']]) })
    expect(p.separations).toEqual(['PANTONE#202766#20C'])
    expect(p.fills).toEqual(['1 1 1 rg', '/CS1 cs 1 scn', '0.894 0.341 0.18 rg'])
    expect(p.detail).toBe('Spot plates only for the inks you chose (PANTONE 2766 C); every other color prints in full color')
  })

  it('white ink asked for: a White plate, and nothing else becomes a plate', async () => {
    const p = await pdfOf({ chosenInksOnly: true, spotNames: new Map([[WHITE, 'White']]) })
    expect(p.separations).toEqual(['White'])
    expect(p.fills[0]).toBe('/CS0 cs 1 scn')
    expect(p.detail).toContain('(White)')
  })

  it('one colour: exactly one plate, the chosen ink', async () => {
    const p = await pdfOf({ chosenInksOnly: true, spotNames: new Map([[NAVY, 'Navy ink']]) })
    expect(p.separations).toEqual(['Navy#20ink'])
  })

  it('a white swatch the customer chose stays a plate under its own name', async () => {
    const p = await pdfOf({ chosenInksOnly: true, spotNames: new Map([[WHITE, 'Opaque White'], [NAVY, 'Navy']]) })
    expect(p.separations).toEqual(['Opaque#20White', 'Navy'])
  })

  it('geometry and colour values are identical with and without plates', async () => {
    const today = await pdfOf({})
    const none = await pdfOf({ chosenInksOnly: true, spotNames: new Map() })
    const some = await pdfOf({ chosenInksOnly: true, spotNames: new Map([[NAVY, 'PANTONE 2766 C']]) })
    expect(none.geometry).toBe(today.geometry)
    expect(some.geometry).toBe(today.geometry)
    // Every colour value is the same, whether written as a plate's preview colour or as a fill.
    expect(today.separationColours).toEqual(none.fills.map((f) => f.replace(' rg', '')))
  })

  it('flag off: every flat colour is a plate named after its colour, as before', async () => {
    const p = await pdfOf({})
    expect(p.separations).toEqual(['White', 'Navy', 'Burnt#20orange'])
    expect(p.detail).toBe('Each color on its own plate, named for your printer')
  })
})

describe('the inks chosen for print', () => {
  it('are the chosen swatches, plus White only when white ink is asked for', () => {
    expect([...chosenPrintInks(null, null)]).toEqual([])
    expect([...chosenPrintInks(new Map([[NAVY, 'PANTONE 2766 C']]), null)]).toEqual([[NAVY, 'PANTONE 2766 C']])
    expect([...chosenPrintInks(null, WHITE)]).toEqual([[WHITE, WHITE_INK_PLATE]])
    // A white swatch the customer chose keeps its own name.
    expect([...chosenPrintInks(new Map([[WHITE, 'Opaque White']]), WHITE)]).toEqual([[WHITE, 'Opaque White']])
  })
})

describe('plate list (preview) matches the PDF', () => {
  it('lists only chosen inks as plates, the other colours as full colour', () => {
    const name = (c: number) => NAMES.get(c)
    const { plates, fullColour } = platesOf(SVG, name, chosenPrintInks(new Map([[NAVY, 'PANTONE 2766 C']]), null))
    expect(plates).toEqual([{ color: NAVY, name: 'PANTONE 2766 C' }])
    expect(fullColour.map((p) => p.name)).toEqual(['White', 'Burnt orange'])
    expect(platesOf(SVG, name, chosenPrintInks(null, null)).plates).toEqual([])
    // Flag off (no chosen map): every colour is a plate, as before.
    expect(platesOf(SVG, name).plates.map((p) => p.name)).toEqual(['White', 'Navy', 'Burnt orange'])
  })
})

describe('cut files are untouched by chosen inks', () => {
  it('cut SVG and DXF are byte-identical with chosen inks only on or off', async () => {
    const files = async (o: Partial<DownloadInput>) => Promise.all(downloadsFor('cut', input(o)).map(async (d) => (await d.make()).text()))
    expect(await files({ chosenInksOnly: true, spotNames: new Map() })).toEqual(await files({}))
  })
})
