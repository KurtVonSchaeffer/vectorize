/**
 * Clean geometry, edges where two gradients meet exactly (gradientEdges with clean geometry): a
 * layer stacked between them must stay clear of their shared edge. Otherwise its outline, smoothed
 * on its own, reaches the edge and shows through as a hairline in browsers (the bird's pink line
 * along the blue feather).
 */
import { describe, expect, it } from 'vitest'
import type { GradientFill } from '../../palette/gradients'
import { traceLabels, type LabelMap } from '../index'

const W = 120, H = 80
const grad = (c0: number, c1: number): GradientFill => ({ kind: 'linear', x1: 0, y1: 0, x2: W, y2: 0, stops: [{ offset: 0, color: c0 }, { offset: 1, color: c1 }] })

/**
 * Navy gradient (largest, bottom), pink flat (middle), blue gradient (smallest, top): navy x 10–50,
 * blue 50–75, pink 75–110, rows 10–70. The navy/blue edge sits 0.4 px left of x 50: the pixels in
 * column 50 are blue with a 40% navy share, as gradientEdges leaves them.
 */
function map(): LabelMap {
  const labels = new Uint8Array(W * H).fill(255), second = new Uint8Array(W * H).fill(255), cov = new Float32Array(W * H).fill(1)
  for (let y = 10; y < 70; y++)
    for (let x = 10; x < 110; x++) {
      const p = y * W + x
      labels[p] = x < 50 ? 0 : x < 75 ? 2 : 1
      if (x === 50) {
        second[p] = 0
        cov[p] = 0.6
      }
    }
  return { w: W, h: H, labels, second, cov, colors: [0x2b3290, 0xd62771, 0x0c6cb0], fills: [grad(0x283290, 0x503ca0), undefined, grad(0x0a64aa, 0x1482c8)] }
}

/** Points of the pink path's outline, in rows away from the corners. */
function pinkOutline(svg: string): [number, number][] {
  const d = svg.match(/<path[^>]*fill="#D62771"[^>]*d="([^"]+)"|<path[^>]*d="([^"]+)"[^>]*fill="#D62771"/i)
  const path = d?.[1] ?? d?.[2] ?? ''
  const nums = path.match(/-?\d+(\.\d+)?/g)!.map(Number)
  const pts: [number, number][] = []
  for (let i = 0; i + 1 < nums.length; i += 2) if (nums[i + 1] > 15 && nums[i + 1] < 65) pts.push([nums[i], nums[i + 1]])
  return pts
}

describe('clean geometry: layers between two gradients that meet exactly', () => {
  const opts = { smoothing: 0.8, minArea: 1, error: 0.5, cornerAngle: 60, precision: 2, mode: 'stacked' as const }

  it('keep clear of the shared edge', () => {
    const { svg } = traceLabels(map(), { ...opts, connectedStacking: true })
    // Drawn navy, pink, blue: the pink extends under the blue (it touches it).
    const order = [...svg.matchAll(/<path[^>]*>/g)].map((m) => (/#D62771/i.test(m[0]) ? 'pink' : /url\(#/.test(m[0]) ? 'grad' : 'other'))
    expect(order.indexOf('pink')).toBeGreaterThan(order.indexOf('grad'))
    expect(order.lastIndexOf('grad')).toBeGreaterThan(order.indexOf('pink'))
    // The pink's outline stays at least half a pixel inside the blue's, never on it.
    const xs = (d: string) => d.match(/-?\d+(\.\d+)?/g)!.map(Number)
    const leftmost = (n: number[]) => { let m = Infinity; for (let i = 0; i + 1 < n.length; i += 2) if (n[i + 1] > 15 && n[i + 1] < 65) m = Math.min(m, n[i]); return m }
    const blue = [...svg.matchAll(/<path[^>]*>/g)].map((m) => m[0]).filter((t) => /url\(#/.test(t)).pop()!
    const pinkMin = Math.min(...pinkOutline(svg).map(([x]) => x))
    expect(pinkMin - leftmost(xs(blue.match(/ d="([^"]+)"/)![1]))).toBeGreaterThanOrEqual(0.5)
  })
})
