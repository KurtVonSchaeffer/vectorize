/**
 * Quality reporting (readiness from measured fidelity, three separate states) is off unless
 * switched on: by VITE_QUALITY_REPORTING=on at build time, or by ?quality-reporting=on in the
 * address for one visit (to try it on a preview). Off, the app reads exactly as before.
 */
export function qualityReportingOn(search = typeof location === 'undefined' ? '' : location.search, env: string | undefined = import.meta.env?.VITE_QUALITY_REPORTING): boolean {
  if (env === 'on') return true
  return new URLSearchParams(search).get('quality-reporting') === 'on'
}

export const QUALITY_REPORTING = qualityReportingOn()
