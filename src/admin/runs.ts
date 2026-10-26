import type { ClientSettings } from '../vectorize/client'
import type { Detection } from '../vectorize/detect'
import type { FidelityVerdict } from '../quality/fidelity'
import { complexity, profileFor, type Complexity } from './complexity'

/**
 * What the admin panel records about each logo it vectorises, and the Layout team's verdict on it,
 * sent to the vectoriser microservice (or kept in this browser until that exists). The success
 * rate per complexity band and the learned default settings are both worked out from these.
 */

export interface RunRecord {
  runId: string
  createdAt: string
  /** The build that made the vector, so a change in results can be traced to a change in code. */
  engineVersion: string
  input: { name: string; type: string; width: number; height: number }
  /**
   * `texture` (Detection.texture: hatching and engraving, 0–1) and `illustration` (traced with a
   * shading layer or simplified) let results for illustrations be read apart from logos.
   */
  detection: { kind: Detection['kind']; colours: number; gradients: number; fine: number; hasAlpha: boolean; compression: number; texture: number; illustration: boolean }
  complexity: Complexity
  /** The learned-settings group, from the upload before tracing (see profileFor). */
  profileKey: string
  /** The settings the vector was made with, and the learned defaults they started from (if any). */
  settings: ClientSettings
  defaultsId: string | null
  output: { paths: number; ms: number }
  /** The engine's own comparison with the upload; null when it couldn't run. */
  autoCheck: { verdict: FidelityVerdict; edgeRecall: number; wrongShare: number; fineLost: number } | null
  /** Optional links to the order, filled in by the artist. */
  links: { logoId?: string; caseNo?: string; salesOrder?: string }
}

export type Outcome = 'usable' | 'touch-up' | 'rejected'

/** The starting pick list; supervisors edit the real one in the microservice. */
export const REVIEW_REASONS = [
  { code: 'lost-detail', label: 'Lost fine detail' },
  { code: 'wrong-colours', label: 'Wrong colours' },
  { code: 'gradient-lost', label: 'Gradient lost' },
  { code: 'text-broken', label: 'Text broken' },
  { code: 'too-many-nodes', label: 'Too many nodes' },
  { code: 'shapes-changed', label: 'Shapes changed' },
  { code: 'background-left', label: 'Background left in' },
  { code: 'not-recognisable', label: 'Character or subject not recognisable' },
  { code: 'low-resolution', label: 'Artwork too low resolution' },
  { code: 'not-vector', label: 'Not suitable for vector' },
] as const

/**
 * What the artwork is, as the artist sees it. The engine's detection guesses (an illustration
 * suggests a mascot), the artist corrects it: success rates are then read per type of artwork,
 * the way the Layout team thinks about their work, not only per complexity band.
 */
export const ASSET_TYPES = [
  { code: 'wordmark', label: 'Wordmark (text only)' },
  { code: 'logo', label: 'Logo or symbol' },
  { code: 'badge', label: 'Badge or emblem' },
  { code: 'mascot', label: 'Mascot or illustration' },
  { code: 'line-art', label: 'Line art or sketch' },
  { code: 'photo', label: 'Photo' },
] as const
export type AssetType = (typeof ASSET_TYPES)[number]['code']

export const CONFIDENCE = ['low', 'medium', 'high'] as const
export type Confidence = (typeof CONFIDENCE)[number]

/** How a vector was made: the engine path, and for illustrations, which choice. */
export const RENDER_MODES = ['logo', 'illustration-detailed', 'illustration-simplified', 'line-art', 'photo', 'pixel'] as const
export type RenderMode = (typeof RENDER_MODES)[number]

export function renderModeOf(kind: Detection['kind'], illustration: boolean, simplified: boolean): RenderMode {
  if (kind === 'flat') return illustration ? (simplified ? 'illustration-simplified' : 'illustration-detailed') : 'logo'
  return kind === 'lineart' ? 'line-art' : kind
}

/** The type the review panel suggests, from what the engine detected. */
export function suggestedAssetType(d: Pick<Detection, 'kind' | 'illustration'>): AssetType {
  if (d.illustration) return 'mascot'
  return d.kind === 'lineart' ? 'line-art' : d.kind === 'photo' ? 'photo' : 'logo'
}

