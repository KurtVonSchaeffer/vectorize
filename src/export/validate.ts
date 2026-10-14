import { flatten, type ColorShape, type Pt } from './path'

/**
 * Geometry checks for print and cut files, on the shapes as they are written (not the file
 * syntax): what a printer's preflight or a cutter would trip over. Nothing here changes the
 * artwork; it reports, so a small but intended detail is never removed for being small.
 */

export interface ExportCheck {
  id: 'open' | 'zero-area' | 'self-intersection' | 'sliver' | 'small' | 'plate-overlap' | 'inks'
  /** fail: the file is broken for its use; warn: worth a look; ok: passed. */
  status: 'ok' | 'warn' | 'fail'
  count: number
  /** Plain words for the person downloading. */
  message: string
  /** Where (in artwork px), at most 20, for highlighting. */
  where: { x: number; y: number }[]
}

export interface ValidateOptions {
  /** Artwork width in its own units (px), and the output width it will be cut / printed at. */
  width: number
  outputWidthMm: number
  /** Narrower than this (mm) can't be cut or weeded reliably. Default 0.3. */
  minCutWidthMm?: number
  /** Pieces whose largest side is under this (mm) are hard to weed. Default 1. */
  minPieceMm?: number
  /** Print plates (knockout) must not overlap by more than this (px; the registration spread). Default 0.5. */
  overlapTolerance?: number
  /** Check that plates don't overlap (print / cut files made of knockout shapes). */
  plates?: boolean
}

interface Piece {
  color: number
  pts: Pt[]
  closed: boolean
}

export function validateShapes(shapes: ColorShape[], o: ValidateOptions): ExportCheck[] {
  const mm = o.outputWidthMm / o.width
  const minCut = o.minCutWidthMm ?? 0.3
  const minPiece = o.minPieceMm ?? 1
  const pieces: Piece[] = shapes.flatMap((s) => s.subpaths.map((sp) => ({ color: s.color, pts: flatten(sp, 0.1), closed: sp.closed })))
  const at = (p: Piece) => {
    const c = centroid(p.pts)
    return { x: +c[0].toFixed(1), y: +c[1].toFixed(1) }
  }
  const found = { open: [] as Piece[], zero: [] as Piece[], cross: [] as Piece[], sliver: [] as Piece[], small: [] as Piece[] }
  for (const p of pieces) {
    if (!p.closed) found.open.push(p)
    const a = Math.abs(polyArea(p.pts))
    const per = perimeter(p.pts)
    if (a < 1e-3) {
      found.zero.push(p)
      continue
    }
    if (selfIntersects(p.pts)) found.cross.push(p)
    // Mean width (twice area over perimeter) of the piece at output size.
    if (((2 * a) / per) * mm < minCut) found.sliver.push(p)
    const [x0, y0, x1, y1] = box(p.pts)
    if (Math.max(x1 - x0, y1 - y0) * mm < minPiece) found.small.push(p)
  }
  const list = (arr: Piece[]) => arr.slice(0, 20).map(at)
  const checks: ExportCheck[] = [
    { id: 'open', status: found.open.length ? 'fail' : 'ok', count: found.open.length, message: found.open.length ? `${found.open.length} outline(s) aren't closed; a cutter can't cut them out.` : 'All outlines are closed.', where: list(found.open) },
    { id: 'zero-area', status: found.zero.length ? 'fail' : 'ok', count: found.zero.length, message: found.zero.length ? `${found.zero.length} outline(s) enclose no area; they would cut as lines.` : 'No empty outlines.', where: list(found.zero) },
    { id: 'self-intersection', status: found.cross.length ? 'warn' : 'ok', count: found.cross.length, message: found.cross.length ? `${found.cross.length} outline(s) cross themselves.` : 'No outline crosses itself.', where: list(found.cross) },
    { id: 'sliver', status: found.sliver.length ? 'warn' : 'ok', count: found.sliver.length, message: found.sliver.length ? `${found.sliver.length} piece(s) are thinner than ${minCut} mm at ${o.outputWidthMm} mm wide: fine for print, too thin to cut.` : `Nothing thinner than ${minCut} mm at ${o.outputWidthMm} mm wide.`, where: list(found.sliver) },
    { id: 'small', status: found.small.length ? 'warn' : 'ok', count: found.small.length, message: found.small.length ? `${found.small.length} piece(s) are under ${minPiece} mm at ${o.outputWidthMm} mm wide: hard to weed when cut.` : `No piece under ${minPiece} mm at ${o.outputWidthMm} mm wide.`, where: list(found.small) },
  ]
  if (o.plates) {
    const overlap = plateOverlap(pieces, o.width, o.overlapTolerance ?? 0.5)
    checks.push({ id: 'plate-overlap', status: overlap.length ? 'warn' : 'ok', count: overlap.length, message: overlap.length ? `Colours overlap in ${overlap.length} place(s) by more than the registration spread.` : 'Colour plates meet without overlapping.', where: overlap.slice(0, 20) })
  }
  const inks = new Set(shapes.map((s) => s.color)).size
  checks.push({ id: 'inks', status: 'ok', count: inks, message: `${inks} ${inks === 1 ? 'colour' : 'colours'} (plates or layers).`, where: [] })
  return checks
}

