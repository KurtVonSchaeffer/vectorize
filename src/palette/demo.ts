import { hexToRgb, rgbToLab } from './color'
import type { Palette } from './parse'

// Generic process-style inks so spot-color mode works before a licensed library is imported.
// Deliberately not Pantone names or values.
const DEMO: [string, string][] = [
  ['Demo Black', '#231F20'],
  ['Demo Warm Red', '#E03C31'],
  ['Demo Orange', '#FF7F2A'],
  ['Demo Yellow', '#FFD100'],
  ['Demo Green', '#2BA84A'],
  ['Demo Teal', '#00A3A1'],
  ['Demo Process Blue', '#0085CA'],
  ['Demo Reflex Blue', '#10069F'],
  ['Demo Violet', '#6A3BA2'],
  ['Demo Magenta', '#D3006C'],
  ['Demo Pink', '#F4A6C6'],
  ['Demo Brown', '#7B4A27'],
  ['Demo Cool Gray', '#97999B'],
  ['Demo Light Gray', '#D9D9D6'],
  ['Demo Navy', '#1F2A44'],
  ['Demo Sky', '#9BCBEB'],
  ['Demo Cream', '#F3E6C4'],
  ['Demo White', '#FFFFFF'],
]

export const DEMO_PALETTE: Palette = {
  name: 'Demo inks (not Pantone)',
  swatches: DEMO.map(([name, hex]) => {
    const rgb = hexToRgb(hex)!
    return { name, rgb, lab: rgbToLab(rgb) }
  }),
}
