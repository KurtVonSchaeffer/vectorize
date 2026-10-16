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
 * 6. Two gradients (prototype): two feathers whose gradients meet without any colour step can't be
 *    split by colour steps. A large piece that still fails is fitted as two gradients, each pixel
 *    going to the one that explains it better, kept only when both pass the normal tolerances,
 *    together they're clearly better than one, each is one coherent shape, and the two agree along
 *    their shared boundary (no seam where the original is continuous).
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
/** A failed region is split only when its best gradient still explains this share of its color. */
const SPLIT_MIN_EXPLAINED = 0.5
/** ...and only when it holds less than this share of the image's border pixels (more is background). */
const SPLIT_MAX_BORDER = 0.5
/** Staircase test (isStaircase): a jump is a step this many times the mean, flat under this share of it. */
const STAIR_JUMP = 3
const STAIR_FLAT = 0.3
/** ...and a staircase has at least this share of the change in jumps, and of the length flat. */
const STAIR_JUMP_SHARE = 0.6
const STAIR_FLAT_SHARE = 0.7
/** Two gradients (twoGradients): tried on failed pieces at least this large (each part SPLIT_MIN). */
const TWO_MIN = 2 * SPLIT_MIN
/** ...when one gradient's residual is at least this (below it, one is already faithful), */
const TWO_MIN_RMS = 3
/** ...kept only when their combined residual is at most this share of the single gradient's, */
const TWO_GAIN = 0.75
/** ...each part's largest connected piece holds this share of it, */
const TWO_COHERENT = 0.9
/** ...and along the shared boundary the two differ from the original's own change by at most this (RMS). */
const TWO_SEAM = 6
/** Gradients grow at most this many pixels into what a split left over (growIntoEdges). */
const LEFTOVER_RINGS = 16
/** Prototype diagnostics: one entry per two-gradient attempt. */
export const twoGradientLog: Record<string, unknown>[] = []

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
  // Pixels a split left over (thin tips and edges of the pieces): gradients may grow into them.
  const leftover = new Int32Array(n) // leftover piece number + 1; 0 = none
  const leftoverCount: number[] = []
  roots.forEach((r, i) => {
    if (size[r] < minArea) return
    const diag = { explained: 0 }
    const g = fitRegion(lists[i], w, R, G, B, diag)
    if (g) regions.push(g)
    else {
      // Only regions that look like gradients joined together are split: a fit that still
      // explains much of the color (several feathers: 0.69–0.76), not flat regions, and not the
      // background (along the image border, often chained to shapes by their soft edges), which
      // splitting can't turn into gradients and which is slow to split.
      const splittable = diag.explained >= SPLIT_MIN_EXPLAINED && borderShare(lists[i], w, h) < SPLIT_MAX_BORDER
      const found = splittable ? splitAndFit(lists[i], w, h, R, G, B, d) : null
      if (found) {
        regions.push(...found.regions)
        rejected.push(...found.rest)
        for (const piece of found.rest) {
          leftoverCount.push(piece.length)
          for (const p of piece) leftover[p] = leftoverCount.length
        }
      } else rejected.push(lists[i])
    }
  })
  const kept = regions.sort((a, b) => b.pixels.length - a.pixels.length).slice(0, opts.max ?? 16)
  if (!kept.length) return kept
  // Pieces of a gradient cut off by other shapes (the counter of an "O" in lettering on a
  // gradient) are too small to show the gradient on their own; they join it when it explains them.
  roots.forEach((r, i) => size[r] < minArea && rejected.push(lists[i]))
  const joined = joinPieces(kept, rejected, w, R, G, B)
  return growIntoEdges(joined, w, h, d, valid, (p) => root[p] >= 0 && size[root[p]] >= minArea, { piece: leftover, sizes: leftoverCount })
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
function splitAndFit(list: Uint32Array, w: number, h: number, R: Float32Array, G: Float32Array, B: Float32Array, d: Uint8ClampedArray): { regions: GradientRegion[]; rest: Uint32Array[] } | null {
  const regions: GradientRegion[] = []
  const rest: Uint32Array[] = []
  // Pixel → position in the piece being split (+1; 0 = not in it), shared by every split.
  const index = new Int32Array(w * h)
  let todo = [list]
  // Each failed piece's single-gradient residual (0: flat, or a staircase).
  const oneRms = new Map<Uint32Array, number>()
  for (const step of SPLIT_STEPS) {
    const next: Uint32Array[] = []
    for (const part of todo)
      for (const piece of splitPixels(part, w, h, R, G, B, step, index)) {
        if (piece.length < SPLIT_MIN) {
          rest.push(piece)
          continue
        }
        const dg: { explained: number; rms?: number } = { explained: 0 }
        const g = fitRegion(piece, w, R, G, B, dg)
        // A piece of flat colors joined by their soft edges (a green and a blue shape) fits as a
        // staircase "gradient"; it stays flat.
        if (g && !isStaircase(g, w, R, G, B)) regions.push(g)
        else {
          next.push(piece)
          oneRms.set(piece, g ? 0 : (dg.rms ?? 0))
        }
      }
    todo = next
  }
  // Pieces still unexplained: two gradients that meet without a colour step (two feathers).
  const left: Uint32Array[] = []
  for (const piece of todo) {
    // One gradient already this close is faithful: the piece failed for being nearly flat (like a
    // background, which would also be the slowest to try).
    const two = piece.length >= TWO_MIN && (oneRms.get(piece) ?? 0) >= TWO_MIN_RMS ? twoGradients(piece, w, h, R, G, B, d, index) : null
    if (two) regions.push(...two)
    else left.push(piece)
  }
  return regions.length ? { regions, rest: [...rest, ...left] } : null
}

