// Parameters passed straight through to VTracer (field names must match its Config struct).
export interface TraceParams {
  binary: boolean
  mode: 'spline' | 'polygon' | 'pixel'
  hierarchical: 'stacked' | 'cutout'
  /** Minimum angle (degrees) treated as a corner rather than smoothed. */
  cornerThreshold: number
  /** Minimum segment length when subdividing curves. */
  lengthThreshold: number
  maxIterations: number
  /** Minimum angle displacement (degrees) to splice a spline. */
  spliceThreshold: number
  /** Discard patches smaller than this size (px, in original-image pixels). */
  filterSpeckle: number
  /** Significant bits per RGB channel (1–8). Lower = fewer colors. */
  colorPrecision: number
  /** Color difference between gradient layers. Higher = fewer layers. */
  layerDifference: number
  /** Decimal places in path coordinates. */
  pathPrecision: number
  /**
   * Flat-color mode: reduce to at most this many colors before tracing (clean edges, no halos).
   * 0 uses VTracer's own color clustering instead (for photos, gradients and pixel art).
   */
  colors: number
  /** Flat-color mode: merge colors closer than this (CIEDE2000). */
  colorMerge: number
  /** Flat-color mode: edge smoothing radius in source pixels. */
  smoothing: number
  /** Flat-color mode: max distance (source px) a curve may stray from the traced edge. */
  curveTolerance: number
}

// Applied in the browser before tracing.
export interface PrepParams {
  /** Longest side is downscaled to this before tracing. */
  maxSize: number
  /** Upscale small images first; smooths jaggies and gives the curve fitter more to work with. */
  upscaleSmall: boolean
}

export interface Preset {
  id: string
  label: string
  hint: string
  trace: TraceParams
}

const base: TraceParams = {
  binary: false,
  mode: 'spline',
  hierarchical: 'stacked',
  cornerThreshold: 60,
  lengthThreshold: 4,
  maxIterations: 10,
  spliceThreshold: 45,
  filterSpeckle: 4,
  colorPrecision: 6,
  layerDifference: 16,
  pathPrecision: 2,
  colors: 0,
  colorMerge: 0,
  smoothing: 0.8,
  curveTolerance: 0.5,
}

export const PRESETS: Preset[] = [
  {
    id: 'logo',
    label: 'Logo',
    hint: 'Few flat colors, crisp corners',
    trace: { ...base, colors: 12, colorMerge: 10, smoothing: 0.8 },
  },
  {
    id: 'illustration',
    label: 'Illustration',
    hint: 'More colors and detail',
    trace: { ...base, colors: 24, colorMerge: 10, smoothing: 0.8, filterSpeckle: 3 },
  },
  {
    id: 'lineart',
    label: 'Line art',
    hint: 'Black & white ink, sketches',
    trace: { ...base, binary: true },
  },
  {
    id: 'detailed',
    label: 'Detailed',
    hint: 'Photos & painterly art (large files)',
    trace: { ...base, colorPrecision: 8, layerDifference: 6, filterSpeckle: 2, cornerThreshold: 90 },
  },
  {
    id: 'pixel',
    label: 'Pixel art',
    hint: 'Keeps hard pixel edges',
    trace: { ...base, mode: 'pixel', colorPrecision: 8, layerDifference: 0, filterSpeckle: 0 },
  },
]

export const DEFAULT_PREP: PrepParams = { maxSize: 2048, upscaleSmall: true }

/**
 * The vtracer-wasm build diverges from VTracer's CLI semantics, so translate the
 * user-facing values here:
 * - `colorPrecision` is read as precision *loss* (8 − bits); passing 8 panics.
 * - `filterSpeckle` is read as an area in pixels, not a side length.
 * - `cornerThreshold` and `spliceThreshold` are read in radians, not degrees.
 * `scale` is the prep resize factor, so speckle size stays relative to the original image.
 */
export function toEngineConfig(p: TraceParams, scale: number): TraceParams {
  const speckle = Math.round(p.filterSpeckle * scale)
  const rad = Math.PI / 180
  return {
    ...p,
    colorPrecision: 8 - Math.min(8, Math.max(1, p.colorPrecision)),
    filterSpeckle: speckle * speckle,
    cornerThreshold: p.cornerThreshold * rad,
    spliceThreshold: p.spliceThreshold * rad,
  }
}
