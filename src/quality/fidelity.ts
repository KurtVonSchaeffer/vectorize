import { deltaE2000, rgbToLab } from '../palette/color'
import { flatten, shapesFromSvg, type ColorShape, type Pt, type Subpath } from '../export/path'
import { selfIntersects } from '../export/validate'
import { compareRasters, type Region } from './compare'
import { lostShading, shadingLoss } from './shading'

/**
 * How faithfully a vector result reproduces the uploaded image, and whether its geometry is fit
 * for production. Pure and deterministic: it reads the upload, the vector drawn at the upload's
 * size, and the SVG text, and changes none of them. Nothing in the app calls it yet.
 *
 * Two separate judgements, because a result can look right and still be poor artwork:
 * - visual: does the vector show what the upload shows? Edges, fine detail (lettering, stars,
 *   thin lines), the shape of small features, and smooth shading.
 * - geometry: is the SVG genuine, editable vector artwork? Raster content, outlines drawn more
 *   than once, self-intersecting or tiny contours, and a paper background drawn as a shape.
 *
 * Limits (each verified on the audit set; see bench/fidelity.ts):
 * - Features are found by colour against their surroundings. Detail with little contrast (a
 *   facet edge between two similar reds, a feather line inside a gradient) is not counted as a
 *   feature; smooth shading is judged separately, as colour error in flat areas.
 * - Lettering is judged as shapes, not as text: a letter that keeps its pixels but loses a
 *   counter or crossbar under one pixel wide may pass. Lettering under about 5 px tall in a
 *   JPEG cannot be told apart from compression noise and is not measured reliably.
 * - Shape changes smaller than a pixel (a 16 px heptagon drawn as a circle) are below what a
 *   raster comparison at the upload's size can see.
 * - Complex gradients: banding is caught as shading error only where the upload is locally
 *   smooth; a gradient replaced by a slightly wrong gradient may pass.
 * - JPEG noise counts as error against a clean vector, so compare a result with another result
 *   for the same upload, not scores across different uploads.
 */

export type FidelityVerdict = 'ready' | 'check' | 'not-suitable'

export type IssueId =
  | 'lost-detail'
  | 'changed-shapes'
  | 'missed-edges'
  | 'flattened-shading'
  | 'raster-content'
  | 'copied-outlines'
  | 'self-intersections'
  | 'tiny-contours'
  | 'paper-shape'

export interface FidelityIssue {
  id: IssueId
  /** Which judgement it affects. */
  kind: 'visual' | 'geometry'
  severity: Exclude<FidelityVerdict, 'ready'>
  count: number
  /** Plain words, for a person. */
  message: string
  /** Where, in upload pixels (largest first, at most 20). */
  where: Region[]
}

export interface FeatureStats {
  /** Features found in the upload (areas of one colour standing out from all their neighbours). */
  count: number
  /** Of these, fine detail: at most FINE_SHARE of the image or FINE_MIN_PX, whichever is larger. */
  fine: number
  /** Fine features the vector doesn't show (under LOST_SHARE of their pixels kept). */
  lost: number
  /** Share of the fine features' area lost (0–1). */
  lostArea: number
  /** Features the vector shows but in a different shape (IoU under CHANGED_IOU). */
  changed: number
}

export interface FidelityReport {
  width: number
  height: number
  /** Source edges with a vector edge within 1 px (0–1), and the reverse. */
  edgeRecall: number
  edgePrecision: number
  /** Mean colour difference, composited over white (0–255), and share of pixels wrong beyond 1 px. */
  meanError: number
  wrongShare: number
  features: FeatureStats
  /** Share of the upload's smooth interior that the vector misses by over ΔE 6, and the mean ΔE there. */
  shading: { share: number; meanDeltaE: number }
  geometry: {
    contours: number
    copiedOutlines: number
    selfIntersecting: number
    /** Closed contours under TINY_AREA upload px². */
    tiny: number
    /** Raster or non-geometry constructs found in the SVG (image, data URI, filter, mask, pattern…). */
    raster: string[]
    /** A near-white shape covering the whole canvas of an opaque upload (its paper). */
    paperShape: boolean
  }
  visual: FidelityVerdict
  geometryVerdict: FidelityVerdict
  /** The worse of the two. */
  verdict: FidelityVerdict
  issues: FidelityIssue[]
}