/**
 * Two gradients for a piece that no single gradient explains and colour steps can't split (two
 * feathers meeting without a step). Starting from a few splits, each part is fitted and every pixel
 * goes to the gradient that explains it better (smoothed, so the parts stay whole shapes), until
 * stable. Kept only when both parts pass the normal tolerances and aren't staircases, together they
 * cut the single gradient's residual to TWO_GAIN or less, each is one coherent shape, and the two
 * agree along their shared boundary (TWO_SEAM). Otherwise null, and the piece stays as it was.
 */
function twoGradients(list: Uint32Array, w: number, h: number, R: Float32Array, G: Float32Array, B: Float32Array, d: Uint8ClampedArray, index: Int32Array): GradientRegion[] | null {
  const m = list.length
  const oneDiag = { explained: 0, rms: 0 }
  const one = fitRegion(list, w, R, G, B, oneDiag, true)
  if (!one) return null
  const log: Record<string, unknown> = { pixels: m, oneRms: round(oneDiag.rms), oneExplained: round(oneDiag.explained) }
  twoGradientLog.push(log)
  const t0 = performance.now()
  list.forEach((p, i) => (index[p] = i + 1))
  const at = (p: number) => [(p % w) + 0.5, Math.floor(p / w) + 0.5]
  const errOf = (f: GradientFill, p: number) => {
    const [x, y] = at(p)
    const c = colorAt(f, x, y)
    return (R[p] - c[0]) ** 2 + (G[p] - c[1]) ** 2 + (B[p] - c[2]) ** 2
  }
  // In-piece neighbours of pixel i (indices into list), 4- or 8-connected.
  const around = (i: number, eight: boolean, visit: (j: number) => void) => {
    const p = list[i], x = p % w, y = (p - x) / w
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if ((!dx && !dy) || (!eight && dx && dy)) continue
        const xx = x + dx, yy = y + dy
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue
        const j = index[yy * w + xx] - 1
        if (j >= 0) visit(j)
      }
  }
  // Connected pieces of each label: component id per pixel and sizes.
  const components = (lab: Uint8Array) => {
    const comp = new Int32Array(m).fill(-1)
    const sizes: number[] = [], labels: number[] = []
    const stack: number[] = []
    for (let s = 0; s < m; s++) {
      if (comp[s] >= 0) continue
      const id = sizes.length
      let n = 0
      comp[s] = id
      stack.push(s)
      while (stack.length) {
        const i = stack.pop()!
        n++
        around(i, false, (j) => {
          if (comp[j] < 0 && lab[j] === lab[s]) {
            comp[j] = id
            stack.push(j)
          }
        })
      }
      sizes.push(n)
      labels.push(lab[s])
    }
    return { comp, sizes, labels }
  }
  const tidy = (lab: Uint8Array) => {
    // Majority of the 8 neighbours, twice, then fragments of a part flip to the other.
    for (let pass = 0; pass < 2; pass++) {
      const next = lab.slice()
      for (let i = 0; i < m; i++) {
        let ones = 0, all = 0
        around(i, true, (j) => {
          all++
          ones += lab[j]
        })
        if (ones * 2 > all + 1) next[i] = 1
        else if (ones * 2 < all - 1) next[i] = 0
      }
      lab.set(next)
    }
    const { comp, sizes, labels } = components(lab)
    const total = [0, 0], biggest = [0, 0]
    sizes.forEach((n, c) => {
      total[labels[c]] += n
      biggest[labels[c]] = Math.max(biggest[labels[c]], n)
    })
    for (let i = 0; i < m; i++) {
      const c = comp[i], l = labels[c]
      if (sizes[c] < biggest[l] && sizes[c] < Math.max(20, total[l] * 0.05)) lab[i] = 1 - l
    }
  }
  const partsOf = (lab: Uint8Array) => [0, 1].map((k) => Uint32Array.from(list.filter((_, i) => lab[i] === k)))
  // One reassignment round: fit both parts, give each pixel to the better one, tidy. Null when a
  // part gets too small or flat.
  const step = (lab: Uint8Array) => {
    const parts = partsOf(lab)
    if (parts.some((pt) => pt.length < SPLIT_MIN)) return null
    const fits = parts.map((pt) => fitRegion(pt, w, R, G, B, undefined, true))
    if (!fits[0] || !fits[1]) return null
    const next = new Uint8Array(m)
    for (let i = 0; i < m; i++) next[i] = errOf(fits[1].fill, list[i]) < errOf(fits[0].fill, list[i]) ? 1 : 0
    tidy(next)
    let changed = 0
    for (let i = 0; i < m; i++) if (next[i] !== lab[i]) changed++
    return { lab: next, changed }
  }
  const finish = (lab: Uint8Array) => {
    const parts = partsOf(lab)
    if (parts.some((pt) => pt.length < SPLIT_MIN)) return null
    const diags = [{ explained: 0, rms: 0 }, { explained: 0, rms: 0 }]
    const fits = parts.map((pt, k) => fitRegion(pt, w, R, G, B, diags[k], true))
    if (!fits[0] || !fits[1]) return null
    const rms = Math.sqrt((diags[0].rms ** 2 * parts[0].length + diags[1].rms ** 2 * parts[1].length) / m)
    return { lab, fits: fits as GradientRegion[], diags, rms }
  }
  // A few rounds from each start; then only the most promising start continues until stable.
  const refine = (starts: Uint8Array[]) => {
    const runs = starts.map((lab) => {
      let cur: Uint8Array | null = lab
      for (let it = 0; it < 3 && cur; it++) {
        const r = step(cur)
        cur = r ? r.lab : null
        if (r && r.changed < m * 0.002) break
      }
      return cur ? finish(cur) : null
    })
    log.starts = runs.map((r) => (r ? round(r.rms) : -1))
    let best = runs.reduce<(typeof runs)[number]>((b, r) => (r && (!b || r.rms < b.rms) ? r : b), null)
    if (!best) return null
    let lab = best.lab
    for (let it = 0; it < 6; it++) {
      const r = step(lab)
      if (!r) break
      lab = r.lab
      if (r.changed < m * 0.002) break
    }
    const last = finish(lab)
    if (last && last.rms <= best.rms) best = last
    return best
  }

  try {
    // Starting splits: by the colour the single gradient leaves unexplained (two feathers differ in
    // hue), and by halves along and across the single gradient's direction.
    const starts: Uint8Array[] = []
    const rv: number[][] = []
    let mr = 0, mg = 0, mb = 0
    for (const p of list) {
      const [x, y] = at(p)
      const c = colorAt(one.fill, x, y)
      const v = [R[p] - c[0], G[p] - c[1], B[p] - c[2]]
      rv.push(v)
      mr += v[0]; mg += v[1]; mb += v[2]
    }
    mr /= m; mg /= m; mb /= m
    const cov = [0, 0, 0, 0, 0, 0]
    for (const [a0, b0, c0] of rv) {
      const a = a0 - mr, b = b0 - mg, c = c0 - mb
      cov[0] += a * a; cov[1] += a * b; cov[2] += a * c; cov[3] += b * b; cov[4] += b * c; cov[5] += c * c
    }
    let e = [1, 0.5, 0.25]
    for (let it = 0; it < 30; it++) {
      const v = [cov[0] * e[0] + cov[1] * e[1] + cov[2] * e[2], cov[1] * e[0] + cov[3] * e[1] + cov[4] * e[2], cov[2] * e[0] + cov[4] * e[1] + cov[5] * e[2]]
      const len = Math.hypot(v[0], v[1], v[2]) || 1
      e = [v[0] / len, v[1] / len, v[2] / len]
    }
    starts.push(Uint8Array.from(rv, (v) => ((v[0] - mr) * e[0] + (v[1] - mg) * e[1] + (v[2] - mb) * e[2] > 0 ? 1 : 0)))
    let cx = 0, cy = 0
    for (const p of list) {
      const [x, y] = at(p)
      cx += x; cy += y
    }
    cx /= m; cy /= m
    const f = one.fill
    const dir = f.kind === 'linear' ? [f.x2 - f.x1, f.y2 - f.y1] : [1, 0]
    for (const [dx, dy] of [dir, [-dir[1], dir[0]]])
      starts.push(Uint8Array.from(list, (p) => {
        const [x, y] = at(p)
        return (x - cx) * dx + (y - cy) * dy > 0 ? 1 : 0
      }))
    const best = refine(starts)
    if (!best) return (log.verdict = 'no two-part fit', null)
    const { lab, fits, diags, rms } = best
    log.parts = fits.map((g, k) => ({ pixels: g.pixels.length, kind: g.fill.kind, rms: round(diags[k].rms), explained: round(diags[k].explained), stops: g.fill.stops.length }))
    log.twoRms = round(rms)
    // Coherence: each part mostly one connected shape.
    const { sizes, labels } = components(lab)
    const coherent = [0, 1].map((k) => {
      const mine = sizes.filter((_, c) => labels[c] === k)
      return Math.max(...mine) / mine.reduce((a, b) => a + b, 0)
    })
    log.coherent = coherent.map((v) => round(v))
    // Seam: along the shared boundary, the change between the two drawn gradients against the
    // original's own change there (unblurred, so real steps count in full), averaged over 8 px
    // cells so JPEG noise cancels and only a systematic jump remains.
    const cells = new Map<number, number[]>()
    let pairs = 0
    for (let i = 0; i < m; i++) {
      const p = list[i]
      for (const q of [(p + 1) % w ? p + 1 : -1, p + w < w * h ? p + w : -1]) {
        const j = q >= 0 ? index[q] - 1 : -1
        if (j < 0 || lab[j] === lab[i]) continue
        const [px, py] = at(p), [qx, qy] = at(q)
        const a = colorAt(fits[lab[i]].fill, px, py), b = colorAt(fits[lab[j]].fill, qx, qy)
        const key = Math.floor(py / 8) * 4096 + Math.floor(px / 8)
        const c = cells.get(key) ?? [0, 0, 0, 0]
        for (let k = 0; k < 3; k++) c[k] += a[k] - b[k] - (d[p * 4 + k] - d[q * 4 + k])
        c[3]++
        cells.set(key, c)
        pairs++
      }
    }
    let seam = 0
    for (const c of cells.values()) seam += ((c[0] / c[3]) ** 2 + (c[1] / c[3]) ** 2 + (c[2] / c[3]) ** 2) / 3
    const seamRms = Math.sqrt(seam / Math.max(1, cells.size))
    log.seam = round(seamRms)
    log.boundary = pairs
    log.boundaryPerSide = round(pairs / Math.sqrt(m))
    const fail = [
      diags.some((dg) => dg.rms > MAX_RMS || dg.explained < MIN_EXPLAINED) && 'a part fails the gradient tolerances',
      fits.some((g) => isStaircase(g, w, R, G, B)) && 'a part is flat colours in steps',
      rms > TWO_GAIN * oneDiag.rms && 'not clearly better than one gradient',
      coherent.some((c) => c < TWO_COHERENT) && 'a part is in pieces',
      seamRms > TWO_SEAM && !(globalThis as { __TWO_NOSEAM?: boolean }).__TWO_NOSEAM && 'visible seam', // prototype switch, for pictures only
    ].filter(Boolean)
    log.verdict = fail.length ? fail.join('; ') : 'two gradients'
    return fail.length ? null : fits
  } finally {
    list.forEach((p) => (index[p] = 0))
    log.ms = Math.round(performance.now() - t0)
  }
}

