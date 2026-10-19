import { deltaE2000, rgbToLab } from '../palette/color'
import type { LabelMap } from '../trace'

/**
 * One-colour artwork from a colour map. Every region the artwork is drawn with becomes the ink,
 * except regions in the paper's colour (a white star on a teal badge, the counters of letters),
 * which stay open, so negative space survives. Regions keep their own outlines, so the master
 * vector still has every internal boundary as an editable edge, all in one ink.
 *
 * A production file (print plate, cut file) can also get a separation gap: a strip of paper
 * along every boundary between two regions that were different colours, so the bird's wing and
 * body still read as two shapes. The gap is never applied to the master, and is cut only where
 * both sides are wide enough to lose it: next to a thin piece (a stripe, a streak inside a
 * letter) the boundary stays joined and is flagged, since cutting either side would eat detail.
 *
 * The gap must not make the file harder to cut: where it leaves a piece the export checker rejects,
 * it is undone there (see runFlat) and the boundary flagged.
 *
 * In a production file all the ink is one piece wherever it touches: a boundary that got no gap
 * is not a cut line, and a thin former-colour stripe is part of the piece around it, not a sliver
 * of its own. The master keeps every former colour as its own shape.
 */

export interface OneColourOptions {
  /** The ink, 0xRRGGBB. */
  ink: number
  /** Separation gap between regions that were different colours, in map px. 0: none (master). A print / cut file gets at least MIN_GAP_PX. */
  gapPx: number
  /** Regions closer than this (ΔE2000) to the paper colour are paper. Default 15. */
  paperDelta?: number
  /** A print / cut file: trace all the ink as one colour, so touching ink is one piece. */
  production?: boolean
  /** Print / cut files: the width (mm) they're made at, for the export checker. */
  outputWidthMm?: number
}

export interface OneColourFlag {
  x: number
  y: number
  /**
   * gap-skipped: a side of this boundary is too thin to lose the gap, so it stays joined.
   * cut-limit: the gap left a piece the export checker rejects (too thin, too small, crossing
   * itself), so it was undone there.
   * gap-sliver: a sliver of another colour no wider than the gap, along a boundary that got a gap,
   * became part of the gap.
   */
  reason: 'gap-skipped' | 'cut-limit' | 'gap-sliver'
}

export interface OneColourResult {
  map: LabelMap
  /** Print / cut files: what's needed to undo the gap in places. */
  undo?: GapUndo
  /** Labels drawn in the ink, and labels left open as paper. */
  ink: number[]
  paper: number[]
  /** Boundaries that got a gap. */
  gaps: number
  flags: OneColourFlag[]
}

/** No shape (paper), as in LabelMap. */
const EMPTY = 254
/** A region that would lose more than this share of its area to symmetric gaps is kept whole. */
const MAX_LOSS = 0.35
/**
 * The narrowest gap a print / cut file gets, in map px. Narrower, the gap only thins the ink along
 * a boundary: both sides keep partial ink, are merged into one piece and traced as one, so nothing
 * is cut apart.
 */
export const MIN_GAP_PX = 1.5

/** The gap a print / cut file actually gets for a requested gap (0: none). */
export const productionGapPx = (gapPx: number) => (gapPx > 0 ? Math.max(MIN_GAP_PX, gapPx) : 0)

const labOf = (c: number) => rgbToLab([(c >> 16) & 255, (c >> 8) & 255, c & 255])

export function toOneColour(map: LabelMap, bgLabel: number, o: OneColourOptions): OneColourResult {
  const { w, h, labels, colors } = map
  const n = w * h
  const area = new Float64Array(colors.length)
  for (let p = 0; p < n; p++) if (labels[p] < EMPTY) area[labels[p]]++
  const paperColor = bgLabel >= 0 && colors[bgLabel] >= 0 ? colors[bgLabel] : 0xffffff
  const paperLab = labOf(paperColor)
  const candidates = colors.map((_, l) => l).filter((l) => l !== bgLabel && colors[l] >= 0 && area[l] > 0)
  let ink = candidates.filter((l) => deltaE2000(labOf(colors[l]), paperLab) >= (o.paperDelta ?? 15))
  // Never an empty result: artwork that is all near the paper colour is still the artwork.
  if (!ink.length) ink = candidates
  const isInk = new Uint8Array(Math.max(colors.length, 256))
  for (const l of ink) isInk[l] = 1
  const paper = candidates.filter((l) => !isInk[l])

  const out: LabelMap = {
    ...map,
    colors: colors.map((c, l) => (isInk[l] ? o.ink : l === bgLabel ? c : paper.includes(l) ? -1 : c)),
    fills: map.fills?.map((f, l) => (isInk[l] ? undefined : f)),
  }
  const gapPx = o.production ? productionGapPx(o.gapPx) : o.gapPx
  const cut = gapPx > 0 && ink.length >= 2 ? carveGaps(out, isInk, bgLabel, gapPx) : { map: out, gaps: 0, flags: [] }
  if (!o.production) return { ...cut, ink, paper }
  return { ...cut, map: onePiecePerInk(cut.map, isInk), ink, paper, undo: { carved: cut.map, plain: out, isInk } }
}

