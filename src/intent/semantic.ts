// Design-intent prototype (research, docs/design-intent.md): a semantic layer between objects and
// SVG. Objects found by SAM are given roles by a small shape grammar for mascot heads (silhouette,
// head, face, muzzle, beard, hands, fur masses), and features inside them are given classes (eye,
// nostril, mouth, brow, cheek, shadow, highlight, crease). Retention is decided by class, not by
// size: eyes, nostrils and the mouth are never dropped; shadows and highlights have per-object
// budgets. Colours are sampled inside each object only, so nothing leaks across its outline. The
// SVG is written silhouette first, then masses, then parts and their features, each a named path.
//
// No trained model knows "eye" here: the grammar decides from position and pairing within the
// face SAM found ("a dark shape in the upper face, mirrored across its axis, is an eye").
import { traceLabels, type LabelMap, type TraceOptions } from '../trace'
import type { ObjectMask } from './sam'
import { mirrorAxis } from './primitives'

export type ObjectRole = 'silhouette' | 'head' | 'face' | 'muzzle' | 'beard' | 'hand' | 'mass'
export type FeatureClass = 'base' | 'eye' | 'nostril' | 'mouth' | 'brow' | 'cheek' | 'shadow' | 'highlight' | 'crease' | 'fur'

/** Per object role: how many features of each class may stay (Infinity: never dropped). */
const BUDGET: Record<ObjectRole, Partial<Record<FeatureClass, number>>> = {
  silhouette: { fur: 2 },
  head: { fur: 2, highlight: 1 },
  mass: { fur: 2, highlight: 1 },
  face: { eye: Infinity, brow: 1, cheek: 2, shadow: 2, highlight: 2 },
  muzzle: { nostril: Infinity, mouth: Infinity, shadow: 1, highlight: 2 },
  beard: { shadow: 1 },
  hand: { crease: 4, highlight: 1 },
}
/** Drawing order: silhouette first, then masses, then parts. */
const ORDER: ObjectRole[] = ['silhouette', 'mass', 'head', 'face', 'muzzle', 'beard', 'hand']

export interface SemanticObject {
  index: number
  role: ObjectRole
  name: string
  parent: number
  area: number
  axis: number | null
  symmetry: number
}

export interface SemanticFeature {
  object: number
  cls: FeatureClass
  name: string
  area: number
  color: number
}

export interface SemanticResult {
  svg: string
  objects: SemanticObject[]
  features: SemanticFeature[]
  /** Named paths written for the artwork in the texture (bases and features). */
  shapes: number
}

const luma = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b
const hex = (c: number) => `#${c.toString(16).padStart(6, '0').toUpperCase()}`

