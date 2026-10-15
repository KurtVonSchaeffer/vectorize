// Reconstruction-quality evaluator (bench only; separate from the print / cut file checks in
// src/export/validate.ts). Compares a result with the clean original region by region and edge by
// edge, so a visibly wrong logo can't pass on a low overall pixel error: each colour region's
// overlap, how far edges moved, whether corners kept their shape, colour halos, bulges and
// notches, and shapes merged, split, lost or added.
//
// All tolerances are in *upload* pixels: a redraw can't be asked to know more than the upload
// shows, but anything it gets wrong by more than about a pixel of the upload is visible.

export interface Defect {
  kind: 'region' | 'edge' | 'corner' | 'halo' | 'shades' | 'bulge' | 'notch' | 'merged' | 'split' | 'missing' | 'extra' | 'colour'
  /** Where, in original px, and how big (upload px for distances, % for regions). */
  x: number
  y: number
  size: number
  note: string
}

export interface Evaluation {
  /** Per colour of the original: overlap with the result (intersection over union, 0–1). */
  regions: { color: string; iou: number }[]
  /** Edge position error, upload px: 95th percentile and worst, of result edges from original edges (placed) and the reverse (missed). */
  edges: { p95: number; max: number; missedP95: number }
  corners: { total: number; kept: number }
  /** Pixels of a colour that isn't in the original, as % of the artwork. */
  foreign: number
  /** Colour accuracy per region (mean ΔE76 of the result's pixels from the original colour), separate from geometry. */
  colours: { color: string; deltaE: number }[]
  defects: Defect[]
  /** No defect beyond tolerance. */
  pass: boolean
}

export interface EvaluateOptions {
  /** Original px per upload px. */
  scale: number
  /** Allowed edge offset, upload px. Default 1. */
  edgeTolerance?: number
  /** A region must overlap at least this much. Default 0.9. */
  minIou?: number
}

interface Classified {
  w: number
  h: number
  /** The rendered colour per pixel. */
  rgb: Int32Array
  cls: Int16Array
  /** Colour distance (ΔE76) of each pixel to its class colour. */
  de: Float32Array
}

const FOREIGN = -1

/** Fill colours named in an SVG (the original's palette). */
export function paletteOf(svg: string): number[] {
  const out = new Set<number>()
  for (const m of svg.matchAll(/fill="#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})"/g)) {
    const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1]
    out.add(parseInt(h, 16))
  }
  return [...out]
}

/** Renders an SVG at w×h without anti-aliasing, so every pixel is one of its colours. */
export async function renderCrisp(svg: string, w: number, h: number): Promise<ImageData> {
  const crisp = svg.replace(/<svg\b/, '<svg shape-rendering="crispEdges"')
  const img = new Image()
  img.src = URL.createObjectURL(new Blob([crisp], { type: 'image/svg+xml' }))
  await img.decode()
  const c = new OffscreenCanvas(w, h)
  const g = c.getContext('2d')!
  g.fillStyle = '#fff'
  g.fillRect(0, 0, w, h)
  g.drawImage(img, 0, 0, w, h)
  return g.getImageData(0, 0, w, h)
}

function lab(c: number): [number, number, number] {
  const f = (v: number) => {
    v /= 255
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  const r = f((c >> 16) & 255), g = f((c >> 8) & 255), b = f(c & 255)
  const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047
  const y = r * 0.2126 + g * 0.7152 + b * 0.0722
  const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883
  const t = (v: number) => (v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116)
  return [116 * t(y) - 16, 500 * (t(x) - t(y)), 200 * (t(y) - t(z))]
}

function classify(img: ImageData, palette: number[]): Classified {
  const { width: w, height: h, data } = img
  const labs = palette.map(lab)
  const cls = new Int16Array(w * h)
  const de = new Float32Array(w * h)
  const rgb = new Int32Array(w * h)
  const cache = new Map<number, [number, number]>()
  for (let p = 0; p < w * h; p++) {
    const c = (data[p * 4] << 16) | (data[p * 4 + 1] << 8) | data[p * 4 + 2]
    rgb[p] = c
    let hit = cache.get(c)
    if (!hit) {
      const l = lab(c)
      let best = 0, bd = Infinity
      labs.forEach((q, i) => {
        const d = Math.hypot(l[0] - q[0], l[1] - q[1], l[2] - q[2])
        if (d < bd) [best, bd] = [i, d]
      })
      hit = [best, bd]
      cache.set(c, hit)
    }
    // Geometry uses the nearest original colour, so a slight colour shift isn't a shape error;
    // only a clearly different colour (a halo, a new colour) is foreign. Colour accuracy is
    // checked separately, per region.
    cls[p] = hit[1] > 30 ? FOREIGN : hit[0]
    de[p] = hit[1]
  }
  return { w, h, rgb, cls, de }
}

/** Boundary pixels: a 4-neighbour has another class. */
function boundary(c: Classified): Uint8Array {
  const { w, h, cls } = c
  const b = new Uint8Array(w * h)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = y * w + x
      if ((x + 1 < w && cls[p + 1] !== cls[p]) || (y + 1 < h && cls[p + w] !== cls[p])) b[p] = 1
      if ((x > 0 && cls[p - 1] !== cls[p]) || (y > 0 && cls[p - w] !== cls[p])) b[p] = 1
    }
  return b
}

