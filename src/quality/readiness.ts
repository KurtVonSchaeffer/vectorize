import type { FidelityReport } from './fidelity'

/**
 * What the app may say about a result, kept as separate facts:
 * 1. generated: a vector was made;
 * 2. automatically checked: assessFidelity compared it with the upload and found no known
 *    problem, found problems, or couldn't run;
 * 3. reviewed: a person looked at this exact result and marked it as reviewed.
 *
 * None of these is a production approval. That will need the production method, the output size,
 * the colours and the checks that apply to them, and the app doesn't record those yet. The
 * automatic check can only ever lower what is said: known problems pass it (see
 * docs/fidelity-measurement.md), so it never stands in for a person's review either.
 */

/** The automatic check of one result. */
export type CheckOutcome =
  | { state: 'checking' }
  | { state: 'checked'; report: FidelityReport }
  /** It didn't produce a report: an error, a timeout, or a result it can't measure. */
  | { state: 'not-checked'; reason: 'error' | 'timeout' | 'unsupported' }

export type AutoCheck = 'checking' | 'no-known-problems' | 'problems-found' | 'not-checked'

export const autoCheckOf = (c: CheckOutcome | null): AutoCheck =>
  !c || c.state === 'not-checked' ? 'not-checked' : c.state === 'checking' ? 'checking' : c.report.verdict === 'ready' ? 'no-known-problems' : 'problems-found'

/** A person's review of one exact result (its SVG). */
export interface Review {
  svg: string
}
export const isReviewed = (review: Review | null, svg: string | undefined) => !!review && !!svg && review.svg === svg

export interface ReadinessInput {
  /** Processing: working, done (a result exists), or failed. */
  status: 'working' | 'ready' | 'error'
  /** "3 colors" or "318 shapes". */
  counted: string
  purpose: 'print' | 'web' | 'cut'
  /** Warnings known without measuring (photos, tiny lettering), already in plain words. */
  warnings: string[]
  /** One-ink spot mode (its own wording). */
  oneInk: boolean
  check: CheckOutcome | null
  reviewed: boolean
}

export interface Readiness {
  generated: boolean
  autoCheck: AutoCheck
  reviewed: boolean
  /** The status line under the headline. */
  summary: string
  /** What the check found, in plain words (most important first, at most 3). */
  findings: string[]
}

const VERB = { print: 'print', web: 'publish', cut: 'cut' } as const

export function readiness(i: ReadinessInput): Readiness {
  const generated = i.status === 'ready'
  const autoCheck = generated ? autoCheckOf(i.check) : 'not-checked'
  const findings = i.check?.state === 'checked' ? i.check.report.issues.map((x) => x.message).slice(0, 3) : []
  const reviewed = generated && i.reviewed
  const verb = VERB[i.purpose]
  let summary: string
  if (i.status === 'error') summary = ''
  else if (!generated) summary = 'Finding colors and tracing edges…'
  else {
    const lead = i.warnings.length ? `${i.counted}. ${i.warnings.join(' ')}` : i.oneInk ? 'One ink: every color prints in this ink, and white areas stay as paper.' : `${i.counted}.`
    const check = {
      checking: 'Checking the vector against your image…',
      'no-known-problems': reviewed ? 'Automatic checks found no known problems.' : `Automatic checks found no known problems, but they can miss small changes, so review it before you ${verb} it.`,
      'problems-found': reviewed ? 'Automatic checks found problems.' : `Automatic checks found problems: zoom in and review it before you ${verb} it.`,
      'not-checked': reviewed ? "It couldn't be checked automatically." : `It couldn't be checked automatically, so review it carefully before you ${verb} it.`,
    }[autoCheck]
    summary = reviewed ? `${lead} ${check} You marked this version as reviewed.` : `${lead} ${check}`
  }
  return { generated, autoCheck, reviewed, summary, findings }
}
