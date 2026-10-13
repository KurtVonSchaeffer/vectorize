import type { LabelMap } from '../trace'
import { deltaE2000, rgbToLab, type Lab } from './color'

/** One brand color: the exact color to output, its name, and how close a traced color must be. */
export interface BrandColor {
  name: string
  /** Exact output color, 0xRRGGBB. */
  color: number
  /** Match distance (CIEDE2000). About 5 is "very close", 10 "close", 20 "loose". */
  tolerance: number
}

/**
 * - `snap`: traced colors within a brand color's tolerance become that exact color; others stay.
 * - `only`: every traced color becomes its nearest brand color (the background only if one is
 *   reasonably close, so a cream backdrop doesn't turn navy when the brand has no light color).
 */
export type BrandMode = 'off' | 'snap' | 'only'

export interface BrandSettings {
  mode: BrandMode
  colors: BrandColor[]
}

export const DEFAULT_BRAND: BrandSettings = { mode: 'off', colors: [] }

const labOf = (c: number): Lab => rgbToLab([(c >> 16) & 255, (c >> 8) & 255, c & 255])

/** Below this distance a background may snap even in "only" mode. */
const BACKGROUND_SNAP = 20

export interface BrandResult {
  map: LabelMap
  /** Output color → brand name, for colors that were matched. */
  named: Map<number, string>
}

/** Applies brand colors to a traced color map, merging labels that end up the same color. */
export function applyBrand(map: LabelMap, brand: BrandSettings, backgroundLabel: number): BrandResult {
  const named = new Map<number, string>()
  if (brand.mode === 'off' || !brand.colors.length) return { map, named }
  const brandLabs = brand.colors.map((b) => labOf(b.color))

  const colors = map.colors.slice()
  colors.forEach((c, l) => {
    if (c < 0) return
    const lab = labOf(c)
    let best = -1
    let bd = Infinity
    brandLabs.forEach((bl, i) => {
      const d = deltaE2000(lab, bl)
      if (d < bd) [best, bd] = [i, d]
    })
    const b = brand.colors[best]
    const within = bd <= b.tolerance
    const snap = brand.mode === 'snap' ? within : l !== backgroundLabel || within || bd <= BACKGROUND_SNAP
    if (!snap) return
    colors[l] = b.color
    named.set(b.color, b.name)
  })

  // Labels that now share a color become one label, so their shapes merge without seams.
  const first = new Map<number, number>()
  const remap = colors.map((c, l) => {
    if (c < 0) return l
    const f = first.get(c)
    if (f === undefined) {
      first.set(c, l)
      return l
    }
    return f
  })
  const changed = remap.some((r, l) => r !== l)
  const relabel = (l: number) => (l < remap.length ? remap[l] : l)
  return {
    map: {
      ...map,
      colors,
      labels: changed ? map.labels.map(relabel) : map.labels,
      second: changed ? map.second.map(relabel) : map.second,
    },
    named,
  }
}

/** Parses "#RRGGBB" / "RRGGBB" into 0xRRGGBB, or null. */
export function parseHex(s: string): number | null {
  const m = s.trim().replace(/^#/, '')
  return /^[0-9a-f]{6}$/i.test(m) ? parseInt(m, 16) : null
}
