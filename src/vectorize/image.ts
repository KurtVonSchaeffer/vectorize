import type { PrepParams } from './params'

/** Anything that can be traced: the loaded file, or its AI-enhanced version. */
export interface InputImage {
  url: string
  width: number
  height: number
  bitmap: ImageBitmap
}

export interface SourceImage extends InputImage {
  /** Unique per loaded file; used as the AI result cache key. */
  id: string
  name: string
}

let nextSourceId = 1

const UPSCALE_BELOW = 1024

const UNSUPPORTED: Record<string, string> = {
  heic: 'HEIC (iPhone photo)',
  heif: 'HEIF (iPhone photo)',
  tif: 'TIFF',
  tiff: 'TIFF',
  psd: 'Photoshop (PSD)',
  ai: 'Illustrator (AI)',
  eps: 'EPS',
  pdf: 'PDF',
  raw: 'camera RAW',
  cr2: 'camera RAW',
  nef: 'camera RAW',
  dng: 'camera RAW',
}

export async function loadImage(blob: Blob, name: string): Promise<SourceImage> {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  const url = URL.createObjectURL(blob)
  let bitmap: ImageBitmap
  try {
    bitmap = await decode(blob, url)
  } catch {
    URL.revokeObjectURL(url)
    const kind = UNSUPPORTED[ext]
    throw new Error(
      kind
        ? `${kind} files can't be opened in the browser. Export it as PNG or JPG and try again.`
        : `Couldn't read "${name}". Try saving it as PNG or JPG.`,
    )
  }
  if (bitmap.width < 2 || bitmap.height < 2) {
    bitmap.close()
    URL.revokeObjectURL(url)
    throw new Error('This image is too small to trace. Use one at least a few pixels wide.')
  }
  // Very large images would exhaust memory later (pixel buffers, workers); work from a copy
  // that's still far above what tracing needs.
  const longest = Math.max(bitmap.width, bitmap.height)
  if (longest > MAX_DECODE) {
    const k = MAX_DECODE / longest
    const smaller = await createImageBitmap(bitmap, { resizeWidth: Math.round(bitmap.width * k), resizeHeight: Math.round(bitmap.height * k), resizeQuality: 'high' })
    bitmap.close()
    bitmap = smaller
  }
  return { id: String(nextSourceId++), name, url, width: bitmap.width, height: bitmap.height, bitmap }
}

async function decode(blob: Blob, url: string): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(blob)
  } catch {
    // createImageBitmap rejects some inputs <img> can still decode, notably SVG. Draw through a
    // canvas (Chrome returns a blank bitmap for createImageBitmap(svgImg, { resize… })), and
    // render vectors at a decent size since they have no real pixel resolution.
    const img = new Image()
    img.src = url
    await img.decode()
    const nw = img.naturalWidth || SVG_MIN_SIZE
    const nh = img.naturalHeight || SVG_MIN_SIZE
    const scale = Math.max(1, SVG_MIN_SIZE / Math.max(nw, nh))
    const canvas = new OffscreenCanvas(Math.round(nw * scale), Math.round(nh * scale))
    canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height)
    return canvas.transferToImageBitmap()
  }
}

const SVG_MIN_SIZE = 1024
const MAX_DECODE = 6000

export function bitmapToImageData(bitmap: ImageBitmap): ImageData {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(bitmap, 0, 0)
  return ctx.getImageData(0, 0, bitmap.width, bitmap.height)
}

export async function imageDataToInput(image: ImageData): Promise<InputImage> {
  const canvas = new OffscreenCanvas(image.width, image.height)
  canvas.getContext('2d')!.putImageData(image, 0, 0)
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  return { url: URL.createObjectURL(blob), width: image.width, height: image.height, bitmap: await createImageBitmap(image) }
}

/** VTracer panics on an image with no visible pixels. */
export function hasVisiblePixels(image: ImageData): boolean {
  const d = image.data
  for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) return true
  return false
}

/** Scale factor applied to the source before tracing. */
export function prepScale(width: number, height: number, prep: PrepParams): number {
  const longest = Math.max(width, height)
  if (longest > prep.maxSize) return prep.maxSize / longest
  if (prep.upscaleSmall && longest < UPSCALE_BELOW) {
    return Math.min(4, Math.ceil(UPSCALE_BELOW / longest))
  }
  return 1
}