export interface ReviewRecord {
  outcome: Outcome
  reasonCode: string | null
  /** The type of artwork, as the artist confirmed it (null on reviews saved before it was asked). */
  assetType: AssetType | null
  /** How sure the artist is (optional): a borderline reject and a hard one are different signals. */
  confidence: Confidence | null
  /**
   * The vector as it was when reviewed (the run has the first result; the artist may have changed
   * settings or switched an illustration to Simplified since): its paths and how it was made.
   */
  final: { paths: number; mode: RenderMode } | null
  comment: string
  /** Minutes saved against doing it by hand; negative when it cost time. */
  minutesSaved: number
  /** The settings the artist ended on: the strongest signal for learning. */
  finalSettings: ClientSettings
  /** The engine's verdict on the final vector, which may differ from the first one's. */
  finalAutoVerdict: FidelityVerdict | null
  /** The order this logo belongs to, as the artist entered it (all optional). */
  links: RunRecord['links']
  reviewedAt: string
}

/** Logo IDs (BLN…), cases (CAS-…) and sales orders (BAR-SO…) as typed: trimmed, upper case, empty ones left out. */
export function cleanLinks(l: { logoId?: string; caseNo?: string; salesOrder?: string }): RunRecord['links'] {
  const out: RunRecord['links'] = {}
  for (const k of ['logoId', 'caseNo', 'salesOrder'] as const) {
    const v = l[k]?.trim().toUpperCase()
    if (v) out[k] = v.slice(0, 64)
  }
  return out
}

/** Longest a manual layout realistically takes, either way. */
export const MAX_MINUTES = 240

/** Why a review can't be saved yet, in plain words; null when it can. */
export function reviewProblem(r: Pick<ReviewRecord, 'outcome' | 'reasonCode' | 'minutesSaved'>): string | null {
  if (r.outcome !== 'usable' && !r.reasonCode) return 'Pick a reason, so we can learn what to fix.'
  if (!Number.isFinite(r.minutesSaved) || Math.abs(r.minutesSaved) > MAX_MINUTES) return `Minutes saved must be between −${MAX_MINUTES} and ${MAX_MINUTES}.`
  return null
}

export interface RunFacts {
  name: string
  type: string
  width: number
  height: number
  detection: Detection
  colours: number
  compression: number
  textLines?: number
  settings: ClientSettings
  defaultsId: string | null
  paths: number
  ms: number
  autoCheck: RunRecord['autoCheck']
  engineVersion: string
}

export function buildRun(f: RunFacts, now = new Date(), id = newId()): RunRecord {
  const c = complexity({ detection: f.detection, colours: f.colours, compression: f.compression, width: f.width, height: f.height, textLines: f.textLines })
  return {
    runId: id,
    createdAt: now.toISOString(),
    engineVersion: f.engineVersion,
    input: { name: f.name, type: f.type, width: f.width, height: f.height },
    detection: {
      kind: f.detection.kind,
      colours: f.colours,
      gradients: f.detection.gradients,
      fine: f.detection.fine,
      hasAlpha: f.detection.hasAlpha,
      compression: f.compression,
      texture: f.detection.texture ?? 0,
      illustration: !!f.detection.illustration,
    },
    complexity: c,
    profileKey: profileFor({ detection: f.detection, compression: f.compression, width: f.width, height: f.height, textLines: f.textLines }),
    settings: f.settings,
    defaultsId: f.defaultsId,
    output: { paths: f.paths, ms: Math.round(f.ms) },
    autoCheck: f.autoCheck,
    links: {},
  }
}

const newId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `run-${Date.now()}-${Math.random().toString(36).slice(2)}`)

/** Learned default settings for one profile, approved by a supervisor. */
export interface LearnedDefaults {
  id: string
  profileKey: string
  settings: Partial<Pick<ClientSettings, 'detail' | 'corners' | 'maxColors' | 'exactShapes' | 'gradients'>>
}

/** Only these settings may come from the learning job; anything else in its answer is ignored. */
const LEARNABLE = ['detail', 'corners', 'maxColors', 'exactShapes', 'gradients'] as const

export function applyDefaults(s: ClientSettings, d: LearnedDefaults | null): ClientSettings {
  if (!d) return s
  const out = { ...s }
  for (const k of LEARNABLE) {
    const v = d.settings[k]
    if (k === 'detail' || k === 'corners') {
      if (typeof v === 'number' && v >= 0 && v <= 1) out[k] = v
    } else if (k === 'maxColors') {
      if (v === null || (typeof v === 'number' && Number.isInteger(v) && v >= 2 && v <= 64)) out.maxColors = v as number | null
    } else if (typeof v === 'boolean') out[k] = v
  }
  return out
}

