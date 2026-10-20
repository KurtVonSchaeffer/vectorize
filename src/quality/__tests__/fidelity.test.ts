import { beforeAll, describe, expect, it } from 'vitest'
import { assessFidelity, type FidelityReport } from '../fidelity'
import { circle, installImageData, paint, rect, regularPolygon, regularStar, renderSvg, vectorize, type RGB } from '../../vectorize/__tests__/fidelity/harness'

beforeAll(installImageData)

const SLOW = 120_000
const BLUE: RGB = [40, 70, 160]
const WHITE: RGB = [255, 255, 255]

/** The default pipeline's result for an upload, measured against that upload. */
function measured(upload: ImageData): FidelityReport {
  const svg = vectorize(upload).svg
  return assessFidelity(upload, renderSvg(svg, upload.width, upload.height), svg)
}
const ids = (r: FidelityReport) => r.issues.map((i) => i.id)

const lettering = () =>
  paint(110, 70, BLUE, [
    { rings: [rect(0, 30, 110, 40)], color: [240, 240, 235] },
    { rings: Array.from({ length: 12 }, (_, k) => rect(6 + k * 8, 31.5, 6 + k * 8 + 1.2, 38.5)), color: [30, 140, 70] },
  ])
const logo = (bg: RGB | null, noise = 0) => paint(120, 120, bg, [{ rings: [circle(60, 60, 45)], color: [40, 110, 180] }, { rings: [rect(35, 50, 85, 70)], color: [250, 220, 80] }], noise)
function gradient(): ImageData {
  const w = 160, h = 100
  const img = paint(w, h, null, [{ rings: [rect(10, 10, 150, 90)], color: [0, 0, 0] }])
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4
      if (!img.data[p + 3]) continue
      const t = (x - 10) / 140
      img.data[p] = 236 + (88 - 236) * t; img.data[p + 1] = 72 + (28 - 72) * t; img.data[p + 2] = 153 + (135 - 153) * t
    }
  return img
}
const svgOf = (w: number, h: number, paths: string, viewBox = '') => `<svg version="1.1" xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"${viewBox ? ` viewBox="${viewBox}"` : ''}>${paths}</svg>`

