import type { GradientFill } from '../palette/gradients'

export type Pt = [number, number]
/** A closed or open subpath: a start point followed by line or cubic segments. */
export interface Subpath {
  start: Pt
  segs: ({ t: 'L'; p: Pt } | { t: 'C'; c1: Pt; c2: Pt; p: Pt })[]
  closed: boolean
}

/** One filled color from an SVG: its subpaths in absolute coordinates. */
export interface ColorShape {
  color: number
  subpaths: Subpath[]
  /** Filled with this gradient (`color` is then its average). */
  gradient?: GradientFill
}

/**
 * Parses SVG path data (M L H V C S Q T Z, absolute and relative) into absolute subpaths.
 * Quadratics become cubics; arcs aren't produced by either tracer and are rejected.
 */
export function parsePath(d: string, tx = 0, ty = 0): Subpath[] {
  const tokens = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) ?? []
  const out: Subpath[] = []
  let i = 0
  let cmd = ''
  let cur: Pt = [0, 0]
  let start: Pt = [0, 0]
  let sub: Subpath | null = null
  let lastCtrl: Pt | null = null
  let lastQuad: Pt | null = null
  const num = () => Number(tokens[i++])
  const isNum = () => i < tokens.length && !/[a-zA-Z]/.test(tokens[i])
  const ensure = () => {
    if (!sub) {
      sub = { start: [cur[0], cur[1]], segs: [], closed: false }
      out.push(sub)
    }
    return sub
  }
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i])) cmd = tokens[i++]
    else if (!cmd) {
      i++
      continue
    }
    const rel = cmd === cmd.toLowerCase()
    const C = cmd.toUpperCase()
    const ox = rel ? cur[0] : 0
    const oy = rel ? cur[1] : 0
    switch (C) {
      case 'M': {
        cur = [num() + ox, num() + oy]
        start = cur
        sub = { start: [cur[0], cur[1]], segs: [], closed: false }
        out.push(sub)
        cmd = rel ? 'l' : 'L' // further pairs are implicit line-tos
        lastCtrl = lastQuad = null
        break
      }
      case 'L':
        cur = [num() + ox, num() + oy]
        ensure().segs.push({ t: 'L', p: cur })
        lastCtrl = lastQuad = null
        break
      case 'H':
        cur = [num() + ox, cur[1]]
        ensure().segs.push({ t: 'L', p: cur })
        lastCtrl = lastQuad = null
        break
      case 'V':
        cur = [cur[0], num() + oy]
        ensure().segs.push({ t: 'L', p: cur })
        lastCtrl = lastQuad = null
        break
      case 'C': {
        const c1: Pt = [num() + ox, num() + oy]
        const c2: Pt = [num() + ox, num() + oy]
        cur = [num() + ox, num() + oy]
        ensure().segs.push({ t: 'C', c1, c2, p: cur })
        lastCtrl = c2
        lastQuad = null
        break
      }
      case 'S': {
        const c1: Pt = lastCtrl ? [2 * cur[0] - lastCtrl[0], 2 * cur[1] - lastCtrl[1]] : [cur[0], cur[1]]
        const c2: Pt = [num() + ox, num() + oy]
        cur = [num() + ox, num() + oy]
        ensure().segs.push({ t: 'C', c1, c2, p: cur })
        lastCtrl = c2
        lastQuad = null
        break
      }
      case 'Q':
      case 'T': {
        const q: Pt = C === 'Q' ? [num() + ox, num() + oy] : lastQuad ? [2 * cur[0] - lastQuad[0], 2 * cur[1] - lastQuad[1]] : [cur[0], cur[1]]
        const p: Pt = [num() + ox, num() + oy]
        const c1: Pt = [cur[0] + (2 / 3) * (q[0] - cur[0]), cur[1] + (2 / 3) * (q[1] - cur[1])]
        const c2: Pt = [p[0] + (2 / 3) * (q[0] - p[0]), p[1] + (2 / 3) * (q[1] - p[1])]
        ensure().segs.push({ t: 'C', c1, c2, p })
        cur = p
        lastQuad = q
        lastCtrl = null
        break
      }
      case 'Z':
        if (sub) (sub as Subpath).closed = true
        cur = start
        sub = null
        lastCtrl = lastQuad = null
        break
      default:
        throw new Error(`Unsupported path command "${cmd}"`)
    }
    // Repeated argument groups ("C … … C … …" written as "C … … … …") reuse `cmd` on the
    // next pass, since a number token doesn't change it.
    if (C === 'Z' && isNum()) cmd = ''
  }
  if (tx || ty) for (const s of out) translate(s, tx, ty)
  return out.filter((s) => s.segs.length > 0)
}

