import { deltaE2000, hexToRgb, rgbToLab, type Lab } from './color'

// Everyday color names, so clients see "Navy" and "Orange" instead of hex codes.
const NAMED: [string, string][] = [
  ['Black', '#111111'], ['Charcoal', '#36454F'], ['Dark gray', '#555555'], ['Gray', '#8A8A8A'], ['Silver', '#C0C0C0'],
  ['Light gray', '#DDDDDD'], ['White', '#FFFFFF'], ['Cream', '#FFF6E0'], ['Beige', '#E8D9B5'], ['Tan', '#C9A66B'],
  ['Brown', '#7A4A24'], ['Dark brown', '#4A2C17'], ['Maroon', '#7A1F2B'], ['Red', '#D7262E'], ['Coral', '#F2725E'],
  ['Pink', '#F4A3C0'], ['Hot pink', '#E3337E'], ['Magenta', '#C2187A'], ['Purple', '#6B3FA0'], ['Lavender', '#B8A4E3'],
  ['Violet', '#8A4FD8'], ['Navy', '#1F2A4A'], ['Dark blue', '#1C3A7A'], ['Blue', '#1C6ED6'], ['Sky blue', '#7EC3EE'],
  ['Light blue', '#BFE0F7'], ['Teal', '#0F8C8C'], ['Turquoise', '#2EC4C4'], ['Mint', '#A8E6CF'], ['Green', '#2E9E4A'],
  ['Dark green', '#1E5631'], ['Olive', '#6B7A2A'], ['Lime', '#9ACD32'], ['Yellow', '#F7D21E'], ['Gold', '#D4A017'],
  ['Mustard', '#C9A227'], ['Orange', '#F08C00'], ['Burnt orange', '#C2561A'], ['Peach', '#FFC9A0'],
]
const TABLE: { name: string; lab: Lab }[] = NAMED.map(([name, hex]) => ({ name, lab: rgbToLab(hexToRgb(hex)!) }))

export function colorName(color: number): string {
  const lab = rgbToLab([(color >> 16) & 255, (color >> 8) & 255, color & 255])
  let best = TABLE[0]
  let bd = Infinity
  for (const t of TABLE) {
    const d = deltaE2000(lab, t.lab)
    if (d < bd) {
      bd = d
      best = t
    }
  }
  return best.name
}

/** Names for a set of colors, disambiguated when two map to the same word ("Blue", "Blue 2"). */
export function colorNames(colors: number[]): string[] {
  const seen = new Map<string, number>()
  return colors.map((c) => {
    const n = colorName(c)
    const k = (seen.get(n) ?? 0) + 1
    seen.set(n, k)
    return k > 1 ? `${n} ${k}` : n
  })
}
