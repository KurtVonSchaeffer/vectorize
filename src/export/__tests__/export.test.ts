import { describe, expect, it } from 'vitest'
import { buildDxf } from '../dxf'
import { flatten, parsePath, shapesFromSvg } from '../path'
import { buildPdf } from '../pdf'

describe('parsePath', () => {
  it('parses our tracer output (absolute M/C/Z)', () => {
    const s = parsePath('M10 10C20 0 30 0 40 10C30 20 20 20 10 10ZM50 50C55 45 60 45 65 50Z')
    expect(s).toHaveLength(2)
    expect(s[0].closed).toBe(true)
    expect(s[0].segs).toHaveLength(2)
    expect(s[1].start).toEqual([50, 50])
  })

  it('handles relative commands, implicit line-tos and H/V', () => {
    const s = parsePath('m10 10 10 0 0 10h-10v-10z')
    expect(s[0].segs.map((g) => g.p)).toEqual([
      [20, 10],
      [20, 20],
      [10, 20],
      [10, 10],
    ])
  })

  it('converts quadratics to cubics', () => {
    const [s] = parsePath('M0 0Q10 10 20 0')
    const g = s.segs[0]
    expect(g.t).toBe('C')
    if (g.t === 'C') expect(g.c1[1]).toBeCloseTo(20 / 3)
  })

  it('applies VTracer-style translate offsets', () => {
    const shapes = shapesFromSvg('<svg><path d="M0 0 L10 0 L10 10 Z " fill="#FF0000" transform="translate(5,7)"/></svg>')
    expect(shapes[0].color).toBe(0xff0000)
    expect(shapes[0].subpaths[0].start).toEqual([5, 7])
  })

  it('flattens curves within tolerance', () => {
    const [s] = parsePath('M0 0C0 55.2 44.8 100 100 100')
    const pts = flatten(s, 0.1)
    expect(pts.length).toBeGreaterThan(8)
    expect(pts.at(-1)).toEqual([100, 100])
  })
})

const shapes = shapesFromSvg(`<svg>
<path d="M0 0L100 0L100 50L0 50Z" fill="#2B2D42" fill-rule="evenodd"/>
<path d="M25 10C40 10 40 40 25 40C10 40 10 10 25 10Z" fill="#F08C00" fill-rule="evenodd"/>
</svg>`)

describe('buildPdf', () => {
  const bytes = buildPdf(
    [
      { shape: shapes[0], spotName: 'PANTONE 2766 C' },
      { shape: shapes[1], spotName: 'Brand Orange' },
    ],
    { width: 100, height: 50, title: 'Test' },
  )
  const text = new TextDecoder('latin1').decode(bytes)

  it('declares one Separation color space per spot ink with escaped names', () => {
    expect(text).toContain('/Separation /PANTONE#202766#20C')
    expect(text).toContain('/Separation /Brand#20Orange')
  })

  it('has a correct cross-reference table', () => {
    const xrefAt = Number(text.match(/startxref\n(\d+)/)![1])
    expect(text.slice(xrefAt, xrefAt + 4)).toBe('xref')
    const offsets = [...text.slice(xrefAt).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]))
    offsets.forEach((o, i) => expect(text.slice(o).startsWith(`${i + 1} 0 obj`)).toBe(true))
  })

  it('writes the stream length that matches the content', () => {
    const m = text.match(/<< \/Length (\d+) >>\nstream\n/)!
    const start = m.index! + m[0].length
    expect(text.slice(start + Number(m[1]), start + Number(m[1]) + 9)).toBe('endstream')
  })

  it('writes plain RGB fills for inks without a spot name', () => {
    const t = new TextDecoder('latin1').decode(buildPdf([{ shape: shapes[0] }], { width: 100, height: 50 }))
    expect(t).toMatch(/0\.169 0\.176 0\.259 rg/)
    expect(t).not.toContain('/Separation')
  })
})

describe('buildDxf', () => {
  const dxf = buildDxf(
    [
      { shape: shapes[0], name: 'Navy' },
      { shape: shapes[1], name: 'Navy' },
    ],
    { width: 100, height: 50, widthMm: 100 },
  )
  it('writes an R12 file with unique layers', () => {
    expect(dxf).toContain('AC1009')
    expect(dxf).toMatch(/\n2\nNAVY\n/)
    expect(dxf).toMatch(/\n2\nNAVY_2\n/)
    expect(dxf.trim().endsWith('EOF')).toBe(true)
  })
  it('writes closed polylines in millimetres with y up', () => {
    expect((dxf.match(/\nPOLYLINE\n/g) ?? []).length).toBe(2)
    // The rectangle's top-left (0,0) in SVG becomes (0, 50) mm.
    expect(dxf).toMatch(/VERTEX\n8\nNAVY\n10\n0\n20\n50\n/)
  })
})

describe('gradients in exports', () => {
  const svg = `<svg version="1.1" xmlns="http://www.w3.org/2000/svg" width="100" height="50">
<defs>
<linearGradient id="gradient-1" gradientUnits="userSpaceOnUse" x1="10" y1="25" x2="90" y2="25"><stop offset="0" stop-color="#EC4899"/><stop offset="0.5" stop-color="#FACC15"/><stop offset="1" stop-color="#581C87"/></linearGradient>
</defs>
<g data-color="#FFF8E7"><path d="M0 0L100 0L100 50L0 50Z" fill="#FFF8E7" fill-rule="evenodd"/></g>
<g id="Gradient_1" data-gradient="gradient-1"><path id="Gradient_1_1" d="M10 10L90 10L90 40L10 40Z" fill="url(#gradient-1)" fill-rule="evenodd"/></g>
</svg>`

  it('reads gradient fills from the SVG', () => {
    const shapes = shapesFromSvg(svg)
    expect(shapes).toHaveLength(2)
    expect(shapes[1].gradient?.kind).toBe('linear')
    expect(shapes[1].gradient?.stops.map((s) => s.offset)).toEqual([0, 0.5, 1])
  })

  it('fills gradients in the PDF with a shading, alongside spot inks', () => {
    const shapes = shapesFromSvg(svg)
    const pdf = new TextDecoder('latin1').decode(buildPdf([{ shape: shapes[0], spotName: 'Cream' }, { shape: shapes[1], spotName: 'ignored' }], { width: 100, height: 50 }))
    expect(pdf).toMatch(/\/Separation \/Cream/)
    expect(pdf).toMatch(/\/Pattern cs \/P1 scn/)
    expect(pdf).toMatch(/\/ShadingType 2 \/ColorSpace \/DeviceRGB \/Coords \[10 25 90 25\]/)
    expect(pdf).toMatch(/\/FunctionType 3 .*\/Bounds \[0\.5\]/)
    expect(pdf).not.toMatch(/\/Separation \/ignored/)
    // Cross-reference offsets still point at their objects.
    const xref = Number(pdf.match(/startxref\n(\d+)/)?.[1])
    expect(pdf.slice(xref, xref + 4)).toBe('xref')
  })
})