export interface PreparedImage {
  image: ImageData
  /** Resize factor from the source to the traced image. */
  scale: number
}

/** `pixelated` keeps hard pixel edges: no upscaling, and nearest-neighbor resampling. */
export function prepareImage(src: InputImage, prep: PrepParams, pixelated: boolean): PreparedImage {
  const scale = prepScale(src.width, src.height, pixelated ? { ...prep, upscaleSmall: false } : prep)
  const w = Math.max(1, Math.round(src.width * scale))
  const h = Math.max(1, Math.round(src.height * scale))
  const canvas = new OffscreenCanvas(w, h)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.imageSmoothingEnabled = !pixelated
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(src.bitmap, 0, 0, w, h)
  const image = ctx.getImageData(0, 0, w, h)
  binarizeAlpha(image)
  return { image, scale }
}

/**
 * VTracer only treats fully transparent pixels as empty; semi-transparent ones are traced as
 * solid shapes in whatever (often meaningless) color they carry, e.g. anti-aliased edges or
 * resampled transparency. Snap alpha to fully on or off.
 */
function binarizeAlpha(image: ImageData) {
  const d = image.data
  for (let i = 3; i < d.length; i += 4) {
    if (d[i] === 255) continue
    if (d[i] >= 128) d[i] = 255
    else d[i - 3] = d[i - 2] = d[i - 1] = d[i] = 0
  }
}

/**
 * VTracer emits fixed pixel width/height at the traced resolution. Add a viewBox so the SVG
 * scales cleanly, and report its size as the original image's dimensions.
 */
export function finalizeSvg(svg: string, traced: { width: number; height: number }, original: { width: number; height: number }): string {
  return svg
    .replace(/<!--.*?-->\s*/s, '')
    // VTracer occasionally emits paths with no geometry.
    .replace(/<path d="\s*"[^>]*\/>\s*/g, '')
    .replace(
      /<svg([^>]*?)\swidth="\d+"\s+height="\d+"/,
      `<svg$1 width="${original.width}" height="${original.height}" viewBox="0 0 ${traced.width} ${traced.height}"`,
    )
}

/** Same SVG, drawn as thin outlines so you can inspect path structure. */
export function outlineSvg(svg: string): string {
  const style =
    '<style>path{fill:none!important;stroke:#ff3d7f;stroke-width:1px;vector-effect:non-scaling-stroke}</style>'
  return svg.replace(/(<svg[^>]*>)/, `$1${style}`)
}

export function countPaths(svg: string): number {
  return (svg.match(/<path\b/g) ?? []).length
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

/** A small flat illustration drawn on a canvas, so the app can be tried without a file. */
export async function sampleImage(): Promise<Blob> {
  const w = 640
  const h = 440
  const c = new OffscreenCanvas(w, h)
  const g = c.getContext('2d')!
  const sky = g.createLinearGradient(0, 0, 0, h)
  sky.addColorStop(0, '#ffd8a8')
  sky.addColorStop(1, '#ff8fa3')
  g.fillStyle = sky
  g.fillRect(0, 0, w, h)
  g.fillStyle = '#fff3bf'
  g.beginPath()
  g.arc(440, 170, 70, 0, Math.PI * 2)
  g.fill()
  const ridge = (color: string, pts: [number, number][]) => {
    g.fillStyle = color
    g.beginPath()
    g.moveTo(0, h)
    pts.forEach(([x, y]) => g.lineTo(x, y))
    g.lineTo(w, h)
    g.closePath()
    g.fill()
  }
  ridge('#9775fa', [[0, 260], [120, 170], [230, 250], [360, 140], [500, 260], [640, 200]])
  ridge('#5f3dc4', [[0, 330], [150, 250], [300, 330], [420, 270], [640, 340]])
  ridge('#2b1a5c', [[0, 390], [200, 350], [380, 395], [640, 360]])
  g.fillStyle = '#ffffff'
  g.font = 'bold 44px system-ui, sans-serif'
  g.fillText('vectorize me', 40, 80)
  return c.convertToBlob({ type: 'image/png' })
}
