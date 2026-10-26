import type { LabelMap } from '../trace'

/**
 * Illustrations (hatched or engraved art: detectArt's texture rule) are traced twice. The flat
 * tracer draws lettering, banners, rings, outlines and backgrounds with clean edges; full colour
 * (VTracer) keeps the shading of fur, faces and wood grain, which flat colours can only draw as
 * blotches. Full colour traces the texture only (the rest is made transparent first), and is drawn
 * over the flat trace. Inside the texture the flat map is filled with one colour first: the
 * shading covers it, and the flat tracer is spared thousands of fragments of fur.
 *
 * Texture is judged on the source, not on how well the flat colours match it: 16 flat colours can
 * match fur pixel by pixel, yet tracing them smooths its 1–2 px strokes into blotches.
 */

/** Texture is judged in blocks of this many px, each with its 8 neighbouring blocks. */
const BLOCK = 8
/**
 * Texture: over this share of pixels next to a sharp change (over 48 levels in a channel)… On the
 * Gorilla Glue logo: face 0.51, fur 0.58, hands 0.36; lettering on its ring 0.27.
 */
export const TEXTURE_BUSY = 0.33
/**
 * …in at least this many distinct shades (16 levels per channel) with 6 px or more each, in a
 * block and its neighbours. Lettering and outlines are busy at their edges but in a few colours
 * and their blends: the Gorilla Glue ring, black lettering and double outline on an orange
 * gradient, has 14–19; its fur, face and hands mostly 20–40.
 */
export const TEXTURE_SHADES = 20
/** Busy share and shades for blocks within NEAR_BLOCKS of clear texture (sparse fur: 0.24, 16)… */
const NEAR_BUSY = 0.15
const TEXTURE_SHADES_NEAR = 12
const NEAR_BLOCKS = 8
/** …and darker than this on average (luma 0–255): strokes on black, not lettering on a light ring. */
const NEAR_LUMA = 100

/**
 * The pixels of the source that are texture (hatching, engraving, fur, wood grain), judged in
 * BLOCK px blocks with their neighbours: busy (TEXTURE_BUSY) and many-coloured (TEXTURE_SHADES).
 * Solid shapes, lettering and outlines stay out, even the black inside an engraving. Areas under
 * `minArea` px are dropped.
 */
