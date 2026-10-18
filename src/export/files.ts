import type { Purpose } from '../vectorize/client'
import { buildDxf } from './dxf'
import { shapesFromSvg, type ColorShape } from './path'
import { buildPdf } from './pdf'

export interface Download {
  label: string
  /** What's inside, in plain words. */
  detail: string
  filename: string
  make: () => Promise<Blob>
}

export interface DownloadInput {
  svg: string
  /** The same artwork with non-overlapping (knockout) shapes, for print plates and cut files. */
  plateSvg?: () => Promise<string>
  /** Coordinate space of the SVG paths. */
  width: number
  height: number
  /**
   * Printed size, in CSS pixels (96 per inch). Defaults to the SVG's own width and height, which
   * are the upload's pixel size; see physicalSize.
   */
  size?: { width: number; height: number }
  baseName: string
  /** Display name per fill color (0xRRGGBB → name). */
  names: Map<number, string>
  /**
   * Print inks the customer chose (swatch library), per fill color. Only these become named
   * spot plates in the PDF; everything else, white included, is ordinary full color.
   */
  spotNames: Map<number, string> | null
  /** Few flat inks (separations make sense) vs many colors (photo). */
  flat: boolean
}

/** The primary and secondary file for each purpose. */
export function downloadsFor(purpose: Purpose, input: DownloadInput): [Download, Download] {
  const { baseName } = input
  const svgBlob = async () => new Blob([input.svg], { type: 'image/svg+xml' })
  const svg: Download = { label: 'SVG', detail: 'Opens in Illustrator, Inkscape, Figma and browsers', filename: `${baseName}.svg`, make: svgBlob }

  const size = physicalSize(input)
  // Print and cut software (Illustrator, CorelDRAW, Cricut) disagree on what a unitless SVG pixel
  // measures, so their SVGs state the size in millimetres; web SVGs keep CSS pixels.
  const sizedSvg: Download = { ...svg, make: async () => new Blob([withSizeMm(input.svg, size, input)], { type: 'image/svg+xml' }) }

  if (purpose === 'print') {
    const spots = input.flat && !!input.spotNames?.size
    const pdf: Download = {
      label: 'PDF',
      detail: spots ? 'Each ink on its own plate, named for your printer' : 'Full-color vector PDF',
      filename: `${baseName}-print.pdf`,
      make: async () => {
        const all = shapesFromSvg((await input.plateSvg?.()) ?? input.svg)
        // Flat art uses knockout shapes, so merging per color is safe; photos stack and must keep order.
        const shapes = input.flat ? mergeByColor(all) : all
        // Everyday color names ("White", "Navy") aren't inks: as Separations, a RIP would make a
        // plate for each, and White can be taken for a white-ink plate. Only chosen inks are spots.
        const inks = shapes.map((shape) => ({ shape, spotName: spots && !shape.gradient ? input.spotNames!.get(shape.color) : undefined }))
        const bytes = buildPdf(inks, { width: input.width, height: input.height, pageSize: Math.max(size.width, size.height) * PT_PER_PX, title: baseName })
        return new Blob([bytes as BlobPart], { type: 'application/pdf' })
      },
    }
    return [pdf, sizedSvg]
  }

  if (purpose === 'cut') {
    const dxf: Download = {
      label: 'DXF',
      detail: 'Outlines for laser cutters and plotters, one layer per color',
      filename: `${baseName}-cut.dxf`,
      make: async () => {
        const all = shapesFromSvg((await input.plateSvg?.()) ?? input.svg)
        const shapes = input.flat ? mergeByColor(all) : all
        let g = 0
        // A gradient is cut from one material, so it's one layer.
        const layers = shapes.map((shape) => ({ shape, name: shape.gradient ? `GRADIENT ${++g}` : (input.names.get(shape.color) ?? 'COLOR') }))
        return new Blob([buildDxf(layers, { width: input.width, height: input.height, widthMm: size.width * MM_PER_PX })], { type: 'application/dxf' })
      },
    }
    return [{ ...sizedSvg, detail: 'For Cricut, Silhouette and vinyl cutters' }, dxf]
  }

  const png: Download = {
    label: 'PNG',
    detail: 'High-resolution image, transparent where the vector is',
    filename: `${baseName}.png`,
    make: () => rasterize(input.svg, input.width, input.height),
  }
  return [{ ...svg, detail: 'Small and sharp at any size, for websites and apps' }, png]
}

/** Points (PDF) per CSS pixel: 72 per inch / 96 per inch. */
const PT_PER_PX = 72 / 96
const MM_PER_PX = 25.4 / 96

/**
 * The artwork's physical size, in CSS pixels: one upload pixel is 1/96 inch (0.2646 mm), the
 * size browsers, Inkscape and Figma already give the SVG. An 800 px wide logo is 211.7 mm wide
 * in the print SVG and in the PDF alike. See docs/print-export.md.
 */
export function physicalSize(input: Pick<DownloadInput, 'svg' | 'width' | 'height' | 'size'>): { width: number; height: number } {
  if (input.size) return input.size
  const root = input.svg.match(/<svg\b[^>]*>/i)?.[0] ?? ''
  const num = (name: string) => {
    const v = root.match(new RegExp(`\\s${name}\\s*=\\s*["']\\s*([\\d.]+)\\s*(px)?\\s*["']`, 'i'))
    const n = v ? Number(v[1]) : NaN
    return Number.isFinite(n) && n > 0 ? n : null
  }
  const w = num('width')
  const h = num('height')
  return w && h ? { width: w, height: h } : { width: input.width, height: input.height }
}

/** The same SVG with its width and height stated in millimetres (the viewBox is unchanged). */
export function withSizeMm(svg: string, size: { width: number; height: number }, coords = size): string {
  const mm = (px: number) => `${+(px * MM_PER_PX).toFixed(3)}mm`
  return svg.replace(/<svg\b[^>]*>/i, (tag) => {
    const viewBox = /\sviewBox\s*=/i.test(tag) ? '' : ` viewBox="0 0 ${coords.width} ${coords.height}"`
    const rest = tag.replace(/\s(width|height)\s*=\s*("[^"]*"|'[^']*')/gi, '')
    return rest.replace(/^<svg\b/i, `<svg width="${mm(size.width)}" height="${mm(size.height)}"${viewBox}`)
  })
}

/**
 * One entry per color, in first-appearance order: each ink becomes one plate (PDF) or one layer
 * (DXF). Safe because print and cut files use knockout shapes that never overlap.
 */
function mergeByColor(shapes: ColorShape[]): ColorShape[] {
  const byColor = new Map<number, ColorShape>()
  for (const s of shapes) {
    const m = byColor.get(s.color)
    if (m) m.subpaths.push(...s.subpaths)
    else byColor.set(s.color, { ...s, subpaths: [...s.subpaths] })
  }
  return [...byColor.values()]
}

/** Renders the SVG to a PNG at 2× the source size, capped at 4096 px. */
async function rasterize(svg: string, w: number, h: number): Promise<Blob> {
  const scale = Math.min(4096 / Math.max(w, h), 2 * Math.max(1, 1200 / Math.max(w, h)))
  const W = Math.round(w * scale)
  const H = Math.round(h * scale)
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    const canvas = new OffscreenCanvas(W, H)
    canvas.getContext('2d')!.drawImage(img, 0, 0, W, H)
    return await canvas.convertToBlob({ type: 'image/png' })
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** Saves a blob through the browser's normal download. */
export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
