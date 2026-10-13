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

// ---------- Fonts that ship with the computer ----------

/**
 * Common fonts bundled with macOS and Windows (and Office), by full face name. Browsers draw
 * these with `local()` without asking, in every browser, so well-known commercial fonts such as
 * Arial Black, Helvetica Neue, Futura or Gill Sans can be matched exactly anywhere.
 */
export const SYSTEM_FONTS = [
  // Sans
  'Arial', 'Arial Bold', 'Arial Black', 'Arial Narrow', 'Arial Narrow Bold', 'Arial Rounded MT Bold',
  'Helvetica', 'Helvetica Bold', 'Helvetica Neue', 'Helvetica Neue Medium', 'Helvetica Neue Bold', 'Helvetica Neue Condensed Bold', 'Helvetica Neue Condensed Black',
  'Futura Medium', 'Futura Bold', 'Futura Condensed Medium', 'Futura Condensed ExtraBold',
  'Avenir Book', 'Avenir Medium', 'Avenir Heavy', 'Avenir Black',
  'Avenir Next Regular', 'Avenir Next Medium', 'Avenir Next Demi Bold', 'Avenir Next Bold', 'Avenir Next Heavy', 'Avenir Next Condensed Bold',
  'Gill Sans', 'Gill Sans SemiBold', 'Gill Sans Bold', 'Gill Sans UltraBold', 'Optima Regular', 'Optima Bold',
  'DIN Alternate Bold', 'DIN Condensed Bold', 'Verdana', 'Verdana Bold', 'Tahoma', 'Tahoma Bold', 'Trebuchet MS', 'Trebuchet MS Bold',
  'Geneva', 'Lucida Grande', 'Lucida Grande Bold', 'Skia', 'Seravek', 'Seravek Bold',
  'Segoe UI', 'Segoe UI Semibold', 'Segoe UI Bold', 'Segoe UI Black', 'Calibri', 'Calibri Bold', 'Candara', 'Candara Bold', 'Corbel', 'Corbel Bold',
  'Franklin Gothic Medium', 'Franklin Gothic Demi', 'Franklin Gothic Heavy', 'Century Gothic', 'Century Gothic Bold', 'Bahnschrift', 'Impact',
  'Tw Cen MT', 'Tw Cen MT Bold', 'Gill Sans MT', 'Gill Sans MT Bold', 'Berlin Sans FB', 'Berlin Sans FB Bold', 'Eras Bold ITC', 'Agency FB', 'Myriad Pro', 'Myriad Pro Bold',
  // Serif
  'Times New Roman', 'Times New Roman Bold', 'Times', 'Times Bold', 'Georgia', 'Georgia Bold', 'Baskerville', 'Baskerville SemiBold', 'Baskerville Bold',
  'Didot', 'Didot Bold', 'Bodoni 72 Book', 'Bodoni 72 Bold', 'Hoefler Text', 'Hoefler Text Black', 'Big Caslon Medium', 'Palatino', 'Palatino Bold',
  'Garamond', 'Garamond Bold', 'Book Antiqua', 'Cambria', 'Cambria Bold', 'Constantia', 'Constantia Bold', 'Rockwell', 'Rockwell Bold', 'Rockwell Extra Bold',
  'Charter Roman', 'Charter Bold', 'Charter Black', 'Iowan Old Style Roman', 'Iowan Old Style Bold', 'Cochin', 'Cochin Bold', 'Athelas Regular', 'Athelas Bold',
  'American Typewriter', 'American Typewriter Bold', 'Copperplate', 'Copperplate Bold', 'Superclarendon Regular', 'Superclarendon Bold', 'Sitka Text',
  'Century Schoolbook', 'Bookman Old Style', 'Perpetua', 'Goudy Old Style', 'Baskerville Old Face', 'Bell MT', 'Calisto MT', 'Californian FB',
  // Display and script
  'Cooper Black', 'Bauhaus 93', 'Broadway', 'Algerian', 'Stencil', 'Showcard Gothic', 'Britannic Bold', 'Haettenschweiler', 'Jokerman', 'Gill Sans Ultra Bold',
  'Brush Script MT', 'Snell Roundhand', 'Snell Roundhand Bold', 'Zapfino', 'Savoye LET', 'Apple Chancery', 'Bradley Hand', 'Lucida Handwriting', 'Segoe Script', 'Segoe Print', 'Ink Free', 'Gabriola',
  'Marker Felt Thin', 'Marker Felt Wide', 'Chalkboard', 'Chalkboard Bold', 'Chalkduster', 'Noteworthy Light', 'Noteworthy Bold', 'Comic Sans MS', 'Comic Sans MS Bold', 'Papyrus',
  'Herculanum', 'Trattatello', 'Phosphate Inline', 'Phosphate Solid', 'Luminari', 'Kefa', 'Mishafi',
  // Mono
  'Courier New', 'Courier New Bold', 'Courier', 'Menlo', 'Monaco', 'Consolas', 'Andale Mono', 'Lucida Console',
]

let systemCache: Promise<FontCandidate[]> | null = null

/** The SYSTEM_FONTS present on this computer (a font that isn't there simply fails to load). */
export function systemFonts(): Promise<FontCandidate[]> {
  systemCache ??= (async () => {
    const found = await Promise.all(
      SYSTEM_FONTS.map(async (name): Promise<FontCandidate | null> => {
        const family = `sys-${name}`
        try {
          // Each face is registered on its own, so it's drawn as itself (no synthesized bold).
          const face = new FontFace(family, `local("${name}")`)
          await face.load()
          document.fonts.add(face)
          return { family, label: name, ref: name, weight: 400, style: 'normal', source: 'system' }
        } catch {
          return null
        }
      }),
    )
    return found.filter((f): f is FontCandidate => !!f)
  })()
  return systemCache
}

// ---------- Font files (for outlines) ----------

/**
 * The font file behind a candidate, for reading letter outlines. Free fonts come from
 * Fontsource (the same Google Fonts, as WOFF files the parser can read), at the nearest weight
 * the family has; installed fonts come from the computer (Chrome/Edge).
 */
export async function fontFile(font: FontCandidate): Promise<ArrayBuffer> {
  if (font.source === 'system') throw new Error('System fonts have no file to read.')
  if (font.source === 'installed') {
    const local = localFiles.get(font.family)
    if (!local) throw new Error('That installed font is no longer available. Check installed fonts again.')
    return (await local.blob()).arrayBuffer()
  }
  // `ref` is the Fontsource id for catalog fonts.
  const id = font.ref.toLowerCase().replace(/[^a-z0-9]+/g, '-')
  const info = await fetch(`https://api.fontsource.org/v1/fonts/${id}`).then((r) => (r.ok ? r.json() : null)).catch(() => null)
  const weights: number[] = info?.weights ?? [400]
  const weight = weights.reduce((best, w) => (Math.abs(w - font.weight) < Math.abs(best - font.weight) ? w : best), weights[0])
  const res = await fetch(`https://cdn.jsdelivr.net/fontsource/fonts/${id}@latest/latin-${weight}-normal.woff`)
  if (!res.ok) throw new Error(`Couldn't download ${font.ref}.`)
  return res.arrayBuffer()
}
