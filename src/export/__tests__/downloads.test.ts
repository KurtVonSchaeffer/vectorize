import { describe, expect, it } from 'vitest'
import { downloadsFor, physicalSize, withSizeMm, type DownloadInput } from '../files'

// A Kestrel-like logo: an 800×480 upload traced at half resolution (the viewBox), three colors.
const svg = `<svg version="1.1" xmlns="http://www.w3.org/2000/svg" width="800" height="480" viewBox="0 0 400 240">
<g data-color="#FFFFFF"><path d="M0 0L400 0L400 240L0 240Z" fill="#FFFFFF" fill-rule="evenodd"/></g>
<g data-color="#E4572E"><path d="M20 20L120 20L120 120L20 120Z" fill="#E4572E" fill-rule="evenodd"/></g>
<g data-color="#29335C"><path d="M200 20L300 20L300 120L200 120Z" fill="#29335C" fill-rule="evenodd"/></g>
</svg>`

const input = (over: Partial<DownloadInput> = {}): DownloadInput => ({
  svg,
  width: 400,
  height: 240,
  baseName: 'kestrel',
  names: new Map([
    [0xffffff, 'White'],
    [0xe4572e, 'Burnt orange'],
    [0x29335c, 'Navy'],
  ]),
  spotNames: null,
  flat: true,
  ...over,
})

const text = async (purpose: 'print' | 'cut' | 'web', label: string, over?: Partial<DownloadInput>) => {
  const d = downloadsFor(purpose, input(over)).find((x) => x.label === label)!
  const blob = await d.make()
  return label === 'PDF' ? new TextDecoder('latin1').decode(new Uint8Array(await blob.arrayBuffer())) : blob.text()
}

describe('print PDF inks', () => {
  it('writes full-color art as plain RGB: no Separation plates, no White plate', async () => {
    const pdf = await text('print', 'PDF')
    expect(pdf).not.toContain('/Separation')
    expect(pdf).not.toContain('/White')
    expect(pdf).toContain('1 1 1 rg') // white is paper-white RGB, no ink after CMYK conversion
    expect(pdf).toMatch(/0\.894 0\.341 0\.18 rg/)
    expect(downloadsFor('print', input())[0].detail).toBe('Full-color vector PDF')
  })

  it('keeps named spot plates for the inks the customer chose, and only those', async () => {
    const spotNames = new Map([
      [0xe4572e, 'PANTONE 171 C'],
      [0x29335c, 'PANTONE 2766 C'],
    ])
    const pdf = await text('print', 'PDF', { spotNames })
    expect(pdf).toContain('/Separation /PANTONE#20171#20C')
    expect(pdf).toContain('/Separation /PANTONE#202766#20C')
    expect((pdf.match(/\/Separation/g) ?? []).length).toBe(2)
    expect(pdf).not.toContain('/White')
    expect(downloadsFor('print', input({ spotNames }))[0].detail).toMatch(/own plate/)
  })

  it('keeps a white ink as a spot plate when the customer chose it', async () => {
    const pdf = await text('print', 'PDF', { spotNames: new Map([[0xffffff, 'Opaque White']]) })
    expect(pdf).toContain('/Separation /Opaque#20White')
  })
})

describe('physical size: one upload pixel = 1/96 inch in every file', () => {
  it('reads the size from the SVG, not the traced coordinate space', () => {
    expect(physicalSize(input())).toEqual({ width: 800, height: 480 })
    expect(physicalSize(input({ svg: '<svg viewBox="0 0 10 10">' }))).toEqual({ width: 400, height: 240 })
  })

  it('makes the PDF page the same size as the print SVG', async () => {
    const pdf = await text('print', 'PDF')
    expect(pdf).toContain('/MediaBox [0 0 600 360]') // 800 px × 0.75 pt
    expect(pdf).toContain('1.5 0 0 -1.5 0 360 cm') // 400-unit viewBox → 600 pt
    const printSvg = await text('print', 'SVG')
    expect(printSvg).toMatch(/<svg width="211\.667mm" height="127mm" version/) // 600 pt = 211.667 mm
    expect(printSvg).toContain('viewBox="0 0 400 240"')
  })

  it('scales small and large uploads the same way (no fixed 10-inch page)', async () => {
    const small = await text('print', 'PDF', { svg: svg.replace('width="800" height="480"', 'width="220" height="132"') })
    expect(small).toContain('/MediaBox [0 0 165 99]')
  })

  it('sizes the cut SVG and DXF by the same rule; web SVG stays in CSS pixels', async () => {
    expect(await text('cut', 'SVG')).toContain('width="211.667mm"')
    expect(await text('cut', 'DXF')).toMatch(/\$EXTMAX\n10\n211\.6667\n20\n127\n/)
    expect(await text('web', 'SVG')).toBe(svg)
  })

  it('adds a viewBox when the SVG has none, so the drawing still fills the page', () => {
    expect(withSizeMm('<svg width="96" height="48"><path/></svg>', { width: 96, height: 48 })).toBe('<svg width="25.4mm" height="12.7mm" viewBox="0 0 96 48"><path/></svg>')
  })
})
