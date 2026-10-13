import type { FontCandidate } from './match'

// ---------- Fonts installed on this computer (Chrome/Edge: Local Font Access API) ----------

interface LocalFontData {
  family: string
  fullName: string
  postscriptName: string
  style: string
  blob(): Promise<Blob>
}

/** Installed font files by candidate family alias, for rebuilding lettering from outlines. */
const localFiles = new Map<string, LocalFontData & { blob(): Promise<Blob> }>()

export const canListInstalledFonts = () => typeof window !== 'undefined' && 'queryLocalFonts' in window

/** Families that hold symbols or icons, not letters. */
const NOT_TEXT = /symbol|dingbat|emoji|icon|wingding|webding|zapf|ornament|music|math|braille|marlett|bodoni ornaments|mt extra/i

const WEIGHTS: [RegExp, number][] = [
  [/thin|hairline/i, 100],
  [/extra ?light|ultra ?light/i, 200],
  [/light/i, 300],
  [/medium/i, 500],
  [/semi ?bold|demi ?bold/i, 600],
  [/extra ?bold|ultra ?bold/i, 800],
  [/black|heavy|fat/i, 900],
  [/bold/i, 700],
]

export function weightOf(style: string): number {
  for (const [re, w] of WEIGHTS) if (re.test(style)) return w
  return 400
}

/**
 * Lists the fonts installed on this computer (asks the user for permission) and registers each
 * style under its exact PostScript name, so "Arial Black" renders as Arial Black rather than a
 * synthesized bold. This is how commercial fonts the studio owns get matched, privately.
 * Must be called from a user gesture.
 */
export async function installedFonts(): Promise<FontCandidate[]> {
  const fonts = (await (window as unknown as { queryLocalFonts(): Promise<LocalFontData[]> }).queryLocalFonts()).filter((f) => !NOT_TEXT.test(f.family))
  const out: FontCandidate[] = []
  const batch = 40
  for (let i = 0; i < fonts.length; i += batch) {
    await Promise.all(
      fonts.slice(i, i + batch).map(async (f) => {
        const family = `lf-${f.postscriptName}`
        try {
          const face = new FontFace(family, `local("${f.postscriptName}")`)
          await face.load()
          document.fonts.add(face)
          localFiles.set(family, f)
          out.push({ family, label: f.fullName, ref: f.postscriptName, weight: 400, style: 'normal', source: 'installed' })
        } catch {
          // Some system faces can't be loaded this way; skip them.
        }
      }),
    )
  }
  return out
}

// ---------- Free fonts (Google Fonts) ----------

/**
 * Popular open-licensed families across styles, including metric-compatible stand-ins for
 * common commercial fonts (Arimo ≈ Arial, Tinos ≈ Times, Cousine ≈ Courier).
 */