function polyArea(pts: Pt[]): number {
  let a = 0
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]
    const q = pts[(i + 1) % pts.length]
    a += p[0] * q[1] - q[0] * p[1]
  }
  return a / 2
}

function perimeter(pts: Pt[]): number {
  let s = 0
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]
    const q = pts[(i + 1) % pts.length]
    s += Math.hypot(q[0] - p[0], q[1] - p[1])
  }
  return s
}

function box(pts: Pt[]): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const [x, y] of pts) {
    if (x < x0) x0 = x
    if (y < y0) y0 = y
    if (x > x1) x1 = x
    if (y > y1) y1 = y
  }
  return [x0, y0, x1, y1]
}

function centroid(pts: Pt[]): Pt {
  const [x0, y0, x1, y1] = box(pts)
  return [(x0 + x1) / 2, (y0 + y1) / 2]
}

/** Whether two non-adjacent edges of a closed polygon cross (touching ends don't count). */
export function selfIntersects(pts: Pt[]): boolean {
  const n = pts.length
  if (n < 4) return false
  const cross = (a: Pt, b: Pt, c: Pt) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
  // Edges sorted by left x, so only edges whose x-ranges overlap are compared.
  const edges = Array.from({ length: n }, (_, i) => {
    const a = pts[i]
    const b = pts[(i + 1) % n]
    return { i, a, b, x0: Math.min(a[0], b[0]), x1: Math.max(a[0], b[0]) }
  }).sort((p, q) => p.x0 - q.x0)
  for (let s = 0; s < n; s++) {
    const e = edges[s]
    for (let t = s + 1; t < n && edges[t].x0 <= e.x1; t++) {
      const f = edges[t]
      const d = Math.abs(e.i - f.i)
      if (d <= 1 || d === n - 1) continue
      const d1 = cross(e.a, e.b, f.a), d2 = cross(e.a, e.b, f.b), d3 = cross(f.a, f.b, e.a), d4 = cross(f.a, f.b, e.b)
      if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true
    }
  }
  return false
}

/**
 * Places where two different colours both cover a point, deeper than the registration spread:
 * each colour is rasterized (even-odd, at 1 px), and overlapping pixels that stay overlapping
 * after shrinking by the tolerance are grouped into places.
 */
function plateOverlap(pieces: Piece[], width: number, tolerance: number): { x: number; y: number }[] {
  const all = pieces.flatMap((p) => p.pts)
  if (!all.length) return []
  const [, , x1, y1] = box(all)
  const w = Math.max(1, Math.ceil(Math.max(width, x1)))
  const h = Math.max(1, Math.ceil(y1))
  const byColor = new Map<number, Piece[]>()
  for (const p of pieces) byColor.set(p.color, [...(byColor.get(p.color) ?? []), p])
  const count = new Uint8Array(w * h)
  for (const ps of byColor.values()) {
    const mask = rasterize(ps.map((p) => p.pts), w, h)
    for (let i = 0; i < w * h; i++) if (mask[i]) count[i]++
  }
  // Shrink the overlap by the tolerance (a 1 px overlap along every shared edge is the spread).
  const r = Math.max(1, Math.ceil(tolerance))
  const deep = new Uint8Array(w * h)
  for (let y = r; y < h - r; y++)
    for (let x = r; x < w - r; x++) {
      let all2 = true
      for (let dy = -r; dy <= r && all2; dy++) for (let dx = -r; dx <= r; dx++) if (count[(y + dy) * w + x + dx] < 2) { all2 = false; break }
      if (all2) deep[y * w + x] = 1
    }
  const out: { x: number; y: number }[] = []
  const seen = new Uint8Array(w * h)
  for (let p = 0; p < w * h; p++) {
    if (!deep[p] || seen[p]) continue
    const stack = [p]
    seen[p] = 1
    let sx = 0, sy = 0, n = 0
    while (stack.length) {
      const q = stack.pop()!
      const x = q % w, y = (q - x) / w
      sx += x
      sy += y
      n++
      for (const k of [q - 1, q + 1, q - w, q + w]) if (k >= 0 && k < w * h && deep[k] && !seen[k]) { seen[k] = 1; stack.push(k) }
    }
    out.push({ x: +(sx / n).toFixed(1), y: +(sy / n).toFixed(1) })
  }
  return out
}

/** Even-odd scanline fill of polygons at pixel centres. */
function rasterize(polys: Pt[][], w: number, h: number): Uint8Array {
  const m = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    const cy = y + 0.5
    const xs: number[] = []
    for (const poly of polys)
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i]
        const b = poly[(i + 1) % poly.length]
        if ((a[1] <= cy && b[1] > cy) || (b[1] <= cy && a[1] > cy)) xs.push(a[0] + ((cy - a[1]) / (b[1] - a[1])) * (b[0] - a[0]))
      }
    xs.sort((p, q) => p - q)
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const from = Math.max(0, Math.ceil(xs[k] - 0.5))
      const to = Math.min(w - 1, Math.floor(xs[k + 1] - 0.5))
      for (let x = from; x <= to; x++) m[y * w + x] ^= 1
    }
  }
  return m
}