/** The vectoriser microservice, as the admin panel sees it. */
export interface RunsApi {
  /** Records a run; the upload and vector are sent with it so they land in blob storage. */
  postRun(run: RunRecord, files: { original: Blob; svg: string }): Promise<void>
  postReview(runId: string, review: ReviewRecord): Promise<void>
  /** The approved defaults for a profile, or null when there are none (or the service can't be reached). */
  getDefaults(profileKey: string): Promise<LearnedDefaults | null>
}

/**
 * The microservice over HTTP. Routes are a proposal to agree with Vernon: POST /runs (multipart:
 * run JSON, original, vector), POST /runs/{id}/review, GET /defaults/{profileKey}.
 */
export function httpRunsApi(baseUrl: string, opts: { token?: () => Promise<string | null>; fetch?: typeof fetch } = {}): RunsApi {
  const base = baseUrl.replace(/\/+$/, '')
  const f = opts.fetch ?? fetch
  const headers = async (more: Record<string, string> = {}) => {
    const t = await opts.token?.()
    return t ? { ...more, Authorization: `Bearer ${t}` } : more
  }
  const ok = async (res: Response, what: string) => {
    if (!res.ok) throw new Error(`Could not ${what} (${res.status}).`)
  }
  return {
    async postRun(run, files) {
      const body = new FormData()
      body.set('run', JSON.stringify(run))
      body.set('original', files.original, run.input.name)
      body.set('vector', new Blob([files.svg], { type: 'image/svg+xml' }), 'vector.svg')
      await ok(await f(`${base}/runs`, { method: 'POST', headers: await headers(), body }), 'save the run')
    },
    async postReview(runId, review) {
      const res = await f(`${base}/runs/${encodeURIComponent(runId)}/review`, { method: 'POST', headers: await headers({ 'Content-Type': 'application/json' }), body: JSON.stringify(review) })
      await ok(res, 'save the review')
    },
    async getDefaults(key) {
      try {
        const res = await f(`${base}/defaults/${encodeURIComponent(key)}`, { headers: await headers() })
        if (res.status === 404 || !res.ok) return null
        const d = await res.json()
        return d && typeof d.id === 'string' && d.settings && typeof d.settings === 'object' ? { id: d.id, profileKey: key, settings: d.settings } : null
      } catch {
        // Learned defaults are an improvement, never a requirement: trace with the usual settings.
        return null
      }
    },
  }
}

/**
 * The admin panel's store: the microservice when VITE_RUNS_API_URL is set, else this browser. Null
 * when even the browser can't keep anything (storage blocked), so the panel says so.
 */
export function defaultRunsApi(url: string | undefined = import.meta.env?.VITE_RUNS_API_URL): (RunsApi & { exportRuns?: () => string }) | null {
  if (url) return httpRunsApi(url)
  try {
    return localRunsApi(window.localStorage)
  } catch {
    return null
  }
}

const STORE_KEY = 'vectorize.admin.runs'

/**
 * Until the microservice exists: runs and reviews kept in this browser (no files), so testing on
 * the admin panel still produces numbers. `exportRuns` hands them over as JSON.
 */
export function localRunsApi(storage: Pick<Storage, 'getItem' | 'setItem'>): RunsApi & { exportRuns(): string } {
  type Entry = { run: RunRecord; review: ReviewRecord | null }
  const load = (): Entry[] => {
    try {
      const v = JSON.parse(storage.getItem(STORE_KEY) ?? '[]')
      return Array.isArray(v) ? v : []
    } catch {
      return []
    }
  }
  const save = (xs: Entry[]) => storage.setItem(STORE_KEY, JSON.stringify(xs))
  return {
    async postRun(run) {
      save([...load(), { run, review: null }])
    },
    async postReview(runId, review) {
      const xs = load()
      const e = xs.find((x) => x.run.runId === runId)
      if (!e) throw new Error('That run was not found in this browser.')
      e.review = review
      e.run.links = { ...e.run.links, ...review.links }
      save(xs)
    },
    async getDefaults() {
      return null
    },
    exportRuns: () => JSON.stringify(load(), null, 2),
  }
}
