import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Enhancer } from '../enhancer'

// A stand-in for the AI worker: answers each request with a 2× blank image when told to.
class FakeWorker {
  static all: FakeWorker[] = []
  onmessage: ((e: MessageEvent) => void) | null = null
  terminated = false
  requests: { id: number; width: number; height: number }[] = []
  constructor() {
    FakeWorker.all.push(this)
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
})
