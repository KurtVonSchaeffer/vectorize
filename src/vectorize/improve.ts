import type { Detection } from './detect'

/**
 * Rules for offering a cleaner version of a result: after the first SVG is shown, alternatives
 * are traced in the background and scored against the upload (scoreAgainstUpload). Measured on
 * the diagnostic set (docs/v7-assessment.md, docs/v7-results.md): offering an alternative only
 * when its score at least halves, with guards against reproducing upload defects, offered 22
 * alternatives across 89 test images, 20 truly better and none worse.
 */

export interface Scored {
  /** Detail missing plus added against the upload, in percent (lower is better). */
  score: number
  /** Edge agreement with the upload (1 = perfect). */
  edgeF1: number
  /** Curve and line segments in the SVG. */
  segments: number
  /** Flat colours in the result. */
  colours: number
}

/** The alternative must score at most this share of the first result's score… */
export const IMPROVE_RATIO = 0.5
/** …and be at least this many points better, so tiny differences on clean results don't count. */
export const IMPROVE_MIN_GAIN = 0.3
/** It may have at most this many times the segments (no traced compression blocks or noise)… */
export const MAX_SEGMENT_GROWTH = 2
/** …no extra colours, and edge agreement no more than this much worse. */
export const EDGE_SLACK = 0.01

/**
 * Whether to offer the alternative. A better score against the upload can come from reproducing
 * its defects (JPEG blocks, noise, blur) rather than the artwork, so the alternative must also
 * not add colours, multiply segments beyond MAX_SEGMENT_GROWTH or lose edge agreement. On the
 * validation set (docs/v7-results.md) applying these checks to every image, not only to files
 * detected as compressed, kept the offers that were truly better and removed the one that wasn't.
 */
export function isImprovement(first: Scored, alternative: Scored): boolean {
  if (alternative.score > first.score * IMPROVE_RATIO) return false
  if (first.score - alternative.score < IMPROVE_MIN_GAIN) return false
  if (alternative.segments > first.segments * MAX_SEGMENT_GROWTH) return false
  if (alternative.colours > first.colours) return false
  if (alternative.edgeF1 < first.edgeF1 - EDGE_SLACK) return false
  return true
}

/**
 * Signs of lossy compression in the pixels: JPEG's ringing leaves small ripples, pixels a few
 * levels above or below both neighbours, around every edge. Clean anti-aliasing only ramps from
 * one colour to the other. Returns the share of non-flat pixel steps that are such ripples:
 * measured 0–0.04 for clean flat artwork and 0.07–0.34 for JPEG at quality 40–95. Fine
 * gradients and dithering also ripple, which only makes the compression guard stricter.
 */
export function compressionRipple(img: ImageData): number {
  const { width: w, height: h, data: d } = img
  const lum = (p: number) => 0.299 * d[p * 4] + 0.587 * d[p * 4 + 1] + 0.114 * d[p * 4 + 2]
  const stride = Math.max(1, Math.round(Math.sqrt((w * h) / 1e6)))
  let ripples = 0
  let active = 0
  const check = (a: number, b: number, c: number) => {
    const dl = b - a
    const dr = b - c
    const big = Math.max(Math.abs(dl), Math.abs(dr))
    if (big < 1 || big > 60) return
    active++
    if (Math.sign(dl) === Math.sign(dr) && Math.min(Math.abs(dl), Math.abs(dr)) >= 1 && big <= 10) ripples++
  }
  for (let y = 0; y < h; y += stride) for (let x = 1; x + 1 < w; x++) check(lum(y * w + x - 1), lum(y * w + x), lum(y * w + x + 1))
  for (let x = 0; x < w; x += stride) for (let y = 1; y + 1 < h; y++) check(lum((y - 1) * w + x), lum(y * w + x), lum((y + 1) * w + x))
  return active ? ripples / active : 0
}

/** From this ripple share on, an image counts as compressed whatever its file type (used by the benchmarks). */
export const COMPRESSED_RIPPLE = 0.06

/** JPEG and WebP files are usually lossy; PNG, GIF and SVG keep exact colours. */
export function isLossy(name: string): boolean {
  return /\.(jpe?g|jfif|webp)$/i.test(name)
}

/** Images this small (longest side, px) are worth trying with AI sharpening. */
export const SHARPEN_BELOW = 300

/** Whether AI sharpening (2×) is worth trying: small images, or artwork made of fine strokes. */
export function worthSharpening(det: Detection, width: number, height: number): boolean {
  return (det.kind === 'flat' || det.kind === 'lineart') && (Math.max(width, height) <= SHARPEN_BELOW || det.fine >= 0.85)
}

/** An alternative to try for an image, before its job is made (rebuilt lettering comes separately). */
export type Alternative = { kind: 'detail'; detail: number; label: string } | { kind: 'sharpen'; label: string }

/** The alternatives worth trying for an image traced at `detail`, cheapest first. */
export function alternatives(det: Detection, width: number, height: number, detail: number): Alternative[] {
  const out: Alternative[] = []
  for (const [d, label] of [
    [detail + 0.25, 'traced with more detail'],
    [detail - 0.25, 'traced with simpler shapes'],
  ] as const)
    if (d >= 0 && d <= 1) out.push({ kind: 'detail', detail: d, label })
  if (worthSharpening(det, width, height)) out.push({ kind: 'sharpen', label: 'sharpened with AI before tracing, which recovers small detail' })
  return out
}

/** The alternative to automatically rebuilt lettering: AI-sharpened, with the letters traced. */
export const SHARPEN_TRACED = 'sharpened with AI before tracing, with the letters traced instead of rebuilt'

/**
 * Whether to offer the AI-sharpened trace (letters traced) over a first result whose lettering
 * was rebuilt from a font. The upload can't rank the two: on small lettering (strokes 1–2 px)
 * every candidate is within the comparison's 1 px tolerance and scores 0.00, so nothing beats
 * the rebuilt result, and comparing at a higher resolution only measures the upload's blur
 * (docs/improver-rebuilt-lettering.md). What it can rank is trace against trace, so the
 * sharpened trace is judged by the usual rule against the same image traced without sharpening
 * (`traced`, letters traced too), and must not be measurably worse than the rebuilt result.
 */
export function isImprovementOverRebuilt(traced: Scored, rebuilt: Scored, alternative: Scored): boolean {
  if (!isImprovement(traced, alternative)) return false
  if (alternative.score > rebuilt.score) return false
  if (alternative.colours > rebuilt.colours) return false
  if (alternative.edgeF1 < rebuilt.edgeF1 - EDGE_SLACK) return false
  return true
}
