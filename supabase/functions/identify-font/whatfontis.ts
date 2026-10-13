/**
 * Font identification through the WhatFontIs API (~1M fonts, commercial and free).
 *
 * Runs on a server so the API key never reaches the browser. Plain web APIs only (fetch,
 * Request, Response), so the same code runs in the Supabase edge function (Deno) and in the
 * Vite dev/preview server (Node).
 *
 * API docs: https://www.whatfontis.com/API-identify-fonts-from-image.html
 */

export interface OnlineFont {
  name: string
  /** Whether the font must be bought or is free to use. */
  type: 'commercial' | 'free' | 'unknown'
  /** The font's page on WhatFontIs, where it can be previewed and bought or downloaded. */
  page: string | null
  /** Where the font comes from (foundry or store domain). */
  source: string | null
  /** A sample image of the font, inlined as a data URL (the app is cross-origin isolated). */
  sample: string | null
}

export type IdentifyResult = { ok: true; fonts: OnlineFont[] } | { ok: false; status: number; error: string }

export interface ServerConfig {
  apiKey: string | undefined
  /** Origins allowed to call from another site (the deployed app). Same-origin always works. */
  allowedOrigins: string[]
  fetch?: typeof fetch
}

const API_URL = 'https://www.whatfontis.com/api2/'
/** Base64 of a ~2 MB image. The client sends a small black-and-white crop, well under this. */
const MAX_IMAGE_CHARS = 2_800_000
const SAMPLES = 6
const SAMPLE_TIMEOUT_MS = 4000

/** WhatFontIs error codes, in words a client can act on. */
const ERRORS: Record<string, [number, string]> = {
  '409': [500, 'The font search is not set up (no API key).'],
  '420': [503, 'The font search service is down. Try again later.'],
  '422': [422, 'No letters could be found in the text. Try a clearer image.'],
  '429': [429, 'The daily limit for online font searches has been reached. Try again tomorrow.'],
  '4221': [422, 'That image type is not supported.'],
  '4222': [413, 'The text image is too large.'],
  '4223': [422, 'No text could be found in the image.'],
}

export async function identifyFont(apiKey: string, image: string, limit = 10, fetchImpl: typeof fetch = fetch): Promise<IdentifyResult> {
  const base64 = image.replace(/^data:image\/[a-z]+;base64,/, '')
  if (!/^[A-Za-z0-9+/]+=*$/.test(base64)) return { ok: false, status: 400, error: 'The image must be base64-encoded PNG or JPEG.' }
  if (base64.length > MAX_IMAGE_CHARS) return { ok: false, status: 413, error: 'The text image is too large.' }

  const body = new URLSearchParams({
    API_KEY: apiKey,
    IMAGEBASE64: '1',
    urlimagebase64: base64,
    // The app already cropped to the text, so search the whole image.
    NOTTEXTBOXSDETECTION: '1',
    FREEFONTS: '0',
    limit: String(Math.min(20, Math.max(1, Math.round(limit)))),
    mode: 'fast',
  })
  let res: Response
  try {
    res = await fetchImpl(API_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body })
  } catch {
    return { ok: false, status: 502, error: 'Could not reach the font search service.' }
  }
  const text = await res.text()
  const data = parseJson(text)

  if (Array.isArray(data)) {
    const fonts = data.filter(isObject).map(toFont).filter((f): f is OnlineFont & { sampleUrl: string | null } => !!f)
    await Promise.all(fonts.slice(0, SAMPLES).map(async (f) => (f.sample = f.sampleUrl ? await inlineImage(f.sampleUrl, fetchImpl) : null)))
    return { ok: true, fonts: fonts.map(({ sampleUrl: _, ...f }) => f) }
  }
  // Errors come back as a bare code, a {code|error} object, or an HTTP status.
  const code = errorCode(data) ?? (ERRORS[String(res.status)] ? String(res.status) : null)
  if (code && ERRORS[code]) return { ok: false, status: ERRORS[code][0], error: ERRORS[code][1] }
  return { ok: false, status: 502, error: `The font search service returned an unexpected response${res.ok ? '' : ` (${res.status})`}.` }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text.trim()
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)
const httpUrl = (v: unknown) => {
  const s = str(v)
  return s && /^https?:\/\//i.test(s) ? s : null
}

function toFont(o: Record<string, unknown>): (OnlineFont & { sampleUrl: string | null }) | null {
  // Names arrive with escaped quotes ("Jenna\\\'s Feet").
  const name = str(o.title)?.replace(/\\+(['"])/g, '$1')
  if (!name) return null
  const type = String(o.type ?? '').toLowerCase()
  return {
    name,
    type: type.startsWith('commercial') ? 'commercial' : type.startsWith('free') ? 'free' : 'unknown',
    page: httpUrl(o.url),
    source: str(o.site),
    sample: null,
    sampleUrl: httpUrl(o.image) ?? httpUrl(o.image1) ?? httpUrl(o.image2),
  }
}

function errorCode(data: unknown): string | null {
  if (typeof data === 'number' || (typeof data === 'string' && /^\d{3,4}$/.test(data))) return String(data)
  if (isObject(data)) for (const k of ['code', 'error', 'status', 'error_code']) if (data[k] != null && /^\d{3,4}$/.test(String(data[k]))) return String(data[k])
  return null
}

async function inlineImage(url: string, fetchImpl: typeof fetch): Promise<string | null> {
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(SAMPLE_TIMEOUT_MS) })
    const type = res.headers.get('content-type') ?? ''
    if (!res.ok || !/^image\/(png|jpeg|gif|webp)/.test(type)) return null
    const bytes = new Uint8Array(await res.arrayBuffer())
    if (bytes.length > 300_000) return null
    let bin = ''
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    return `data:${type.split(';')[0]};base64,${btoa(bin)}`
  } catch {
    return null
  }
}

// ---------- HTTP endpoint ----------

/**
 * GET  → { configured } (lets the app show the online search only when it will work)
 * POST { image: base64 PNG/JPEG, limit? } → { fonts } or { error }
 */
export async function handle(req: Request, config: ServerConfig): Promise<Response> {
  const origin = req.headers.get('origin')
  const cors: Record<string, string> =
    origin && config.allowedOrigins.includes(origin)
      ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'content-type, authorization, apikey', Vary: 'Origin' }
      : {}
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors } })

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
  // Browsers send Origin on cross-site requests; only listed sites may spend the API quota.
  if (origin && !cors['Access-Control-Allow-Origin'] && origin !== new URL(req.url).origin) return json({ error: 'This site is not allowed to use the font search.' }, 403)
  if (req.method === 'GET') return json({ configured: !!config.apiKey })
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405)
  if (!config.apiKey) return json({ error: 'The online font search is not set up on this server.' }, 503)
  if (Number(req.headers.get('content-length') ?? 0) > MAX_IMAGE_CHARS + 1000) return json({ error: 'The text image is too large.' }, 413)

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Expected a JSON body.' }, 400)
  }
  if (!isObject(body) || typeof body.image !== 'string') return json({ error: 'Expected { image }.' }, 400)
  const result = await identifyFont(config.apiKey, body.image, typeof body.limit === 'number' ? body.limit : 10, config.fetch)
  return result.ok ? json({ fonts: result.fonts }) : json({ error: result.error }, result.status)
}