function translate(s: Subpath, tx: number, ty: number) {
  const m = (p: Pt): Pt => [p[0] + tx, p[1] + ty]
  s.start = m(s.start)
  s.segs = s.segs.map((g) => (g.t === 'L' ? { t: 'L', p: m(g.p) } : { t: 'C', c1: m(g.c1), c2: m(g.c2), p: m(g.p) }))
}

/** Reads every filled <path> from an SVG string (as written by our tracer or VTracer). */
export function shapesFromSvg(svg: string): ColorShape[] {
  const gradients = gradientsFromSvg(svg)
  const shapes: ColorShape[] = []
  for (const m of svg.matchAll(/<path\b([^>]*)\/?>/g)) {
    const attrs = m[1]
    const d = attrs.match(/\sd="([^"]*)"/)?.[1]
    const fill = attrs.match(/\sfill="#([0-9a-fA-F]{6})"/)?.[1]
    const gradient = gradients.get(attrs.match(/\sfill="url\(#([^)"]+)\)"/)?.[1] ?? '')
    if (!d || (!fill && !gradient)) continue
    const t = attrs.match(/translate\(\s*(-?[\d.]+)[ ,]+(-?[\d.]+)\s*\)/)
    const subpaths = parsePath(d, t ? Number(t[1]) : 0, t ? Number(t[2]) : 0)
    if (!subpaths.length) continue
    if (gradient) shapes.push({ color: averageColor(gradient), subpaths, gradient })
    else shapes.push({ color: parseInt(fill!, 16), subpaths })
  }
  return shapes
}

/** The <linearGradient>/<radialGradient> definitions our tracer writes (userSpaceOnUse), by id. */
function gradientsFromSvg(svg: string): Map<string, GradientFill> {
  const out = new Map<string, GradientFill>()
  for (const m of svg.matchAll(/<(linear|radial)Gradient\b([^>]*)>([\s\S]*?)<\/\1Gradient>/g)) {
    const attr = (k: string) => Number(m[2].match(new RegExp(`\\s${k}="(-?[\\d.e-]+)"`))?.[1] ?? 0)
    const id = m[2].match(/\sid="([^"]+)"/)?.[1]
    if (!id) continue
    const stops = [...m[3].matchAll(/<stop\b[^>]*offset="([\d.]+)"[^>]*stop-color="#([0-9a-fA-F]{6})"/g)].map((s) => ({ offset: Number(s[1]), color: parseInt(s[2], 16) }))
    if (!stops.length) continue
    out.set(id, m[1] === 'linear' ? { kind: 'linear', x1: attr('x1'), y1: attr('y1'), x2: attr('x2'), y2: attr('y2'), stops } : { kind: 'radial', cx: attr('cx'), cy: attr('cy'), r: attr('r'), stops })
  }
  return out
}

function averageColor(g: GradientFill): number {
  const c = [0, 1, 2].map((k) => g.stops.reduce((s, st) => s + ((st.color >> (16 - 8 * k)) & 255), 0) / g.stops.length)
  return (Math.round(c[0]) << 16) | (Math.round(c[1]) << 8) | Math.round(c[2])
}

/** Flattens a subpath into a polyline, with curve steps no longer than `tol` units of chord error. */
export function flatten(s: Subpath, tol: number): Pt[] {
  const pts: Pt[] = [s.start]
  let cur = s.start
  for (const g of s.segs) {
    if (g.t === 'L') pts.push(g.p)
    else {
      const len = dist(cur, g.c1) + dist(g.c1, g.c2) + dist(g.c2, g.p)
      const n = Math.min(64, Math.max(2, Math.ceil(Math.sqrt(len / Math.max(tol, 1e-3)))))
      for (let k = 1; k <= n; k++) {
        const t = k / n
        const mt = 1 - t
        pts.push([
          mt ** 3 * cur[0] + 3 * mt * mt * t * g.c1[0] + 3 * mt * t * t * g.c2[0] + t ** 3 * g.p[0],
          mt ** 3 * cur[1] + 3 * mt * mt * t * g.c1[1] + 3 * mt * t * t * g.c2[1] + t ** 3 * g.p[1],
        ])
      }
    }
    cur = g.p
  }
  return pts
}

const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1])
