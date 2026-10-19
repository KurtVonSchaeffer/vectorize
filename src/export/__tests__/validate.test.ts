import { describe, expect, it } from 'vitest'
import type { ColorShape, Pt, Subpath } from '../path'
import { selfIntersects, validateShapes } from '../validate'

const poly = (pts: Pt[], closed = true): Subpath => ({ start: pts[0], segs: pts.slice(1).map((p) => ({ t: 'L' as const, p })), closed })
const rect = (x: number, y: number, w: number, h: number) => poly([[x, y], [x + w, y], [x + w, y + h], [x, y + h]])
const shape = (color: number, ...subpaths: Subpath[]): ColorShape => ({ color, subpaths })
// 200 px artwork output at 200 mm: 1 px = 1 mm.
const opts = { width: 200, outputWidthMm: 200 }
const status = (shapes: ColorShape[], id: string, o = {}) => validateShapes(shapes, { ...opts, ...o }).find((c) => c.id === id)!

describe('validateShapes', () => {
  it('passes clean closed shapes', () => {
    const checks = validateShapes([shape(0xff0000, rect(10, 10, 50, 50)), shape(0x0000ff, rect(60, 10, 50, 50))], { ...opts, plates: true })
    expect(checks.filter((c) => c.status !== 'ok')).toEqual([])
    expect(checks.find((c) => c.id === 'inks')!.count).toBe(2)
  })
  it('fails open outlines and empty ones', () => {
    expect(status([shape(0, poly([[0, 0], [10, 0], [10, 10]], false))], 'open').status).toBe('fail')
    expect(status([shape(0, poly([[0, 0], [10, 0], [20, 0]]))], 'zero-area').status).toBe('fail')
  })
  it('finds an outline crossing itself', () => {
    expect(selfIntersects([[0, 0], [10, 10], [10, 0], [0, 10]])).toBe(true)
    expect(selfIntersects([[0, 0], [10, 0], [10, 10], [0, 10]])).toBe(false)
  })
  it('warns about pieces too thin or too small to cut, without failing them', () => {
    const thin = status([shape(0, rect(10, 10, 50, 0.2))], 'sliver')
    expect(thin.status).toBe('warn')
    expect(thin.count).toBe(1)
    expect(status([shape(0, rect(10, 10, 0.6, 0.6))], 'small').status).toBe('warn')
    // At 1,000 mm wide the same 0.6 px piece is 3 mm: fine.
    expect(status([shape(0, rect(10, 10, 0.6, 0.6))], 'small', { outputWidthMm: 1000 }).status).toBe('ok')
  })
  it('finds plates that overlap beyond the registration spread', () => {
    const overlapping = validateShapes([shape(0xff0000, rect(10, 10, 50, 50)), shape(0x0000ff, rect(40, 10, 50, 50))], { ...opts, plates: true })
    expect(overlapping.find((c) => c.id === 'plate-overlap')!.status).toBe('warn')
  })
})