export function semanticRedraw(
  map: LabelMap,
  objects: ObjectMask[],
  src: ImageData,
  texture: Uint8Array,
  trace: TraceOptions,
  opts: { contrast?: number } = {},
): SemanticResult {
  const { contrast = 28 } = opts
  const { w, h } = map
  const n = w * h

  // ---- Objects: hierarchy, symmetry, roles ----
  const order = objects.map((_, i) => i).sort((a, b) => objects[b].area - objects[a].area)
  const inside = (a: number, b: number) => {
    // Share of object a inside object b.
    let k = 0
    const [x0, y0, x1, y1] = objects[a].box
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (objects[a].mask[y * w + x] && objects[b].mask[y * w + x]) k++
    return k / objects[a].area
  }
  const parent = objects.map(() => -1)
  order.forEach((i, k) => {
    for (let j = k - 1; j >= 0; j--) {
      const p = order[j]
      if (objects[p].area > objects[i].area && inside(i, p) >= 0.8) {
        parent[i] = p
        break
      }
    }
  })
  const sym = objects.map((o) => mirrorAxis(o, w))
  const meanLuma = objects.map((o) => {
    let s = 0
    for (let y = o.box[1]; y <= o.box[3]; y++)
      for (let x = o.box[0]; x <= o.box[2]; x++) {
        const p = y * w + x
        if (o.mask[p]) s += luma(src.data[p * 4], src.data[p * 4 + 1], src.data[p * 4 + 2])
      }
    return s / o.area
  })
  const role: ObjectRole[] = objects.map(() => 'mass')
  const children = (i: number) => objects.map((_, j) => j).filter((j) => parent[j] === i)
  const descendants = (i: number): number[] => children(i).flatMap((c) => [c, ...descendants(c)])
  // Silhouette: the largest object holding at least two others.
  const silhouette = order.find((i) => descendants(i).length >= 2) ?? -1
  if (silhouette >= 0) role[silhouette] = 'silhouette'
  // Face: the largest symmetric part (0.4–5% of the image) that is lighter than its parent.
  const isPart = (i: number) => objects[i].area >= n * 0.004 && objects[i].area <= n * 0.05
  const face = order.find((i) => isPart(i) && sym[i].score >= 0.85 && (parent[i] < 0 || meanLuma[i] > meanLuma[parent[i]])) ?? -1
  if (face >= 0) role[face] = 'face'
  // Head: the face's nearest ancestor that isn't the silhouette.
  if (face >= 0 && parent[face] >= 0 && parent[face] !== silhouette) role[parent[face]] = 'head'
  // Muzzle: the largest symmetric object smaller than the face, centred in its lower half (SAM's
  // muzzle usually reaches below the face's mask, so containment isn't required).
  const muzzle =
    face >= 0
      ? (order.find((i) => {
          if (i === face || objects[i].area >= objects[face].area || objects[i].area < objects[face].area * 0.2 || sym[i].score < 0.8) return false
          const fb = objects[face].box
          const cx = (objects[i].box[0] + objects[i].box[2]) / 2
          const cy = (objects[i].box[1] + objects[i].box[3]) / 2
          return cx > fb[0] && cx < fb[2] && cy > (fb[1] + fb[3]) / 2 && cy < fb[3] + (fb[3] - fb[1]) * 0.2
        }) ?? -1)
      : -1
  if (muzzle >= 0) role[muzzle] = 'muzzle'
  // Beard: an object just below the muzzle (or face), overlapping it horizontally.
  const chin = muzzle >= 0 ? muzzle : face
  if (chin >= 0) {
    const cb = objects[chin].box
    const beard = order.find((i) => i !== chin && role[i] === 'mass' && objects[i].area < objects[chin].area * 1.5 && objects[i].box[1] >= cb[1] + (cb[3] - cb[1]) * 0.6 && objects[i].box[1] <= cb[3] + 20 && objects[i].box[0] < cb[2] && objects[i].box[2] > cb[0])
    if (beard !== undefined) role[beard] = 'beard'
  }
  // Hands: small objects (0.2–1.5%) outside the head, far to the left or right.
  const head = role.indexOf('head')
  const centreX = silhouette >= 0 ? (objects[silhouette].box[0] + objects[silhouette].box[2]) / 2 : w / 2
  const halfW = silhouette >= 0 ? (objects[silhouette].box[2] - objects[silhouette].box[0]) / 2 : w / 4
  objects.forEach((o, i) => {
    if (role[i] !== 'mass' || o.area < n * 0.002 || o.area > n * 0.015) return
    if (head >= 0 && descendants(head).includes(i)) return
    const cx = (o.box[0] + o.box[2]) / 2
    if (Math.abs(cx - centreX) > halfW * 0.85) role[i] = 'hand'
  })

  // ---- Ownership: each texture pixel belongs to the smallest object holding it ----
  const owner = new Int32Array(n).fill(-1)
  for (const i of order) {
    const o = objects[i]
    for (let y = o.box[1]; y <= o.box[3]; y++)
      for (let x = o.box[0]; x <= o.box[2]; x++) {
        const p = y * w + x
        if (o.mask[p] && texture[p]) owner[p] = i
      }
  }
  // Texture outside every object joins the object owning most of its neighbourhood (grown out).
  growOwners(owner, texture, w, h)

  // ---- Object-local colours: averaged over 5×5 px, counting only the same object's pixels ----
  const avg = localAverage(src, owner, w, h, 2)

  // ---- Features per object ----
  const prim = new Int16Array(n).fill(-1) // primitive id per pixel
  const features: SemanticFeature[] = []
  const prims: { object: number; cls: FeatureClass; name: string; color: [number, number, number] }[] = []
  const names = new Map<string, number>()
  const nameFor = (base: string) => {
    const k = (names.get(base) ?? 0) + 1
    names.set(base, k)
    return k === 1 ? base : `${base}-${k}`
  }
  // Masses are named by where they sit on the silhouette: shoulders, chest, left or right arm.
  const sb = silhouette >= 0 ? objects[silhouette].box : ([0, 0, w - 1, h - 1] as [number, number, number, number])
  const massName = (i: number) => {
    const b = objects[i].box
    const u = ((b[0] + b[2]) / 2 - sb[0]) / Math.max(1, sb[2] - sb[0])
    const v = ((b[1] + b[3]) / 2 - sb[1]) / Math.max(1, sb[3] - sb[1])
    if (v > 0.75) return 'chest'
    if (u < 0.3) return 'left-arm'
    if (u > 0.7) return 'right-arm'
    return v > 0.4 ? 'shoulders' : 'fur'
  }
  const objName = objects.map((_, i) => nameFor(role[i] === 'mass' ? massName(i) : role[i] === 'hand' ? ((objects[i].box[0] + objects[i].box[2]) / 2 < (sb[0] + sb[2]) / 2 ? 'left-hand' : 'right-hand') : role[i]))

  for (const i of order) {
    const o = objects[i]
    const px: number[] = []
    for (let y = o.box[1]; y <= o.box[3]; y++) for (let x = o.box[0]; x <= o.box[2]; x++) if (owner[y * w + x] === i) px.push(y * w + x)
    if (!px.length) continue
    const r = role[i]
    const lum = new Float32Array(n)
    for (const q of px) lum[q] = luma(avg[q * 3], avg[q * 3 + 1], avg[q * 3 + 2])
    const sorted = px.map((q) => lum[q]).sort((a, b) => a - b)
    const median = sorted[sorted.length >> 1]
    const isMass = r === 'silhouette' || r === 'head' || r === 'mass'
    // Base colour: masses as seen (their lighter half), parts by their median tone.
    const baseOf = (keep: (l: number) => boolean) => {
      let R = 0, G = 0, B = 0, c = 0
      for (const q of px) if (keep(lum[q])) (R += avg[q * 3]), (G += avg[q * 3 + 1]), (B += avg[q * 3 + 2]), c++
      return c ? [R / c, G / c, B / c] : [avg[px[0] * 3], avg[px[0] * 3 + 1], avg[px[0] * 3 + 2]]
    }
    const base = (isMass ? baseOf((l) => l >= median) : baseOf((l) => Math.abs(l - median) <= contrast / 2)) as [number, number, number]
    const baseId = prims.push({ object: i, cls: 'base', name: `${objName[i]}-base`, color: base }) - 1
    for (const q of px) prim[q] = baseId

    // Dark / light shapes: masses on blurred lightness (squinting), parts pixel by pixel, smoothed.
    const mid = luma(...base)
    const sigma = Math.max(2, Math.round(Math.sqrt(o.area) * 0.03))
    const level = new Int8Array(n)
    if (isMass) {
      const soft = blurWithin(lum, owner, i, w, h, o.box, sigma)
      for (const q of px) level[q] = soft[q] < mid - contrast ? -1 : soft[q] > mid + contrast ? 1 : 0
    } else
      for (const sign of [-1, 1] as const) {
        const ind = new Float32Array(n)
        for (const q of px) if (sign < 0 ? lum[q] < median - contrast : lum[q] > median + contrast) ind[q] = 1
        const sm = blurWithin(ind, owner, i, w, h, o.box, sigma)
        for (const q of px) if (sm[q] > 0.5) level[q] = sign
      }
    const comps = components(level, owner, i, px, w, h)
    for (const c of comps) c.meanLuma = c.pixels.reduce((s, q) => s + lum[q], 0) / c.area

    // Classify by the grammar for this role, in the object's own frame (u across, v down, 0–1).
    const [bx0, by0, bx1, by1] = o.box
    const axis = sym[i].axis ?? (bx0 + bx1) / 2
    const frame = (c: Comp) => ({ u: (c.cx - bx0) / Math.max(1, bx1 - bx0), v: (c.cy - by0) / Math.max(1, by1 - by0), du: (c.cx - axis) / Math.max(1, (bx1 - bx0) / 2) })
    const classify = (c: Comp): FeatureClass | null => {
      const { u, v, du } = frame(c)
      const wide = c.width / Math.max(1, c.height)
      if (isMass) return c.dark ? 'fur' : c.area >= px.length * 0.05 ? 'highlight' : null
      if (r === 'face') {
        if (c.dark && v < 0.6 && Math.abs(du) > 0.12 && Math.abs(du) < 0.8) return 'eye'
        if (!c.dark && v < 0.45 && wide > 2 && Math.abs(du) < 0.3) return 'brow'
        if (!c.dark && Math.abs(du) > 0.35 && v > 0.3) return 'cheek'
        return c.dark ? 'shadow' : 'highlight'
      }
      if (r === 'muzzle') {
        if (c.dark && v > 0.2 && v < 0.75 && Math.abs(du) > 0.05 && Math.abs(du) < 0.6 && c.area < px.length * 0.15) return 'nostril'
        if (c.dark && v >= 0.6 && wide > 2) return 'mouth'
        return c.dark ? 'shadow' : 'highlight'
      }
      if (r === 'hand') return c.dark ? 'crease' : 'highlight'
      if (r === 'beard') return c.dark ? 'shadow' : null
      void u
      return null
    }
    const minArea = 12
    const byClass = new Map<FeatureClass, { c: Comp; score: number }[]>()
    for (const c of comps) {
      const cls = classify(c)
      if (!cls || c.area < minArea) continue
      const list = byClass.get(cls) ?? []
      list.push({ c, score: c.area * Math.abs(c.meanLuma - mid) })
      byClass.set(cls, list)
    }
    for (const [cls, list] of byClass) {
      const limit = BUDGET[r][cls] ?? 0
      // Never-dropped classes still need to be real shapes, not single-pixel noise.
      const kept = list.sort((a, b) => b.score - a.score).slice(0, limit === Infinity ? list.length : limit).filter(({ c }) => limit === Infinity || c.area >= px.length * 0.01)
      for (const { c } of kept) {
        let R = 0, G = 0, B = 0
        for (const q of c.pixels) (R += avg[q * 3]), (G += avg[q * 3 + 1]), (B += avg[q * 3 + 2])
        const side = cls === 'eye' || cls === 'nostril' || cls === 'cheek' ? (c.cx < axis ? 'left-' : 'right-') : ''
        const id = prims.push({ object: i, cls, name: nameFor(`${objName[i]}-${side}${cls}`), color: [R / c.pixels.length, G / c.pixels.length, B / c.pixels.length] }) - 1
        for (const q of c.pixels) prim[q] = id
      }
    }
  }

  // ---- Symmetry: the face and the muzzle are mirrored (left half onto the right), features with
  // their side names swapped, so left and right eyes are a pair. ----
  for (const i of order) {
    if (role[i] !== 'face' && role[i] !== 'muzzle') continue
    const { axis, score } = sym[i]
    if (axis === null || score < 0.85) continue
    const o = objects[i]
    const a2 = Math.round(axis * 2)
    const twin = new Map<number, number>()
    for (let y = o.box[1]; y <= o.box[3]; y++)
      for (let x = Math.ceil(axis); x <= o.box[2]; x++) {
        const mx = a2 - x
        if (mx < o.box[0] || mx >= x) continue
        const p = y * w + x, q = y * w + mx
        if (owner[p] !== i || owner[q] !== i) continue
        const from = prim[q]
        let to = from
        const pr = prims[from]
        if (pr && pr.name.includes('-left-')) {
          to = twin.get(from) ?? -1
          if (to < 0) {
            const right = pr.name.replace('-left-', '-right-')
            const existing = prims.findIndex((x2) => x2.name === right)
            to = existing >= 0 ? existing : prims.push({ ...pr, name: right }) - 1
            twin.set(from, to)
          }
        }
        prim[p] = to
      }
    // A right-side feature with no left partner was overwritten by the mirror: it is gone.
  }

  // ---- Palette: features keep their own colour; colours within 20 share one ----
  const palette: number[] = []
  const colourOf = prims.map((p) => {
    const [r, g, b] = p.color
    const k = palette.findIndex((c) => Math.hypot(((c >> 16) & 255) - r, ((c >> 8) & 255) - g, (c & 255) - b) < 20)
    if (k >= 0) return palette[k]
    const c = (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b)
    palette.push(c)
    return c
  })

  // ---- SVG: the flat artwork without the texture, then the objects in drawing order ----
  const flat: LabelMap = { ...map, labels: map.labels.map((l, p) => (texture[p] ? 254 : l)), fine: undefined }
  const flatSvg = traceLabels(flat, { ...trace, mode: 'knockout', spread: 0 }).svg
  const flatBody = flatSvg.replace(/^[\s\S]*?<svg\b[^>]*>/i, '').replace(/<\/svg>\s*$/i, '')
  const groups: string[] = []
  let shapes = 0
  const area = new Int32Array(prims.length)
  for (let p = 0; p < n; p++) if (prim[p] >= 0) area[prim[p]]++
  const objectOrder = order.slice().sort((a, b) => ORDER.indexOf(role[a]) - ORDER.indexOf(role[b]) || objects[b].area - objects[a].area)
  // Every texture pixel belongs to some object after growOwners; one left without a primitive (none
  // was made for its object) takes its object's base.
  const baseOfObject = new Map<number, number>()
  prims.forEach((pr, id) => pr.cls === 'base' && baseOfObject.set(pr.object, id))
  for (let p = 0; p < n; p++) if (texture[p] && prim[p] < 0 && owner[p] >= 0 && baseOfObject.has(owner[p])) prim[p] = baseOfObject.get(owner[p])!
  // Bases are drawn whole, under their features, as a designer layers them: the silhouette's base
  // is the whole illustration, each object's base its whole own area, features on top. Nothing is
  // drawn more than one level deep, and no seam can open between pieces.
  const objectOf = new Int32Array(n).fill(-1)
  for (let p = 0; p < n; p++) if (prim[p] >= 0) objectOf[p] = prims[prim[p]].object
  // The silhouette reaches 1 px past the texture, under the artwork around it, so no seam shows
  // where the two meet.
  const near = (p: number) => texture[p] === 1 || (p % w > 0 && texture[p - 1] === 1) || (p % w < w - 1 && texture[p + 1] === 1) || (p >= w && texture[p - w] === 1) || (p < n - w && texture[p + w] === 1)
  const isWithin = (i: number) => (p: number) => (role[i] === 'silhouette' ? near(p) : objectOf[p] === i)
  for (const i of objectOrder) {
    const paths: string[] = []
    prims.forEach((pr, id) => {
      if (pr.object !== i || !area[id]) return
      const d = pr.cls === 'base' ? traceWhere(isWithin(i), w, h, trace) : traceMask(prim, id, w, h, trace)
      if (!d) return
      paths.push(`<path id="${pr.name}" data-class="${pr.cls}" d="${d}" fill="${hex(colourOf[id])}" fill-rule="evenodd"/>`)
      features.push({ object: i, cls: pr.cls, name: pr.name, area: area[id], color: colourOf[id] })
      shapes++
    })
    if (paths.length) groups.push(`<g id="${objName[i]}" data-role="${role[i]}">${paths.join('')}</g>`)
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><g id="artwork">${flatBody}</g><g id="illustration">${groups.join('')}</g></svg>`
  return {
    svg,
    objects: objects.map((o, i) => ({ index: i, role: role[i], name: objName[i], parent: parent[i], area: o.area, axis: sym[i].axis, symmetry: +sym[i].score.toFixed(3) })),
    features,
    shapes,
  }
}

interface Comp {
  dark: boolean
  pixels: number[]
  area: number
  cx: number
  cy: number
  width: number
  height: number
  meanLuma: number
}

/** Connected pieces of one level (dark or light) within the object's own pixels. */
function components(level: Int8Array, owner: Int32Array, i: number, px: number[], w: number, h: number): Comp[] {
  const seen = new Uint8Array(w * h)
  const out: Comp[] = []
  for (const s of px) {
    if (seen[s] || !level[s]) continue
    const lv = level[s]
    const pixels: number[] = []
    const stack = [s]
    seen[s] = 1
    let x0 = w, y0 = h, x1 = 0, y1 = 0, sx = 0, sy = 0
    while (stack.length) {
      const q = stack.pop()!
      pixels.push(q)
      const x = q % w, y = (q - x) / w
      sx += x
      sy += y
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
      for (const t of [x > 0 ? q - 1 : -1, x < w - 1 ? q + 1 : -1, q - w, q + w]) if (t >= 0 && t < w * h && !seen[t] && owner[t] === i && level[t] === lv) (seen[t] = 1), stack.push(t)
    }
    out.push({ dark: lv < 0, pixels, area: pixels.length, cx: sx / pixels.length, cy: sy / pixels.length, width: x1 - x0 + 1, height: y1 - y0 + 1, meanLuma: 0 })
  }
  return out
}

/** One primitive's pixels traced as one compound path (cropped to its box for speed). */
function traceMask(prim: Int16Array, id: number, w: number, h: number, trace: TraceOptions): string | null {
  return traceWhere((p) => prim[p] === id, w, h, trace)
}

/** The pixels where `at` holds, traced as one compound path (cropped to their box for speed). */
export function traceWhere(at: (p: number) => boolean, w: number, h: number, trace: TraceOptions): string | null {
  let x0 = w, y0 = h, x1 = -1, y1 = -1
  for (let p = 0; p < w * h; p++) {
    if (!at(p)) continue
    const x = p % w, y = (p - x) / w
    if (x < x0) x0 = x
    if (x > x1) x1 = x
    if (y < y0) y0 = y
    if (y > y1) y1 = y
  }
  if (x1 < 0) return null
  const pad = 2
  x0 = Math.max(0, x0 - pad)
  y0 = Math.max(0, y0 - pad)
  x1 = Math.min(w - 1, x1 + pad)
  y1 = Math.min(h - 1, y1 + pad)
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1
  const labels = new Uint8Array(cw * ch).fill(254)
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) if (at((y + y0) * w + x + x0)) labels[y * cw + x] = 0
  const map: LabelMap = { w: cw, h: ch, labels, second: new Uint8Array(cw * ch).fill(255), cov: new Float32Array(cw * ch).fill(1), colors: [0] }
  const { layers } = traceLabels(map, { ...trace, mode: 'knockout', spread: 0, exactShapes: false })
  const d = layers.map((l) => l.d).join(' ').trim()
  if (!d) return null
  // Shift into place: every coordinate pair is absolute in the crop. Arcs (A) carry radii and flags
  // too, so only pairs after M, L, C, S, Q, T and the end point of A are moved.
  return shiftPath(d, x0, y0)
}

/** Moves absolute path data by (dx, dy). Handles M L H V C S Q T A Z. */
function shiftPath(d: string, dx: number, dy: number): string {
  const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[+-]?\d+)?/g) ?? []
  const out: string[] = []
  let cmd = ''
  let k = 0
  const r = (v: number) => String(+v.toFixed(2))
  for (const t of tokens) {
    if (/[a-zA-Z]/.test(t)) {
      cmd = t
      k = 0
      out.push(t)
      continue
    }
    const v = Number(t)
    let shifted = v
    switch (cmd) {
      case 'M': case 'L': case 'C': case 'S': case 'Q': case 'T':
        shifted = v + (k % 2 === 0 ? dx : dy)
        break
      case 'H': shifted = v + dx; break
      case 'V': shifted = v + dy; break
      case 'A': {
        const at = k % 7
        shifted = at === 5 ? v + dx : at === 6 ? v + dy : v
        break
      }
      default: shifted = v
    }
    out.push(r(shifted))
    k++
  }
  return out.join(' ').replace(/ ([a-zA-Z]) /g, '$1').replace(/^([a-zA-Z]) /, '$1')
}

/** Texture pixels in no object take the owner most common among their neighbours, growing out. */
function growOwners(owner: Int32Array, texture: Uint8Array, w: number, h: number) {
  const n = w * h
  let todo: number[] = []
  for (let p = 0; p < n; p++) if (texture[p] && owner[p] < 0) todo.push(p)
  for (let round = 0; round < 300 && todo.length; round++) {
    const set: [number, number][] = []
    const next: number[] = []
    for (const p of todo) {
      const x = p % w
      const counts = new Map<number, number>()
      for (const t of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w]) if (t >= 0 && t < n && owner[t] >= 0) counts.set(owner[t], (counts.get(owner[t]) ?? 0) + 1)
      if (!counts.size) {
        next.push(p)
        continue
      }
      let best = -1, most = 0
      for (const [o, c] of counts) if (c > most) [best, most] = [o, c]
      set.push([p, best])
    }
    for (const [p, o] of set) owner[p] = o
    if (next.length === todo.length) break
    todo = next
  }
  void h
}

/** Colour averaged over a (2r+1)² box, counting only pixels with the same owner (or, outside objects, all). */
function localAverage(src: ImageData, owner: Int32Array, w: number, h: number, r: number): Float32Array {
  const d = src.data
  const out = new Float32Array(w * h * 3)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = y * w + x
      const o = owner[p]
      if (o < 0) {
        out[p * 3] = d[p * 4]
        out[p * 3 + 1] = d[p * 4 + 1]
        out[p * 3 + 2] = d[p * 4 + 2]
        continue
      }
      let R = 0, G = 0, B = 0, c = 0
      for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r); yy++)
        for (let xx = Math.max(0, x - r); xx <= Math.min(w - 1, x + r); xx++) {
          const q = yy * w + xx
          if (owner[q] !== o) continue
          R += d[q * 4]
          G += d[q * 4 + 1]
          B += d[q * 4 + 2]
          c++
        }
      out[p * 3] = R / c
      out[p * 3 + 1] = G / c
      out[p * 3 + 2] = B / c
    }
  return out
}

/** Gaussian-ish blur (three box passes) counting only the object's own pixels. */
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
