import { describe, expect, it } from 'vitest'
import { downloadsFor, type DownloadInput } from '../files'

// A one-colour job: the master (with its background) and the print / cut file (one ink, no
// background), 800 × 400 traced px, for 200 mm wide.
const MASTER = `<svg version="1.1" xmlns="http://www.w3.org/2000/svg" width="1600" height="800" viewBox="0 0 800 400">
<g data-color="#FFFFFF"><path d="M0 0L800 0L800 400L0 400Z" fill="#FFFFFF"/></g>
<g data-color="#0F8A7E"><path d="M100 100L700 100L700 300L100 300Z" fill="#0F8A7E"/></g>
</svg>`
const PLATES = `<svg version="1.1" xmlns="http://www.w3.org/2000/svg" width="1600" height="800" viewBox="0 0 800 400">
<g data-color="#0F8A7E"><path d="M100 100L390 100L390 300L100 300Z" fill="#0F8A7E"/><path d="M410 100L700 100L700 300L410 300Z" fill="#0F8A7E"/></g>
</svg>`
const input = (patch: Partial<DownloadInput> = {}): DownloadInput => ({
  svg: MASTER,
  plateSvg: async () => PLATES,
  cutSvgFromPlates: true,
  width: 800,
  height: 400,
  baseName: 'logo',
  names: new Map([[0x0f8a7e, 'Teal'], [0xffffff, 'White']]),
  spotNames: new Map([[0x0f8a7e, 'PANTONE 2768 C']]),
  flat: true,
  outputWidthMm: 200,
  ...patch,
})
const text = async (d: { make: () => Promise<Blob> }) => new TextDecoder('latin1').decode(await (await d.make()).arrayBuffer())
const rootSize = (svg: string) => svg.match(/<svg\b[^>]*\swidth="([^"]+)"[^>]*\sheight="([^"]+)"/)?.slice(1)

describe('one-colour exports agree with each other', () => {
  it('print SVG is the print file (no background, same pieces as the PDF), not the master', async () => {
    const [, svg] = downloadsFor('print', input())
    const s = await text(svg)
    expect(s).not.toMatch(/#FFFFFF/i)
    expect((s.match(/<path/g) ?? []).length).toBe(2)
    expect(svg.filename).toBe('logo-print.svg')
  })

  it('the master SVG (website) is unchanged', async () => {
    const [svg] = downloadsFor('web', input())
    expect(await text(svg)).toBe(MASTER)
  })

  it('DXF layers carry the plate name (made safe for DXF)', async () => {
    const [, dxf] = downloadsFor('cut', input())
    const layers = [...(await text(dxf)).matchAll(/\n\s*0\r?\n\s*LAYER\r?\n\s*2\r?\n([^\r\n]+)/g)].map((m) => m[1].trim())
    expect(layers).toEqual(['PANTONE_2768_C'])
    const [, custom] = downloadsFor('cut', input({ spotNames: new Map([[0x0f8a7e, 'Custom ink #0F8A7E']]) }))
    expect([...(await text(custom)).matchAll(/\n\s*0\r?\n\s*LAYER\r?\n\s*2\r?\n([^\r\n]+)/g)].map((m) => m[1].trim())).toEqual(['CUSTOM_INK_0F8A7E'])
  })

  it('SVG, PDF and DXF are all 200 × 100 mm', async () => {
    const [pdf, printSvg] = downloadsFor('print', input())
    const [cutSvg, dxf] = downloadsFor('cut', input())
    for (const s of [await text(printSvg), await text(cutSvg)]) expect(rootSize(s)).toEqual(['200mm', '100mm'])
    const box = (await text(pdf)).match(/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/)!.slice(1).map(Number)
    expect(box[0]).toBeCloseTo((200 * 72) / 25.4, 1)
    expect(box[1]).toBeCloseTo((100 * 72) / 25.4, 1)
    const d = await text(dxf)
    expect(d).toMatch(/\$INSUNITS\r?\n\s*70\r?\n\s*4\b/) // millimetres
    const ext = d.match(/\$EXTMAX\r?\n\s*10\r?\n\s*([\d.]+)\r?\n\s*20\r?\n\s*([\d.]+)/)!.slice(1).map(Number)
    expect(ext[0]).toBeCloseTo(200, 1)
    expect(ext[1]).toBeCloseTo(100, 1)
  })

  it('without an output size (other colour modes), files are made as before', async () => {
    const [pdf, svg] = downloadsFor('print', input({ outputWidthMm: undefined, cutSvgFromPlates: false }))
    expect(await text(svg)).toBe(MASTER)
    expect((await text(pdf)).match(/MediaBox \[0 0 ([\d.]+) /)![1]).toBe('720')
  })
})
