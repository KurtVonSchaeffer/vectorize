import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FlatTracer } from '../flat-tracer'
import { JOB_TIMEOUT_MS, TimeoutError, Tracer } from '../tracer'

// A stand-in worker that answers only when told to (or never).
class FakeWorker {
  static all: FakeWorker[] = []
  onmessage: ((e: MessageEvent) => void) | null = null
  onerror: ((e: ErrorEvent) => void) | null = null
  terminated = false
  last: { id: number } | null = null
  constructor() {
    FakeWorker.all.push(this)
  }
  postMessage(msg: { id: number }) {
    this.last = msg
  }
  answer(data: object) {
    this.onmessage?.({ data: { id: this.last!.id, ...data } } as MessageEvent)
  }
  terminate() {
    this.terminated = true
  }
}

const image = { data: new Uint8ClampedArray(16), width: 2, height: 2 } as unknown as ImageData

describe('stuck jobs never leave the page waiting', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    FakeWorker.all = []
    vi.stubGlobal('Worker', FakeWorker)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('a trace that never answers fails with a timeout and its worker is replaced', async () => {
    const t = new Tracer()
    const job = t.trace(image, {} as never)
    vi.advanceTimersByTime(JOB_TIMEOUT_MS)
    await expect(job).rejects.toBeInstanceOf(TimeoutError)
    expect(FakeWorker.all[0].terminated).toBe(true)
    // The next job gets a fresh worker and works.
    const next = t.trace(image, {} as never)
    expect(FakeWorker.all).toHaveLength(2)
    FakeWorker.all[1].answer({ ok: true, svg: '<svg/>', ms: 1 })
    await expect(next).resolves.toMatchObject({ svg: '<svg/>' })
  })

  it('a trace that answers in time is not cut off later', async () => {
    const t = new Tracer()
    const job = t.trace(image, {} as never)
    FakeWorker.all[0].answer({ ok: true, svg: '<svg/>', ms: 1 })
    await expect(job).resolves.toMatchObject({ svg: '<svg/>' })
    vi.advanceTimersByTime(JOB_TIMEOUT_MS * 2)
    expect(FakeWorker.all[0].terminated).toBe(false)
  })

  it('the flat-colour pipeline times out the same way', async () => {
    const f = new FlatTracer()
    const job = f.run(image, {} as never)
    vi.advanceTimersByTime(JOB_TIMEOUT_MS - 1)
    expect(FakeWorker.all[0].terminated).toBe(false)
    vi.advanceTimersByTime(1)
    await expect(job).rejects.toBeInstanceOf(TimeoutError)
    expect(FakeWorker.all[0].terminated).toBe(true)
  })
})
