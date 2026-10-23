import { shapesFromSvg } from './path'

/** One print plate: an ink and the name the PDF separation gets. */
export interface Plate {
  color: number
  name: string
}

const hex = (c: number) => '#' + c.toString(16).padStart(6, '0').toUpperCase()

/**
 * The plates in a print (knockout) SVG, one per ink, in the order the PDF makes them, and how many
 * shapes are gradients (printed in full colour, not on a plate). With `chosen` (print files: only
 * the inks chosen for print are plates, see chosenPrintInks), a colour without a chosen ink isn't a
 * plate: it's listed in `fullColour`, as the PDF prints it.
 */
export function platesOf(
  svg: string,
  name: (color: number) => string | undefined,
  chosen?: Map<number, string> | null,
): { plates: Plate[]; gradients: number; fullColour: Plate[] } {
  const seen = new Map<number, Plate>()
  const process = new Map<number, Plate>()
  let gradients = 0
  for (const s of shapesFromSvg(svg))
    if (s.gradient) gradients++
    else if (chosen !== undefined && !chosen?.has(s.color)) {
      if (!process.has(s.color)) process.set(s.color, { color: s.color, name: name(s.color) ?? hex(s.color) })
    } else if (!seen.has(s.color)) seen.set(s.color, { color: s.color, name: chosen?.get(s.color) ?? name(s.color) ?? hex(s.color) })
  return { plates: [...seen.values()], gradients, fullColour: [...process.values()] }
}

/** The name a white-ink plate gets when the customer asks for white ink (print files). */
export const WHITE_INK_PLATE = 'White'

/**
 * Print files (flag): the inks that become spot plates. Only what the customer chose: print inks
 * from their library or the one-colour ink (`spotNames`), and white ink when they asked for it in
 * "White ink in print files" (`whiteInk`, the paper colour the white areas have). Everything else
 * prints in full colour; a colour appearing in the image is never a plate by itself.
 */
export function chosenPrintInks(spotNames: Map<number, string> | null, whiteInk: number | null): Map<number, string> {
  const inks = new Map(spotNames ?? [])
  if (whiteInk !== null && !inks.has(whiteInk)) inks.set(whiteInk, WHITE_INK_PLATE)
  return inks
}

/** The print SVG showing a single plate (preview only: every other ink is hidden). */
export function onePlate(svg: string, color: number): string {
  const style = `<style>path{display:none}path[fill="${hex(color)}" i]{display:inline}</style>`
  return svg.replace(/(<svg\b[^>]*>)/, `$1${style}`)
}