export function texturedMask(src: ImageData, minArea = 16 * BLOCK * BLOCK): Uint8Array {
  const { width: w, height: h, data: d } = src
  const bw = Math.ceil(w / BLOCK)
  const bh = Math.ceil(h / BLOCK)
  const far = (i: number, j: number) => Math.max(Math.abs(d[i] - d[j]), Math.abs(d[i + 1] - d[j + 1]), Math.abs(d[i + 2] - d[j + 2])) > 48
  const busy = new Float32Array(bw * bh)
  const luma = new Float32Array(bw * bh)
  const shades: Map<number, number>[] = []
  for (let by = 0; by < bh; by++)
    for (let bx = 0; bx < bw; bx++) {
      const counts = new Map<number, number>()
      let n = 0
      let changes = 0
      let light = 0
      for (let y = by * BLOCK; y < Math.min(h - 1, (by + 1) * BLOCK); y++)
        for (let x = bx * BLOCK; x < Math.min(w - 1, (bx + 1) * BLOCK); x++) {
          const i = (y * w + x) * 4
          if (d[i + 3] < 128) continue
          n++
          light += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
          if (far(i, i + 4) || far(i, i + w * 4)) changes++
          const shade = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4)
          counts.set(shade, (counts.get(shade) ?? 0) + 1)
        }
      busy[by * bw + bx] = n ? changes / n : 0
      luma[by * bw + bx] = n ? light / n : 255
      shades.push(counts)
    }
  const blocks = new Uint8Array(bw * bh)
  const weak = new Uint8Array(bw * bh)
  for (let by = 0; by < bh; by++)
    for (let bx = 0; bx < bw; bx++) {
      let sum = 0
      let k = 0
      const counts = new Map<number, number>()
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const X = bx + dx
          const Y = by + dy
          if (X < 0 || Y < 0 || X >= bw || Y >= bh) continue
          sum += busy[Y * bw + X]
          k++
          for (const [s, v] of shades[Y * bw + X]) counts.set(s, (counts.get(s) ?? 0) + v)
        }
      let many = 0
      for (const v of counts.values()) if (v >= 6) many++
      if (sum / k > TEXTURE_BUSY && many >= TEXTURE_SHADES) blocks[by * bw + bx] = 1
      else if (sum / k > NEAR_BUSY && many >= TEXTURE_SHADES_NEAR && luma[by * bw + bx] < NEAR_LUMA) weak[by * bw + bx] = 1
    }
  // The edges of an engraving are sparser (a few strokes on black) and pass a lower bar only:
  // they're taken in up to NEAR_BLOCKS from clear texture when dark. Lettering on a light ring
  // next to the texture passes the lower bar too, but isn't dark.
  for (let k = 0; k < NEAR_BLOCKS; k++) {
    const reach = grow(blocks, bw, bh)
    for (let b = 0; b < blocks.length; b++) if (reach[b] && weak[b]) blocks[b] = 1
  }
  // Inside an engraving, solid black and smooth highlights (a forehead, a muzzle) are blocks of
  // their own: left out, they'd be flat patches with square edges among the shading. Close gaps
  // of one block, then take in every hole the texture surrounds.
  const closed = fillHoles(shrink(grow(blocks, bw, bh), bw, bh), bw)
  // Blocks to pixels by bilinear interpolation between block centres, so the edge runs diagonally
  // and round instead of in BLOCK px steps (which show as squares against the flat layer).
  const mask = new Uint8Array(w * h)
  const at = (x: number, y: number) => closed[Math.min(bh - 1, Math.max(0, y)) * bw + Math.min(bw - 1, Math.max(0, x))]
  for (let y = 0; y < h; y++) {
    const fy = (y + 0.5) / BLOCK - 0.5
    const y0 = Math.floor(fy)
    const ty = fy - y0
    for (let x = 0; x < w; x++) {
      const fx = (x + 0.5) / BLOCK - 0.5
      const x0 = Math.floor(fx)
      const tx = fx - x0
      const v = (at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty) + (at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty
      if (v > 0.5) mask[y * w + x] = 1
    }
  }
  return dropSmall(mask, w, h, minArea)
}

/** Each block with any of its 8 neighbours set (grow) or with all of them set (shrink). */
function grow(m: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(m.length)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let dy = -1; dy <= 1 && !out[y * w + x]; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const X = x + dx, Y = y + dy
          if (X >= 0 && Y >= 0 && X < w && Y < h && m[Y * w + X]) {
            out[y * w + x] = 1
            break
          }
        }
  return out
}
function shrink(m: Uint8Array, w: number, h: number): Uint8Array {
  const inv = grow(m.map((v) => 1 - v), w, h)
  return inv.map((v) => 1 - v)
}

/**
 * Sets every area of 0s that doesn't reach the edge (a hole surrounded by the mask) and is under
 * 1% of the image. A larger one is artwork of its own, such as a banner of lettering between the
 * hands and fur that hold it, and keeps its clean edges.
 */
function fillHoles(m: Uint8Array, w: number): Uint8Array {
  const out = m.slice()
  const seen = new Uint8Array(m.length)
  const max = m.length * 0.01
  for (let s = 0; s < m.length; s++) {
    if (m[s] || seen[s]) continue
    const area: number[] = []
    const stack = [s]
    seen[s] = 1
    let edge = false
    while (stack.length) {
      const p = stack.pop()!
      area.push(p)
      const x = p % w
      if (x === 0 || x === w - 1 || p < w || p >= m.length - w) edge = true
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w]) if (q >= 0 && q < m.length && !m[q] && !seen[q]) (seen[q] = 1), stack.push(q)
    }
    if (!edge && area.length < max) for (const p of area) out[p] = 1
  }
  return out
}

