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

/**
 * Admin panel: the Layout team's build inside Barron's admin panel (docs/admin-panel.md). It
 * records every run and the artist's review, always checks results against the upload, makes
 * production files with clean geometry and paper left out, and leaves out the online font search,
 * whose licence covers personal use only.
 */
export function adminModeOn(search?: string, env: FlagEnv = { value: import.meta.env?.VITE_ADMIN_MODE, dev }): boolean {
  return featureOn('admin', env, search)
}
export const ADMIN_MODE = adminModeOn()

/** Quality reporting: readiness from measured fidelity (docs/fidelity-measurement.md). Always on in the admin panel. */
export function qualityReportingOn(search?: string, env: FlagEnv = { value: import.meta.env?.VITE_QUALITY_REPORTING, dev }): boolean {
  return featureOn('quality-reporting', env, search)
}
export const QUALITY_REPORTING = ADMIN_MODE || qualityReportingOn()

/**
 * Print and cut files: a paper background left out of the plates, and one physical size for
 * every print and cut file (docs/print-files.md).
 */
export function printFilesOn(search?: string, env: FlagEnv = { value: import.meta.env?.VITE_PRINT_FILES, dev }): boolean {
  return featureOn('print-files', env, search)
}
export const PRINT_FILES = ADMIN_MODE || printFilesOn()

/** Clean geometry: reconstruction fixes, starting with shapes drawn twice (docs/clean-geometry.md). */
export function cleanGeometryOn(search?: string, env: FlagEnv = { value: import.meta.env?.VITE_CLEAN_GEOMETRY, dev }): boolean {
  return featureOn('clean-geometry', env, search)
}
export const CLEAN_GEOMETRY = ADMIN_MODE || cleanGeometryOn()

/** Fine detail: in the master artwork, thin lines keep their width and length (docs/fine-detail.md). */
export function fineDetailOn(search?: string, env: FlagEnv = { value: import.meta.env?.VITE_FINE_DETAIL, dev }): boolean {
  return featureOn('fine-detail', env, search)
}
export const FINE_DETAIL = ADMIN_MODE || fineDetailOn()

/** Straight edges: long straight stretches of traced outlines drawn as exact lines (docs/straight-edges.md). */
export function straightEdgesOn(search?: string, env: FlagEnv = { value: import.meta.env?.VITE_STRAIGHT_EDGES, dev }): boolean {
  return featureOn('straight-edges', env, search)
}
export const STRAIGHT_EDGES = ADMIN_MODE || straightEdgesOn()

/** Exact arcs: circular stretches of traced outlines drawn as exact arcs, rounded corners as fillets (docs/exact-arcs.md). */
export function exactArcsOn(search?: string, env: FlagEnv = { value: import.meta.env?.VITE_EXACT_ARCS, dev }): boolean {
  return featureOn('exact-arcs', env, search)
}
export const EXACT_ARCS = ADMIN_MODE || exactArcsOn()
