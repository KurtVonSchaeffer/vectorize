import { weightOf } from './candidates'
import type { FontCandidate } from './match'

/**
 * How a word rebuilt from a font is set, in the coordinates of the outlines it travels with:
 * enough to write it as editable SVG text that lands on those outlines when the font is installed.
 */
export interface TextLayout {
  /** Real font names, most specific first: the face's full name, then its family. */
  families: string[]
  weight: number
  style: 'normal' | 'italic'
  /** Font size (em). */
  size: number
  /** Baseline y. */
  baseline: number
  /** Each letter's origin (pen position), in the order of `chars`. */
  xs: number[]
  /** The letters placed, one per entry of `xs`. */
  chars: string[]
}

/** A style suffix of a face's full name ("ExtraBold", "Demi Bold", "Black"). */
const STYLE_SUFFIX = /\s+(?:(?:ultra|extra|semi|demi)[\s-]?)?(?:thin|hairline|light|regular|book|medium|bold|heavy|black|normal)$/i

/**
 * The names and weight to write a candidate's text with. Inside the app a candidate is drawn
 * under an alias (its `family`); an exported file needs the real names: the full name ("Arial
 * Black", a family of its own) and the family left after the style ("Arial" for "Arial Bold").
 */
export function fontNames(f: FontCandidate): { families: string[]; weight: number } {
  const family = f.label.replace(STYLE_SUFFIX, '').trim() || f.label
  const weight = f.source === 'google' ? f.weight : weightOf(f.label.slice(family.length)) || 400
  return { families: [...new Set([f.label, family])], weight }
}

/** The same layout in coordinates `k` times larger. */
export function scaleLayout(l: TextLayout, k: number): TextLayout {
  return { ...l, size: l.size * k, baseline: l.baseline * k, xs: l.xs.map((x) => x * k) }
}
