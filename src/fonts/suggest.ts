import type { FontReport } from './identify'
import type { LineLettering } from './lettering'
import type { FontCandidate } from './match'

/**
 * Which font matches the app suggests, shared by the app (FontPanel, App) and the benchmarks
 * (bench/improver-sim.ts) so the two can't drift apart.
 *
 * Lettering is never replaced with a font automatically, and a font is never offered as a
 * cleaner version either. The background improver judges candidates against the upload, which
 * can't measure lettering fidelity: on small lettering it forgives sub-pixel misplacement and
 * spacing, and rewards a rebuild for losing the traced letters' small blobs (small gradient logo
 * PNG: 0.75 → 0.36 against the upload, 0.35 → 0.48 against the original, and it passed the offer
 * rule). Tried on the 89-pair benchmark, a suggested typeface was worse than the traced letters
 * on 9 of 33 uploads. So a close match is only suggested by name, as a typeface the customer can
 * try and compare; the traced letters stay until they choose it.
 */
export const SUGGEST_MIN_SCORE = 0.85

/**
 * In the admin panel the person choosing is a layout artist who can tell a right typeface from a
 * near miss, so weaker matches are suggested too (Barron's own "barron.com", correctly matched to
 * Quicksand Bold, scored 0.75). Still only suggested by name: nothing is replaced until they choose.
 */
export const ADMIN_SUGGEST_MIN_SCORE = 0.7

/** Whether a line's best match is close enough to suggest by name. */
export function worthSuggesting(match: { score: number } | undefined, min = SUGGEST_MIN_SCORE): match is { score: number } {
  return !!match && match.score >= min
}

export interface FontSuggestion {
  line: number
  text: string
  font: string
  score: number
  placed: LineLettering
}

/**
 * The suggestion for a line, placed ahead so trying it is instant: only words whose text the image
 * supports (never an unverified reading). Null when nothing of the line can be placed.
 */
export async function placeSuggestion(
  report: FontReport,
  line: number,
  match: FontCandidate & { score: number },
  place: (report: FontReport, line: FontReport['lines'][number], match: FontCandidate) => Promise<LineLettering>,
): Promise<FontSuggestion | null> {
  const found = await place(report, report.lines[line], match).catch(() => null)
  const words = found?.words.filter((w) => !w.doubts?.length) ?? []
  if (!found || !words.length) return null
  return { line, text: report.lines[line].text, font: match.label, score: match.score, placed: { ...found, words } }
}
