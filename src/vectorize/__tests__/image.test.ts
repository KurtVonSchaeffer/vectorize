import { describe, expect, it } from 'vitest'
import { layersToSvg } from '../../trace'
import { finalizeSvg } from '../image'

const traced = { width: 800, height: 400 }
const original = { width: 400, height: 200 }
const root = (svg: string) => svg.match(/<svg\b[^>]*>/)![0]

describe('finalizeSvg', () => {
  it('sizes the root as the original with a viewBox in traced pixels', () => {
    const out = finalizeSvg('<svg version="1.1" xmlns="http://www.w3.org/2000/svg" width="800" height="400"><path d="M0 0L1 1"/></svg>', traced, original)
    expect(root(out)).toBe('<svg version="1.1" xmlns="http://www.w3.org/2000/svg" width="400" height="200" viewBox="0 0 800 400">')
    expect(out).toContain('<path d="M0 0L1 1"/>')
  })

  it('handles any attribute order and quote style', () => {
    const out = finalizeSvg(`<svg height='400' class="logo" xmlns="http://www.w3.org/2000/svg" width='800'><path d="M0 0"/></svg>`, traced, original)
    expect(root(out)).toContain('class="logo"')
    expect(root(out)).toContain('width="400" height="200" viewBox="0 0 800 400"')
  })

  it('never duplicates width, height or viewBox, and drops unit dimensions', () => {
    const out = finalizeSvg('<svg width="800px" height="400.0px" width="1" viewBox="0 0 800 400"><path d="M1 1"/></svg>', traced, original)
    for (const a of ['width', 'height', 'viewBox']) expect(root(out).match(new RegExp(`\\s${a}=`, 'g'))).toHaveLength(1)
    expect(root(out)).toContain('width="400" height="200"')
  })

  it('keeps an existing viewBox, since it defines the path coordinates', () => {
    const out = finalizeSvg('<svg viewBox="10 20 800 400" width="800" height="400"/>', traced, original)
    expect(root(out)).toContain('viewBox="10 20 800 400"')
    expect(out.endsWith('/>')).toBe(true)
  })

  it('replaces a malformed viewBox', () => {
    for (const box of ['0 0 0 400', 'none', '0 0 NaN 4', '1 2 3'])
      expect(root(finalizeSvg(`<svg viewBox="${box}" width="8" height="4"></svg>`, traced, original))).toContain('viewBox="0 0 800 400"')
  })

  it('only changes the root element', () => {
    const out = finalizeSvg('<svg width="800" height="400"><svg width="5" height="6"/><rect width="7" height="8"/></svg>', traced, original)
    expect(out).toContain('<svg width="5" height="6"/>')
    expect(out).toContain('<rect width="7" height="8"/>')
  })

  it('removes empty paths and comments but keeps real paths and look-alike attributes', () => {
    const svg = `<svg width="800" height="400"><!-- a --><path fill="red" d=" "/><path d='' ></path><path data-d="" d="M0 0"/><!--\nb--></svg>`
    const out = finalizeSvg(svg, traced, original)
    expect(out).not.toContain('fill="red"')
    expect(out).not.toContain("d=''")
    expect(out).not.toContain('<!--')
    expect(out).toContain('<path data-d="" d="M0 0"/>')
  })

  it('produces valid, correctly sized SVG from the flat tracer', () => {
    const svg = layersToSvg([{ color: 0xff0000, d: 'M0 0L10 0L10 10Z' }], 800, 400)
    const out = finalizeSvg(svg, traced, original)
    expect(root(out)).toContain('width="400" height="200" viewBox="0 0 800 400"')
    expect(out.match(/<svg\b/g)).toHaveLength(1)
    expect(out.trim().endsWith('</svg>')).toBe(true)
  })
})