/** Removes 4-connected areas of the mask smaller than `minArea`. */
function dropSmall(m: Uint8Array, w: number, h: number, minArea: number): Uint8Array {
  const n = w * h
  const seen = new Uint8Array(n)
  const stack = new Int32Array(n)
  const members: number[] = []
  for (let s = 0; s < n; s++) {
    if (!m[s] || seen[s]) continue
    seen[s] = 1
    let top = 0
    stack[top++] = s
    members.length = 0
    while (top) {
      const p = stack[--top]
      members.push(p)
      const x = p % w
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w]) if (q >= 0 && q < n && m[q] && !seen[q]) (seen[q] = 1), (stack[top++] = q)
    }
    if (members.length < minArea) for (const p of members) m[p] = 0
  }
  return m
}

/** Width (px) of the band along the texture's edge where the flat map keeps its colours. */
const SEAM_BAND = 3

/**
 * The label map with each texture area filled with its most common label (pure, no blends), but
 * for a SEAM_BAND px band inside its edge. The shading layer draws over it, so its colour only
 * shows if the shading leaves a gap.
 */
export function fillTexture(map: LabelMap, texture: Uint8Array): LabelMap {
  const { w, h } = map
  const n = w * h
  // A band inside the edge keeps its own colours: the shading's anti-aliased edge blends with the
  // flat layer there, and a fill colour would show as a seam.
  let mask = texture
  for (let k = 0; k < SEAM_BAND; k++) {
    const next = new Uint8Array(n)
    for (let p = 0; p < n; p++) {
      const x = p % w
      next[p] = mask[p] && x > 0 && x < w - 1 && p >= w && p < n - w && mask[p - 1] && mask[p + 1] && mask[p - w] && mask[p + w] ? 1 : 0
    }
    mask = next
  }
  const labels = map.labels.slice()
  const second = map.second.slice()
  const cov = map.cov.slice()
  const seen = new Uint8Array(n)
  const stack = new Int32Array(n)
  const members: number[] = []
  const counts = new Map<number, number>()
  for (let s = 0; s < n; s++) {
    if (!mask[s] || seen[s]) continue
    seen[s] = 1
    let top = 0
    stack[top++] = s
    members.length = 0
    counts.clear()
    while (top) {
      const p = stack[--top]
      members.push(p)
      counts.set(map.labels[p], (counts.get(map.labels[p]) ?? 0) + 1)
      const x = p % w
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w]) if (q >= 0 && q < n && mask[q] && !seen[q]) (seen[q] = 1), (stack[top++] = q)
    }
    let best = members.length ? map.labels[members[0]] : 0
    let most = -1
    for (const [l, c] of counts) if (l < 254 && c > most) [best, most] = [l, c]
    for (const p of members) {
      labels[p] = best
      second[p] = 255
      cov[p] = 1
    }
  }
  // Fine detail reads the same filled labelling (its kept line ends inside texture are covered too).
  return { ...map, labels, second, cov, ...(map.fine ? { fine: { labels, second, cov } } : {}) }
}

/** Radius (px) of the averaging that turns texture into tones (simplifyTexture). */
const SIMPLIFY_RADIUS = 3
/** Shapes inside the texture smaller than this share of the image are merged into their surroundings. */
const SIMPLIFY_MIN_SHARE = 0.0005

/**
 * The label map with the texture redrawn as a few solid shapes, as a designer redrawing the logo
 * would: by its tones, not its strokes. Each texture pixel takes the flat colour nearest to the
 * source averaged over SIMPLIFY_RADIUS (black and orange hatching reads as brown, as it does from
 * a distance; the most common colour would make engraved fur a black blob), then shapes under
 * SIMPLIFY_MIN_SHARE of the image join the colour around them. The flat colours are unchanged:
 * the Gorilla Glue fur becomes black, brown, orange and cream shapes, with holes, instead of
 * strokes. Edge blends inside the texture are dropped (the shapes are new, not the image's).
 */
