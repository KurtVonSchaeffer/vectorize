/**
 * Finds the gradients in flat artwork and describes each as an SVG gradient, so it can be drawn
 * as one smooth shape instead of a stack of color bands.
 *
 * 1. Regions: neighboring pixels join when their (lightly blurred) colors differ by only a few
 *    units. Flat colors and gradients both form regions; real edges, where color jumps, don't.
 * 2. Gradient or flat: a region whose colors span a wide range is a gradient candidate.
 * 3. Fit: the region's main color axis is fitted against position, as a plane (linear gradient)
 *    and as a paraboloid (radial gradient; its vertex is the center). Colors along the chosen
 *    direction form a profile, simplified to a few color stops.
 * 4. Accept: only when the gradient reproduces the region's pixels closely. Texture, photos and
 *    noise fail this and stay with the normal flat-color tracer.
 * 5. Split: overlapping gradient shapes (the feathers of a bird) flow into each other where they
 *    meet, so step 1 can join several of them into one region that no single gradient explains.
 *    A large region that fails is split again with tighter color steps, and each large enough
 *    piece is fitted on its own. When no piece fits, the region is left exactly as it was.
 *
 * Colors are fitted in sRGB, which is how SVG interpolates gradients.
 */

export interface GradientStop {
  /** 0–1 along the gradient. */
  offset: number
  color: number
}

export type GradientFill =
  | { kind: 'linear'; x1: number; y1: number; x2: number; y2: number; stops: GradientStop[] }
  | { kind: 'radial'; cx: number; cy: number; r: number; stops: GradientStop[] }

export interface GradientRegion {
  fill: GradientFill
  /** Average color (0xRRGGBB), used where a single color is needed. */
  color: number
  /** Pixel indices (y·w + x) in the region. */
  pixels: Uint32Array
}

export interface GradientOptions {
  /** Smallest region considered, in pixels (default: 0.3% of the image, at least 150). */
  minArea?: number
  /** At most this many gradients, largest first (default 16). */
  max?: number
}

/** Neighbors closer than this (max channel difference, after blur) belong to one region. */
const STEP = 6
/** A region whose main color axis spans less than this (sRGB units) is a flat color. */
const MIN_RANGE = 28
/** Accepted fits: residual RMS (sRGB units) and share of the color variance explained. */
const MAX_RMS = 7
const MIN_EXPLAINED = 0.85
/** Profile resolution along the gradient. */
const BINS = 48
/** Color stops are kept where straight interpolation would be off by more than this. */
const STOP_TOLERANCE = 4
const MAX_STOPS = 8
/** An edge pixel joins a gradient when within this of the gradient's color there. */
const EDGE_MATCH = 24
/** A region that fails fitting is split again with these tighter neighbor steps, in turn. */
const SPLIT_STEPS = [3, 2]
/** Pieces of a split region at least this large (pixels) are fitted on their own. */
const SPLIT_MIN = 400