/** Feature thresholds. */
const FEATURE_DE = 15 // ΔE2000 a feature must stand out by from every neighbouring area
const MIN_CORE = 3 // solid pixels a feature needs, so compression specks aren't features
export const FINE_SHARE = 0.01 // fine detail: at most this share of the image,
export const FINE_MIN_PX = 400 // or at most this many pixels, whichever is larger
export const LOST_SHARE = 0.5
export const CHANGED_IOU = 0.75
const CHANGED_MIN_AREA = 12
/** Geometry thresholds (upload px). */
export const TINY_AREA = 4
/** Two outlines are the same when every point of each is within this of the other (upload px). */
const COPY_MATCH = 0.5
const PAPER_MIN_CHANNEL = 235
const PAPER_COVER = 0.97
/** Verdict thresholds, calibrated on the audit set (bench/fidelity-baseline.json). */
const LOST_CHECK = 0.12
const LOST_UNSUITABLE = 0.3
const CHANGED_CHECK = 3
const RECALL_CHECK = 0.9
const RECALL_UNSUITABLE = 0.8

const RASTER_CONSTRUCTS: [string, RegExp][] = [
  ['image', /<image\b/i],
  ['data URI', /\bdata:/i],
  ['foreignObject', /<foreignObject\b/i],
  ['filter', /<filter\b|\sfilter="/i],
  ['mask', /<mask\b|\smask="/i],
  ['pattern', /<pattern\b/i],
  ['clip path', /<clipPath\b|\sclip-path="/i],
  ['external reference', /\s(?:xlink:)?href="(?!#)/i],
]

export function assessFidelity(upload: ImageData, vector: ImageData, svg: string): FidelityReport {
  const { width: w, height: h } = upload
  if (vector.width !== w || vector.height !== h) throw new RangeError(`The vector must be drawn at the upload's size (${w}×${h}), not ${vector.width}×${vector.height}`)

  const cmp = compareRasters(upload.data, vector.data, w, h, { tolerance: 1 })
  const feat = features(upload, vector)
  const shade = shadingLoss(upload, vector)
  const geo = geometry(svg, upload)

  const issues: FidelityIssue[] = []
  const fineArea = feat.fineArea
  const lostArea = fineArea ? feat.lostAreaPx / fineArea : 0
  if (feat.lost.length && lostArea >= LOST_CHECK)
    issues.push({
      id: 'lost-detail', kind: 'visual', severity: lostArea >= LOST_UNSUITABLE ? 'not-suitable' : 'check', count: feat.lost.length, where: top(feat.lost),
      message: `${feat.lost.length} small ${feat.lost.length === 1 ? 'detail is' : 'details are'} missing (${Math.round(lostArea * 100)}% of the fine detail), such as lettering, stars or thin lines.`,
    })
  if (feat.changed.length >= CHANGED_CHECK)
    issues.push({ id: 'changed-shapes', kind: 'visual', severity: 'check', count: feat.changed.length, where: top(feat.changed), message: `${feat.changed.length} small shapes changed shape (for example, points cut off or corners rounded).` })
  if (cmp.edgeRecall < RECALL_CHECK)
    issues.push({ id: 'missed-edges', kind: 'visual', severity: cmp.edgeRecall < RECALL_UNSUITABLE ? 'not-suitable' : 'check', count: cmp.missingDetails.length, where: cmp.missingDetails.slice(0, 20), message: `${Math.round((1 - cmp.edgeRecall) * 100)}% of the image's edges are missing or moved by more than 1 px.` })
  if (lostShading(shade))
    issues.push({ id: 'flattened-shading', kind: 'visual', severity: 'check', count: 1, where: [], message: `Smooth shading became flat colour in ${Math.round(shade.share * 100)}% of the artwork.` })
  if (geo.raster.length)
    issues.push({ id: 'raster-content', kind: 'geometry', severity: 'not-suitable', count: geo.raster.length, where: [], message: `The SVG contains ${geo.raster.join(', ')}: not pure vector shapes.` })
  if (geo.copied.length)
    issues.push({ id: 'copied-outlines', kind: 'geometry', severity: 'check', count: geo.copied.length, where: top(geo.copied), message: `${geo.copied.length} ${geo.copied.length === 1 ? 'outline is' : 'outlines are'} drawn twice, one copy hidden under the other.` })
  if (geo.crossing.length)
    issues.push({ id: 'self-intersections', kind: 'geometry', severity: 'check', count: geo.crossing.length, where: top(geo.crossing), message: `${geo.crossing.length} ${geo.crossing.length === 1 ? 'outline crosses' : 'outlines cross'} itself.` })
  if (geo.tiny.length)
    issues.push({ id: 'tiny-contours', kind: 'geometry', severity: 'check', count: geo.tiny.length, where: top(geo.tiny), message: `${geo.tiny.length} ${geo.tiny.length === 1 ? 'shape is' : 'shapes are'} smaller than ${TINY_AREA} px², too small to see or cut.` })
  if (geo.paper)
    issues.push({ id: 'paper-shape', kind: 'geometry', severity: 'check', count: 1, where: [{ x: 0, y: 0, w, h, area: w * h }], message: 'The paper background is drawn as a white shape; it would print as white ink.' })

  const worst = (kind: FidelityIssue['kind']): FidelityVerdict => {
    const s = issues.filter((i) => i.kind === kind).map((i) => i.severity)
    return s.includes('not-suitable') ? 'not-suitable' : s.length ? 'check' : 'ready'
  }
  const visual = worst('visual')
  const geometryVerdict = worst('geometry')
  const verdict = visual === 'not-suitable' || geometryVerdict === 'not-suitable' ? 'not-suitable' : visual === 'check' || geometryVerdict === 'check' ? 'check' : 'ready'
  return {
    width: w,
    height: h,
    edgeRecall: cmp.edgeRecall,
    edgePrecision: cmp.edgePrecision,
    meanError: cmp.meanError,
    wrongShare: cmp.tolerantWrongShare,
    features: { count: feat.count, fine: feat.fine, lost: feat.lost.length, lostArea, changed: feat.changed.length },
    shading: shade,
    geometry: { contours: geo.contours, copiedOutlines: geo.copied.length, selfIntersecting: geo.crossing.length, tiny: geo.tiny.length, raster: geo.raster, paperShape: geo.paper },
    visual,
    geometryVerdict,
    verdict,
    issues,
  }
}

const top = (r: Region[]) => [...r].sort((a, b) => b.area - a.area).slice(0, 20)

// ---------- Features: areas of one colour that stand out from their surroundings ----------

/**
 * The upload's colours are found from its solid pixels (all 4 neighbours alike), and both images
 * are labelled with the nearest of them, so anti-aliasing is treated the same way in each. A
 * feature is a connected area of one label in the upload, with at least MIN_CORE solid pixels,
 * whose colour differs by FEATURE_DE or more from every area it touches. Steps inside a gradient
 * are smaller than that, so gradients don't break into features.
 */
function features(upload: ImageData, vector: ImageData) {
  const { width: w, height: h } = upload
  const n = w * h
  const U = over(upload.data, n)
  const V = over(vector.data, n)
  const tu = transparency(upload.data, n)
  const tv = transparency(vector.data, n)
  const palette = paletteOf(U, tu, w, h)
  const labs = palette.map((c) => rgbToLab(c))
  const lu = labelWith(U, tu, palette, n)
  const lv = labelWith(V, tv, palette, n)

  // Connected areas of one label (8-connected), with their solid pixel count.
  const comp = new Int32Array(n).fill(-1)
  const areas: { label: number; px: number[]; core: number; x0: number; y0: number; x1: number; y1: number; touches: Set<number> }[] = []
  const stack: number[] = []
  for (let s = 0; s < n; s++) {
    if (comp[s] >= 0 || lu[s] < 0) continue
    const id = areas.length
    const a = { label: lu[s], px: [] as number[], core: 0, x0: w, y0: h, x1: 0, y1: 0, touches: new Set<number>() }
    areas.push(a)
    comp[s] = id
    stack.push(s)
    while (stack.length) {
      const p = stack.pop()!
      a.px.push(p)
      const x = p % w, y = (p / w) | 0
      if (x < a.x0) a.x0 = x
      if (y < a.y0) a.y0 = y
      if (x > a.x1) a.x1 = x
      if (y > a.y1) a.y1 = y
      if (solid(U, tu, p, x, y, w, h)) a.core++
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue
          const xx = x + dx, yy = y + dy
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue
          const q = yy * w + xx
          if (lu[q] === a.label && comp[q] < 0) {
            comp[q] = id
            stack.push(q)
          }
        }
    }
  }
  // Neighbouring labels, among areas with a real core (AA fringes don't count as surroundings).
  for (let p = 0; p < n; p++) {
    const a = comp[p]
    if (a < 0) continue
    const x = p % w, y = (p / w) | 0
    if (x + 1 < w) link(a, comp[p + 1])
    if (y + 1 < h) link(a, comp[p + w])
  }
  function link(a: number, b: number) {
    if (b < 0 || a === b) return
    if (areas[b].core >= MIN_CORE) areas[a].touches.add(areas[b].label)
    if (areas[a].core >= MIN_CORE) areas[b].touches.add(areas[a].label)
  }

  const imageArea = n - count(tu)
  const lost: Region[] = []
  const changed: Region[] = []
  let count_ = 0, fine = 0, fineArea = 0, lostAreaPx = 0
  const largest = areas.reduce((m, a, i) => (a.px.length > (areas[m]?.px.length ?? -1) ? i : m), -1)
  areas.forEach((a, i) => {
    if (i === largest || a.core < MIN_CORE || a.label === TRANSPARENT) return
    let stands = a.touches.size > 0
    for (const t of a.touches) if (t === TRANSPARENT ? false : deltaE2000(labs[a.label], labs[t]) < FEATURE_DE) stands = false
    if (!stands) return
    count_++
    const region: Region = { x: a.x0, y: a.y0, w: a.x1 - a.x0 + 1, h: a.y1 - a.y0 + 1, area: a.px.length }
    // Kept: the vector shows the feature's colour at the pixel or within 1 px of it.
    let kept = 0
    for (const p of a.px) if (near(lv, p, a.label, w, h)) kept++
    const isFine = a.px.length <= Math.max(FINE_MIN_PX, FINE_SHARE * imageArea)
    if (isFine) {
      fine++
      fineArea += a.px.length
    }
    if (kept / a.px.length < LOST_SHARE) {
      if (isFine) {
        lost.push(region)
        lostAreaPx += a.px.length
      }
      return
    }
    // Shape: IoU of the feature's pixels and the vector's pixels of that colour around it.
    if (a.px.length < CHANGED_MIN_AREA || !isFine) return
    const inU = new Set(a.px)
    let inter = 0, union = inU.size
    for (let y = Math.max(0, a.y0 - 2); y <= Math.min(h - 1, a.y1 + 2); y++)
      for (let x = Math.max(0, a.x0 - 2); x <= Math.min(w - 1, a.x1 + 2); x++) {
        const p = y * w + x
        if (lv[p] !== a.label) continue
        // Only vector pixels connected to this feature's place, not a neighbouring feature's.
        if (inU.has(p)) inter++
        else if (comp[p] < 0 || areas[comp[p]].label !== a.label) union++
      }
    if (inter / union < CHANGED_IOU) changed.push(region)
  })
  return { count: count_, fine, fineArea, lost, lostAreaPx, changed }
}

const TRANSPARENT = -2

function over(d: ArrayLike<number>, n: number): Float32Array {
  const out = new Float32Array(n * 3)
  for (let p = 0; p < n; p++) {
    const a = d[p * 4 + 3] / 255
    for (let k = 0; k < 3; k++) out[p * 3 + k] = d[p * 4 + k] * a + 255 * (1 - a)
  }
  return out
}
function transparency(d: ArrayLike<number>, n: number): Uint8Array {
  const t = new Uint8Array(n)
  for (let p = 0; p < n; p++) t[p] = d[p * 4 + 3] < 128 ? 1 : 0
  return t
}
const count = (a: Uint8Array) => a.reduce((s, v) => s + v, 0)

/**
 * Solid: alike (within 24 levels in every channel) to both neighbours along at least one line
 * through the pixel (horizontal, vertical or diagonal), so a one-pixel stroke is solid along its
 * length while an anti-aliased edge pixel, which differs from the pixels across the edge, is not
 * unless the edge runs exactly along a pixel row (those blends are removed from the palette).
 */
function solid(c: Float32Array, t: Uint8Array, p: number, x: number, y: number, w: number, h: number): boolean {
  if (t[p] || x === 0 || y === 0 || x === w - 1 || y === h - 1) return false
  const alike = (q: number) => {
    if (t[q]) return false
    for (let k = 0; k < 3; k++) if (Math.abs(c[q * 3 + k] - c[p * 3 + k]) > 24) return false
    return true
  }
  return (alike(p - 1) && alike(p + 1)) || (alike(p - w) && alike(p + w)) || (alike(p - w - 1) && alike(p + w + 1)) || (alike(p - w + 1) && alike(p + w - 1))
}

/** The upload's colours: peaks of the solid pixels' colour histogram, at least 0.05% of them each. */
function paletteOf(c: Float32Array, t: Uint8Array, w: number, h: number): [number, number, number][] {
  const bins = new Map<number, { n: number; r: number; g: number; b: number }>()
  let total = 0
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x
      if (!solid(c, t, p, x, y, w, h)) continue
      const r = c[p * 3], g = c[p * 3 + 1], b = c[p * 3 + 2]
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)
      const e = bins.get(key) ?? { n: 0, r: 0, g: 0, b: 0 }
      e.n++; e.r += r; e.g += g; e.b += b
      bins.set(key, e)
      total++
    }
  const sorted = [...bins.values()].sort((a, b) => b.n - a.n)
  const out: [number, number, number][] = []
  // Transparent pixels are composited over white, so edges against them blend toward white.
  const refs: [number, number, number][] = t.some((v) => v) ? [[255, 255, 255]] : []
  for (const e of sorted) {
    if (e.n < Math.max(2, total * 0.0005) || out.length >= 48) break
    const col: [number, number, number] = [e.r / e.n, e.g / e.n, e.b / e.n]
    // A bin next to a stronger one is the same colour (compression, rounding).
    if (out.some((o) => Math.max(Math.abs(o[0] - col[0]), Math.abs(o[1] - col[1]), Math.abs(o[2] - col[2])) <= 16)) continue
    // A mix of two stronger colours is anti-aliasing along an edge, not a colour of its own.
    if (isBlend(col, [...refs, ...out])) continue
    out.push(col)
  }
  return out
}

function isBlend(c: [number, number, number], palette: [number, number, number][]): boolean {
  for (let i = 0; i < palette.length; i++)
    for (let j = i + 1; j < palette.length; j++) {
      const a = palette[i], b = palette[j]
      const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
      const len = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2
      if (!len) continue
      const t = ((c[0] - a[0]) * ab[0] + (c[1] - a[1]) * ab[1] + (c[2] - a[2]) * ab[2]) / len
      if (t < 0.15 || t > 0.85) continue
      if (Math.hypot(a[0] + t * ab[0] - c[0], a[1] + t * ab[1] - c[1], a[2] + t * ab[2] - c[2]) <= 12) return true
    }
  return false
}

function labelWith(c: Float32Array, t: Uint8Array, palette: [number, number, number][], n: number): Int32Array {
  const out = new Int32Array(n)
  for (let p = 0; p < n; p++) {
    if (t[p]) {
      out[p] = TRANSPARENT
      continue
    }
    let best = -1, bd = Infinity
    for (let i = 0; i < palette.length; i++) {
      const d = (c[p * 3] - palette[i][0]) ** 2 + (c[p * 3 + 1] - palette[i][1]) ** 2 + (c[p * 3 + 2] - palette[i][2]) ** 2
      if (d < bd) [best, bd] = [i, d]
    }
    out[p] = best
  }
  return out
}

/** Whether the label appears at p or one of its 8 neighbours. */
function near(l: Int32Array, p: number, label: number, w: number, h: number): boolean {
  if (l[p] === label) return true
  const x = p % w, y = (p / w) | 0
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy
      if (xx >= 0 && yy >= 0 && xx < w && yy < h && l[yy * w + xx] === label) return true
    }
  return false
}