export function simplifyTexture(map: LabelMap, texture: Uint8Array, src: ImageData): LabelMap {
  const { w, h } = map
  const n = w * h
  const labels = map.labels.slice()
  const second = map.second.slice()
  const cov = map.cov.slice()
  // Box average of the source per channel, from summed-area tables.
  const d = src.data
  const sats = [0, 1, 2].map((c) => {
    const sat = new Float64Array((w + 1) * (h + 1))
    for (let y = 0; y < h; y++) {
      let row = 0
      for (let x = 0; x < w; x++) {
        row += d[(y * w + x) * 4 + c]
        sat[(y + 1) * (w + 1) + x + 1] = sat[y * (w + 1) + x + 1] + row
      }
    }
    return sat
  })
  const R = SIMPLIFY_RADIUS
  const avg = new Float32Array(n * 3)
  const inside: number[] = []
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - R), y1 = Math.min(h, y + R + 1)
    for (let x = 0; x < w; x++) {
      const p = y * w + x
      if (!texture[p]) continue
      const x0 = Math.max(0, x - R), x1 = Math.min(w, x + R + 1)
      const area = (x1 - x0) * (y1 - y0)
      for (let c = 0; c < 3; c++) avg[p * 3 + c] = (sats[c][y1 * (w + 1) + x1] - sats[c][y0 * (w + 1) + x1] - sats[c][y1 * (w + 1) + x0] + sats[c][y0 * (w + 1) + x0]) / area
      inside.push(p)
    }
  }
  if (!inside.length) return map
  // The texture's own tones (a designer picks a few fur colours from the fur), each reusing a flat
  // colour when one is close, so the palette grows only by tones the artwork lacks.
  const tones = kmeansRgb(inside, avg, SIMPLIFY_TONES)
  const colors = map.colors.slice()
  const toneLabel = tones.map(([r, g, b]) => {
    let near = -1
    let nearDist = SAME_TONE ** 2
    colors.forEach((c, l) => {
      if (c < 0) return
      const dist = (((c >> 16) & 255) - r) ** 2 + (((c >> 8) & 255) - g) ** 2 + ((c & 255) - b) ** 2
      if (dist < nearDist) [near, nearDist] = [l, dist]
    })
    if (near >= 0 || colors.length >= 254) return near >= 0 ? near : 0
    colors.push((Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b))
    return colors.length - 1
  })
  // Black line work isn't kept apart: in engraving it's most of the texture (keeping pixels dark
  // over 3×3 px turned the Gorilla Glue fur black again), so faces keep their tones, not their lines.
  for (const p of inside) {
    let best = Infinity
    tones.forEach(([r, g, b], k) => {
      const dist = (avg[p * 3] - r) ** 2 + (avg[p * 3 + 1] - g) ** 2 + (avg[p * 3 + 2] - b) ** 2
      if (dist < best) {
        best = dist
        labels[p] = toneLabel[k]
      }
    })
  }
  for (let p = 0; p < n; p++)
    if (texture[p]) {
      second[p] = 255
      cov[p] = 1
    }
  // Small shapes inside the texture join the label they border most.
  const minArea = Math.max(16, Math.round(n * SIMPLIFY_MIN_SHARE))
  const seen = new Uint8Array(n)
  const stack = new Int32Array(n)
  const members: number[] = []
  const around = new Map<number, number>()
  for (let s = 0; s < n; s++) {
    if (!texture[s] || seen[s]) continue
    const l = labels[s]
    seen[s] = 1
    let top = 0
    stack[top++] = s
    members.length = 0
    around.clear()
    while (top) {
      const p = stack[--top]
      members.push(p)
      const x = p % w
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w]) {
        if (q < 0 || q >= n) continue
        if (labels[q] === l) {
          if (!seen[q] && texture[q]) (seen[q] = 1), (stack[top++] = q)
        } else around.set(labels[q], (around.get(labels[q]) ?? 0) + 1)
      }
    }
    if (members.length >= minArea || !around.size) continue
    let to = l
    let most = 0
    for (const [k, c] of around) if (k < 254 && c > most) [to, most] = [k, c]
    for (const p of members) labels[p] = to
  }
  return { ...map, colors, labels, second, cov, ...(map.fine ? { fine: { labels, second, cov } } : {}) }
}

/** Tones a simplified texture is drawn in. */
const SIMPLIFY_TONES = 5
/** A tone this close (RGB distance) to a flat colour uses that colour. */
const SAME_TONE = 24