export function findGradients(img: ImageData, opts: GradientOptions = {}): GradientRegion[] {
  const { width: w, height: h, data: d } = img
  const n = w * h
  const minArea = opts.minArea ?? Math.max(150, n * 0.003)
  if (n < minArea) return []

  const [R, G, B, valid] = blurred(d, w, h)

  // Regions by union-find over 4-neighbors.
  const parent = new Int32Array(n)
  for (let p = 0; p < n; p++) parent[p] = p
  const find = (p: number) => {
    while (parent[p] !== p) p = parent[p] = parent[parent[p]]
    return p
  }
  const near = (p: number, q: number) =>
    valid[p] && valid[q] && Math.abs(R[p] - R[q]) <= STEP && Math.abs(G[p] - G[q]) <= STEP && Math.abs(B[p] - B[q]) <= STEP
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = y * w + x
      if (x + 1 < w && near(p, p + 1)) union(p, p + 1)
      if (y + 1 < h && near(p, p + w)) union(p, p + w)
    }
  function union(a: number, b: number) {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[ra] = rb
  }

  // Group pixels by region (counting sort), keeping only large regions.
  const size = new Int32Array(n)
  const root = new Int32Array(n)
  for (let p = 0; p < n; p++) {
    root[p] = valid[p] ? find(p) : -1
    if (root[p] >= 0) size[root[p]]++
  }
  // Pixels grouped by region (counting sort), for every region of at least 20 pixels.
  const PIECE = 20
  const slot = new Int32Array(n).fill(-1)
  const roots: number[] = []
  for (let p = 0; p < n; p++)
    if (root[p] === p && size[p] >= PIECE) {
      slot[p] = roots.length
      roots.push(p)
    }
  const lists = roots.map((r) => new Uint32Array(size[r]))
  const fill = new Int32Array(roots.length)
  for (let p = 0; p < n; p++) {
    const sl = root[p] >= 0 ? slot[root[p]] : -1
    if (sl >= 0) lists[sl][fill[sl]++] = p
  }

  const regions: GradientRegion[] = []
  const rejected: Uint32Array[] = []
  roots.forEach((r, i) => {
    if (size[r] < minArea) return
    const g = fitRegion(lists[i], w, R, G, B)
    if (g) regions.push(g)
    else {
      const found = splitAndFit(lists[i], w, R, G, B)
      if (found) {
        regions.push(...found.regions)
        rejected.push(...found.rest)
      } else rejected.push(lists[i])
    }
  })
  const kept = regions.sort((a, b) => b.pixels.length - a.pixels.length).slice(0, opts.max ?? 16)
  if (!kept.length) return kept
  // Pieces of a gradient cut off by other shapes (the counter of an "O" in lettering on a
  // gradient) are too small to show the gradient on their own; they join it when it explains them.
  roots.forEach((r, i) => size[r] < minArea && rejected.push(lists[i]))
  const joined = joinPieces(kept, rejected, w, R, G, B)
  return growIntoEdges(joined, w, h, d, valid, (p) => root[p] >= 0 && size[root[p]] >= minArea)
}

/** The gradient's color at a point (sRGB). */
export function colorAt(f: GradientFill, x: number, y: number): [number, number, number] {
  let t: number
  if (f.kind === 'linear') {
    const dx = f.x2 - f.x1, dy = f.y2 - f.y1
    t = ((x - f.x1) * dx + (y - f.y1) * dy) / Math.max(1e-9, dx * dx + dy * dy)
  } else t = Math.hypot(x - f.cx, y - f.cy) / Math.max(1e-9, f.r)
  const stops = f.stops
  const rgb = (c: number): [number, number, number] => [(c >> 16) & 255, (c >> 8) & 255, c & 255]
  if (t <= stops[0].offset) return rgb(stops[0].color)
  for (let i = 1; i < stops.length; i++) {
    if (t > stops[i].offset) continue
    const a = rgb(stops[i - 1].color), b = rgb(stops[i].color)
    const u = (t - stops[i - 1].offset) / Math.max(1e-9, stops[i].offset - stops[i - 1].offset)
    return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u]
  }
  return rgb(stops[stops.length - 1].color)
}

function joinPieces(regions: GradientRegion[], pieces: Uint32Array[], w: number, R: Float32Array, G: Float32Array, B: Float32Array): GradientRegion[] {
  const extra: Uint32Array[][] = regions.map(() => [])
  const boxes = regions.map((r) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const p of r.pixels) {
      const x = p % w, y = Math.floor(p / w)
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
    return [x0, y0, x1, y1]
  })
  for (const piece of pieces) {
    let best = -1, bestErr = MAX_RMS
    regions.forEach((r, k) => {
      const [x0, y0, x1, y1] = boxes[k]
      let err = 0
      for (const p of piece) {
        const x = p % w, y = Math.floor(p / w)
        // Only pieces inside the gradient's area, not look-alike colors elsewhere.
        if (x < x0 - 2 || x > x1 + 2 || y < y0 - 2 || y > y1 + 2) return
        const c = colorAt(r.fill, x + 0.5, y + 0.5)
        err += (R[p] - c[0]) ** 2 + (G[p] - c[1]) ** 2 + (B[p] - c[2]) ** 2
      }
      const rms = Math.sqrt(err / piece.length / 3)
      if (rms < bestErr) [best, bestErr] = [k, rms]
    })
    if (best >= 0) extra[best].push(piece)
  }
  return regions.map((r, k) => (extra[k].length ? { ...r, pixels: Uint32Array.from([...r.pixels, ...extra[k].flatMap((e) => Array.from(e))]) } : r))
}