/** Euclidean distance to the nearest set pixel (Felzenszwalb & Huttenlocher). */
export function distanceTo(seed: Uint8Array, w: number, h: number): Float32Array {
  const INF = 1e12
  const n = Math.max(w, h)
  const f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1)
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
    for (let x = 0; x < w; x++) g[y * w + x] = Math.sqrt(d[x])
  }
  return g
}

/** Connected pieces (4-connected) of the pixels `take` accepts. */
function pieces(w: number, h: number, take: (p: number) => boolean): number[][] {
  const seen = new Uint8Array(w * h)
  const out: number[][] = []
  for (let s = 0; s < w * h; s++) {
    if (seen[s] || !take(s)) continue
    const px: number[] = []
    const stack = [s]
    seen[s] = 1
    while (stack.length) {
      const p = stack.pop()!
      px.push(p)
      const x = p % w
      for (const q of [x > 0 ? p - 1 : -1, x + 1 < w ? p + 1 : -1, p - w, p + w])
        if (q >= 0 && q < w * h && !seen[q] && take(q)) {
          seen[q] = 1
          stack.push(q)
        }
    }
    out.push(px)
  }
  return out
}

const centre = (px: number[], w: number) => {
  let sx = 0, sy = 0
  for (const p of px) [sx, sy] = [sx + (p % w), sy + Math.floor(p / w)]
  return { x: Math.round(sx / px.length), y: Math.round(sy / px.length) }
}

const pct = (a: number) => Math.round(a * 1000) / 10
const round2 = (a: number) => Math.round(a * 100) / 100

export async function evaluate(originalSvg: string, resultSvg: string, w: number, h: number, o: EvaluateOptions): Promise<Evaluation> {
  const palette = paletteOf(originalSvg)
  const ref = classify(await renderCrisp(originalSvg, w, h), palette)
  const out = classify(await renderCrisp(resultSvg, w, h), palette)
  return compare(ref, out, palette, o)
}

