import { describe, expect, it } from 'vitest'
import type { FidelityReport } from '../fidelity'
import { runCheck } from '../check'
import { qualityReportingOn } from '../flags'

const report = { verdict: 'ready', issues: [] } as unknown as FidelityReport

describe('runCheck: every way a measurement can end', () => {
  it('a report becomes "checked"', async () => expect(await runCheck(async () => report, 1000)).toEqual({ state: 'checked', report }))

  it('an error becomes "not checked"', async () => expect(await runCheck(async () => Promise.reject(new Error('worker crashed')), 1000)).toEqual({ state: 'not-checked', reason: 'error' }))

  it('a throw becomes "not checked"', async () =>
    expect(
      await runCheck(() => {
        throw new Error('boom')
      }, 1000),
    ).toEqual({ state: 'not-checked', reason: 'error' }))

  it('a measurement that never answers times out, and is told to stop', async () => {
    let stopped = false
    const outcome = await runCheck((signal) => {
      signal.addEventListener('abort', () => (stopped = true))
      return new Promise<FidelityReport>(() => {})
    }, 30)
    expect(outcome).toEqual({ state: 'not-checked', reason: 'timeout' })
    expect(stopped).toBe(true)
  })

  it('a report that arrives after the time limit is ignored', async () => {
    const outcome = await runCheck(() => new Promise<FidelityReport>((ok) => setTimeout(() => ok(report), 80)), 20)
    expect(outcome).toEqual({ state: 'not-checked', reason: 'timeout' })
  })

  it('a malformed report becomes "not checked"', async () => {
    expect(await runCheck(async () => ({}) as FidelityReport, 1000)).toEqual({ state: 'not-checked', reason: 'error' })
    expect(await runCheck(async () => ({ verdict: 'approved', issues: [] }) as unknown as FidelityReport, 1000)).toEqual({ state: 'not-checked', reason: 'error' })
  })
})

describe('feature flag', () => {
  const prod = { value: undefined, dev: false }
  it('is off in a production build, whatever the address says', () => {
    expect(qualityReportingOn('', prod)).toBe(false)
    expect(qualityReportingOn('?quality-reporting=on', prod)).toBe(false)
    expect(qualityReportingOn('?quality-reporting=on', { value: 'off', dev: false })).toBe(false)
    expect(qualityReportingOn('?quality-reporting=on', { value: 'yes', dev: false })).toBe(false)
  })
  it('is on for everyone only when a build switches it on', () => expect(qualityReportingOn('', { value: 'on', dev: false })).toBe(true))
  it('lets the address switch it on only in preview builds and the local dev server', () => {
    expect(qualityReportingOn('?quality-reporting=on', { value: 'preview', dev: false })).toBe(true)
    expect(qualityReportingOn('', { value: 'preview', dev: false })).toBe(false)
    expect(qualityReportingOn('?a=1&quality-reporting=on', { value: undefined, dev: true })).toBe(true)
    expect(qualityReportingOn('', { value: undefined, dev: true })).toBe(false)
  })
})