/**
 * Splits a region that no single gradient explains into pieces whose neighbors differ by at most
 * each of SPLIT_STEPS in turn, fitting every piece of SPLIT_MIN pixels or more. Returns the
 * gradients found and the leftover pieces, or null when nothing fits (the region then stays whole,
 * so its leftovers can't be absorbed into a neighboring gradient).
 */
function splitAndFit(list: Uint32Array, w: number, R: Float32Array, G: Float32Array, B: Float32Array): { regions: GradientRegion[]; rest: Uint32Array[] } | null {
  const regions: GradientRegion[] = []
  const rest: Uint32Array[] = []
  let todo = [list]
  for (const step of SPLIT_STEPS) {
    const next: Uint32Array[] = []
    for (const part of todo)
      for (const piece of splitPixels(part, w, R, G, B, step)) {
        if (piece.length < SPLIT_MIN) {
          rest.push(piece)
          continue
        }
        const g = fitRegion(piece, w, R, G, B)
        if (g) regions.push(g)
        else next.push(piece)
      }
    todo = next
  }
  return regions.length ? { regions, rest: [...rest, ...todo] } : null
}

/** The connected pieces of a region whose 4-neighbors differ by at most `step` in every channel. */
function splitPixels(list: Uint32Array, w: number, R: Float32Array, G: Float32Array, B: Float32Array, step: number): Uint32Array[] {
  const index = new Map<number, number>()
  list.forEach((p, i) => index.set(p, i))
  const parent = new Int32Array(list.length)
  for (let i = 0; i < parent.length; i++) parent[i] = i
  const find = (i: number) => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]]
    return i
  }
  const near = (p: number, q: number) => Math.abs(R[p] - R[q]) <= step && Math.abs(G[p] - G[q]) <= step && Math.abs(B[p] - B[q]) <= step
  list.forEach((p, i) => {
    const right = (p + 1) % w !== 0 ? index.get(p + 1) : undefined
    const below = index.get(p + w)
    for (const j of [right, below])
      if (j !== undefined && near(p, list[j])) {
        const a = find(i)
        const b = find(j)
        if (a !== b) parent[a] = b
      }
  })
  const groups = new Map<number, number[]>()
  list.forEach((p, i) => {
    const r = find(i)
    const g = groups.get(r)
    if (g) g.push(p)
    else groups.set(r, [p])
  })
  return [...groups.values()].map((g) => Uint32Array.from(g))
}

/**
 * Blurring pulls a region's outline about a pixel inside its real edge. Give each gradient the
 * edge pixels next to it that belong to no large region, so its shape reaches the real edge.
 */
function growIntoEdges(regions: GradientRegion[], w: number, h: number, d: Uint8ClampedArray, valid: Uint8Array, inLarge: (p: number) => boolean): GradientRegion[] {
  const owner = new Int16Array(w * h).fill(-1)
  regions.forEach((r, k) => r.pixels.forEach((p) => (owner[p] = k)))
  const extra: number[][] = regions.map(() => [])
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = y * w + x
      if (owner[p] >= 0 || !valid[p] || inLarge(p)) continue
      const k = [x > 0 ? p - 1 : -1, x + 1 < w ? p + 1 : -1, y > 0 ? p - w : -1, y + 1 < h ? p + w : -1].map((q) => (q >= 0 ? owner[q] : -1)).find((o) => o >= 0)
      if (k === undefined) continue
      // Only pixels that look like the gradient there; a neighbor's own edge pixels stay its own.
      const c = colorAt(regions[k].fill, x + 0.5, y + 0.5)
      if (Math.max(Math.abs(d[p * 4] - c[0]), Math.abs(d[p * 4 + 1] - c[1]), Math.abs(d[p * 4 + 2] - c[2])) <= EDGE_MATCH) extra[k].push(p)
    }
  return regions.map((r, k) => (extra[k].length ? { ...r, pixels: Uint32Array.from([...r.pixels, ...extra[k]]) } : r))
}