/** k-means of the colours `avg` holds at `pixels`, started from evenly spaced lightness quantiles. */
function kmeansRgb(pixels: number[], avg: Float32Array, k: number): [number, number, number][] {
  const step = Math.max(1, Math.floor(pixels.length / 20000))
  const sample = pixels.filter((_, i) => i % step === 0)
  const light = (p: number) => 0.299 * avg[p * 3] + 0.587 * avg[p * 3 + 1] + 0.114 * avg[p * 3 + 2]
  const sorted = sample.slice().sort((a, b) => light(a) - light(b))
  let centers = Array.from({ length: k }, (_, i) => {
    const p = sorted[Math.min(sorted.length - 1, Math.floor(((i + 0.5) / k) * sorted.length))]
    return [avg[p * 3], avg[p * 3 + 1], avg[p * 3 + 2]] as [number, number, number]
  })
  for (let it = 0; it < 12; it++) {
    const sums = centers.map(() => [0, 0, 0, 0])
    for (const p of sample) {
      let best = 0
      let bestDist = Infinity
      centers.forEach(([r, g, b], c) => {
        const dist = (avg[p * 3] - r) ** 2 + (avg[p * 3 + 1] - g) ** 2 + (avg[p * 3 + 2] - b) ** 2
        if (dist < bestDist) [best, bestDist] = [c, dist]
      })
      sums[best][0] += avg[p * 3]
      sums[best][1] += avg[p * 3 + 1]
      sums[best][2] += avg[p * 3 + 2]
      sums[best][3]++
    }
    centers = centers.map((c, i) => (sums[i][3] ? [sums[i][0] / sums[i][3], sums[i][1] / sums[i][3], sums[i][2] / sums[i][3]] : c))
  }
  return centers
}

/**
 * The shading image with everything outside the texture made transparent, so VTracer only traces
 * the texture (it leaves transparent pixels empty) and its outline is the texture's edge. `mask` is
 * in flat-map pixels (w × h); the shading image may be larger. `pad` flat px around the texture
 * are kept too (none by default: the flat layer under the edge keeps its own colours, fillTexture).
 */
export function onlyTexture(image: ImageData, mask: Uint8Array, w: number, h: number, pad = 0): ImageData {
  // Grow the mask by `pad` (rows, then columns).
  const rows = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    let last = -Infinity
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x]) last = x
      if (x - last <= pad) rows[y * w + x] = 1
    }
    last = Infinity
    for (let x = w - 1; x >= 0; x--) {
      if (mask[y * w + x]) last = x
      if (last - x <= pad) rows[y * w + x] = 1
    }
  }
  const grown = new Uint8Array(w * h)
  for (let x = 0; x < w; x++) {
    let last = -Infinity
    for (let y = 0; y < h; y++) {
      if (rows[y * w + x]) last = y
      if (y - last <= pad) grown[y * w + x] = 1
    }
    last = Infinity
    for (let y = h - 1; y >= 0; y--) {
      if (rows[y * w + x]) last = y
      if (last - y <= pad) grown[y * w + x] = 1
    }
  }
  const { width: W, height: H } = image
  const data = image.data.slice()
  for (let Y = 0; Y < H; Y++) {
    const y = Math.min(h - 1, Math.floor((Y * h) / H))
    for (let X = 0; X < W; X++) {
      const x = Math.min(w - 1, Math.floor((X * w) / W))
      if (!grown[y * w + x]) data.fill(0, (Y * W + X) * 4, (Y * W + X) * 4 + 4)
    }
  }
  return new ImageData(data, W, H)
}

/** The share of the image that is texture. */
export const maskShare = (mask: Uint8Array) => mask.reduce((s, v) => s + v, 0) / (mask.length || 1)

/**
 * Shorter path data with the same shape, for VTracer's output (M, C and Z, absolute): curves whose
 * controls lie on their chord become lines (h, v or l), and every step is relative, written to
 * `precision` decimals without spare characters. Steps are taken between rounded absolute points,
 * so rounding never accumulates. Other commands are left as they are.
 */
