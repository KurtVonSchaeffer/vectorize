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
  const { baseName } = input
  const svgBlob = async () => new Blob([input.svg], { type: 'image/svg+xml' })
  const svg: Download = { label: 'SVG', detail: 'Opens in Illustrator, Inkscape, Figma and browsers', filename: `${baseName}.svg`, make: svgBlob }

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
        const bytes = buildPdf(inks, { width: input.width, height: input.height, title: baseName })
        return new Blob([bytes as BlobPart], { type: 'application/pdf' })
      },
    }
    return [pdf, svg]
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
        return new Blob([buildDxf(layers, { width: input.width, height: input.height })], { type: 'application/dxf' })
      },
    }
    return [{ ...svg, detail: 'For Cricut, Silhouette and vinyl cutters' }, dxf]
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