/** What a print / cut file needs to undo its gap in places (see undoGaps). */
export interface GapUndo {
  /** Before merging the ink into pieces: with the gaps cut, and without. */
  carved: LabelMap
  plain: LabelMap
  isInk: Uint8Array
}

/**
 * The gaps undone within each area (a piece the export checker rejects, plus `margin` map px),
 * then the ink merged into pieces again. Returns the new map and the new state.
 */
export function undoGaps(u: GapUndo, areas: [number, number, number, number][], margin: number): { map: LabelMap; undo: GapUndo } {
  const { w, h } = u.carved
  const labels = u.carved.labels.slice(), second = u.carved.second.slice(), cov = u.carved.cov.slice()
  for (const [x0, y0, x1, y1] of areas)
    for (let y = Math.max(0, Math.floor(y0 - margin)); y <= Math.min(h - 1, Math.ceil(y1 + margin)); y++)
      for (let x = Math.max(0, Math.floor(x0 - margin)); x <= Math.min(w - 1, Math.ceil(x1 + margin)); x++) {
        const p = y * w + x
        ;[labels[p], second[p], cov[p]] = [u.plain.labels[p], u.plain.second[p], u.plain.cov[p]]
      }
  const carved = { ...u.carved, labels, second, cov }
  return { map: onePiecePerInk(carved, u.isInk), undo: { ...u, carved } }
}

/** Whether any pixel within an area (plus `margin` map px) is part of a cut gap. */
export function nearGap(u: GapUndo, [x0, y0, x1, y1]: [number, number, number, number], margin: number): boolean {
  const { w, h } = u.carved
  for (let y = Math.max(0, Math.floor(y0 - margin)); y <= Math.min(h - 1, Math.ceil(y1 + margin)); y++)
    for (let x = Math.max(0, Math.floor(x0 - margin)); x <= Math.min(w - 1, Math.ceil(x1 + margin)); x++) {
      const p = y * w + x
      if (u.carved.labels[p] !== u.plain.labels[p] || u.carved.cov[p] !== u.plain.cov[p]) return true
    }
  return false
}

/**
 * Each connected piece of ink takes one label (the one most of it has), so the tracer draws touching
 * ink as one piece. Separate pieces keep the label they mostly had, so lettering and other separate
 * shapes are traced exactly as before.
 */
function onePiecePerInk(map: LabelMap, isInk: Uint8Array): LabelMap {
  const { w, h } = map
  const n = w * h
  const labels = map.labels.slice(), second = map.second.slice(), cov = map.cov.slice()
  const ink = (l: number) => l < EMPTY && isInk[l] === 1
  // A pixel is part of a piece when any share of it is ink (a 1 px stroke is often mostly ink in
  // pixels whose larger share is paper).
  const touches = (p: number) => ink(map.labels[p]) || (ink(map.second[p]) && map.cov[p] < 1)
  const seen = new Uint8Array(n)
  for (let s = 0; s < n; s++) {
    if (seen[s] || !touches(s)) continue
    const px: number[] = []
    const votes = new Map<number, number>()
    const stack = [s]
    seen[s] = 1
    while (stack.length) {
      const p = stack.pop()!
      px.push(p)
      if (ink(map.labels[p])) votes.set(map.labels[p], (votes.get(map.labels[p]) ?? 0) + map.cov[p])
      if (ink(map.second[p])) votes.set(map.second[p], (votes.get(map.second[p]) ?? 0) + 1 - map.cov[p])
      const x = p % w
      for (const q of [x > 0 ? p - 1 : -1, x + 1 < w ? p + 1 : -1, p - w, p + w])
        if (q >= 0 && q < n && !seen[q] && touches(q)) {
          seen[q] = 1
          stack.push(q)
        }
    }
    const to = [...votes].sort((a, b) => b[1] - a[1])[0][0]
    for (const p of px) {
      const a = ink(labels[p]), b = ink(second[p])
      if (a) labels[p] = to
      if (b) second[p] = to
      // An edge between two former colours is now inside the ink.
      if (a && b) [second[p], cov[p]] = [255, 1]
    }
  }
  return { ...map, labels, second, cov }
}

