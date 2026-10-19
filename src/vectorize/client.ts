import type { ArtKind, Detection } from './detect'
import { DEFAULT_PREP, PRESETS, type PrepParams, type TraceParams } from './params'

export type Purpose = 'print' | 'web' | 'cut'
export type Style = 'auto' | ArtKind

/** The handful of choices a client makes. Everything technical is derived from these. */
export interface ClientSettings {
  purpose: Purpose
  /** 'auto' uses the detected kind. */
  style: Style
  /** 0 = simpler shapes, 1 = more detail. */
  detail: number
  /** 0 = rounded, 1 = sharp. */
  corners: number
  /** Upper limit on colors for flat artwork; null lets merging decide. */
  maxColors: number | null
  /** Keep edge-blend colors instead of folding them into real colors. */
  keepBlends: boolean
  /** Snap circles, ellipses, stars and polygons to exact geometry. */
  exactShapes: boolean
  /** Keep smooth gradients as SVG gradients instead of color bands. */
  gradients: boolean
  /** One colour (Color mode → One color): the ink, and the separation gap cut into print and cut files. */
  oneColour: OneColourSettings
}

/**
 * The colour limits offered under Fine-tune. A limit of 1 isn't one of them: the background counts as
 * a colour, so it merged artwork and background into a single blob. One colour is its own mode
 * (Color mode → One color), which sets maxColors to 1 to run the one-colour engine.
 */
export const COLOR_LIMITS = [2, 3, 4, 5, 6, 8, 10, 12, 16, 24]
const MIN_COLORS = COLOR_LIMITS[0]

export interface OneColourSettings {
  /** The ink, 0xRRGGBB; null: the artwork's darkest colour. */
  ink: number | null
  /** Gap between regions that were different colours, at the output width. 0 = none. */
  gapMm: number
  /** Width the file will be printed or cut at, so the gap is a real size. */
  outputWidthMm: number
  /** Show the preview with the gaps the print / cut file will have (the master has none). */
  previewGaps: boolean
}

export const DEFAULT_CLIENT: ClientSettings = { purpose: 'print', style: 'auto', detail: 0.5, corners: 0.75, maxColors: null, keepBlends: false, exactShapes: true, gradients: true, oneColour: { ink: null, gapMm: 0.5, outputWidthMm: 200, previewGaps: false } }

/**
 * Per-image additions to the Detail slider, from what the image is like. Measured on the
 * diagnostic set: artwork made mostly of fine strokes (hairlines, small text) keeps more of its
 * detail with tighter curve fitting, and tiny images with a smaller speck size; neither gains
 * from lower colour merging, which only lets JPEG noise in as extra colours, so that stays with
 * the slider. The slider still moves every setting; these are added on top.
 */
export interface DetailBoost {
  curves: number
  specks: number
}
export const NO_BOOST: DetailBoost = { curves: 0, specks: 0 }

export function detailBoost(det: Detection, width: number, height: number): DetailBoost {
  return { curves: det.fine >= FINE_ART ? 0.25 : 0, specks: Math.max(width, height) <= TINY_IMAGE ? 0.25 : 0 }
}

/** Fine-stroke share (see Detection.fine) from which artwork counts as fine. */
const FINE_ART = 0.85
/** Longest side (px) up to which an image counts as tiny. */
const TINY_IMAGE = 160

const preset = (id: string) => PRESETS.find((p) => p.id === id)!.trace
const lerp = (a: number, b: number, t: number) => a + (b - a) * t

/** Engine parameters for an artwork kind and the client's two sliders. */
export function traceParamsFor(kind: ArtKind, s: ClientSettings, boost: DetailBoost = NO_BOOST): TraceParams {
  const clamp = (v: number) => Math.min(1, Math.max(0, v))
  const d = clamp(s.detail)
  const dc = clamp(s.detail + boost.curves)
  const ds = clamp(s.detail + boost.specks)
  const c = clamp(s.corners)
  const curves = {
    curveTolerance: Math.max(0.2, lerp(0.9, 0.1, dc)),
    cornerThreshold: Math.round(lerp(135, 35, c)),
    smoothing: +lerp(1.3, 0.5, c).toFixed(2),
  }
  switch (kind) {
    case 'photo':
      return {
        ...preset('detailed'),
        layerDifference: Math.round(lerp(16, 2, d)),
        filterSpeckle: Math.round(lerp(6, 1, ds)),
        cornerThreshold: curves.cornerThreshold,
      }
    case 'pixel':
      return preset('pixel')
    case 'lineart':
      return { ...preset('lineart'), ...curves, filterSpeckle: Math.round(lerp(5, 1, ds)) }
    case 'flat':
    default:
      return {
        ...preset('logo'),
        ...curves,
        // One colour (maxColors 1) finds every region first (all colours), then draws them in the ink.
        colors: s.maxColors === null || s.maxColors === 1 ? 12 : Math.max(MIN_COLORS, s.maxColors),
        colorMerge: Math.round(lerp(16, 4, d)),
        filterSpeckle: Math.round(lerp(6, 1, ds)),
      }
  }
}

/**
 * Image preparation per kind. Photos are traced at their own size, never upscaled, and capped
 * at roughly 1250 px (up to 1600 px for more detail): in testing, upscaling or tracing photos
 * larger made VTracer chase JPEG noise. That was 3× slower and less accurate, with 2–3× larger
 * files.
 */
export function prepFor(kind: ArtKind, s: ClientSettings): PrepParams {
  if (kind === 'photo') return { maxSize: Math.round(lerp(900, 1600, Math.min(1, Math.max(0, s.detail)))), upscaleSmall: false }
  return DEFAULT_PREP
}

/** Whether the output depends on the purpose (flat art traces knockout shapes for print/cut). */
export const purposeAffectsTrace = (kind: ArtKind, spot: boolean) => spot || kind === 'flat' || kind === 'lineart'

export const KIND_LABEL: Record<ArtKind, string> = {
  flat: 'Logo or illustration',
  photo: 'Photo or painting',
  lineart: 'Line art',
  pixel: 'Pixel art',
}
