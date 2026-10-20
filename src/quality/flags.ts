/**
 * Quality reporting is unfinished, so it is off for everyone unless a build switches it on:
 * - VITE_QUALITY_REPORTING=on: on for everyone using that build (a release decision).
 * - VITE_QUALITY_REPORTING=preview: off, but ?quality-reporting=on turns it on for one visit.
 *   Set this only for the Preview environment (Vercel → Settings → Environment Variables), so
 *   reviewers can try it on preview deployments.
 * - The local dev server (npm run dev) also honours ?quality-reporting=on.
 * Any other build, production included, ignores the address: customers can't switch it on.
 */
export type FlagEnv = { value: string | undefined; dev: boolean }

export function qualityReportingOn(
  search = typeof location === 'undefined' ? '' : location.search,
  env: FlagEnv = { value: import.meta.env?.VITE_QUALITY_REPORTING, dev: !!import.meta.env?.DEV },
): boolean {
  if (env.value === 'on') return true
  if (env.value !== 'preview' && !env.dev) return false
  return new URLSearchParams(search).get('quality-reporting') === 'on'
}

export const QUALITY_REPORTING = qualityReportingOn()
