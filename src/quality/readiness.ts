import type { FidelityReport } from './fidelity'

/**
 * What the app may say about a result, kept as three separate facts:
 * 1. generated: a vector was made;
 * 2. automatically checked: assessFidelity compared it with the upload and found no known
 *    problem, found problems, or couldn't run;
 * 3. production-approved: a person reviewed it and said so.
 *
 * The automatic check can only ever lower what is said. It never approves artwork for
 * production: known problems pass it (see docs/fidelity-measurement.md), so approval comes only
 * from a person's action, recorded for one exact result.
 */

/** The automatic check of one result. */
export type CheckOutcome =
  | { state: 'checking' }
  | { state: 'checked'; report: FidelityReport }
  /** It didn't produce a report: an error, a timeout, or a result it can't measure (photos). */
  | { state: 'not-checked'; reason: 'error' | 'timeout' | 'unsupported' }

export type AutoCheck = 'checking' | 'no-known-problems' | 'problems-found' | 'not-checked'

export const autoCheckOf = (c: CheckOutcome | null): AutoCheck =>
  !c || c.state === 'not-checked' ? 'not-checked' : c.state === 'checking' ? 'checking' : c.report.verdict === 'ready' ? 'no-known-problems' : 'problems-found'

/** A person's production approval of one exact result (its SVG). */
export interface Approval {
  svg: string
}
export const isApproved = (approval: Approval | null, svg: string | undefined) => !!approval && !!svg && approval.svg === svg

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
  approved: boolean
}

export interface Readiness {
  generated: boolean
  autoCheck: AutoCheck
  approved: boolean
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
  const approved = generated && i.approved
  const verb = VERB[i.purpose]
  let summary: string
  if (i.status === 'error') summary = ''
  else if (!generated) summary = 'Finding colors and tracing edges…'
  else {
    const lead = i.warnings.length ? `${i.counted}. ${i.warnings.join(' ')}` : i.oneInk ? 'One ink: every color prints in this ink, and white areas stay as paper.' : `${i.counted}.`
    const check = {
      checking: 'Checking the vector against your image…',
      'no-known-problems': `Automatic checks found no known problems, but they can miss small changes, so review it before you ${verb} it.`,
      'problems-found': `Automatic checks found problems: zoom in and review it before you ${verb} it.`,
      'not-checked': `It couldn't be checked automatically, so review it carefully before you ${verb} it.`,
    }[autoCheck]
    summary = approved ? `${lead} You approved this version for production.` : `${lead} ${check}`
  }
  return { generated, autoCheck, approved, summary, findings }
}