/** Share of the image's border pixels that belong to a region. */
function borderShare(pixels: Uint32Array, w: number, h: number): number {
  let n = 0
  for (const p of pixels) {
    const x = p % w
    const y = (p - x) / w
    if (x === 0 || y === 0 || x === w - 1 || y === h - 1) n++
  }
  return n / Math.max(1, 2 * (w + h) - 4)
}

/**
 * Whether a fitted gradient is really flat colors in steps: along its direction, the color stays
 * put almost everywhere and all the change happens in a few narrow jumps (the soft edges between
 * the flat shapes). A real gradient changes throughout. Measured: stepped flats 0.78–1 of the
 * change in jumps with 0.93–0.99 of the length flat; real gradients at most 0.71 and 0.67.
 */
export function isStaircase(g: GradientRegion, w: number, R: Float32Array, G: Float32Array, B: Float32Array): boolean {
  const f = g.fill
  const tOf =
    f.kind === 'linear'
      ? (x: number, y: number) => {
          const dx = f.x2 - f.x1, dy = f.y2 - f.y1
          return ((x - f.x1) * dx + (y - f.y1) * dy) / Math.max(1e-6, Math.hypot(dx, dy))
        }
      : (x: number, y: number) => Math.hypot(x - f.cx, y - f.cy)
  // A one-pixel color profile along the gradient (each step averaged over the region's width).
  const bins = new Map<number, number[]>()
  for (const p of g.pixels) {
    const t = Math.round(tOf((p % w) + 0.5, Math.floor(p / w) + 0.5))
    const b = bins.get(t) ?? [0, 0, 0, 0]
    b[0] += R[p]; b[1] += G[p]; b[2] += B[p]; b[3]++
    bins.set(t, b)
  }
  const prof = [...bins.keys()].sort((a, b) => a - b).map((t) => bins.get(t)!).filter((b) => b[3] >= 3).map((b) => [b[0] / b[3], b[1] / b[3], b[2] / b[3]])
  if (prof.length < 8) return false
  const steps = prof.slice(1).map((c, i) => Math.abs(c[0] - prof[i][0]) + Math.abs(c[1] - prof[i][1]) + Math.abs(c[2] - prof[i][2]))
  const total = steps.reduce((s, d) => s + d, 0)
  if (!total) return true
  const mean = total / steps.length
  const jump = steps.filter((d) => d > STAIR_JUMP * mean).reduce((s, d) => s + d, 0) / total
  const flat = steps.filter((d) => d < STAIR_FLAT * mean).length / steps.length
  return jump >= STAIR_JUMP_SHARE && flat >= STAIR_FLAT_SHARE
}