/** 3×3 box blur of the RGB channels (opaque pixels only), plus which pixels are opaque. */
function blurred(d: Uint8ClampedArray, w: number, h: number): [Float32Array, Float32Array, Float32Array, Uint8Array] {
  const n = w * h
  const valid = new Uint8Array(n)
  for (let p = 0; p < n; p++) valid[p] = d[p * 4 + 3] >= 128 ? 1 : 0
  const out = [new Float32Array(n), new Float32Array(n), new Float32Array(n)] as const
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = y * w + x
      if (!valid[p]) continue
      let s0 = 0, s1 = 0, s2 = 0, c = 0
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= h) continue
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx
          if (xx < 0 || xx >= w) continue
          const q = yy * w + xx
          if (!valid[q]) continue
          s0 += d[q * 4]; s1 += d[q * 4 + 1]; s2 += d[q * 4 + 2]; c++
        }
      }
      out[0][p] = s0 / c
      out[1][p] = s1 / c
      out[2][p] = s2 / c
    }
  return [out[0], out[1], out[2], valid]
}

function fitRegion(pixels: Uint32Array, w: number, R: Float32Array, G: Float32Array, B: Float32Array): GradientRegion | null {
  const m = pixels.length
  // Mean color and position.
  let mr = 0, mg = 0, mb = 0, mx = 0, my = 0
  for (const p of pixels) {
    mr += R[p]; mg += G[p]; mb += B[p]
    mx += (p % w) + 0.5; my += Math.floor(p / w) + 0.5
  }
  mr /= m; mg /= m; mb /= m; mx /= m; my /= m

  // Main color axis: principal eigenvector of the color covariance (power iteration).
  const cov = [0, 0, 0, 0, 0, 0] // rr rg rb gg gb bb
  for (const p of pixels) {
    const a = R[p] - mr, b = G[p] - mg, c = B[p] - mb
    cov[0] += a * a; cov[1] += a * b; cov[2] += a * c; cov[3] += b * b; cov[4] += b * c; cov[5] += c * c
  }
  const variance = (cov[0] + cov[3] + cov[5]) / m // total, summed over channels
  let e = [1, 1, 1]
  for (let it = 0; it < 30; it++) {
    const v = [cov[0] * e[0] + cov[1] * e[1] + cov[2] * e[2], cov[1] * e[0] + cov[3] * e[1] + cov[4] * e[2], cov[2] * e[0] + cov[4] * e[1] + cov[5] * e[2]]
    const len = Math.hypot(v[0], v[1], v[2])
    if (!len) return null
    e = [v[0] / len, v[1] / len, v[2] / len]
  }

  // The color coordinate along that axis, per pixel, and its spread.
  const s = new Float32Array(m)
  let smin = Infinity, smax = -Infinity
  for (let i = 0; i < m; i++) {
    const p = pixels[i]
    s[i] = (R[p] - mr) * e[0] + (G[p] - mg) * e[1] + (B[p] - mb) * e[2]
    if (s[i] < smin) smin = s[i]
    if (s[i] > smax) smax = s[i]
  }
  if (smax - smin < MIN_RANGE) return null // a flat color

  const xs = new Float32Array(m)
  const ys = new Float32Array(m)
  for (let i = 0; i < m; i++) {
    xs[i] = (pixels[i] % w) + 0.5 - mx
    ys[i] = Math.floor(pixels[i] / w) + 0.5 - my
  }

  // Linear: s ≈ a + b·x + c·y gives the direction of change.
  const lin = leastSquares(m, (i) => [1, xs[i], ys[i]], s)
  if (!lin) return null
  // A symmetric (radial) gradient has no overall direction; then only radial is tried.
  const dirLen = Math.hypot(lin[1], lin[2])
  let dir: [number, number] = dirLen > 1e-6 ? [lin[1] / dirLen, lin[2] / dirLen] : [1, 0]
  // Point left to right (or top to bottom), as a designer would draw it.
  if (dir[0] < -1e-6 || (Math.abs(dir[0]) <= 1e-6 && dir[1] < 0)) dir = [-dir[0], -dir[1]]
  const linear = dirLen > 1e-6 ? profileFit(pixels, R, G, B, (i) => xs[i] * dir[0] + ys[i] * dir[1]) : null

  // Radial: s ≈ a + b·x + c·y + q·(x² + y²); the paraboloid's vertex is the center.
  let radial: (Profile & { cx: number; cy: number }) | null = null
  const quad = leastSquares(m, (i) => [1, xs[i], ys[i], xs[i] * xs[i] + ys[i] * ys[i]], s)
  if (quad && Math.abs(quad[3]) > 1e-9) {
    const cx = -quad[1] / (2 * quad[3])
    const cy = -quad[2] / (2 * quad[3])
    // The center should be near the region, or this is really a linear gradient.
    let ext = 0
    for (let i = 0; i < m; i++) ext = Math.max(ext, Math.abs(xs[i]), Math.abs(ys[i]))
    if (Math.hypot(cx, cy) < ext * 1.2) {
      const fit = profileFit(pixels, R, G, B, (i) => Math.hypot(xs[i] - cx, ys[i] - cy))
      radial = { ...fit, cx: cx + mx, cy: cy + my }
    }
  }

  // Radial has more freedom, so it must be clearly better.
  const useRadial = radial !== null && (!linear || radial.rms < linear.rms * 0.85)
  const best = useRadial ? radial : linear
  if (!best) return null
  const explained = 1 - (best.rms * best.rms * 3) / Math.max(1e-6, variance)
  if (best.rms > MAX_RMS || explained < MIN_EXPLAINED) return null

  const stops = simplifyStops(best.colors)
  const color = rgbInt(mr, mg, mb)
  if (useRadial) {
    const r = radial!
    // Offsets run from the center (0) to the farthest pixel (1).
    const span = r.tmax
    if (span <= 0) return null
    const scaled = stops.map((st) => ({ offset: (r.tmin + st.offset * (r.tmax - r.tmin)) / span, color: st.color }))
    return { fill: { kind: 'radial', cx: round(r.cx), cy: round(r.cy), r: round(span), stops: scaled }, color, pixels }
  }
  const at = (t: number): [number, number] => [mx + dir[0] * t, my + dir[1] * t]
  const [x1, y1] = at(best.tmin)
  const [x2, y2] = at(best.tmax)
  return { fill: { kind: 'linear', x1: round(x1), y1: round(y1), x2: round(x2), y2: round(y2), stops }, color, pixels }
}

