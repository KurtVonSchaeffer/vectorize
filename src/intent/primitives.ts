// Design-intent prototype (research, docs/design-intent.md): objects decomposed into design
// primitives. A designer redrawing a mascot draws each object (head, face, muzzle, hand) as a
// solid base shape, then cuts in its few defining features: the shadows (eye sockets, nostrils,
// the parting of the fur) and the highlights (brow ridge, muzzle, knuckles), each a smooth
// solid shape. Everything smaller is dropped. Colours are shared across the drawing from a small
// palette, and the result is traced as knockout shapes (no overlaps, holes punched) and written as
// one compound path per colour.
import type { LabelMap } from '../trace'
import type { ObjectMask } from './sam'

export interface PrimitiveOptions {
  /** Lightness (luma 0–255) a feature must differ from its object's base by. */
  contrast?: number
  /** Features smaller than this share of their object's own area are dropped… */
  minShare?: number
  /** …and smaller than this many px. */
  minArea?: number
  /** Feature outlines are smoothed by blurring them over this share of √(object area)… */
  smoothShare?: number
  /** …at least this many px. */
  minSmooth?: number
  /** At most this many features in the whole drawing, the most visible first (area × contrast). */
  budget?: number
  /**
   * Masses (objects over massShare of the image: a head, shoulders) keep at most massFeatures
   * features, each at least massMinShare of the mass. A designer draws fur as a solid shape with
   * a shadow or two, not as highlight blobs scattered over it.
   */
  massShare?: number
  massFeatures?: number
  massMinShare?: number
  /** Colours within this RGB distance share one. */
  merge?: number
  /** Mirror parts whose silhouette matches its mirror image at least this well (IoU)… */
  symmetry?: number
  /** …and that are at most this share of the image. */
  mirrorMaxShare?: number
  /** Finally, any piece of the texture under this share of the image joins its surroundings. */
  finalMinShare?: number
}

export interface Primitive {
  object: number
  kind: 'base' | 'shadow' | 'highlight'
  area: number
  color: [number, number, number]
}

export interface Decomposition {
  map: LabelMap
  primitives: Primitive[]
  /** Objects as a tree: parent index per object (−1 for a root). */
  parents: number[]
  mirrored: number[]
  palette: number[]
}

const luma = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b

/**
 * Replaces the texture of `map` with the objects' primitives. `texture` is the area that may
 * change; pixels of it in no object keep the base of the object around them, or the flat label.
 */
