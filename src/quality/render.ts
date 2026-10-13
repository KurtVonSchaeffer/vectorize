import { compareRasters, type CompareOptions, type RasterComparison } from './compare'

/** Renders an SVG to ImageData at the given size (browser only). Undrawn areas stay transparent. */
export async function rasterizeSvg(svg: string, width: number, height: number): Promise<ImageData> {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    const c = new OffscreenCanvas(width, height)
    const g = c.getContext('2d', { willReadFrequently: true })!
    g.drawImage(img, 0, 0, width, height)
    return g.getImageData(0, 0, width, height)
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** Renders `svg` at the reference's size and compares it with the reference (see compareRasters). */
export async function compareSvg(svg: string, reference: ImageData, options?: CompareOptions): Promise<RasterComparison> {
  const candidate = await rasterizeSvg(svg, reference.width, reference.height)
  return compareRasters(reference.data, candidate.data, reference.width, reference.height, options)
}