interface Profile {
  tmin: number
  tmax: number
  /** Mean color per bin from tmin to tmax. */
  colors: [number, number, number][]
  rms: number
}

/** Colors as a function of one coordinate t (binned means), and how well that explains them. */
function profileFit(pixels: Uint32Array, R: Float32Array, G: Float32Array, B: Float32Array, tOf: (i: number) => number): Profile {
  const m = pixels.length
  const t = new Float32Array(m)
  let tmin = Infinity, tmax = -Infinity
  for (let i = 0; i < m; i++) {
    t[i] = tOf(i)
    if (t[i] < tmin) tmin = t[i]
    if (t[i] > tmax) tmax = t[i]
  }
  const span = Math.max(1e-6, tmax - tmin)
  const binOf = (v: number) => Math.min(BINS - 1, Math.floor(((v - tmin) / span) * BINS))
  const sum = new Float64Array(BINS * 3)
  const cnt = new Float64Array(BINS)
  for (let i = 0; i < m; i++) {
    const b = binOf(t[i])
    const p = pixels[i]
    sum[b * 3] += R[p]; sum[b * 3 + 1] += G[p]; sum[b * 3 + 2] += B[p]
    cnt[b]++
  }
  const colors: [number, number, number][] = []
  for (let b = 0; b < BINS; b++) colors.push(cnt[b] ? [sum[b * 3] / cnt[b], sum[b * 3 + 1] / cnt[b], sum[b * 3 + 2] / cnt[b]] : [NaN, NaN, NaN])
  fillGaps(colors)

  // Residual against the profile, interpolated between bin centers.
  let err = 0
  for (let i = 0; i < m; i++) {
    const u = ((t[i] - tmin) / span) * BINS - 0.5
    const b0 = Math.max(0, Math.min(BINS - 1, Math.floor(u)))
    const b1 = Math.min(BINS - 1, b0 + 1)
    const f = Math.max(0, Math.min(1, u - b0))
    const p = pixels[i]
    const c0 = colors[b0], c1 = colors[b1]
    err += (R[p] - (c0[0] + (c1[0] - c0[0]) * f)) ** 2 + (G[p] - (c0[1] + (c1[1] - c0[1]) * f)) ** 2 + (B[p] - (c0[2] + (c1[2] - c0[2]) * f)) ** 2
  }
  return { tmin, tmax, colors, rms: Math.sqrt(err / m / 3) }
}