function carveGaps(map: LabelMap, isInk: Uint8Array, bgLabel: number, gapPx: number): { map: LabelMap; gaps: number; flags: OneColourFlag[] } {
  const { w, h, labels } = map
  const n = w * h
  const fill = bgLabel >= 0 && map.colors[bgLabel] >= 0 ? bgLabel : EMPTY
  // Regions are connected pieces of one ink label: a colour used in many places (black lettering
  // and a black wing) is judged piece by piece, so a thin stroke is thin even if its colour isn't.
  const comp = new Int32Array(n).fill(-1)
  const pieces: { label: number; px: number[]; x0: number; y0: number; x1: number; y1: number }[] = []
  for (let s = 0; s < n; s++) {
    const l = labels[s]
    if (comp[s] >= 0 || l >= EMPTY || !isInk[l]) continue
    const id = pieces.length
    const piece = { label: l, px: [] as number[], x0: w, y0: h, x1: -1, y1: -1 }
    pieces.push(piece)
    const stack = [s]
    comp[s] = id
    while (stack.length) {
      const p = stack.pop()!
      const x = p % w, y = (p / w) | 0
      piece.px.push(p)
      if (x < piece.x0) piece.x0 = x
      if (x > piece.x1) piece.x1 = x
      if (y < piece.y0) piece.y0 = y
      if (y > piece.y1) piece.y1 = y
      for (const q of [x > 0 ? p - 1 : -1, x + 1 < w ? p + 1 : -1, y > 0 ? p - w : -1, y + 1 < h ? p + w : -1])
        if (q >= 0 && comp[q] < 0 && labels[q] === l) {
          comp[q] = id
          stack.push(q)
        }
    }
  }
  const N = pieces.length
  const key = (a: number, b: number) => (a < b ? a * N + b : b * N + a)
  // Shared boundary length per pair of pieces; a few pixels of contact is noise, not a boundary.
  const shared = new Map<number, { len: number; sx: number; sy: number }>()
  const touch = (p: number, q: number) => {
    const a = comp[p], b = comp[q]
    if (a < 0 || b < 0 || a === b) return
    const k = key(a, b)
    const s = shared.get(k) ?? { len: 0, sx: 0, sy: 0 }
    s.len++
    s.sx += p % w
    s.sy += (p / w) | 0
    shared.set(k, s)
  }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = y * w + x
      if (x + 1 < w) touch(p, p + 1)
      if (y + 1 < h) touch(p, p + w)
    }
  const minLen = Math.max(4, 3 * gapPx)
  const real = (a: number, b: number) => (shared.get(key(a, b))?.len ?? 0) >= minLen
  const half = gapPx / 2
  const near = new Set<number>()
  for (const [k, s] of shared) if (s.len >= minLen) [near.add(Math.floor(k / N)), near.add(k % N)]

  // Ink kept in a pixel `db` from a boundary, when `cut` px of gap is taken from this side.
  const keep = (db: number, cut: number) => Math.min(1, Math.max(0, db - cut + 0.5))
  /** Per pixel of piece `a`: distance to its boundary with the pieces `ok` accepts. */
  const distances = (a: number, ok: (b: number) => boolean) => {
    const pc = pieces[a]
    const x0 = pc.x0, y0 = pc.y0, bw = pc.x1 - pc.x0 + 1, bh = pc.y1 - pc.y0 + 1
    const seed = new Uint8Array(bw * bh)
    let any = false
    for (const p of pc.px) {
      const x = p % w, y = (p / w) | 0
      for (const q of [x > 0 ? p - 1 : -1, x + 1 < w ? p + 1 : -1, y > 0 ? p - w : -1, y + 1 < h ? p + w : -1]) {
        const b = q >= 0 ? comp[q] : -1
        if (b >= 0 && b !== a && ok(b) && real(a, b)) {
          seed[(y - y0) * bw + (x - x0)] = 1
          any = true
          break
        }
      }
    }
    // The boundary lies half a pixel beyond the seed pixels' centres.
    const d2 = any ? edt(seed, bw, bh) : null
    return { at: (p: number) => (d2 ? Math.sqrt(d2[(((p / w) | 0) - y0) * bw + ((p % w) - x0)]) + 0.5 : Infinity), any }
  }

  // Pass 1: the share of each piece a symmetric gap would remove.
  const thin = new Uint8Array(N)
  for (const a of near) {
    const d = distances(a, () => true)
    let lost = 0
    for (const p of pieces[a].px) lost += 1 - keep(d.at(p), half)
    if (lost / pieces[a].px.length > MAX_LOSS) thin[a] = 1
  }

  // A thin piece no wider than the gap (at most 1.5 px), lying between two wide pieces, is a sliver
  // of a third colour along their boundary (anti-aliasing where two edges coincide): it sits
  // inside the strip the gap cuts anyway, so it becomes part of the gap instead of stopping it.
  const absorbed = new Uint8Array(N)
  for (const a of near) {
    if (!thin[a]) continue
    const px = pieces[a].px
    let rim = 0
    const wide = new Set<number>()
    for (const p of px) {
      const x = p % w, y = (p / w) | 0
      for (const q of [x > 0 ? p - 1 : -1, x + 1 < w ? p + 1 : -1, y > 0 ? p - w : -1, y + 1 < h ? p + w : -1]) {
        if (q < 0 || comp[q] === a) continue
        rim++
        if (comp[q] >= 0 && !thin[comp[q]] && real(a, comp[q])) wide.add(comp[q])
      }
    }
    if (wide.size >= 2 && (2 * px.length) / Math.max(1, rim) <= Math.max(1, Math.min(gapPx, 1.5))) {
      absorbed[a] = 1
      thin[a] = 0
    }
  }

  // Pass 2: cut, only between two wide pieces (each side loses half the gap).
  const out = { labels: labels.slice(), second: map.second.slice(), cov: map.cov.slice() }
  for (let a = 0; a < N; a++) if (absorbed[a]) for (const p of pieces[a].px) [out.labels[p], out.second[p], out.cov[p]] = [fill, 255, 1]
  for (const a of near) {
    if (thin[a] || absorbed[a]) continue
    const toWide = distances(a, (b) => !thin[b])
    if (!toWide.any) continue
    const l = pieces[a].label
    for (const p of pieces[a].px) {
      const k = keep(toWide.at(p), half)
      if (k >= 1) continue
      if (k >= 0.5) [out.labels[p], out.second[p], out.cov[p]] = [l, fill, k]
      else [out.labels[p], out.second[p], out.cov[p]] = [fill, l, 1 - k]
    }
  }

  const flags: OneColourFlag[] = []
  let gaps = 0
  for (const [k, s] of shared) {
    if (s.len < minLen) continue
    const a = Math.floor(k / N), b = k % N
    const at = { x: +(s.sx / s.len).toFixed(1), y: +(s.sy / s.len).toFixed(1) }
    if (thin[a] || thin[b]) flags.push({ ...at, reason: 'gap-skipped' })
    else if (!absorbed[a] && !absorbed[b]) gaps++
  }
  for (let a = 0; a < N; a++) {
    if (!absorbed[a]) continue
    const px = pieces[a].px
    const c = px[px.length >> 1]
    flags.push({ x: c % w, y: Math.floor(c / w), reason: 'gap-sliver' })
  }
  return { map: { ...map, ...out }, gaps, flags }
}

/** Squared Euclidean distance to the nearest seed (Felzenszwalb & Huttenlocher), per pixel. */
function edt(seed: Uint8Array, w: number, h: number): Float32Array {
  const INF = 1e12
  const f = new Float64Array(Math.max(w, h))
  const d = new Float64Array(Math.max(w, h))
  const v = new Int32Array(Math.max(w, h))
  const z = new Float64Array(Math.max(w, h) + 1)
  const g = new Float32Array(w * h)
  const line = (len: number) => {
    let k = 0
    v[0] = 0
    z[0] = -INF
    z[1] = INF
    for (let q = 1; q < len; q++) {
      let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
      while (s <= z[k]) {
        k--
        s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
      }
      k++
      v[k] = q
      z[k] = s
      z[k + 1] = INF
    }
    k = 0
    for (let q = 0; q < len; q++) {
      while (z[k + 1] < q) k++
      d[q] = (q - v[k]) ** 2 + f[v[k]]
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = seed[y * w + x] ? 0 : INF
    line(h)
    for (let y = 0; y < h; y++) g[y * w + x] = d[y]
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = g[y * w + x]
    line(w)
    for (let x = 0; x < w; x++) g[y * w + x] = d[x]
  }
  return g
}