/** The connected pieces of a region whose 4-neighbors differ by at most `step` in every channel. */
function splitPixels(list: Uint32Array, w: number, h: number, R: Float32Array, G: Float32Array, B: Float32Array, step: number, index: Int32Array): Uint32Array[] {
  list.forEach((p, i) => (index[p] = i + 1))
  const parent = new Int32Array(list.length)
  for (let i = 0; i < parent.length; i++) parent[i] = i
  const find = (i: number) => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]]
    return i
  }
  const near = (p: number, q: number) => Math.abs(R[p] - R[q]) <= step && Math.abs(G[p] - G[q]) <= step && Math.abs(B[p] - B[q]) <= step
  list.forEach((p, i) => {
    const right = (p + 1) % w !== 0 ? index[p + 1] - 1 : -1
    const below = p + w < w * h ? index[p + w] - 1 : -1
    for (const j of [right, below])
      if (j >= 0 && near(p, list[j])) {
        const a = find(i)
        const b = find(j)
        if (a !== b) parent[a] = b
      }
  })
  list.forEach((p) => (index[p] = 0))
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
 * Pixels a split left over (`leftover`: the thin tip of a feather, too small to be a piece) are
 * grown into ring by ring, so the gradient keeps the shape's full outline. Only small leftovers
 * (under SPLIT_MIN); growing into large failed pieces would cut them into slivers.
 */
