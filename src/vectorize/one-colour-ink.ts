import { deltaE2000, rgbToLab } from '../palette/color'
import type { Swatch } from '../palette/parse'

const hex = (c: number) => `#${c.toString(16).padStart(6, '0').toUpperCase()}`
export const swatchColor = (s: Swatch) => (s.rgb[0] << 16) | (s.rgb[1] << 8) | s.rgb[2]

/**
 * The print plate's name for a one-colour ink: the library ink's own name when the customer chose
 * one from their library; otherwise marked as a custom ink. A library name is never inferred from
 * how close a colour looks.
 */
export const oneColourPlateName = (ink: number, libraryName: string | null) => libraryName ?? `Custom ink ${hex(ink)}`

/**
 * The library ink nearest a colour, by screen colour (ΔE2000). Only a suggestion for the customer to
 * confirm: on-screen closeness says nothing certain about how the printed ink matches.
 */
export function nearestInk(ink: number, swatches: Swatch[]): { swatch: Swatch; deltaE: number } | null {
  const lab = rgbToLab([(ink >> 16) & 255, (ink >> 8) & 255, ink & 255])
  let best: { swatch: Swatch; deltaE: number } | null = null
  for (const swatch of swatches) {
    const deltaE = deltaE2000(lab, swatch.lab)
    if (!best || deltaE < best.deltaE) best = { swatch, deltaE }
  }
  return best
}
