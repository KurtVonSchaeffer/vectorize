import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Enhancer, IDLE_RELEASE_MS } from '../enhancer'

// A stand-in for the AI worker: answers each request with a 2× blank image when told to.
class FakeWorker {
  static all: FakeWorker[] = []
  static failNext = false
  onmessage: ((e: MessageEvent) => void) | null = null
  onerror: ((e: ErrorEvent) => void) | null = null
  terminated = false
  requests: { id: number; width: number; height: number }[] = []
  constructor() {
    if (FakeWorker.failNext) {
      FakeWorker.failNext = false
      throw new Error('blocked')
    }
    FakeWorker.all.push(this)
  }
  crash() {
    this.onerror?.({ message: 'out of memory', preventDefault() {} } as unknown as ErrorEvent)
  }
  postMessage(msg: { id: number; width: number; height: number }) {
    this.requests.push(msg)
  }
  finish() {
    const r = this.requests.shift()!
    const w = r.width * 2
    const h = r.height * 2
    this.onmessage?.({ data: { type: 'done', id: r.id, pixels: new ArrayBuffer(w * h * 4), width: w, height: h } } as MessageEvent)
  }
  terminate() {
    this.terminated = true
  }
}

class FakeImageData {
  constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
}

const img = (n: number) => new FakeImageData(new Uint8ClampedArray(n * n * 4), n, n) as unknown as ImageData

describe('Enhancer idle release', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    FakeWorker.all = []
    FakeWorker.failNext = false
    vi.stubGlobal('Worker', FakeWorker)
    vi.stubGlobal('ImageData', FakeImageData)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('starts the worker only when needed and stops it after being idle', async () => {
    const e = new Enhancer(1000)
    expect(FakeWorker.all).toHaveLength(0)
    const job = e.upscale('a', img(10), '2x')
    const w = FakeWorker.all[0]
    w.finish()
    expect((await job)!.width).toBe(20)
    vi.advanceTimersByTime(999)
    expect(w.terminated).toBe(false)
    vi.advanceTimersByTime(1)
    expect(w.terminated).toBe(true)
  })

  it('never stops the worker while a job is running, and restarts it for the next one', async () => {
    const e = new Enhancer(1000)
    const first = e.upscale('a', img(10), '2x')
    const second = e.upscale('b', img(12), '2x')
    const w = FakeWorker.all[0]
    w.finish()
    await first
    vi.advanceTimersByTime(5000)
    expect(w.terminated).toBe(false)
    w.finish()
    await second
    vi.advanceTimersByTime(1000)
    expect(w.terminated).toBe(true)
    const third = e.upscale('c', img(8), '2x')
    expect(FakeWorker.all).toHaveLength(2)
    FakeWorker.all[1].finish()
    expect((await third)!.width).toBe(16)
  })

  it('a new job cancels the pending release', async () => {
    const e = new Enhancer(1000)
    const first = e.upscale('a', img(10), '2x')
    FakeWorker.all[0].finish()
    await first
    vi.advanceTimersByTime(900)
    const second = e.upscale('b', img(10), '2x')
    vi.advanceTimersByTime(900)
    expect(FakeWorker.all[0].terminated).toBe(false)
    FakeWorker.all[0].finish()
    await second
    expect(FakeWorker.all).toHaveLength(1)
  })

  it('serves cached results without starting the worker again', async () => {
    const e = new Enhancer(1000)
    const first = e.upscale('a', img(10), '2x')
    FakeWorker.all[0].finish()
    await first
    vi.advanceTimersByTime(1000)
    expect(await e.upscale('a', img(10), '2x')).toBe(await first)
    expect(FakeWorker.all).toHaveLength(1)
  })

  it('stops the worker after 5 minutes idle by default, and the timer restarts when a job finishes', async () => {
    expect(IDLE_RELEASE_MS).toBe(5 * 60_000)
    const e = new Enhancer()
    const first = e.upscale('a', img(10), '2x')
    FakeWorker.all[0].finish()
    await first
    vi.advanceTimersByTime(4 * 60_000)
    const second = e.upscale('b', img(10), '2x')
    vi.advanceTimersByTime(10 * 60_000)
    expect(FakeWorker.all[0].terminated).toBe(false)
    FakeWorker.all[0].finish()
    await second
    vi.advanceTimersByTime(5 * 60_000 - 1)
    expect(FakeWorker.all[0].terminated).toBe(false)
    vi.advanceTimersByTime(1)
    expect(FakeWorker.all[0].terminated).toBe(true)
  })

  it('keeps one worker through a run of uploads and stops it only after the last', async () => {
    const e = new Enhancer(1000)
    const jobs = [1, 2, 3, 4, 5].map((n) => e.upscale(`img${n}`, img(10 + n), '2x'))
    const w = FakeWorker.all[0]
    for (const job of jobs) {
      vi.advanceTimersByTime(2000)
      expect(w.terminated).toBe(false)
      w.finish()
      await job
    }
    expect(FakeWorker.all).toHaveLength(1)
    vi.advanceTimersByTime(1000)
    expect(w.terminated).toBe(true)
  })

  it('fails the running jobs when the worker crashes, and starts a fresh worker next time', async () => {
    const e = new Enhancer(1000)
    const job = e.upscale('a', img(10), '2x')
    FakeWorker.all[0].crash()
    await expect(job).rejects.toThrow('out of memory')
    expect(FakeWorker.all[0].terminated).toBe(true)
    const retry = e.upscale('a', img(10), '2x')
    expect(FakeWorker.all).toHaveLength(2)
    FakeWorker.all[1].finish()
    expect((await retry)!.width).toBe(20)
  })

  it('reports a worker that cannot start, and tries again on the next request', async () => {
    const e = new Enhancer(1000)
    FakeWorker.failNext = true
    await expect(e.upscale('a', img(10), '2x')).rejects.toThrow('blocked')
    const retry = e.upscale('a', img(10), '2x')
    FakeWorker.all[0].finish()
    expect((await retry)!.width).toBe(20)
  })

  it('cancelled work is rejected, and a stopped worker can never answer a newer request', async () => {
    const e = new Enhancer(1000)
    const old = e.upscale('old', img(10), '2x')
    const stale = FakeWorker.all[0]
    e.dispose()
    await expect(old).rejects.toThrow('disposed')
    const fresh = e.upscale('new', img(12), '2x')
    expect(FakeWorker.all).toHaveLength(2)
    // The stopped worker replies late with the same id the new request might have used.
    stale.requests = [{ id: FakeWorker.all[1].requests[0].id, width: 10, height: 10 }]
    stale.finish()
    FakeWorker.all[1].finish()
    expect((await fresh)!.width).toBe(24)
  })
})
