import type { ArtKind } from './detect'
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
}

export const DEFAULT_CLIENT: ClientSettings = { purpose: 'print', style: 'auto', detail: 0.5, corners: 0.75, maxColors: null, keepBlends: false, exactShapes: true, gradients: true }

const preset = (id: string) => PRESETS.find((p) => p.id === id)!.trace
const lerp = (a: number, b: number, t: number) => a + (b - a) * t

/** Engine parameters for an artwork kind and the client's two sliders. */
export function traceParamsFor(kind: ArtKind, s: ClientSettings): TraceParams {
  const d = Math.min(1, Math.max(0, s.detail))
  const c = Math.min(1, Math.max(0, s.corners))
  const curves = {
    curveTolerance: Math.max(0.2, lerp(0.9, 0.1, d)),
    cornerThreshold: Math.round(lerp(135, 35, c)),
    smoothing: +lerp(1.3, 0.5, c).toFixed(2),
  }
  switch (kind) {
    case 'photo':
      return {
        ...preset('detailed'),
        layerDifference: Math.round(lerp(16, 2, d)),
        filterSpeckle: Math.round(lerp(6, 1, d)),
        cornerThreshold: curves.cornerThreshold,
      }
    case 'pixel':
      return preset('pixel')
    case 'lineart':
      return { ...preset('lineart'), ...curves, filterSpeckle: Math.round(lerp(5, 1, d)) }
    case 'flat':
    default:
      return {
        ...preset('logo'),
        ...curves,
        colors: s.maxColors ?? 12,
        colorMerge: Math.round(lerp(16, 4, d)),
        filterSpeckle: Math.round(lerp(6, 1, d)),
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