// ---------- Geometry: is the SVG genuine, editable vector artwork? ----------

function geometry(svg: string, upload: ImageData) {
  const raster = RASTER_CONSTRUCTS.filter(([, re]) => re.test(svg)).map(([name]) => name)
  const shapes = shapesFromSvg(svg)
  // Path coordinates are in the SVG's viewBox (traced px); measure in upload px.
  const vb = svg.match(/<svg\b[^>]*\sviewBox="\s*[-\d.e]+[ ,]+[-\d.e]+[ ,]+([\d.e]+)[ ,]+([\d.e]+)/i)
  const wAttr = svg.match(/<svg\b[^>]*\swidth="([\d.]+)/i)
  const units = vb ? Number(vb[1]) : wAttr ? Number(wAttr[1]) : upload.width
  const k = upload.width / units
  const rings: { color: number; pts: Pt[]; area: number; box: [number, number, number, number] }[] = []
  for (const s of shapes as ColorShape[])
    for (const sp of s.subpaths) {
      const pts = flatten(sp, 0.05).map(([x, y]) => [x * k, y * k] as Pt)
      rings.push({ color: s.color, pts, area: Math.abs(polyArea(pts)), box: boxOf(pts) })
    }
  const reg = (r: (typeof rings)[number]): Region => ({ x: Math.floor(r.box[0]), y: Math.floor(r.box[1]), w: Math.ceil(r.box[2] - r.box[0]) + 1, h: Math.ceil(r.box[3] - r.box[1]) + 1, area: Math.round(r.area) })

  // The same filled outline twice, in two different paths (one drawn under the other): area within
  // 3% and box within 1 px to find candidates, then every point of each outline within COPY_MATCH
  // of the other. Holes don't count: two layers with a hole in the same place share an edge but
  // draw nothing twice. Rings of one path are its holes and parts, not copies.
  const owner: number[] = []
  shapes.forEach((s, i) => s.subpaths.forEach(() => owner.push(i)))
  const hole = rings.map((r, i) => rings.reduce((n, o, j) => (j !== i && owner[j] === owner[i] && inside(r.pts[0], o.pts) ? n + 1 : n), 0) % 2 === 1)
  const copied: Region[] = []
  const order = rings.map((_, i) => i).sort((a, b) => rings[a].box[0] - rings[b].box[0])
  for (let s = 0; s < order.length; s++) {
    const i = order[s]
    const a = rings[i]
    if (a.area < TINY_AREA || hole[i]) continue
    for (let t = s + 1; t < order.length && rings[order[t]].box[0] - a.box[0] <= 1; t++) {
      const j = order[t]
      const b = rings[j]
      if (owner[i] === owner[j] || hole[j]) continue
      if (Math.abs(a.area - b.area) > 0.03 * a.area || !a.box.every((v, k) => Math.abs(v - b.box[k]) <= 1)) continue
      if (within(a.pts, b.pts, COPY_MATCH) && within(b.pts, a.pts, COPY_MATCH)) {
        copied.push(reg(a))
        break
      }
    }
  }
  // Crossings are tested on a much finer flattening: near-tangent curves flattened coarsely can
  // appear to cross when they don't (seen on two Firefox outlines).
  const fine = shapes.flatMap((s) => s.subpaths.map((sp) => fineFlatten(sp, k)))
  const crosses = fine.map((pts) => pts.length < 40000 && selfIntersects(pts))
  const crossing = rings.filter((_, i) => crosses[i]).map(reg)
  // A crossing outline's lobes cancel in its area, so it is reported as crossing, not as tiny.
  const tiny = rings.filter((r, i) => !crosses[i] && r.area < TINY_AREA).map(reg)

  // Paper: an opaque upload whose vector has a near-white shape covering the whole canvas.
  const d = upload.data
  let opaque = true
  for (let i = 3; i < d.length && opaque; i += 4) if (d[i] < 255) opaque = false
  const W = upload.width, H = upload.height
  const paper =
    opaque &&
    rings.some((r, i) => {
      const c = shapes[owner[i]].color
      const light = Math.min((c >> 16) & 255, (c >> 8) & 255, c & 255) >= PAPER_MIN_CHANNEL
      return light && r.area >= PAPER_COVER * W * H
    })
  return { raster, contours: rings.length, copied, crossing, tiny, paper }
}

/** A subpath as a polyline with curve steps of at most 0.05 upload px (up to 1024 per curve), scaled by k. */
function fineFlatten(sp: Subpath, k: number): Pt[] {
  const pts: Pt[] = [[sp.start[0] * k, sp.start[1] * k]]
  let cur = sp.start
  for (const g of sp.segs) {
    if (g.t === 'L') pts.push([g.p[0] * k, g.p[1] * k])
    else {
      const len = (Math.hypot(g.c1[0] - cur[0], g.c1[1] - cur[1]) + Math.hypot(g.c2[0] - g.c1[0], g.c2[1] - g.c1[1]) + Math.hypot(g.p[0] - g.c2[0], g.p[1] - g.c2[1])) * k
      const n = Math.min(1024, Math.max(2, Math.ceil(len / 0.05)))
      for (let i = 1; i <= n; i++) {
        const t = i / n, u = 1 - t
        pts.push([(u ** 3 * cur[0] + 3 * u * u * t * g.c1[0] + 3 * u * t * t * g.c2[0] + t ** 3 * g.p[0]) * k, (u ** 3 * cur[1] + 3 * u * u * t * g.c1[1] + 3 * u * t * t * g.c2[1] + t ** 3 * g.p[1]) * k])
      }
    }
    cur = g.p
  }
  return pts
}

/** Even-odd: whether a point is inside a closed polyline. */
function inside([x, y]: Pt, r: Pt[]): boolean {
  let c = false
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i]
    const [xj, yj] = r[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c
  }
  return c
}

/** Whether every point of `a` (up to 200, evenly spread) is within `tol` of the outline `b`. */
function within(a: Pt[], b: Pt[], tol: number): boolean {
  const step = Math.max(1, Math.floor(a.length / 200))
  for (let i = 0; i < a.length; i += step) {
    const [x, y] = a[i]
    let near = false
    for (let k = 0; k < b.length && !near; k++) {
      const p = b[k], q = b[(k + 1) % b.length]
      const dx = q[0] - p[0], dy = q[1] - p[1]
      const L = dx * dx + dy * dy
      const t = L ? Math.max(0, Math.min(1, ((x - p[0]) * dx + (y - p[1]) * dy) / L)) : 0
      if (Math.hypot(p[0] + t * dx - x, p[1] + t * dy - y) <= tol) near = true
    }
    if (!near) return false
  }
  return true
}

function polyArea(p: Pt[]): number {
  let a = 0
  for (let i = 0; i < p.length; i++) {
    const [x0, y0] = p[i]
    const [x1, y1] = p[(i + 1) % p.length]
    a += x0 * y1 - x1 * y0
  }
  return a / 2
}
function boxOf(p: Pt[]): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const [x, y] of p) {
    if (x < x0) x0 = x
    if (y < y0) y0 = y
    if (x > x1) x1 = x
    if (y > y1) y1 = y
  }
  return [x0, y0, x1, y1]
}