describe('finds known reconstruction defects against the upload', () => {
  it('lost lettering strokes (1.2 px strokes on a band)', () => {
    const r = measured(lettering())
    expect(r.features.lost).toBe(12)
    expect(r.features.lostArea).toBeGreaterThan(0.9)
    expect(ids(r)).toContain('lost-detail')
    expect(r.visual).toBe('not-suitable')
  }, SLOW)

  it('small stars whose points were cut off', () => {
    const stars = Array.from({ length: 12 }, (_, k) => regularStar(14 + (k % 4) * 22, 14 + Math.floor(k / 4) * 22, 5))
    const r = measured(paint(100, 70, BLUE, [{ rings: stars, color: WHITE }]))
    expect(r.features.changed).toBeGreaterThanOrEqual(10)
    expect(ids(r)).toContain('changed-shapes')
    expect(r.visual).not.toBe('ready')
  }, SLOW)

  it('outlines drawn twice, one hidden under the other', () => {
    const img = paint(120, 120, null, [
      { rings: [circle(60, 40, 30)], color: [2, 157, 236] },
      { rings: [rect(20, 85, 28, 105), rect(35, 85, 43, 105), circle(65, 95, 9), circle(65, 95, 5, true)], color: [1, 108, 165] },
    ])
    const r = measured(img)
    // The two bars and the ring's outline; the ring's counter is a hole in both layers, which draws nothing twice.
    expect(r.geometry.copiedOutlines).toBe(3)
    expect(r.geometryVerdict).toBe('check')
    // It looks right: the copies are hidden, so only the geometry judgement flags them.
    expect(r.visual).toBe('ready')
  }, SLOW)

  it('a paper background drawn as a white shape on an opaque upload, and not on a transparent one', () => {
    expect(measured(logo([252, 253, 251], 3)).geometry.paperShape).toBe(true)
    expect(measured(logo(null)).geometry.paperShape).toBe(false)
  }, SLOW)

  it('a gradient flattened to one colour', () => {
    const g = gradient()
    const svg = svgOf(160, 100, '<path d="M10 10L150 10L150 90L10 90Z" fill="#A43090" fill-rule="evenodd"/>')
    const r = assessFidelity(g, renderSvg(svg, 160, 100), svg)
    expect(r.shading.share).toBeGreaterThan(0.5)
    expect(ids(r)).toContain('flattened-shading')
  })

  it('self-intersecting and tiny contours, measured in upload pixels through the viewBox', () => {
    const img = logo(null)
    const bowTie = '<path d="M20 20L60 60L60 20L20 60Z" fill="#286EB4"/>'
    const speck = '<path d="M200 200L202 200L202 202L200 202Z" fill="#286EB4"/>' // 2×2 viewBox units = 1 upload px²
    const svg = svgOf(120, 120, bowTie + speck, '0 0 240 240')
    const r = assessFidelity(img, renderSvg(svg, 120, 120), svg)
    expect(r.geometry.selfIntersecting).toBe(1)
    expect(r.geometry.tiny).toBe(1)
  })

  for (const [name, el] of [
    ['image', '<image href="logo.png" width="10" height="10"/>'],
    ['data URI', '<path d="M0 0L9 0L9 9Z" fill="url(data:image/png;base64,AAAA)"/>'],
    ['filter', '<filter id="f"><feGaussianBlur stdDeviation="2"/></filter>'],
    ['mask', '<mask id="m"><rect width="9" height="9"/></mask>'],
    ['pattern', '<pattern id="p" width="4" height="4"/>'],
    ['clip path', '<clipPath id="c"><rect width="9" height="9"/></clipPath>'],
    ['foreignObject', '<foreignObject width="9" height="9"/>'],
  ] as const)
    it(`raster or non-geometry content in the SVG: ${name}`, () => {
      const img = logo(null)
      const svg = svgOf(120, 120, el)
      const r = assessFidelity(img, img, svg)
      expect(r.geometry.raster).toContain(name)
      expect(r.geometryVerdict).toBe('not-suitable')
    })
})

describe('passes faithful results', () => {
  it('an exact copy of the upload, for every fixture', () => {
    for (const img of [lettering(), logo(null), logo(WHITE, 6), gradient(), paint(96, 96, BLUE, [{ rings: [regularStar(48, 48, 7)], color: WHITE }])]) {
      const r = assessFidelity(img, img, svgOf(img.width, img.height, ''))
      expect(r.edgeRecall).toBe(1)
      expect(r.features.lost).toBe(0)
      expect(r.features.changed).toBe(0)
      expect(r.visual).toBe('ready')
    }
  }, SLOW)

  it('a clean transparent logo', () => expect(measured(logo(null)).verdict).toBe('ready'), SLOW)

  it('a clean logo on white with compression-like noise (visual judgement)', () => {
    const r = measured(logo(WHITE, 6))
    expect(r.visual).toBe('ready')
    expect(r.features.lost).toBe(0)
  }, SLOW)

  it('a linear gradient kept as a gradient fill', () => {
    const r = measured(gradient())
    expect(ids(r)).not.toContain('flattened-shading')
    expect(r.verdict).toBe('ready')
  }, SLOW)

  it('a 40 px five-point star', () => expect(measured(paint(96, 96, BLUE, [{ rings: [regularStar(48, 48, 20)], color: WHITE }])).visual).toBe('ready'), SLOW)
})

describe('documented limits', () => {
  // A 24 px heptagon drawn as a circle differs by under a pixel: invisible to a comparison at the
  // upload's size. The tracer will have to report its own shape substitutions (PR 5).
  it('does not see a 24 px heptagon replaced by a circle', () => {
    const img = paint(96, 96, null, [{ rings: [rect(8, 8, 88, 88)], color: BLUE }, { rings: [regularPolygon(48, 48, 12, 7)], color: WHITE }])
    expect(measured(img).visual).toBe('ready')
  }, SLOW)

  it('rejects a vector drawn at a different size from the upload', () => {
    const img = logo(null)
    expect(() => assessFidelity(img, paint(60, 60, null, []), svgOf(60, 60, ''))).toThrow(RangeError)
  })
})