export function decompose(map: LabelMap, objects: ObjectMask[], src: ImageData, texture: Uint8Array, opts: PrimitiveOptions = {}): Decomposition {
  const { contrast = 28, minShare = 0.01, minArea = 120, smoothShare = 0.03, minSmooth = 2, budget = 40, merge = 30, symmetry = 0.9, mirrorMaxShare = 0.2, finalMinShare = 0.0005, massShare = 0.03, massFeatures = 2, massMinShare = 0.05 } = opts
  const { w, h } = map
  const n = w * h
  const avg = boxAverage(src, 2)

  // 1. Hierarchy: each object's parent is the smallest larger object holding 80% of it.
  const order = objects.map((_, i) => i).sort((a, b) => objects[b].area - objects[a].area)
  const parents = objects.map(() => -1)
  order.forEach((i, k) => {
    let best = -1
    for (let j = 0; j < k; j++) {
      const p = order[j]
      if (objects[p].area <= objects[i].area) continue
      let inside = 0
      for (let q = 0; q < n; q++) if (objects[i].mask[q] && objects[p].mask[q]) inside++
      if (inside >= objects[i].area * 0.8 && (best < 0 || objects[p].area < objects[best].area)) best = p
    }
    parents[i] = best
  })
  // 2. Ownership: each texture pixel belongs to the smallest object holding it.
  const owner = new Int32Array(n).fill(-1)
  for (const i of order) for (let q = 0; q < n; q++) if (objects[i].mask[q] && texture[q]) owner[q] = i
  const own = objects.map(() => [] as number[])
  for (let q = 0; q < n; q++) if (owner[q] >= 0) own[owner[q]].push(q)

  // 3. Per object: base colour, then shadow and highlight features, smoothed and filtered.
  const level = new Int8Array(n) // −1 shadow, 0 base, 1 highlight
  const featureId = new Int32Array(n).fill(-1)
  type Feature = { object: number; kind: 'shadow' | 'highlight'; pixels: number[]; score: number }
  const features: Feature[] = []
  const base: [number, number, number][] = objects.map(() => [0, 0, 0])
  objects.forEach((o, i) => {
    const px = own[i]
    if (!px.length) return
    const lights = px.map((q) => luma(avg[q * 3], avg[q * 3 + 1], avg[q * 3 + 2])).sort((a, b) => a - b)
    const half = lights[lights.length >> 1]
    const sigma = Math.max(minSmooth, Math.round(Math.sqrt(o.area) * smoothShare))
    const lum = new Float32Array(n)
    for (const q of px) lum[q] = luma(avg[q * 3], avg[q * 3 + 1], avg[q * 3 + 2])
    let r = 0, g = 0, b = 0, c = 0
    if (o.area > n * massShare) {
      // A mass (a head, shoulders): the base is the mean colour of its lighter half, the colour
      // it's seen as. Engraved fur averages dark (the Gorilla Glue head: 65, 38, 19) but is seen as
      // its orange-brown strokes; a designer draws that tone and puts the darks in as shadow shapes,
      // found on the lightness blurred first (squinting). Judged pixel by pixel, a head was one shadow.
      for (const q of px) {
        if (lum[q] < half) continue
        r += avg[q * 3]; g += avg[q * 3 + 1]; b += avg[q * 3 + 2]; c++
      }
      base[i] = [r / c, g / c, b / c]
      const mid = luma(...base[i])
      const soft = blurWithin(lum, owner, i, w, h, o.box, sigma)
      for (const q of px) level[q] = soft[q] < mid - contrast ? -1 : soft[q] > mid + contrast ? 1 : 0
    } else {
      // A part (a face, a muzzle, a hand): its features are small and sharp. The base is the mean
      // of the pixels near its median lightness, and each pixel clearly darker or lighter counts,
      // smoothed into shapes.
      for (const q of px) {
        if (Math.abs(lum[q] - half) > contrast / 2) continue
        r += avg[q * 3]; g += avg[q * 3 + 1]; b += avg[q * 3 + 2]; c++
      }
      base[i] = c ? [r / c, g / c, b / c] : [avg[px[0] * 3], avg[px[0] * 3 + 1], avg[px[0] * 3 + 2]]
      for (const sign of [-1, 1] as const) {
        const ind = new Float32Array(n)
        for (const q of px) if (sign < 0 ? lum[q] < half - contrast : lum[q] > half + contrast) ind[q] = 1
        const sm = blurWithin(ind, owner, i, w, h, o.box, sigma)
        for (const q of px) if (sm[q] > 0.5) level[q] = sign
      }
    }
    // Features: connected pieces of one level, large enough.
    const seen = new Uint8Array(n)
    const minA = Math.max(minArea, px.length * minShare)
    for (const s of px) {
      if (seen[s] || level[s] === 0) continue
      const lv = level[s]
      const pieces: number[] = []
      const stack = [s]
      seen[s] = 1
      while (stack.length) {
        const q = stack.pop()!
        pieces.push(q)
        const x = q % w
        for (const t of [x > 0 ? q - 1 : -1, x < w - 1 ? q + 1 : -1, q - w, q + w]) if (t >= 0 && t < n && !seen[t] && owner[t] === i && level[t] === lv) (seen[t] = 1), stack.push(t)
      }
      if (pieces.length < minA) {
        for (const q of pieces) level[q] = 0
        continue
      }
      let fl = 0
      for (const q of pieces) fl += luma(avg[q * 3], avg[q * 3 + 1], avg[q * 3 + 2])
      fl /= pieces.length
      features.push({ object: i, kind: lv < 0 ? 'shadow' : 'highlight', pixels: pieces, score: pieces.length * Math.abs(fl - luma(...base[i])) })
    }
  })
  // 4. The budget: masses keep a feature or two, and the most visible features overall stay; the
  // rest become their object's base.
  features.sort((a, b) => b.score - a.score)
  const perMass = new Map<number, number>()
  const allowed = features.filter((f) => {
    if (objects[f.object].area <= n * massShare) return true
    const count = perMass.get(f.object) ?? 0
    if (count >= massFeatures || f.pixels.length < own[f.object].length * massMinShare) return false
    perMass.set(f.object, count + 1)
    return true
  })
  const kept = allowed.slice(0, budget)
  const keptSet = new Set(kept)
  for (const f of features) if (!keptSet.has(f)) for (const q of f.pixels) level[q] = 0
  kept.forEach((f, k) => f.pixels.forEach((q) => (featureId[q] = k)))

  // 5. Colours: each base and feature its mean colour, then merged into a small shared palette.
  const wanted: [number, number, number][] = []
  const baseColour = base.map((c) => wanted.push(c) - 1)
  const featureColour = kept.map((f) => {
    let r = 0, g = 0, b = 0
    for (const q of f.pixels) { r += avg[q * 3]; g += avg[q * 3 + 1]; b += avg[q * 3 + 2] }
    return wanted.push([r / f.pixels.length, g / f.pixels.length, b / f.pixels.length]) - 1
  })
  const palette: [number, number, number][] = []
  const slot = wanted.map((c) => {
    const k = palette.findIndex((p) => Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]) < merge)
    if (k >= 0) return k
    palette.push(c)
    return palette.length - 1
  })
  // Palette entries reuse a flat colour when one is close (the logo's own black, cream, orange).
  const colors = map.colors.slice()
  const paletteLabel = palette.map(([r, g, b]) => {
    let near = -1
    let nd = merge * merge
    colors.forEach((c, l) => {
      if (c < 0) return
      const d = (((c >> 16) & 255) - r) ** 2 + (((c >> 8) & 255) - g) ** 2 + ((c & 255) - b) ** 2
      if (d < nd) [near, nd] = [l, d]
    })
    if (near >= 0 || colors.length >= 254) return Math.max(0, near)
    colors.push((Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b))
    return colors.length - 1
  })

  // 6. Paint: owned pixels take their feature's colour, or their object's base.
  const labels = map.labels.slice()
  for (let q = 0; q < n; q++) {
    if (!texture[q]) continue
    const i = owner[q]
    if (i < 0) continue
    labels[q] = paletteLabel[slot[featureId[q] >= 0 && level[q] !== 0 ? featureColour[featureId[q]] : baseColour[i]]]
  }
  // Texture in no object takes the label most common around it within the texture.
  fillOrphans(labels, owner, texture, w, h)

  // 7. Symmetry: parts that mirror well get their left half on the right.
  // Largest first, so a face mirrors after (and over) the head it sits in.
  const mirrored: number[] = []
  order.forEach((i) => {
    const o = objects[i]
    if (o.area > n * mirrorMaxShare) return
    const { axis, score } = mirrorAxis(o, w)
    if (axis === null || score < symmetry) return
    const a2 = Math.round(axis * 2)
    for (let y = o.box[1]; y <= o.box[3]; y++)
      for (let x = Math.ceil(axis); x <= o.box[2]; x++) {
        const mx = a2 - x
        if (mx < o.box[0] || mx >= x) continue
        const p = y * w + x, q = y * w + mx
        if (o.mask[p] && o.mask[q] && texture[p] && texture[q]) labels[p] = labels[q]
      }
    mirrored.push(i)
  })

  // 8. Pieces under finalMinShare (object-edge slivers, leftovers between objects) join the label
  // they border most, in the texture only: the drawing is its primitives, not their crumbs. Pieces
  // that are mostly a feature the budget kept (an eye, a nostril) stay, however small.
  const minPiece = Math.max(16, Math.round(n * finalMinShare))
  const seen = new Uint8Array(n)
  for (let s = 0; s < n; s++) {
    if (!texture[s] || seen[s]) continue
    const l = labels[s]
    const members: number[] = []
    const around = new Map<number, number>()
    const stack = [s]
    seen[s] = 1
    while (stack.length) {
      const q = stack.pop()!
      members.push(q)
      const x = q % w
      for (const t of [x > 0 ? q - 1 : -1, x < w - 1 ? q + 1 : -1, q - w, q + w]) {
        if (t < 0 || t >= n) continue
        if (labels[t] === l && texture[t]) {
          if (!seen[t]) (seen[t] = 1), stack.push(t)
        } else if (labels[t] !== l) around.set(labels[t], (around.get(labels[t]) ?? 0) + 1)
      }
    }
    if (members.length >= minPiece || !around.size) continue
    if (members.filter((q) => featureId[q] >= 0 && level[q] !== 0).length >= members.length / 2) continue
    let to = l, most = 0
    for (const [k, c] of around) if (c > most) [to, most] = [k, c]
    for (const q of members) labels[q] = to
  }

  const changed = (q: number) => labels[q] !== map.labels[q]
  const primitives: Primitive[] = [
    ...objects.map((_, i) => ({ object: i, kind: 'base' as const, area: own[i].length, color: palette[slot[baseColour[i]]] })).filter((p) => p.area > 0),
    ...kept.map((f, k) => ({ object: f.object, kind: f.kind, area: f.pixels.length, color: palette[slot[featureColour[k]]] })),
  ]
  return {
    map: { ...map, colors, labels, second: map.second.map((v, q) => (changed(q) || texture[q] ? 255 : v)), cov: map.cov.map((v, q) => (changed(q) || texture[q] ? 1 : v)), fine: undefined },
    primitives,
    parents,
    mirrored,
    palette: palette.map(([r, g, b]) => (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b)),
  }
}

