import { describe, expect, it } from 'vitest'
import type { Detection } from '../detect'
import { betterOffer, compressionRipple, COMPRESSED_RIPPLE, isImprovement, isLossy, worthSharpening, type Scored } from '../improve'

const r = (score: number, segments: number, more: Partial<Scored> = {}): Scored => ({ score, segments, edgeF1: 0.95, colours: 3, ...more })
const det = (patch: Partial<Detection> = {}): Detection => ({ kind: 'flat', hasAlpha: false, background: null, gradients: 0, fine: 0.2, ...patch })

describe('isImprovement', () => {
  it('offers an alternative only when it at least halves the score', () => {
    expect(isImprovement(r(10, 100), r(4, 120))).toBe(true)
    expect(isImprovement(r(10, 100), r(6, 120))).toBe(false)
  })

  it('ignores tiny differences on results that are already clean', () => {
    expect(isImprovement(r(0.4, 100), r(0.15, 100))).toBe(false)
    expect(isImprovement(r(0.8, 100), r(0.3, 100))).toBe(true)
  })

  it('refuses alternatives with extra colours or worse edges', () => {
    expect(isImprovement(r(4, 100), r(1, 110, { colours: 4 }))).toBe(false)
    expect(isImprovement(r(4, 100), r(1, 110, { edgeF1: 0.9 }))).toBe(false)
    expect(isImprovement(r(4, 100), r(1, 110, { edgeF1: 0.945 }))).toBe(true)
  })

  it('refuses alternatives that more than double the segments (traced compression blocks or noise)', () => {
    // Measured cases: AI sharpening of a 120 px JPEG badge (2.79 → 0.99 against the upload, worse
    // in truth, 196 → 638 segments) and of 3 px strokes in a PNG (36 → 351 segments, worse in truth).
    expect(isImprovement(r(2.79, 196), r(0.99, 638))).toBe(false)
    expect(isImprovement(r(1.51, 36, { colours: 2 }), r(0.25, 351, { colours: 3 }))).toBe(false)
    expect(isImprovement(r(2.73, 250), r(0.6, 480))).toBe(true)
  })
})

describe('betterOffer', () => {
  it('replaces the offer so far only with an improvement that scores lower', () => {
    const first = r(10, 100)
    expect(betterOffer(first, r(4, 120))).toBe(true)
    expect(betterOffer(first, r(3, 120), 4)).toBe(true)
    expect(betterOffer(first, r(4, 120), 4)).toBe(false)
    expect(betterOffer(first, r(6, 120), Infinity)).toBe(false)
  })
})

describe('isLossy', () => {
  it('treats JPEG and WebP as lossy, PNG, GIF and SVG as exact', () => {
    for (const n of ['logo.jpg', 'LOGO.JPEG', 'a.webp', 'b.jfif']) expect(isLossy(n)).toBe(true)
    for (const n of ['logo.png', 'icon.gif', 'mark.svg', 'noextension']) expect(isLossy(n)).toBe(false)
  })
})

describe('worthSharpening', () => {
  it('tries AI sharpening on small images and fine-stroke artwork only', () => {
    expect(worthSharpening(det(), 240, 160)).toBe(true)
    expect(worthSharpening(det(), 1200, 800)).toBe(false)
    expect(worthSharpening(det({ fine: 0.9 }), 1200, 800)).toBe(true)
    expect(worthSharpening(det({ kind: 'photo' }), 240, 160)).toBe(false)
    expect(worthSharpening(det({ kind: 'pixel' }), 32, 32)).toBe(false)
  })
})

describe('compressionRipple', () => {
  class FakeImageData {
    constructor(
      public data: Uint8ClampedArray,
      public width: number,
      public height: number,
    ) {}
  }
  const img = (w: number, h: number, f: (x: number, y: number) => number) => {
    const d = new Uint8ClampedArray(w * h * 4)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d.set([f(x, y), f(x, y), f(x, y), 255], (y * w + x) * 4)
    return new FakeImageData(d, w, h) as unknown as ImageData
  }
  // A dark square on white with a 2 px anti-aliased ramp.
  const edge = (x: number, y: number) => {
    const t = Math.min(1, Math.max(0, (Math.min(x, y) - 20) / 2))
    return 255 - 200 * t
  }

  it('reads clean anti-aliased edges as uncompressed', () => {
    expect(compressionRipple(img(64, 64, edge))).toBeLessThan(COMPRESSED_RIPPLE)
    expect(compressionRipple(img(64, 64, () => 200))).toBe(0)
  })

  it('finds the ripples JPEG ringing leaves around edges', () => {
    // The same edge with a decaying ±3 ripple beside it.
    const rung = (x: number, y: number) => {
      const dist = Math.abs(Math.min(x, y) - 20)
      return edge(x, y) + (dist < 6 ? (dist % 2 ? 3 : -3) : 0)
    }
    expect(compressionRipple(img(64, 64, rung))).toBeGreaterThan(COMPRESSED_RIPPLE)
  })
})