export function compactPath(d: string, precision = 1): string {
  if (/[^MCZmcz\d\s.,eE+-]/.test(d)) return d
  const nums = d.match(/[MCZmcz]|-?\d*\.?\d+(?:e[+-]?\d+)?/gi) ?? []
  const f = 10 ** precision
  const r = (v: number) => Math.round(v * f) / f
  const fmt = (v: number) => {
    const s = String(r(v) || 0)
    return s.replace(/^(-?)0\./, '$1.')
  }
  // Joins numbers with the fewest separators: none before "-", or before "." after a decimal.
  const join = (vals: number[]) => {
    let out = ''
    let prev = ''
    for (const v of vals) {
      const s = fmt(v)
      if (out && !(s[0] === '-' || (s[0] === '.' && prev.includes('.')))) out += ' '
      out += s
      prev = s
    }
    return out
  }
  let out = ''
  let i = 0
  let cx = 0, cy = 0 // rounded current point
  let sx = 0, sy = 0
  let cmd = ''
  const num = () => Number(nums[i++])
  while (i < nums.length) {
    if (/^[MCZmcz]$/.test(nums[i])) cmd = nums[i++]
    if (cmd === 'Z' || cmd === 'z') {
      out += 'z'
      cx = sx
      cy = sy
      cmd = ''
      continue
    }
    if (cmd === 'M') {
      const x = r(num()), y = r(num())
      out += 'm' + join([x - cx, y - cy])
      cx = sx = x
      cy = sy = y
      // VTracer always follows M with a command letter; bare pairs (implicit lines) end up below.
      cmd = ''
      continue
    }
    if (cmd === 'C') {
      const x1 = num(), y1 = num(), x2 = num(), y2 = num()
      const x = r(num()), y = r(num())
      const dx = x - cx, dy = y - cy
      const len = Math.hypot(dx, dy)
      const off = (px: number, py: number) => (len ? Math.abs((px - cx) * dy - (py - cy) * dx) / len : Math.hypot(px - cx, py - cy))
      const along = (px: number, py: number) => (len ? ((px - cx) * dx + (py - cy) * dy) / (len * len) : 0)
      const straight = off(x1, y1) <= 0.5 / f && off(x2, y2) <= 0.5 / f && along(x1, y1) >= -0.01 && along(x1, y1) <= 1.01 && along(x2, y2) >= -0.01 && along(x2, y2) <= 1.01
      if (straight) out += dy === 0 ? 'h' + join([dx]) : dx === 0 ? 'v' + join([dy]) : 'l' + join([dx, dy])
      else out += 'c' + join([x1 - cx, y1 - cy, x2 - cx, y2 - cy, dx, dy])
      cx = x
      cy = y
      continue
    }
    return d // relative input or anything unexpected: keep the original
  }
  return out
}

/** compactPath on every path of an SVG fragment. */
export const compactPaths = (svg: string, precision = 1) => svg.replace(/(<path\b[^>]*?\sd=")([^"]*)"/g, (_, head: string, d: string) => `${head}${compactPath(d, precision)}"`)

const viewBox = (svg: string): [number, number, number, number] | null => {
  const nums = svg.match(/<svg\b[^>]*\sviewBox="([^"]+)"/i)?.[1].split(/[\s,]+/).map(Number)
  return nums?.length === 4 && nums.every(Number.isFinite) ? (nums as [number, number, number, number]) : null
}
const inner = (svg: string) => svg.replace(/^[\s\S]*?<svg\b[^>]*>/i, '').replace(/<\/svg>\s*$/i, '')

/**
 * The flat SVG with the full-colour SVG drawn over it as a group of its own ("Shading"), scaled to
 * the flat viewBox when the two were traced at different sizes. The full-colour drawing was traced
 * from the texture only (onlyTexture), so it needs no clip path: the file stays plain filled paths,
 * which Illustrator, CorelDRAW, cutters and the self-check all read as vector artwork.
 */
export function composeIllustration(flatSvg: string, photoSvg: string): string {
  const shading = compactPaths(inner(photoSvg)).trim()
  if (!/<path\b/.test(shading)) return flatSvg
  const fb = viewBox(flatSvg)
  const pb = viewBox(photoSvg)
  const scale = fb && pb ? [fb[2] / pb[2], fb[3] / pb[3]] : [1, 1]
  const transform = scale[0] !== 1 || scale[1] !== 1 ? ` transform="scale(${+scale[0].toFixed(6)} ${+scale[1].toFixed(6)})"` : ''
  return flatSvg.replace(/<\/svg>\s*$/i, `<g id="Shading"${transform}>${shading}</g></svg>`)
}