/** Gaussian-ish blur (three box passes) of `v`, counting only pixels the object owns. */
function blurWithin(v: Float32Array, owner: Int32Array, i: number, w: number, h: number, box: [number, number, number, number], sigma: number): Float32Array {
  const r = Math.max(1, Math.round(sigma * 0.9))
  const [x0, y0, x1, y1] = [Math.max(0, box[0] - r), Math.max(0, box[1] - r), Math.min(w - 1, box[2] + r), Math.min(h - 1, box[3] + r)]
  let cur = v
  for (let pass = 0; pass < 3; pass++) {
    const tmp = new Float32Array(v.length)
    const out = new Float32Array(v.length)
    for (let y = y0; y <= y1; y++) {
      let s = 0, c = 0
      for (let x = x0; x <= Math.min(x1, x0 + r); x++) if (owner[y * w + x] === i) (s += cur[y * w + x]), c++
      for (let x = x0; x <= x1; x++) {
        if (owner[y * w + x] === i) tmp[y * w + x] = c ? s / c : 0
        const add = x + r + 1, sub = x - r
        if (add <= x1 && owner[y * w + add] === i) (s += cur[y * w + add]), c++
        if (sub >= x0 && owner[y * w + sub] === i) (s -= cur[y * w + sub]), c--
      }
    }
    for (let x = x0; x <= x1; x++) {
      let s = 0, c = 0
      for (let y = y0; y <= Math.min(y1, y0 + r); y++) if (owner[y * w + x] === i) (s += tmp[y * w + x]), c++
      for (let y = y0; y <= y1; y++) {
        if (owner[y * w + x] === i) out[y * w + x] = c ? s / c : 0
        const add = y + r + 1, sub = y - r
        if (add <= y1 && owner[add * w + x] === i) (s += tmp[add * w + x]), c++
        if (sub >= y0 && owner[sub * w + x] === i) (s -= tmp[sub * w + x]), c--
      }
    }
    cur = out
  }
  return cur
}

