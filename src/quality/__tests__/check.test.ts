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
  it('is off unless switched on', () => {
    expect(qualityReportingOn('', undefined)).toBe(false)
    expect(qualityReportingOn('?quality-reporting=off', 'off')).toBe(false)
    expect(qualityReportingOn('', 'on')).toBe(true)
    expect(qualityReportingOn('?a=1&quality-reporting=on', undefined)).toBe(true)
  })
})
