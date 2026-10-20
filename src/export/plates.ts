import { shapesFromSvg } from './path'

/** One print plate: an ink and the name the PDF separation gets. */
export interface Plate {
  color: number
  name: string
}

const hex = (c: number) => '#' + c.toString(16).padStart(6, '0').toUpperCase()

/**
 * The plates in a print (knockout) SVG, one per ink, in the order the PDF makes them, and how many
 * shapes are gradients (printed in full colour, not on a plate).
 */
export function platesOf(svg: string, name: (color: number) => string | undefined): { plates: Plate[]; gradients: number } {
  const seen = new Map<number, Plate>()
  let gradients = 0
  for (const s of shapesFromSvg(svg))
    if (s.gradient) gradients++
    else if (!seen.has(s.color)) seen.set(s.color, { color: s.color, name: name(s.color) ?? hex(s.color) })
  return { plates: [...seen.values()], gradients }
}

/** The print SVG showing a single plate (preview only: every other ink is hidden). */
export function onePlate(svg: string, color: number): string {
  const style = `<style>path{display:none}path[fill="${hex(color)}" i]{display:inline}</style>`
  return svg.replace(/(<svg\b[^>]*>)/, `$1${style}`)
}
