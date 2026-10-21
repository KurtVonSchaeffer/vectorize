/**
 * Unfinished features are off for everyone unless a build switches them on. For a feature with
 * environment variable VITE_X and address parameter x:
 * - VITE_X=on: on for everyone using that build (a release decision).
 * - VITE_X=preview: off, but ?x=on turns it on for one visit. Set this only for the Preview
 *   environment (Vercel → Settings → Environment Variables), so reviewers can try it.
 * - The local dev server (npm run dev) also honours ?x=on.
 * Any other build, production included, ignores the address: customers can't switch it on.
 */
export type FlagEnv = { value: string | undefined; dev: boolean }

export function featureOn(param: string, env: FlagEnv, search = typeof location === 'undefined' ? '' : location.search): boolean {
  if (env.value === 'on') return true
  if (env.value !== 'preview' && !env.dev) return false
  return new URLSearchParams(search).get(param) === 'on'
}

const dev = !!import.meta.env?.DEV

/** Quality reporting: readiness from measured fidelity (docs/fidelity-measurement.md). */
export function qualityReportingOn(search?: string, env: FlagEnv = { value: import.meta.env?.VITE_QUALITY_REPORTING, dev }): boolean {
  return featureOn('quality-reporting', env, search)
}
export const QUALITY_REPORTING = qualityReportingOn()

/**
 * Print and cut files: a paper background left out of the plates, and one physical size for
 * every print and cut file (docs/print-files.md).
 */
export function printFilesOn(search?: string, env: FlagEnv = { value: import.meta.env?.VITE_PRINT_FILES, dev }): boolean {
  return featureOn('print-files', env, search)
}
export const PRINT_FILES = printFilesOn()

/** Clean geometry: reconstruction fixes, starting with shapes drawn twice (docs/clean-geometry.md). */
export function cleanGeometryOn(search?: string, env: FlagEnv = { value: import.meta.env?.VITE_CLEAN_GEOMETRY, dev }): boolean {
  return featureOn('clean-geometry', env, search)
}
export const CLEAN_GEOMETRY = cleanGeometryOn()

/** Fine detail: in the master artwork, thin lines keep their width and length (docs/fine-detail.md). */
export function fineDetailOn(search?: string, env: FlagEnv = { value: import.meta.env?.VITE_FINE_DETAIL, dev }): boolean {
  return featureOn('fine-detail', env, search)
}
export const FINE_DETAIL = fineDetailOn()

/** Colour accuracy: thin lines and small lettering keep their real colours (docs/colour-accuracy.md). */
export function colourAccuracyOn(search?: string, env: FlagEnv = { value: import.meta.env?.VITE_COLOUR_ACCURACY, dev }): boolean {
  return featureOn('colour-accuracy', env, search)
}
export const COLOUR_ACCURACY = colourAccuracyOn()