function compare(ref: Classified, out: Classified, palette: number[], o: EvaluateOptions): Evaluation {
  const { w, h } = ref
  const n = w * h
  const k = o.scale
  const tol = (o.edgeTolerance ?? 1) * k
  const minIou = o.minIou ?? 0.9
  const defects: Defect[] = []
  const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`
  // Background: the class along the border.
  const bgCount = new Map<number, number>()
  for (let x = 0; x < w; x++) for (const p of [x, (h - 1) * w + x]) bgCount.set(ref.cls[p], (bgCount.get(ref.cls[p]) ?? 0) + 1)
  const bg = [...bgCount].sort((a, b) => b[1] - a[1])[0][0]
  let art = 0
  for (let p = 0; p < n; p++) if (ref.cls[p] !== bg) art++

  // 1. Regions: overlap per colour.
  const regions = palette.map((c, i) => {
    let inter = 0, uni = 0
    for (let p = 0; p < n; p++) {
      const a = ref.cls[p] === i, b = out.cls[p] === i
      if (a && b) inter++
      if (a || b) uni++
    }
    return { color: hex(c), iou: uni ? round2(inter / uni) : 1, area: uni }
  })
  for (const r of regions) if (r.area > 0.002 * n && r.iou < minIou) defects.push({ kind: 'region', x: -1, y: -1, size: pct(r.iou), note: `${r.color} region overlaps the original by only ${pct(r.iou)}%` })

  // 2. Edges: how far the result's edges are from the original's, and the reverse.
  const rb = boundary(ref), ob = boundary(out)
  const dToRef = distanceTo(rb, w, h), dToOut = distanceTo(ob, w, h)
  const placed: number[] = [], missed: number[] = []
  for (let p = 0; p < n; p++) {
    if (ob[p]) placed.push(dToRef[p])
    if (rb[p]) missed.push(dToOut[p])
  }
  const q95 = (a: number[]) => (a.length ? a.sort((x, y) => x - y)[Math.floor(a.length * 0.95)] : 0)
  const edges = { p95: round2(q95(placed) / k), max: round2((placed.length ? Math.max(...placed) : 0) / k), missedP95: round2(q95(missed) / k) }
  if (edges.p95 > (o.edgeTolerance ?? 1)) defects.push({ kind: 'edge', x: -1, y: -1, size: edges.p95, note: `5% of edges are more than ${edges.p95} upload px from the original's` })

  // 3. Wrong pixels, grouped: halos (a colour the original doesn't have, or doesn't have there,
  // in a thin band), bulges and notches (an edge pushed out or pulled in beyond tolerance).
  const wrong = (p: number) => ref.cls[p] !== out.cls[p]
  let foreign = 0
  for (let p = 0; p < n; p++) if (out.cls[p] === FOREIGN && ref.cls[p] !== FOREIGN) foreign++
  for (const px of pieces(w, h, wrong)) {
    const mask = new Uint8Array(n)
    for (const p of px) mask[p] = 1
    // Thickness: twice the deepest point's distance to the piece's outside.
    const outside = new Uint8Array(n)
    for (let p = 0; p < n; p++) outside[p] = mask[p] ? 0 : 1
    const inner = distanceTo(outside, w, h)
    let thick = 0
    for (const p of px) thick = Math.max(thick, inner[p])
    thick *= 2
    if (px.length < (k * k) / 2) continue
    const at = centre(px, w)
    // Classes the original has right next to this piece.
    const near = new Set<number>()
    for (const p of px) for (const q of [p - 1, p + 1, p - w, p + w]) if (q >= 0 && q < n && !mask[q]) near.add(ref.cls[q])
    const cand = new Map<number, number>()
    for (const p of px) cand.set(out.cls[p], (cand.get(out.cls[p]) ?? 0) + 1)
    const drawn = [...cand].sort((a, b) => b[1] - a[1])[0][0]
    const longThin = thick <= 1.5 * k && px.length >= 6 * k * k
    if (drawn === FOREIGN || (!near.has(drawn) && longThin)) {
      if (px.length >= 2 * k * k) defects.push({ kind: 'halo', ...at, size: round2(thick / k), note: `${drawn === FOREIGN ? 'a colour the original does not use' : `${hex(palette[drawn])}, which the original has nowhere near here,`} in a band ${round2(thick / k)} upload px wide` })
    } else if (thick > 2 * tol) {
      const fg = drawn !== bg
      defects.push({ kind: fg ? 'bulge' : 'notch', ...at, size: round2(thick / k), note: `${fg ? 'shape pushed out' : 'shape cut into'} by ${round2(thick / k)} upload px` })
    }
  }

  // 4. Corners of the original: the share of a disc around a sharp turn that is inside the shape.
  // A straight edge gives one half; a convex corner much less, a concave one much more. A corner is
  // kept when the result's share there is close.
  const R = Math.max(3, Math.round(1.5 * k))
  const disc: number[] = []
  for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) if (dx * dx + dy * dy <= R * R) disc.push(dy * w + dx)
  const share = (c: Classified, p: number, cl: number) => {
    let s = 0
    for (const d of disc) if (c.cls[p + d] === cl) s++
    return s / disc.length
  }
  const cornerPx = new Uint8Array(n)
  const shareAt = new Float32Array(n)
  const classAt = new Int16Array(n)
  for (let y = R; y < h - R; y++)
    for (let x = R; x < w - R; x++) {
      const p = y * w + x
      if (!rb[p] || ref.cls[p] === bg) continue
      const s = share(ref, p, ref.cls[p])
      if (s < 0.33 || s > 0.75) [cornerPx[p], shareAt[p], classAt[p]] = [1, s, ref.cls[p]]
    }
  let total = 0, kept = 0
  for (const px of pieces(w, h, (p) => cornerPx[p] === 1)) {
    if (px.length < 2) continue
    // The sharpest point of the cluster stands for the corner.
    let best = px[0]
    for (const p of px) if (Math.abs(shareAt[p] - 0.5) > Math.abs(shareAt[best] - 0.5)) best = p
    total++
    const s = share(out, best, classAt[best])
    if (Math.abs(s - shareAt[best]) <= 0.15) kept++
    else defects.push({ kind: 'corner', x: best % w, y: Math.floor(best / w), size: round2(Math.abs(s - shareAt[best])), note: `${shareAt[best] < 0.5 ? 'corner' : 'inside corner'} ${s > shareAt[best] === shareAt[best] < 0.5 ? 'rounded or filled' : 'cut or sharpened'} (${pct(shareAt[best])}% → ${pct(s)}% inside)` })
  }

  // 5. Topology: each original shape (connected piece of one colour) should be one result shape.
  const minShape = 4 * k * k
  for (let c = 0; c < palette.length; c++) {
    if (c === bg) continue
    const refShapes = pieces(w, h, (p) => ref.cls[p] === c).filter((s) => s.length >= minShape)
    const outShapes = pieces(w, h, (p) => out.cls[p] === c).filter((s) => s.length >= minShape)
    const owner = new Int32Array(n).fill(-1)
    refShapes.forEach((s, i) => s.forEach((p) => (owner[p] = i)))
    const hits = refShapes.map(() => new Set<number>())
    outShapes.forEach((s, j) => {
      const covered = new Map<number, number>()
      for (const p of s) if (owner[p] >= 0) covered.set(owner[p], (covered.get(owner[p]) ?? 0) + 1)
      const real = [...covered].filter(([i, m]) => m >= 0.2 * refShapes[i].length || m >= 0.5 * s.length)
      for (const [i] of real) hits[i].add(j)
      if (!real.length) defects.push({ kind: 'extra', ...centre(s, w), size: s.length / (k * k), note: `${hex(palette[c])} shape the original doesn't have` })
      if (real.length > 1) defects.push({ kind: 'merged', ...centre(s, w), size: real.length, note: `${real.length} ${hex(palette[c])} shapes joined into one` })
    })
    refShapes.forEach((s, i) => {
      if (!hits[i].size) defects.push({ kind: 'missing', ...centre(s, w), size: s.length / (k * k), note: `${hex(palette[c])} shape missing` })
      else if (hits[i].size > 1) defects.push({ kind: 'split', ...centre(s, w), size: hits[i].size, note: `${hex(palette[c])} shape broken into ${hits[i].size}` })
    })
  }
  if (pct(foreign / Math.max(1, art)) > 0.5) defects.push({ kind: 'colour', x: -1, y: -1, size: pct(foreign / art), note: `${pct(foreign / art)}% of the artwork is a colour the original doesn't use` })
  // Tone halos: a band drawn in a noticeably different shade of a colour (a
  // dark rim along a stripe, a blob of another shade inside a region). A whole region a little
  // off is a colour shift (below), not a halo, so only thin bands count.
  const off = (p: number) => out.cls[p] >= 0 && out.de[p] > 15
  for (const px of pieces(w, h, off)) {
    if (px.length < 2 * k * k) continue
    // Mean width (twice the area over the perimeter): a band that widens where two bands meet is still a band.
    const mask = new Uint8Array(n)
    for (const p of px) mask[p] = 1
    let rim = 0
    for (const p of px) if (!mask[p - 1] || !mask[p + 1] || !mask[p - w] || !mask[p + w]) rim++
    const thick = (2 * px.length) / Math.max(1, rim)
    const region = new Set<number>()
    for (const p of px) region.add(out.cls[p])
    const regionArea = [...region].reduce((t, c) => t + regions[c].area, 0)
    if (thick <= 2.5 * k && px.length < 0.5 * regionArea) defects.push({ kind: 'halo', ...centre(px, w), size: round2(thick / k), note: `a band of another shade inside ${[...region].map((c) => hex(palette[c])).join('/')}, ${round2(thick / k)} upload px wide` })
  }

  // Blotchy regions: one flat colour of the original drawn as two or more visibly different shades.
  for (let c = 0; c < palette.length; c++) {
    const hist = new Map<number, number>()
    let total = 0
    for (let p = 0; p < n; p++)
      if (ref.cls[p] === c) {
        hist.set(out.rgb[p], (hist.get(out.rgb[p]) ?? 0) + 1)
        total++
      }
    const main = [...hist].filter(([, m]) => m >= 0.08 * total).map(([col]) => col)
    const apart = main.some((a, i) => main.some((b, j) => j > i && Math.hypot(...lab(a).map((v, t) => v - lab(b)[t])) > 10))
    if (total > 0.002 * n && apart) defects.push({ kind: 'shades', x: -1, y: -1, size: main.length, note: `${hex(palette[c])} region drawn in ${main.length} different shades (${main.map(hex).join(', ')})` })
  }

  // Colour accuracy, per region where both agree on the shape.
  const sum = new Float64Array(palette.length), cnt = new Float64Array(palette.length)
  for (let p = 0; p < n; p++)
    if (ref.cls[p] >= 0 && ref.cls[p] === out.cls[p]) {
      sum[ref.cls[p]] += out.de[p]
      cnt[ref.cls[p]]++
    }
  const colours = palette.map((c, i) => ({ color: hex(c), deltaE: cnt[i] ? round2(sum[i] / cnt[i]) : 0 }))
  for (const c of colours) if (c.deltaE > 10) defects.push({ kind: 'colour', x: -1, y: -1, size: c.deltaE, note: `${c.color} drawn ΔE ${c.deltaE} off (visible colour change)` })

  return {
    regions: regions.map(({ color, iou }) => ({ color, iou })),
    edges,
    corners: { total, kept },
    foreign: pct(foreign / Math.max(1, art)),
    colours,
    defects,
    pass: defects.length === 0,
  }
}
