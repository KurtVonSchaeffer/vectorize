/**
 * Processing results are unchanged: SVG, PDF and DXF output for a set of fixtures must match, byte
 * for byte, the output of main @ 4926f81 (hashes recorded by running this file there). A change
 * that alters any traced path or export fails here and has to update GOLDEN on purpose, so the
 * difference shows in review.
 *
 * Also proves that measuring a result (assessFidelity) changes neither the result nor its inputs.
 */
import { createHash } from 'crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildDxf } from '../../../export/dxf'
import { shapesFromSvg } from '../../../export/path'
import { buildPdf } from '../../../export/pdf'
import { assessFidelity } from '../../../quality/fidelity'
import { runFlat } from '../../pipeline'
import { circle, installImageData, paint, productionOptions, rect, regularPolygon, regularStar, renderSvg, type RGB } from './harness'

beforeAll(installImageData)

const sha = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex').slice(0, 16)
const BLUE: RGB = [40, 70, 160]

function gradientCard(): ImageData {
  const w = 160, h = 100
  const img = paint(w, h, null, [{ rings: [rect(10, 10, 150, 90)], color: [0, 0, 0] }, { rings: [circle(80, 50, 18)], color: [255, 255, 255] }])
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4
      if (!img.data[p + 3] || img.data[p] > 250) continue
      const t = (x - 10) / 140
      img.data[p] = 236 + (88 - 236) * t; img.data[p + 1] = 72 + (28 - 72) * t; img.data[p + 2] = 153 + (135 - 153) * t
    }
  return img
}

const FIXTURES: Record<string, () => ImageData> = {
  stars: () => paint(96, 96, BLUE, [{ rings: [regularStar(30, 30, 7), regularStar(66, 60, 20)], color: [255, 255, 255] }]),
  polygons: () => paint(96, 96, null, [{ rings: [rect(8, 8, 88, 88)], color: BLUE }, { rings: [regularPolygon(48, 48, 12, 7), regularPolygon(25, 70, 8, 6)], color: [255, 255, 255] }]),
  lettering: () => paint(110, 70, BLUE, [{ rings: [rect(0, 30, 110, 40)], color: [240, 240, 235] }, { rings: Array.from({ length: 12 }, (_, k) => rect(6 + k * 8, 31.5, 6 + k * 8 + 1.2, 38.5)), color: [30, 140, 70] }]),
  stacked: () =>
    paint(120, 120, null, [
      { rings: [circle(60, 40, 30)], color: [2, 157, 236] },
      { rings: [rect(20, 85, 28, 105), rect(35, 85, 43, 105), circle(65, 95, 9), circle(65, 95, 5, true)], color: [1, 108, 165] },
    ]),
  paper: () => paint(120, 120, [252, 253, 251], [{ rings: [circle(60, 60, 35)], color: [40, 110, 180] }, { rings: [rect(40, 50, 80, 70)], color: [250, 220, 80] }], 3),
  gradient: gradientCard,
}

type Output = { svg: string; knockout: string; oneColour: string; pdf: string; dxf: string }

function files(img: ImageData) {
  const o = productionOptions(img)
  const svg = runFlat(img, o).svg
  const knockout = runFlat(img, { ...o, trace: { ...o.trace, mode: 'knockout', spread: 0.15 } }).svg
  const one = runFlat(img, { ...o, gradients: 'apply', oneColour: { ink: null, gapPx: 2, production: true, outputWidthMm: 200 } }).svg
  const shapes = shapesFromSvg(knockout)
  const pdf = buildPdf(shapes.map((shape) => ({ shape })), { width: img.width, height: img.height, title: 'golden' })
  const dxf = buildDxf(shapes.map((shape, i) => ({ shape, name: `C${i}` })), { width: img.width, height: img.height })
  return { svg, knockout, one, pdf, dxf }
}

function outputs(img: ImageData): Output {
  const f = files(img)
  return { svg: sha(f.svg), knockout: sha(f.knockout), oneColour: sha(f.one), pdf: sha(f.pdf), dxf: sha(f.dxf) }
}

// Recorded on main @ 4926f81.
const GOLDEN: Record<string, Output> = {
  stars: { svg: 'e56f232dc8a43e28', knockout: 'b72de94f6a1fee7b', oneColour: '48b0fa55076439e2', pdf: '6674e400abe83183', dxf: '14a6aff672196b08' },
  polygons: { svg: '8677dd96321bf2ee', knockout: '65e37f64daab25e0', oneColour: '2b59405a91f1731b', pdf: '42dae3a7f3a56797', dxf: 'f826ae6252507542' },
  lettering: { svg: '85e07fc16cb64eb5', knockout: '2473b7258b77a267', oneColour: '49b9293867655843', pdf: 'c23659a1640d1760', dxf: '580e3545f8a12a97' },
  stacked: { svg: '0c6d67e576aea33c', knockout: '961dbf1db370e939', oneColour: '53c05cbfcf3d4a0c', pdf: 'b373ac055e8f2694', dxf: 'c3d30721b4d31ab5' },
  paper: { svg: '17c8bf47351103ca', knockout: '7d0730e2cb672e05', oneColour: 'e07e4b1b1f3d158e', pdf: 'd012bca1a5e07acf', dxf: 'f3d82f751a422781' },
  gradient: { svg: 'b8ead4384be4c147', knockout: '502e700ee6bf1297', oneColour: '3a58d5581dda2e98', pdf: 'b59c9a0a36fd3dfa', dxf: 'd25c3ee2665431b7' },
}

describe('processing results match main byte for byte', () => {
  for (const [name, make] of Object.entries(FIXTURES))
    it(`${name}: SVG, knockout SVG, One-colour SVG, PDF and DXF`, () => {
      const got = outputs(make())
      if (process.env.PRINT_GOLDEN) console.log(`GOLDEN ${name} ${JSON.stringify(got)}`)
      expect(got).toEqual(GOLDEN[name])
    }, 120_000)
})

describe('outputs are pure vector (no raster shortcut)', () => {
  it('no SVG contains images, data URIs, filters, masks, patterns or clip paths; no PDF contains an image', () => {
    for (const make of Object.values(FIXTURES)) {
      const img = make()
      const f = files(img)
      for (const svg of [f.svg, f.knockout, f.one]) expect(assessFidelity(img, img, svg).geometry.raster).toEqual([])
      expect(new TextDecoder('latin1').decode(f.pdf)).not.toMatch(/\/Subtype\s*\/Image|\/BI\b/)
    }
  }, 300_000)
})

describe('measuring does not change processing', () => {
  it('leaves the result, the upload and the rendered vector unchanged, and gives the same report twice', () => {
    const img = FIXTURES.lettering()
    const before = runFlat(img, productionOptions(img)).svg
    const uploadCopy = new Uint8ClampedArray(img.data)
    const vector = renderSvg(before, img.width, img.height)
    const vectorCopy = new Uint8ClampedArray(vector.data)
    const first = assessFidelity(img, vector, before)
    const second = assessFidelity(img, vector, before)
    expect(second).toEqual(first)
    expect(img.data).toEqual(uploadCopy)
    expect(vector.data).toEqual(vectorCopy)
    expect(runFlat(img, productionOptions(img)).svg).toBe(before)
  }, 120_000)
})
