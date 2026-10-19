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
  /**
   * Print and cut SVGs are the plates too (one colour: no background, gaps, and touching ink as one
   * piece are in the plates only). The master SVG is unchanged and stays the website download.
   */
  cutSvgFromPlates?: boolean
  /** The width print and cut files are made at (one colour's output width): SVG, PDF and DXF all get it. */
  outputWidthMm?: number
  /** Coordinate space of the SVG paths. */
  width: number
  height: number
  baseName: string
  /** Display name per fill color (0xRRGGBB → name). */
  names: Map<number, string>
  /** Spot names (swatch library) per fill color, when matched. */
  spotNames: Map<number, string> | null
  /** Few flat inks (separations make sense) vs many colors (photo). */
  flat: boolean
}

/** The primary and secondary file for each purpose. */
export function downloadsFor(purpose: Purpose, input: DownloadInput): [Download, Download] {
  const { baseName, outputWidthMm: widthMm } = input
  const svgBlob = async () => new Blob([input.svg], { type: 'image/svg+xml' })
  const svg: Download = { label: 'SVG', detail: 'Opens in Illustrator, Inkscape, Figma and browsers', filename: `${baseName}.svg`, make: svgBlob }
  // The print / cut file as an SVG, at its physical size when it has one.
  const plateSvg: Download | null =
    input.cutSvgFromPlates && input.plateSvg
      ? { ...svg, make: async () => new Blob([widthMm ? physicalSize(await input.plateSvg!(), widthMm, input.width, input.height) : await input.plateSvg!()], { type: 'image/svg+xml' }) }
      : null
  // A plate or layer is named after the ink chosen for it (spot name) when there is one.
  const inkName = (color: number) => input.spotNames?.get(color) ?? input.names.get(color)

  if (purpose === 'print') {
    const pdf: Download = {
      label: 'PDF',
      detail: input.flat ? 'Each color on its own plate, named for your printer' : 'Full-color vector PDF',
      filename: `${baseName}-print.pdf`,
      make: async () => {
        const all = shapesFromSvg((await input.plateSvg?.()) ?? input.svg)
        // Flat art uses knockout shapes, so merging per color is safe; photos stack and must keep order.
        const shapes = input.flat ? mergeByColor(all) : all
        const inks = shapes.map((shape) => ({
          shape,
          spotName: input.flat && !shape.gradient ? (input.spotNames?.get(shape.color) ?? input.names.get(shape.color) ?? undefined) : undefined,
        }))
        const bytes = buildPdf(inks, { width: input.width, height: input.height, title: baseName, widthPt: widthMm ? (widthMm * 72) / 25.4 : undefined })
        return new Blob([bytes as BlobPart], { type: 'application/pdf' })
      },
    }
    return [pdf, plateSvg ? { ...plateSvg, filename: `${baseName}-print.svg`, detail: 'The print file as an SVG: the same artwork as the PDF' } : svg]
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
        const layers = shapes.map((shape) => ({ shape, name: shape.gradient ? `GRADIENT ${++g}` : (inkName(shape.color) ?? 'COLOR') }))
        return new Blob([buildDxf(layers, { width: input.width, height: input.height, widthMm })], { type: 'application/dxf' })
      },
    }
    return [{ ...(plateSvg ?? svg), detail: 'For Cricut, Silhouette and vinyl cutters' }, dxf]
  }

  const png: Download = {
    label: 'PNG',
    detail: 'High-resolution image, transparent where the vector is',
    filename: `${baseName}.png`,
    make: () => rasterize(input.svg, input.width, input.height),
  }
  return [{ ...svg, detail: 'Small and sharp at any size, for websites and apps' }, png]
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

/**
 * The SVG at a physical size: the root's width and height in millimetres (height from the
 * coordinates' aspect ratio); the viewBox, and so every path, is unchanged.
 */
export function physicalSize(svg: string, widthMm: number, width: number, height: number): string {
  const mm = (v: number) => `${+v.toFixed(3)}mm`
  return svg.replace(/<svg\b([^>]*?)(\/?)>/i, (_, attrs: string, selfClose: string) => {
    const size = (name: string) => new RegExp(`\\s${name}\\s*=\\s*("[^"]*"|'[^']*')`, 'gi')
    const box = attrs.match(/\sviewBox\s*=\s*("[^"]*"|'[^']*')/i) ? '' : ` viewBox="0 0 ${width} ${height}"`
    return `<svg${attrs.replace(size('width'), '').replace(size('height'), '')} width="${mm(widthMm)}" height="${mm((widthMm * height) / width)}"${box}${selfClose}>`
  })
}