export const GOOGLE_FAMILIES = [
  // Sans
  'Inter', 'Roboto', 'Open Sans', 'Montserrat', 'Lato', 'Poppins', 'Raleway', 'Nunito', 'Nunito Sans', 'Work Sans', 'Rubik',
  'Archivo', 'Archivo Black', 'Oswald', 'Bebas Neue', 'Anton', 'League Spartan', 'Barlow', 'Barlow Condensed', 'Fira Sans',
  'Source Sans 3', 'PT Sans', 'Noto Sans', 'Ubuntu', 'Mulish', 'Quicksand', 'Karla', 'Manrope', 'DM Sans', 'Space Grotesk',
  'Outfit', 'Sora', 'Plus Jakarta Sans', 'Lexend', 'Josefin Sans', 'Kanit', 'Titillium Web', 'Exo 2', 'Hind', 'Cabin', 'Heebo',
  'Asap', 'Arimo', 'Libre Franklin', 'Public Sans', 'IBM Plex Sans', 'Red Hat Display', 'Figtree', 'Saira', 'Teko', 'Fjalla One',
  'Russo One', 'Righteous', 'Varela Round', 'Comfortaa', 'Fredoka', 'Baloo 2', 'Passion One', 'Francois One', 'Encode Sans',
  'Chivo', 'Overpass', 'Prompt', 'Jost', 'Urbanist', 'Albert Sans', 'Hanken Grotesk', 'Signika', 'Abel', 'Dosis',
  // Serif and slab
  'Playfair Display', 'Merriweather', 'Lora', 'PT Serif', 'Libre Baskerville', 'EB Garamond', 'Cormorant Garamond', 'Crimson Text',
  'Noto Serif', 'Source Serif 4', 'DM Serif Display', 'Bitter', 'Roboto Slab', 'Zilla Slab', 'Arvo', 'Rokkitt', 'Cinzel', 'Prata',
  'Old Standard TT', 'Spectral', 'Domine', 'Frank Ruhl Libre', 'Josefin Slab', 'Tinos', 'Libre Caslon Text', 'Cardo', 'Alegreya',
  'Abril Fatface', 'Alfa Slab One', 'Ultra', 'Rozha One', 'Yeseva One', 'Bodoni Moda', 'Marcellus', 'Cormorant',
  // Display and script
  'Pacifico', 'Lobster', 'Dancing Script', 'Great Vibes', 'Satisfy', 'Kaushan Script', 'Caveat', 'Shadows Into Light',
  'Permanent Marker', 'Amatic SC', 'Sacramento', 'Yellowtail', 'Courgette', 'Cookie', 'Playball', 'Bungee', 'Lilita One',
  'Black Ops One', 'Monoton', 'Bangers', 'Luckiest Guy', 'Staatliches', 'Alfa Slab One', 'Special Elite',
  // Mono
  'Roboto Mono', 'Source Code Pro', 'JetBrains Mono', 'Space Mono', 'IBM Plex Mono', 'Inconsolata', 'Fira Code', 'Cousine',
]
const GOOGLE_WEIGHTS = [400, 700, 900]
const WEIGHT_NAME: Record<number, string> = { 100: 'Thin', 200: 'ExtraLight', 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold', 900: 'Black' }

/**
 * Loads the candidate free fonts, subset to just the letters needed (the request carries the
 * set of distinct characters, never the words). Each family is first requested as a variable
 * font (one file for every weight); families that aren't variable fall back to one request per
 * weight. Weights a family doesn't have, and duplicate files, are skipped.
 */
export async function googleFonts(chars: string, onProgress?: (done: number, total: number) => void): Promise<FontCandidate[]> {
  const text = encodeURIComponent([...new Set(chars.replace(/\s/g, ''))].sort().join(''))
  const families = [...new Set(GOOGLE_FAMILIES)]
  const out: FontCandidate[] = []
  const seenFiles = new Set<string>()
  let done = 0

  const load = async (family: string, axis: string, weights: number[], descriptor: string): Promise<boolean> => {
    const res = await fetch(`https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@${axis}&text=${text}`)
    if (!res.ok) return false
    const url = (await res.text()).match(/url\((https:[^)]+)\)/)?.[1]
    if (!url) return false
    if (seenFiles.has(url)) return true // same file as a weight already loaded
    seenFiles.add(url)
    const alias = `gf-${family}-${axis}`
    const face = new FontFace(alias, `url(${url})`, { weight: descriptor })
    await face.load()
    document.fonts.add(face)
    for (const weight of weights) out.push({ family: alias, label: `${family} ${WEIGHT_NAME[weight]}`, ref: family, weight, style: 'normal', source: 'google' })
    return true
  }

  const run = async (family: string) => {
    try {
      if (await load(family, '100..900', GOOGLE_WEIGHTS, '100 900')) return
      for (const w of GOOGLE_WEIGHTS) await load(family, String(w), [w], String(w)).catch(() => false)
    } catch {
      // Network problem: skip this family.
    } finally {
      onProgress?.(++done, families.length)
    }
  }
  const queue = [...families]
  await Promise.all(Array.from({ length: 16 }, async () => {
    while (queue.length) await run(queue.shift()!)
  }))
  return out
}

// ---------- Font files (for outlines) ----------

/**
 * The font file behind a candidate, for reading letter outlines. Free fonts come from
 * Fontsource (the same Google Fonts, as WOFF files the parser can read), at the nearest weight
 * the family has; installed fonts come from the computer (Chrome/Edge).
 */
export async function fontFile(font: FontCandidate): Promise<ArrayBuffer> {
  if (font.source === 'installed') {
    const local = localFiles.get(font.family)
    if (!local) throw new Error('That installed font is no longer available. Check installed fonts again.')
    return (await local.blob()).arrayBuffer()
  }
  const id = font.ref.toLowerCase().replace(/[^a-z0-9]+/g, '-')
  const info = await fetch(`https://api.fontsource.org/v1/fonts/${id}`).then((r) => (r.ok ? r.json() : null)).catch(() => null)
  const weights: number[] = info?.weights ?? [400]
  const weight = weights.reduce((best, w) => (Math.abs(w - font.weight) < Math.abs(best - font.weight) ? w : best), weights[0])
  const res = await fetch(`https://cdn.jsdelivr.net/fontsource/fonts/${id}@latest/latin-${weight}-normal.woff`)
  if (!res.ok) throw new Error(`Couldn't download ${font.ref}.`)
  return res.arrayBuffer()
}