/** Empty bins take the color interpolated between their nearest filled neighbors. */
function fillGaps(colors: [number, number, number][]) {
  const filled = colors.map((c, i) => (Number.isNaN(c[0]) ? -1 : i)).filter((i) => i >= 0)
  if (!filled.length) return
  for (let i = 0; i < colors.length; i++) {
    if (!Number.isNaN(colors[i][0])) continue
    const before = filled.filter((f) => f < i).pop()
    const after = filled.find((f) => f > i)
    if (before === undefined) colors[i] = [...colors[after!]]
    else if (after === undefined) colors[i] = [...colors[before]]
    else {
      const f = (i - before) / (after - before)
      colors[i] = [0, 1, 2].map((k) => colors[before][k] + (colors[after][k] - colors[before][k]) * f) as [number, number, number]
    }
  }
}

/**
 * The fewest stops that reproduce the profile: Douglas–Peucker over the bins, splitting where
 * straight interpolation between kept stops is furthest off.
 */
function simplifyStops(colors: [number, number, number][]): GradientStop[] {
  const n = colors.length
  const offset = (i: number) => (i === 0 ? 0 : i === n - 1 ? 1 : (i + 0.5) / n)
  const keep = new Set([0, n - 1])
  const split = (a: number, b: number) => {
    let worst = -1, wd = STOP_TOLERANCE
    for (let i = a + 1; i < b; i++) {
      const f = (offset(i) - offset(a)) / (offset(b) - offset(a))
      const dd = Math.max(...[0, 1, 2].map((k) => Math.abs(colors[i][k] - (colors[a][k] + (colors[b][k] - colors[a][k]) * f))))
      if (dd > wd) [worst, wd] = [i, dd]
    }
    if (worst < 0 || keep.size >= MAX_STOPS) return
    keep.add(worst)
    split(a, worst)
    split(worst, b)
  }
  split(0, n - 1)
  return [...keep].sort((a, b) => a - b).map((i) => ({ offset: round(offset(i), 4), color: rgbInt(...colors[i]) }))
}

/** Solves the normal equations for a small linear least-squares problem. */
function leastSquares(m: number, row: (i: number) => number[], y: Float32Array): number[] | null {
  const k = row(0).length
  const A = Array.from({ length: k }, () => new Float64Array(k + 1))
  for (let i = 0; i < m; i++) {
    const r = row(i)
    for (let a = 0; a < k; a++) {
      for (let b = 0; b < k; b++) A[a][b] += r[a] * r[b]
      A[a][k] += r[a] * y[i]
    }
  }
  // Gaussian elimination with partial pivoting.
  for (let c = 0; c < k; c++) {
    let piv = c
    for (let r = c + 1; r < k; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r
    if (Math.abs(A[piv][c]) < 1e-9) return null
    ;[A[c], A[piv]] = [A[piv], A[c]]
    for (let r = 0; r < k; r++) {
      if (r === c) continue
      const f = A[r][c] / A[c][c]
      for (let j = c; j <= k; j++) A[r][j] -= f * A[c][j]
    }
  }
  return A.map((r, i) => r[k] / r[i])
}

const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)))
const rgbInt = (r: number, g: number, b: number) => (clamp(r) << 16) | (clamp(g) << 8) | clamp(b)
const round = (v: number, places = 2) => +v.toFixed(places)

/** The SVG element for a gradient fill (userSpaceOnUse, in the traced image's pixels). */
export function gradientSvg(id: string, f: GradientFill): string {
  const hex = (c: number) => '#' + c.toString(16).padStart(6, '0').toUpperCase()
  const stops = f.stops.map((s) => `<stop offset="${s.offset}" stop-color="${hex(s.color)}"/>`).join('')
  return f.kind === 'linear'
    ? `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${f.x1}" y1="${f.y1}" x2="${f.x2}" y2="${f.y2}">${stops}</linearGradient>`
    : `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${f.cx}" cy="${f.cy}" r="${f.r}">${stops}</radialGradient>`
}