/** Texture pixels in no object take the most common label among their already-set neighbours (repeated outward). */
function fillOrphans(labels: Uint8Array, owner: Int32Array, texture: Uint8Array, w: number, h: number) {
  const n = w * h
  let todo: number[] = []
  const done = new Uint8Array(n)
  for (let q = 0; q < n; q++) {
    if (!texture[q] || owner[q] >= 0) done[q] = 1
    else todo.push(q)
  }
  for (let round = 0; round < 200 && todo.length; round++) {
    const next: number[] = []
    const set: [number, number][] = []
    for (const q of todo) {
      const x = q % w
      const counts = new Map<number, number>()
      for (const t of [x > 0 ? q - 1 : -1, x < w - 1 ? q + 1 : -1, q - w, q + w]) if (t >= 0 && t < n && done[t] && texture[t]) counts.set(labels[t], (counts.get(labels[t]) ?? 0) + 1)
      if (!counts.size) {
        next.push(q)
        continue
      }
      let best = 0, most = 0
      for (const [l, c] of counts) if (c > most) [best, most] = [l, c]
      set.push([q, best])
    }
    for (const [q, l] of set) (labels[q] = l), (done[q] = 1)
    if (next.length === todo.length) break
    todo = next
  }
  void h
}

/** The source averaged over a (2r+1)² box, as RGB per pixel. */
function boxAverage(src: ImageData, r: number): Float32Array {
  const { width: w, height: h, data: d } = src
  const out = new Float32Array(w * h * 3)
  const sat = new Float64Array((w + 1) * (h + 1))
  for (let c = 0; c < 3; c++) {
    for (let y = 0; y < h; y++) {
      let row = 0
      for (let x = 0; x < w; x++) {
        row += d[(y * w + x) * 4 + c]
        sat[(y + 1) * (w + 1) + x + 1] = sat[y * (w + 1) + x + 1] + row
      }
    }
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1)
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1)
        out[(y * w + x) * 3 + c] = (sat[y1 * (w + 1) + x1] - sat[y0 * (w + 1) + x1] - sat[y1 * (w + 1) + x0] + sat[y0 * (w + 1) + x0]) / ((x1 - x0) * (y1 - y0))
      }
    }
  }
  return out
}

