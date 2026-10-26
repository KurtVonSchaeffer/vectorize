import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_CLIENT } from '../../vectorize/client'
import { applyDefaults, buildRun, cleanLinks, httpRunsApi, localRunsApi, renderModeOf, reviewProblem, suggestedAssetType, type ReviewRecord, type RunFacts } from '../runs'

const facts: RunFacts = {
  name: 'acme.jpg',
  type: 'image/jpeg',
  width: 800,
  height: 400,
  detection: { kind: 'flat', hasAlpha: false, background: 0xffffff, gradients: 1, fine: 0.2 },
  colours: 4,
  compression: 0.12,
  settings: DEFAULT_CLIENT,
  defaultsId: null,
  paths: 120,
  ms: 812.4,
  autoCheck: { verdict: 'check', edgeRecall: 0.96, wrongShare: 0.004, fineLost: 1 },
  engineVersion: 'abc123',
}

const review: ReviewRecord = { outcome: 'touch-up', reasonCode: 'lost-detail', assetType: 'logo', confidence: 'medium', final: { paths: 96, mode: 'logo' }, comment: '', minutesSaved: 10, finalSettings: DEFAULT_CLIENT, finalAutoVerdict: 'ready', links: { caseNo: 'CAS-161569' }, reviewedAt: '2026-11-03T09:00:00.000Z' }

function memoryStorage() {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }
}

describe('buildRun', () => {
  it('records the complexity, its band and the profile the learned settings belong to', () => {
    const run = buildRun(facts, new Date('2026-11-03T08:00:00Z'), 'run-1')
    expect(run).toMatchObject({ runId: 'run-1', createdAt: '2026-11-03T08:00:00.000Z', engineVersion: 'abc123', output: { paths: 120, ms: 812 } })
    expect(run.complexity.band).toBe('simple')
    expect(run.profileKey).toBe('flat/simple/lossy')
  })
  it('records texture and whether it was traced as an illustration, so mascots can be read apart', () => {
    expect(buildRun(facts).detection).toMatchObject({ texture: 0, illustration: false })
    const mascot = buildRun({ ...facts, detection: { ...facts.detection, texture: 0.41, illustration: true } })
    expect(mascot.detection).toMatchObject({ texture: 0.41, illustration: true })
  })
})

describe('renderModeOf', () => {
  it('names how the reviewed vector was made, including the illustration choice', () => {
    expect(renderModeOf('flat', false, false)).toBe('logo')
    expect(renderModeOf('flat', true, false)).toBe('illustration-detailed')
    expect(renderModeOf('flat', true, true)).toBe('illustration-simplified')
    expect(renderModeOf('lineart', false, false)).toBe('line-art')
    expect(renderModeOf('photo', false, false)).toBe('photo')
  })
})

describe('suggestedAssetType', () => {
  it('suggests what the engine detected, for the artist to confirm', () => {
    expect(suggestedAssetType({ kind: 'flat', illustration: true })).toBe('mascot')
    expect(suggestedAssetType({ kind: 'flat' })).toBe('logo')
    expect(suggestedAssetType({ kind: 'lineart' })).toBe('line-art')
    expect(suggestedAssetType({ kind: 'photo' })).toBe('photo')
  })
})

describe('reviewProblem', () => {
  it('asks for a reason unless the result was usable', () => {
    expect(reviewProblem({ outcome: 'usable', reasonCode: null, minutesSaved: 5 })).toBeNull()
    expect(reviewProblem({ outcome: 'rejected', reasonCode: null, minutesSaved: 0 })).toMatch(/reason/)
    expect(reviewProblem({ outcome: 'touch-up', reasonCode: 'text-broken', minutesSaved: 3 })).toBeNull()
  })
  it('refuses impossible minutes', () => {
    expect(reviewProblem({ outcome: 'usable', reasonCode: null, minutesSaved: 999 })).toMatch(/between/)
    expect(reviewProblem({ outcome: 'usable', reasonCode: null, minutesSaved: NaN })).toMatch(/between/)
  })
})

describe('applyDefaults', () => {
  it('takes only learnable settings, and only valid values', () => {
    const s = applyDefaults(DEFAULT_CLIENT, { id: 'd1', profileKey: 'flat/simple/clean', settings: { detail: 0.7, corners: 2, maxColors: 6, purpose: 'cut' } as never })
    expect(s.detail).toBe(0.7)
    expect(s.corners).toBe(DEFAULT_CLIENT.corners)
    expect(s.maxColors).toBe(6)
    expect(s.purpose).toBe(DEFAULT_CLIENT.purpose)
  })
  it('leaves the settings alone without defaults', () => {
    expect(applyDefaults(DEFAULT_CLIENT, null)).toBe(DEFAULT_CLIENT)
  })
})

describe('httpRunsApi', () => {
  it('posts runs as multipart, reviews as JSON, with the token', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 201 }))
    const api = httpRunsApi('https://svc.example/api/', { fetch, token: async () => 't0k' })
    const run = buildRun(facts, new Date(), 'run-9')
    await api.postRun(run, { original: new Blob(['x']), svg: '<svg/>' })
    await api.postReview('run-9', review)
    const calls = fetch.mock.calls as unknown as [string, RequestInit][]
    expect(calls[0][0]).toBe('https://svc.example/api/runs')
    expect(calls[0][1].body).toBeInstanceOf(FormData)
    expect((calls[0][1].headers as Record<string, string>).Authorization).toBe('Bearer t0k')
    expect(calls[1][0]).toBe('https://svc.example/api/runs/run-9/review')
    expect(JSON.parse(calls[1][1].body as string).outcome).toBe('touch-up')
  })
  it('says what failed when the service refuses', async () => {
    const api = httpRunsApi('https://svc.example', { fetch: async () => new Response(null, { status: 500 }) })
    await expect(api.postReview('r', review)).rejects.toThrow(/save the review \(500\)/)
  })
  it('treats missing or unreachable defaults as none', async () => {
    expect(await httpRunsApi('https://svc.example', { fetch: async () => new Response(null, { status: 404 }) }).getDefaults('k')).toBeNull()
    expect(await httpRunsApi('https://svc.example', { fetch: async () => Promise.reject(new Error('offline')) }).getDefaults('k')).toBeNull()
    const found = await httpRunsApi('https://svc.example', { fetch: async () => Response.json({ id: 'd7', settings: { detail: 0.6 } }) }).getDefaults('flat/medium/clean')
    expect(found).toEqual({ id: 'd7', profileKey: 'flat/medium/clean', settings: { detail: 0.6 } })
  })
})

describe('cleanLinks', () => {
  it('trims and upper-cases what the artist typed, and leaves out empty fields', () => {
    expect(cleanLinks({ logoId: ' bln000260748 ', caseNo: '', salesOrder: 'bar-so01505023' })).toEqual({ logoId: 'BLN000260748', salesOrder: 'BAR-SO01505023' })
    expect(cleanLinks({})).toEqual({})
  })
})

describe('localRunsApi', () => {
  it('keeps runs and reviews in the browser and exports them', async () => {
    const api = localRunsApi(memoryStorage())
    const run = buildRun(facts, new Date(), 'run-2')
    await api.postRun(run, { original: new Blob(), svg: '' })
    await api.postReview('run-2', review)
    const out = JSON.parse(api.exportRuns())
    expect(out).toHaveLength(1)
    expect(out[0].review.reasonCode).toBe('lost-detail')
    // The order the artist named is kept on the run too, so it can be found from the case.
    expect(out[0].run.links).toEqual({ caseNo: 'CAS-161569' })
    await expect(api.postReview('missing', review)).rejects.toThrow(/not found/)
  })
})
