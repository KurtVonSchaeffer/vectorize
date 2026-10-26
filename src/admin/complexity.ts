import type { ArtKind, Detection } from '../vectorize/detect'
import { COMPRESSED_RIPPLE } from '../vectorize/improve'

/**
 * How hard a logo is to vectorise, 0–100, from signals the engine already measures. The admin
 * panel stores it with every run so the success rate can be shown per band; the weights are a
 * first guess, to be checked against the Layout team's verdicts (see the plan's Technical design).
 */
export type ComplexityBand = 'simple' | 'medium' | 'complex'

export interface ComplexityInput {
  detection: Pick<Detection, 'kind' | 'gradients' | 'fine' | 'texture' | 'illustration'>
  /** Flat colours in the result (palette size); 0 when colours don't apply (photos). */
  colours: number
  /** Share of JPEG ripples (compressionRipple), 0–1. */
  compression: number
  width: number
  height: number
  /** Lines of lettering found, when known. */
  textLines?: number
}

export interface Complexity {
  score: number
  band: ComplexityBand
  /** Points per signal, so a score can be explained and the weights tuned. */
  parts: { kind: number; colours: number; gradients: number; fine: number; texture: number; compression: number; resolution: number; lettering: number }
}

/** Upper ends of the simple and medium bands. */
export const SIMPLE_MAX = 30
export const MEDIUM_MAX = 60

/** Photos and painterly art rarely make clean vectors; pixel art needs its hard edges kept. */
const KIND_POINTS: Record<ArtKind, number> = { flat: 0, lineart: 5, pixel: 20, photo: 40 }
/** Longest side (px) below which detail is scarce, and below which it's very scarce. */
const SMALL_SIDE = 600
/** Texture (Detection.texture) of artwork in solid shapes, which adds no points. */
const TEXTURE_PLAIN = 0.15
const TINY_SIDE = 300

const clamp01 = (x: number) => Math.min(1, Math.max(0, x))

export function complexity(i: ComplexityInput): Complexity {
  const side = Math.max(i.width, i.height)
  const parts = {
    // A hatched illustration is traced as flat art with a shading layer; it's as hard as a photo.
    kind: i.detection.illustration ? KIND_POINTS.photo : KIND_POINTS[i.detection.kind],
    // Two colours (ink and background) are the easy case; each one more adds edges to get right.
    colours: Math.round(Math.min(10, Math.max(0, i.colours - 2)) * 2),
    gradients: Math.min(3, i.detection.gradients) * 5,
    fine: Math.round(clamp01(i.detection.fine) * 20),
    // Solid shapes change colour only where two colours meet (0.05–0.15); hatching and engraving
    // change it everywhere (0.4 and more), and lose shading however they're traced.
    texture: Math.round(clamp01(((i.detection.texture ?? 0) - TEXTURE_PLAIN) / 0.3) * 20),
    // Clean artwork ripples 0–0.04; JPEG noise from COMPRESSED_RIPPLE on adds nodes, not accuracy.
    compression: Math.round(clamp01((i.compression - 0.02) / (COMPRESSED_RIPPLE * 2)) * 10),
    resolution: side < TINY_SIDE ? 10 : side < SMALL_SIDE ? 5 : 0,
    lettering: Math.min(2, i.textLines ?? 0) * 5,
  }
  const score = Math.min(100, Object.values(parts).reduce((a, b) => a + b, 0))
  return { score, band: bandOf(score), parts }
}

export const bandOf = (score: number): ComplexityBand => (score <= SIMPLE_MAX ? 'simple' : score <= MEDIUM_MAX ? 'medium' : 'complex')

/**
 * The group a run's learned settings belong to: artwork kind, band and whether the image was
 * compressed, for example "flat/medium/lossy".
 */
export function profileKey(kind: ArtKind, band: ComplexityBand, compression: number): string {
  return `${kind}/${band}/${compression >= COMPRESSED_RIPPLE ? 'lossy' : 'clean'}`
}

/**
 * The profile of an upload before it's traced, so its learned defaults can be fetched first. The
 * colour count isn't known yet, so it doesn't count here; the run stores both scores.
 */
export function profileFor(i: Omit<ComplexityInput, 'colours'>): string {
  return profileKey(i.detection.kind, complexity({ ...i, colours: 0 }).band, i.compression)
}