/** The vertical axis about which the object's silhouette best matches its mirror image (IoU). */
export function mirrorAxis(o: ObjectMask, w: number): { axis: number | null; score: number } {
  const [bx0, by0, bx1, by1] = o.box
  const centre = (bx0 + bx1) / 2
  const span = Math.max(2, Math.round((bx1 - bx0) * 0.1))
  let best = { axis: null as number | null, score: 0 }
  for (let a2 = Math.round((centre - span) * 2); a2 <= Math.round((centre + span) * 2); a2++) {
    let inter = 0, union = 0
    for (let y = by0; y <= by1; y++)
      for (let x = bx0; x <= bx1; x++) {
        const a = o.mask[y * w + x]
        const mx = a2 - x
        const b = mx >= 0 && mx < w ? o.mask[y * w + mx] : 0
        if (a && b) inter++
        if (a || b) union++
      }
    const score = union ? inter / union : 0
    if (score > best.score) best = { axis: a2 / 2, score }
  }
  return best
}

/**
 * Each colour's paths as one compound path (even-odd), in drawing order. The flat tracer writes a
 * group per colour; its pieces never overlap one another, so joining them changes nothing on screen.
 */
export function compoundPerColour(svg: string): string {
  return svg.replace(/(<g\b[^>]*data-color="[^"]*"[^>]*>)([\s\S]*?)(<\/g>)/g, (_, open: string, body: string, close: string) => {
    const paths = [...body.matchAll(/<path\b([^>]*?)\sd="([^"]*)"([^>]*)\/>/g)]
    if (paths.length < 2 || body.replace(/<path\b[^>]*\/>/g, '').trim()) return open + body + close
    const attrs = (paths[0][1] + paths[0][3]).replace(/\sid="[^"]*"/g, '')
    return `${open}<path d="${paths.map((p) => p[2]).join(' ')}"${attrs}/>${close}`
  })
}