function growIntoEdges(regions: GradientRegion[], w: number, h: number, d: Uint8ClampedArray, valid: Uint8Array, inLarge: (p: number) => boolean, leftover?: { piece: Int32Array; sizes: number[] }): GradientRegion[] {
  const owner = new Int16Array(w * h).fill(-1)
  regions.forEach((r, k) => r.pixels.forEach((p) => (owner[p] = k)))
  const extra: number[][] = regions.map(() => [])
  const grow = (p: number, x: number, y: number) => {
    const k = [x > 0 ? p - 1 : -1, x + 1 < w ? p + 1 : -1, y > 0 ? p - w : -1, y + 1 < h ? p + w : -1].map((q) => (q >= 0 ? owner[q] : -1)).find((o) => o >= 0)
    if (k === undefined) return -1
    // Only pixels that look like the gradient there; a neighbor's own edge pixels stay its own.
    const c = colorAt(regions[k].fill, x + 0.5, y + 0.5)
    return Math.max(Math.abs(d[p * 4] - c[0]), Math.abs(d[p * 4 + 1] - c[1]), Math.abs(d[p * 4 + 2] - c[2])) <= EDGE_MATCH ? k : -1
  }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = y * w + x
      if (owner[p] >= 0 || !valid[p] || inLarge(p)) continue
      const k = grow(p, x, y)
      if (k >= 0) extra[k].push(p)
    }
  if (leftover) {
    // The first ring above doesn't claim pixels yet (as before); the leftover rings do, in turn.
    const { piece } = leftover
    let todo: number[] = []
    for (let p = 0; p < w * h; p++) if (piece[p] && owner[p] < 0 && valid[p] && leftover.sizes[piece[p] - 1] < SPLIT_MIN) todo.push(p)
    const taken: [number, number][] = []
    for (let ring = 0; ring < LEFTOVER_RINGS && todo.length; ring++) {
      const found: [number, number][] = []
      const rest: number[] = []
      for (const p of todo) {
        const x = p % w
        const k = grow(p, x, (p - x) / w)
        if (k >= 0) found.push([p, k])
        else rest.push(p)
      }
      if (!found.length) break
      for (const [p, k] of found) {
        owner[p] = k
        taken.push([p, k])
      }
      todo = rest
    }
    for (const [p, k] of taken) extra[k].push(p)
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

function fitRegion(pixels: Uint32Array, w: number, R: Float32Array, G: Float32Array, B: Float32Array, diag?: { explained: number; rms?: number }, loose = false): GradientRegion | null {
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
  if (diag) {
    diag.explained = explained
    diag.rms = best.rms
  }
  // Loose: any fit, for comparing candidates (twoGradients); the tolerances are applied after.
  if (!loose && (best.rms > MAX_RMS || explained < MIN_EXPLAINED)) return null

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
