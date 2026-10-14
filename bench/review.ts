// Visual review for the real-logo acceptance test (bench/real.html): the upload, the first
// result, the suggested improvement and the original side by side, enlarged together up to 32×;
// structural checks (nodes, jagged or kinked outlines, merged / broken / missing / extra shapes,
// wrong colours, cut-file pieces); a manual checklist per logo; and a self-contained HTML report
// with a PASS / REVIEW / FAIL verdict per logo and a release recommendation.
// Nothing here changes what the app does.
import type { ColourMatch } from '../src/quality/compare'
import { shapesFromSvg, type Subpath } from '../src/export/path'

/** Thresholds for the structural flags. They raise REVIEW, never FAIL on their own. */
export const STRUCTURE = {
  /** Segments per 100 px of outline (at upload size) above which a result is node-heavy. */
  maxNodesPer100px: 12,
  /** Node count above this multiple of the original SVG's. */
  maxNodesVsOriginal: 3,
  /** Share of segments shorter than ¾ upload px: stair-steps that show as jagged edges when enlarged. */
  maxShortSegments: 0.15,
  /** Share of curve-to-curve joins with a 15–60° bend: lumps that show when enlarged. */
  maxKinks: 0.05,
  /** Cut pieces smaller than this (mm, at the DXF's 200 mm width) are hard to weed. */
  minCutPieceMm: 1,
  /** A colour this far (ΔE2000) from the original's is listed as wrong. */
  wrongColourDE: 3,
}

export interface Box {
  /** Fractions of the image. */
  x: number
  y: number
  w: number
  h: number
  kind: 'merged' | 'broken' | 'missing' | 'extra' | 'interpreted'
  /** Only on this picture (0 upload, 1 first result, 2 offer, 3 original); all vector pictures when unset. */
  pane?: number
}

export interface Structure {
  /** What the shapes were compared with. */
  against: 'original' | 'upload'
  nodes: number
  originalNodes: number | null
  nodesPer100px: number
  shortSegments: number
  kinks: number
  openOutlines: number
  cutPieces: number
  tinyCutPieces: number
  shapes: { reference: number; result: number; merged: number; broken: number; missing: number; extra: number }
  boxes: Box[]
  /** The spot with the most outline (fractions), enlarged when nothing is flagged. */
  focus: { x: number; y: number }
  wrongColours: ColourMatch[]
}

// ---------------------------------------------------------------------------------------------
// Structural checks

const segCount = (subs: Subpath[]) => subs.reduce((n, s) => n + s.segs.length, 0)

function outlineStats(subs: Subpath[], scale: number) {
  let short = 0
  let segs = 0
  let joins = 0
  let kinks = 0
  for (const s of subs) {
    let prev = s.start
    let lastTangent: [number, number] | null = null
    let lastWasCurve = false
    for (const g of s.segs) {
      segs++
      if (Math.hypot(g.p[0] - prev[0], g.p[1] - prev[1]) * scale < 0.75) short++
      if (g.t === 'C') {
        const inT: [number, number] = [g.c1[0] - prev[0], g.c1[1] - prev[1]]
        if (lastWasCurve && lastTangent) {
          const a = Math.hypot(...inT) * Math.hypot(...lastTangent)
          if (a > 1e-9) {
            joins++
            const bend = (Math.acos(Math.max(-1, Math.min(1, (inT[0] * lastTangent[0] + inT[1] * lastTangent[1]) / a))) * 180) / Math.PI
            if (bend > 15 && bend < 60) kinks++
          }
        }
        lastTangent = [g.p[0] - g.c2[0], g.p[1] - g.c2[1]]
        lastWasCurve = true
      } else lastWasCurve = false
      prev = g.p
    }
  }
  return { short: segs ? short / segs : 0, kinks: joins ? kinks / joins : 0 }
}

/** Composites RGBA over white and returns the ink mask (pixels unlike the border colour). */
function inkMask(img: ImageData): Uint8Array {
  const { width: w, height: h, data } = img
  const rgb = new Uint8ClampedArray(w * h * 3)
  for (let p = 0; p < w * h; p++) {
    const a = data[p * 4 + 3] / 255
    for (let k = 0; k < 3; k++) rgb[p * 3 + k] = data[p * 4 + k] * a + 255 * (1 - a)
  }
  // Background: the most common (coarsely quantized) colour along the border.
  const votes = new Map<number, number>()
  const vote = (p: number) => {
    const q = ((rgb[p * 3] >> 4) << 8) | ((rgb[p * 3 + 1] >> 4) << 4) | (rgb[p * 3 + 2] >> 4)
    votes.set(q, (votes.get(q) ?? 0) + 1)
  }
  for (let x = 0; x < w; x++) vote(x), vote((h - 1) * w + x)
  for (let y = 0; y < h; y++) vote(y * w), vote(y * w + w - 1)
  const bgq = [...votes].sort((a, b) => b[1] - a[1])[0][0]
  const bg = [((bgq >> 8) & 15) * 16 + 8, ((bgq >> 4) & 15) * 16 + 8, (bgq & 15) * 16 + 8]
  const mask = new Uint8Array(w * h)
  for (let p = 0; p < w * h; p++) {
    const d = Math.max(Math.abs(rgb[p * 3] - bg[0]), Math.abs(rgb[p * 3 + 1] - bg[1]), Math.abs(rgb[p * 3 + 2] - bg[2]))
    mask[p] = d > 60 ? 1 : 0
  }
  return mask
}

interface Components {
  labels: Int32Array
  areas: number[]
  bbox: [number, number, number, number][]
}

function components(mask: Uint8Array, w: number, h: number): Components {
  const labels = new Int32Array(w * h).fill(-1)
  const areas: number[] = []
  const bbox: [number, number, number, number][] = []
  const stack: number[] = []
  for (let p0 = 0; p0 < w * h; p0++) {
    if (!mask[p0] || labels[p0] >= 0) continue
    const id = areas.length
    let area = 0
    let x0 = w, y0 = h, x1 = 0, y1 = 0
    labels[p0] = id
    stack.push(p0)
    while (stack.length) {
      const p = stack.pop()!
      const x = p % w
      const y = (p - x) / w
      area++
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1])
        if (q >= 0 && mask[q] && labels[q] < 0) {
          labels[q] = id
          stack.push(q)
        }
    }
    areas.push(area)
    bbox.push([x0, y0, x1, y1])
  }
  return { labels, areas, bbox }
}

/**
 * Counts separate shapes (letters, marks, dots) in the reference and the result and matches
 * them by overlap: a result shape covering two reference shapes merged them; a reference shape
 * split over two result shapes is broken; one the result barely covers is missing; a result shape
 * the reference barely covers is extra.
 */
export function compareShapes(reference: ImageData, result: ImageData): Pick<Structure, 'shapes' | 'boxes'> {
  const { width: w, height: h } = reference
  const minArea = Math.max(6, w * h * 1e-5)
  const rm = inkMask(reference)
  const cm = inkMask(result)
  const R = components(rm, w, h)
  const C = components(cm, w, h)
  const overlap = new Map<number, number>()
  const rInk = new Array(R.areas.length).fill(0)
  const cInk = new Array(C.areas.length).fill(0)
  for (let p = 0; p < w * h; p++) {
    const r = R.labels[p]
    const c = C.labels[p]
    if (r >= 0 && c >= 0) overlap.set(r * C.areas.length + c, (overlap.get(r * C.areas.length + c) ?? 0) + 1)
    if (r >= 0 && cm[p]) rInk[r]++
    if (c >= 0 && rm[p]) cInk[c]++
  }
  // Shapes covering more than a quarter of the image are backgrounds, not letters or marks.
  const big = (a: number) => a >= minArea && a <= w * h * 0.25
  const pieces = new Map<number, number[]>()
  const covers = new Map<number, number[]>()
  for (const [key, n] of overlap) {
    const r = Math.floor(key / C.areas.length)
    const c = key % C.areas.length
    if (!big(R.areas[r]) || !big(C.areas[c])) continue
    if (n >= 0.15 * R.areas[r]) pieces.set(r, [...(pieces.get(r) ?? []), c])
    if (n >= 0.3 * R.areas[r]) covers.set(c, [...(covers.get(c) ?? []), r])
  }
  const boxes: Box[] = []
  const box = (b: [number, number, number, number], kind: Box['kind']) => boxes.push({ x: b[0] / w, y: b[1] / h, w: (b[2] - b[0] + 1) / w, h: (b[3] - b[1] + 1) / h, kind })
  const union = (bs: [number, number, number, number][]): [number, number, number, number] => [Math.min(...bs.map((b) => b[0])), Math.min(...bs.map((b) => b[1])), Math.max(...bs.map((b) => b[2])), Math.max(...bs.map((b) => b[3]))]
  let merged = 0, broken = 0, missing = 0, extra = 0
  for (const [c, rs] of covers)
    if (rs.length >= 2) {
      merged++
      box(union([C.bbox[c], ...rs.map((r) => R.bbox[r])]), 'merged')
    }
  for (const [r, cs] of pieces)
    if (cs.length >= 2) {
      broken++
      box(R.bbox[r], 'broken')
    }
  R.areas.forEach((a, r) => {
    if (big(a) && rInk[r] < 0.5 * a) {
      missing++
      box(R.bbox[r], 'missing')
    }
  })
  C.areas.forEach((a, c) => {
    if (big(a) && cInk[c] < 0.3 * a) {
      extra++
      box(C.bbox[c], 'extra')
    }
  })
  return {
    shapes: { reference: R.areas.filter(big).length, result: C.areas.filter(big).length, merged, broken, missing, extra },
    boxes: boxes.sort((a, b) => b.w * b.h - a.w * a.h),
  }
}

/** Outline length of the ink in an image (its own pixels), and the 1/16-size cell with the most outline. */
function outline(img: ImageData): { length: number; focus: { x: number; y: number } } {
  const m = inkMask(img)
  const { width: w, height: h } = img
  const cell = Math.max(1, Math.round(Math.max(w, h) / 16))
  const cols = Math.ceil(w / cell)
  const cells = new Array(cols * Math.ceil(h / cell)).fill(0)
  let n = 0
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = y * w + x
      if (m[p] && (x === 0 || y === 0 || x === w - 1 || y === h - 1 || !m[p - 1] || !m[p + 1] || !m[p - w] || !m[p + w])) {
        n++
        cells[Math.floor(y / cell) * cols + Math.floor(x / cell)]++
      }
    }
  const best = cells.indexOf(Math.max(...cells))
  return { length: n, focus: { x: Math.min(1, ((best % cols) + 0.5) * cell / w), y: Math.min(1, (Math.floor(best / cols) + 0.5) * cell / h) } }
}

function originalNodes(svg: string): number | null {
  try {
    const n = segCount(shapesFromSvg(svg).flatMap((s) => s.subpaths))
    // Originals drawn with <rect>, <circle>, <polygon> or text aren't counted reliably.
    return n && !/<(rect|circle|ellipse|polygon|polyline|line|text)\b/.test(svg) ? n : null
  } catch {
    return null
  }
}

export function structureChecks(o: {
  svg: string
  plateSvg: string
  width: number
  height: number
  /** Reference and result rendered at the same size (original if supplied, else the upload). */
  reference: ImageData
  result: ImageData
  against: 'original' | 'upload'
  originalSvg: string | null
  colours: ColourMatch[]
}): Structure {
  const subs = shapesFromSvg(o.svg).flatMap((s) => s.subpaths)
  const nodes = segCount(subs)
  const k = o.result.width / o.width
  const ol = outline(o.result)
  const outlinePx = ol.length / k
  const { short, kinks } = outlineStats(subs, 1)
  const plate = shapesFromSvg(o.plateSvg).flatMap((s) => s.subpaths)
  const mm = 200 / o.width
  const tiny = plate.filter((s) => {
    const xs = [s.start[0], ...s.segs.map((g) => g.p[0])]
    const ys = [s.start[1], ...s.segs.map((g) => g.p[1])]
    return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) * mm < STRUCTURE.minCutPieceMm
  }).length
  return {
    against: o.against,
    nodes,
    originalNodes: o.originalSvg ? originalNodes(o.originalSvg) : null,
    nodesPer100px: +(outlinePx ? (nodes / outlinePx) * 100 : 0).toFixed(1),
    shortSegments: +short.toFixed(3),
    kinks: +kinks.toFixed(3),
    openOutlines: plate.filter((s) => !s.closed).length,
    cutPieces: plate.length,
    tinyCutPieces: tiny,
    ...compareShapes(o.reference, o.result),
    focus: ol.focus,
    wrongColours: o.colours.filter((c) => c.deltaE > STRUCTURE.wrongColourDE),
  }
}

/** Plain-language flags for the structural checks. */
export function structureFlags(s: Structure): string[] {
  const f: string[] = []
  const vs = s.against === 'original' ? 'the original' : 'the upload'
  if (s.nodesPer100px > STRUCTURE.maxNodesPer100px) f.push(`excessive nodes: ${s.nodes} (${s.nodesPer100px} per 100 px of outline)`)
  if (s.originalNodes && s.nodes > s.originalNodes * STRUCTURE.maxNodesVsOriginal) f.push(`excessive nodes: ${s.nodes} vs ${s.originalNodes} in the original`)
  if (s.shortSegments > STRUCTURE.maxShortSegments) f.push(`jagged edges likely when enlarged: ${Math.round(s.shortSegments * 100)}% of segments under ¾ px`)
  if (s.kinks > STRUCTURE.maxKinks) f.push(`lumpy curves likely when enlarged: ${Math.round(s.kinks * 100)}% of curve joins bend 15–60°`)
  if (s.shapes.merged) f.push(`${s.shapes.merged} merged shape(s) / letters vs ${vs}`)
  if (s.shapes.broken) f.push(`${s.shapes.broken} broken shape(s) vs ${vs}`)
  if (s.shapes.missing) f.push(`${s.shapes.missing} missing detail(s) vs ${vs}`)
  if (s.shapes.extra) f.push(`${s.shapes.extra} extra shape(s) not in ${vs}`)
  if (s.wrongColours.length) f.push(`incorrect colour(s): ${s.wrongColours.map((c) => `${c.reference}→${c.candidate} (ΔE ${c.deltaE.toFixed(1)})`).join(', ')}`)
  if (s.openOutlines) f.push(`cut file: ${s.openOutlines} open outline(s)`)
  if (s.tinyCutPieces) f.push(`cut file: ${s.tinyCutPieces} of ${s.cutPieces} pieces under ${STRUCTURE.minCutPieceMm} mm at 200 mm wide (hard to weed)`)
  return f
}

// ---------------------------------------------------------------------------------------------
// Side-by-side and enlarged comparison

export interface Visual {
  file: string
  width: number
  height: number
  /** Image sources (object or data URLs). */
  upload: string
  first: string
  offer: { label: string; src: string } | null
  original: string | null
  /** Whether the original is vector (rendered sharp at any zoom) or a PNG. */
  originalIsVector: boolean
  boxes: Box[]
  focus: { x: number; y: number }
  /** Picture titles, when not the acceptance test's (upload, first result, offer, original). */
  titles?: [string, string, string, string]
}

export const svgUrl = (svg: string) => URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
export const ZOOMS = [1, 4, 8, 16, 32]
const VIEW = 230

const BOX_COLOURS: Record<Box['kind'], string> = { merged: '#c0362c', broken: '#d97706', missing: '#7c3aed', extra: '#0369a1', interpreted: '#db2777' }

function panes(v: Visual) {
  return [
    { title: v.titles?.[0] ?? 'Upload (raster)', src: v.upload, pixelated: true, note: 'pixels shown as they are' },
    { title: v.titles?.[1] ?? 'First vector result', src: v.first, pixelated: false, note: '' },
    { title: v.titles?.[2] ?? 'Suggested improvement', src: v.offer?.src ?? null, pixelated: false, note: v.offer ? v.offer.label : 'none suggested' },
    { title: v.titles?.[3] ?? 'Original artwork', src: v.original, pixelated: false, note: v.original ? (v.originalIsVector ? 'vector' : 'high-res PNG') : 'not supplied: review by eye' },
  ]
}

/** Inline style for an image showing the logo at `zoom`, centred on (fx, fy). */
function placement(v: Visual, zoom: number, fx: number, fy: number) {
  const fit = Math.min(VIEW / v.width, VIEW / v.height)
  const w = v.width * fit * zoom
  const h = v.height * fit * zoom
  const left = zoom === 1 ? (VIEW - w) / 2 : Math.min(0, Math.max(VIEW - w, VIEW / 2 - fx * w))
  const top = zoom === 1 ? (VIEW - h) / 2 : Math.min(0, Math.max(VIEW - h, VIEW / 2 - fy * h))
  return { w, h, left, top }
}

const BACKGROUNDS: Record<string, string> = {
  checker: 'background:#fff repeating-conic-gradient(#ddd 0 25%,#fff 0 50%) 0 0/16px 16px',
  white: 'background:#fff',
  black: 'background:#111',
}

/** Static markup of the four panes (used live and in the report). */
export function panesHtml(v: Visual, zoom: number, fx: number, fy: number, bg = 'checker', showBoxes = true): string {
  const p = placement(v, zoom, fx, fy)
  return panes(v)
    .map((pane, i) => {
      const img = pane.src
        ? `<img src="${pane.src}" alt="" style="position:absolute;left:${p.left}px;top:${p.top}px;width:${p.w}px;height:${p.h}px;max-width:none;${pane.pixelated ? 'image-rendering:pixelated;' : ''}">`
        : `<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#888;text-align:center;padding:12px">${pane.note}</div>`
      const boxes =
        showBoxes && pane.src && (i === 1 || i === 2 || (i === 3 && v.original))
          ? v.boxes.filter((b) => b.pane === undefined || b.pane === i).map((b) => `<div title="${b.kind}" style="position:absolute;left:${p.left + b.x * p.w - 2}px;top:${p.top + b.y * p.h - 2}px;width:${b.w * p.w + 4}px;height:${b.h * p.h + 4}px;border:2px solid ${BOX_COLOURS[b.kind]};pointer-events:none"></div>`).join('')
          : ''
      return `<figure style="margin:0;width:${VIEW}px"><div data-pane="${i}" style="position:relative;width:${VIEW}px;height:${VIEW}px;overflow:hidden;border:1px solid #ccc;cursor:crosshair;${BACKGROUNDS[bg]}">${img}${boxes}</div><figcaption style="font-size:11px;margin-top:3px"><b>${pane.title}</b>${pane.src && pane.note ? `<br><small>${pane.note}</small>` : ''}</figcaption></figure>`
    })
    .join('')
}

/** A live viewer: zoom buttons, background toggle, click a pane to choose the enlarged spot. */
export function viewer(v: Visual): HTMLElement {
  const el = document.createElement('div')
  let zoom = 1
  let bg = 'checker'
  let showBoxes = true
  const first = v.boxes[0]
  let fx = first ? first.x + first.w / 2 : v.focus.x
  let fy = first ? first.y + first.h / 2 : v.focus.y
  const legend = Object.entries(BOX_COLOURS).map(([k, c]) => `<span style="color:${c}">■ ${k}</span>`).join(' ')
  const draw = () => {
    el.innerHTML = `<div style="margin:6px 0">Enlarge: ${ZOOMS.map((z) => `<button data-zoom="${z}" style="${z === zoom ? 'font-weight:bold' : ''}">${z}×</button>`).join('')}
      &nbsp; Background: ${Object.keys(BACKGROUNDS).map((b) => `<button data-bg="${b}" style="${b === bg ? 'font-weight:bold' : ''}">${b}</button>`).join('')}
      &nbsp; <label><input type="checkbox" data-boxes ${showBoxes ? 'checked' : ''}> flagged areas</label> <small>${v.boxes.length ? legend : 'no shape flags'}</small>
      ${v.boxes.length ? ` &nbsp; <button data-next>next flag</button>` : ''}
      <br><small>Click any picture to choose the spot to enlarge; all four follow.</small></div>
      <div style="display:flex;gap:10px;flex-wrap:wrap">${panesHtml(v, zoom, fx, fy, bg, showBoxes)}</div>`
  }
  let flag = 0
  el.addEventListener('click', (e) => {
    const t = e.target as HTMLElement
    if (t.dataset.zoom) zoom = Number(t.dataset.zoom)
    else if (t.dataset.bg) bg = t.dataset.bg
    else if (t.dataset.boxes !== undefined) showBoxes = (t as HTMLInputElement).checked
    else if (t.dataset.next !== undefined) {
      flag = (flag + 1) % v.boxes.length
      const b = v.boxes[flag]
      fx = b.x + b.w / 2
      fy = b.y + b.h / 2
      if (zoom === 1) zoom = 8
    } else {
      const pane = t.closest('[data-pane]') as HTMLElement | null
      if (!pane) return
      const r = pane.getBoundingClientRect()
      const p = placement(v, zoom, fx, fy)
      fx = Math.max(0, Math.min(1, (e.clientX - r.left - p.left) / p.w))
      fy = Math.max(0, Math.min(1, (e.clientY - r.top - p.top) / p.h))
      if (zoom === 1) zoom = 8
    }
    draw()
  })
  draw()
  return el
}

// ---------------------------------------------------------------------------------------------
// Manual review

export const CHECKS: { key: string; label: string; hint: string }[] = [
  { key: 'enlarged', label: 'Enlarged 16–32×', hint: 'Curves smooth, no jagged edges, wobble, lumps or broken curves; corners sharp where they should be' },
  { key: 'lettering', label: 'Lettering & font', hint: 'Every letter legible and spelled right, counters open, no merged letters, rebuilt font is the right one' },
  { key: 'small', label: 'Small text & fine lines', hint: 'Taglines, ® / ™, thin rules survive; nothing invented' },
  { key: 'shapes', label: 'Shapes & detail', hint: 'No broken, missing or extra shapes compared with the original / upload' },
  { key: 'colour', label: 'Colour', hint: 'Brand colours right (hex / Pantone), similar shades kept apart' },
  { key: 'transparency', label: 'Transparency', hint: 'No white box or halo on the black background; holes cut out' },
  { key: 'gradients', label: 'Gradients', hint: 'Smooth, no banding, same direction and end colours' },
  { key: 'print', label: 'Print file (PDF)', hint: 'Opens in Illustrator / Acrobat, one plate per colour, plates don’t overlap' },
  { key: 'cut', label: 'Cut file (DXF)', hint: 'Opens in the cutter software, closed outlines, no tiny unweedable pieces' },
  { key: 'offer', label: 'Suggested improvement', hint: 'Really looks better than the first result (no suggestion is fine)' },
]
export const ANSWERS = ['ok', 'minor', 'fail', 'n/a'] as const
export type Answer = (typeof ANSWERS)[number]
export type Overall = 'yes' | 'minor' | 'no'

export interface Review {
  checks: Partial<Record<string, Answer>>
  overall?: Overall
  notes: string
  reviewer?: string
  at?: string
  /** Fingerprint of the files reviewed (upload and original), so a review is never carried over to different artwork with the same name. */
  digest?: string
}

const STORE = 'real-review-v1'
export function loadReviews(): Record<string, Review> {
  try {
    return JSON.parse(localStorage.getItem(STORE) ?? '{}')
  } catch {
    return {}
  }
}
function saveReview(file: string, r: Review) {
  try {
    const all = loadReviews()
    all[file] = r
    localStorage.setItem(STORE, JSON.stringify(all))
  } catch {
    // Not saved in this browser; the report still includes it while the page is open.
  }
}

export type Verdict = 'PASS' | 'REVIEW' | 'FAIL'

/**
 * The final verdict per logo: an automatic failure or a manual "no" / failed check is FAIL;
 * a complete review answered "yes", with automatic checks passed (or no original to check),
 * is PASS; everything else (unreviewed, minor fixes) is REVIEW.
 */
export function finalVerdict(auto: boolean | null, review: Review | undefined): Verdict {
  const failedCheck = review && Object.values(review.checks).includes('fail')
  if (auto === false || review?.overall === 'no' || failedCheck) return 'FAIL'
  if (review?.overall === 'yes') return 'PASS'
  return 'REVIEW'
}

/** The checklist form for one logo; `onChange` fires after every answer. */
export function reviewForm(file: string, review: Review, onChange: (r: Review) => void): HTMLElement {
  const el = document.createElement('div')
  el.style.cssText = 'margin-top:8px;padding:8px;border:1px solid #ddd;max-width:960px'
  const radio = (name: string, value: string, current: string | undefined) => `<label style="margin-right:6px"><input type="radio" name="${name}" value="${value}" ${current === value ? 'checked' : ''}> ${value}</label>`
  const id = file.replace(/[^a-z0-9]/gi, '_')
  el.innerHTML = `<b>Manual review</b> <small>(saved in this browser)</small>
    <table style="margin-top:4px">${CHECKS.map((c) => `<tr><td title="${c.hint}"><b>${c.label}</b><br><small>${c.hint}</small></td><td style="white-space:nowrap">${ANSWERS.map((a) => radio(`${id}-${c.key}`, a, review.checks[c.key])).join('')}</td></tr>`).join('')}
    <tr><td><b>Would you send this to a printer for this customer without touching it?</b></td><td style="white-space:nowrap">${(['yes', 'minor', 'no'] as Overall[]).map((a) => radio(`${id}-overall`, a, review.overall)).join('')}</td></tr></table>
    <label>Notes <input data-notes style="width:70%" value="${(review.notes ?? '').replace(/"/g, '&quot;')}"></label>`
  const update = () => {
    for (const c of CHECKS) review.checks[c.key] = ((el.querySelector(`input[name="${id}-${c.key}"]:checked`) as HTMLInputElement | null)?.value as Answer) ?? undefined
    review.overall = ((el.querySelector(`input[name="${id}-overall"]:checked`) as HTMLInputElement | null)?.value as Overall) ?? undefined
    review.notes = (el.querySelector('[data-notes]') as HTMLInputElement).value
    review.at = new Date().toISOString()
    saveReview(file, review)
    onChange(review)
  }
  el.addEventListener('change', update)
  el.addEventListener('input', (e) => (e.target as HTMLElement).dataset.notes !== undefined && update())
  return el
}

// ---------------------------------------------------------------------------------------------
// Release recommendation and report

export interface ReportRow {
  file: string
  category: string
  verdict: Verdict
  auto: boolean | null
  /** Automatic failures and structural flags. */
  notes: string[]
  flags: string[]
  metrics: [string, string][]
  review: Review | undefined
  /** Null when the logo couldn't be tested or isn't flat artwork. */
  visual: Visual | null
  /** Release-blocking problems (worse offer, invalid export, wrong font, open cut outlines, a test that failed to run). */
  blocking: string[]
  /** Why the logo is outside the test (photos, pixel art); it's listed but not counted. */
  excluded?: string
}

export function recommendation(all: ReportRow[], categories: Record<string, string>): { decision: 'RELEASE' | 'REVISE' | 'HOLD BACK' | 'INCOMPLETE'; reasons: string[] } {
  const reasons: string[] = []
  const excluded = all.filter((r) => r.excluded)
  // Logos that failed to run stay in (as blocking FAIL rows); only out-of-scope artwork is left out.
  const rows = all.filter((r) => !r.excluded)
  if (excluded.length) reasons.push(`${excluded.length} logo(s) left out, not flat artwork: ${excluded.map((r) => r.file).join(', ')}`)
  const blocking = rows.filter((r) => r.blocking.length)
  if (blocking.length) reasons.push(...blocking.map((r) => `${r.file}: ${r.blocking.join('; ')}`))
  const unreviewed = rows.filter((r) => !r.review?.overall)
  const acceptable = rows.filter((r) => r.verdict === 'PASS' || (r.verdict === 'REVIEW' && r.review?.overall === 'minor'))
  const share = rows.length ? acceptable.length / rows.length : 0
  const weak = Object.entries(categories).filter(([k]) => {
    const rs = rows.filter((r) => r.category === k)
    return rs.length && rs.filter((r) => acceptable.includes(r)).length / rs.length < 0.5
  })
  const enlarged = rows.filter((r) => r.review?.checks.enlarged === 'fail')
  if (rows.length < 10) reasons.push(`only ${rows.length} logos tested (10–15 needed)`)
  if (unreviewed.length) reasons.push(`${unreviewed.length} logo(s) not reviewed by eye yet`)
  reasons.push(`${acceptable.length}/${rows.length} (${Math.round(share * 100)}%) acceptable as-is or with minor fixes (80% needed)`)
  if (weak.length) reasons.push(`categories below 50%: ${weak.map(([, l]) => l).join(', ')}`)
  if (enlarged.length) reasons.push(`${enlarged.length} logo(s) fail the enlargement check: ${enlarged.map((r) => r.file).join(', ')}`)
  if (blocking.length) return { decision: 'REVISE', reasons }
  if (unreviewed.length || rows.length < 10) return { decision: 'INCOMPLETE', reasons }
  if (share < 0.8 || weak.length || enlarged.length > rows.length * 0.2) return { decision: 'HOLD BACK', reasons }
  return { decision: 'RELEASE', reasons }
}

const toDataUrl = async (src: string | null): Promise<string | null> => {
  if (!src) return null
  if (src.startsWith('data:')) return src
  const blob = await (await fetch(src)).blob()
  return new Promise((resolve) => {
    const fr = new FileReader()
    fr.onload = () => resolve(fr.result as string)
    fr.readAsDataURL(blob)
  })
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const VERDICT_COLOUR: Record<Verdict, string> = { PASS: '#1d8a4b', REVIEW: '#b45309', FAIL: '#c0362c' }

/** A self-contained HTML report (images embedded), with each logo at 1× and enlarged 16×. */
export async function reportHtml(rows: ReportRow[], categories: Record<string, string>, meta: { version: string }): Promise<string> {
  const rec = recommendation(rows, categories)
  // Totals leave out-of-scope artwork out, as the recommendation does; its sections still show.
  const counted = rows.filter((r) => !r.excluded)
  const count = (v: Verdict) => counted.filter((r) => r.verdict === v).length
  const parts: string[] = []
  for (const r of rows) {
    if (!r.visual) {
      parts.push(`<section style="border-top:2px solid #ddd;padding-top:10px;margin-top:18px">
      <h2 style="margin:0"><span style="color:${VERDICT_COLOUR[r.verdict]}">${r.verdict}</span> · ${esc(r.file)} <small style="font-weight:normal;color:#666">${esc(categories[r.category] ?? r.category)}</small></h2>
      ${r.blocking.length ? `<p style="margin:4px 0;color:#c0362c"><b>Release-blocking:</b> ${r.blocking.map(esc).join('; ')}</p>` : ''}
      ${r.excluded ? `<p style="margin:4px 0"><b>Not counted:</b> ${esc(r.excluded)}</p>` : ''}
    </section>`)
      continue
    }
    const v: Visual = { ...r.visual, upload: (await toDataUrl(r.visual.upload))!, first: (await toDataUrl(r.visual.first))!, original: await toDataUrl(r.visual.original), offer: r.visual.offer ? { ...r.visual.offer, src: (await toDataUrl(r.visual.offer.src))! } : null }
    const b = v.boxes[0]
    const fx = b ? b.x + b.w / 2 : v.focus.x
    const fy = b ? b.y + b.h / 2 : v.focus.y
    const rv = r.review
    parts.push(`<section style="page-break-inside:avoid;border-top:2px solid #ddd;padding-top:10px;margin-top:18px">
      <h2 style="margin:0"><span style="color:${VERDICT_COLOUR[r.verdict]}">${r.verdict}</span> · ${esc(r.file)} <small style="font-weight:normal;color:#666">${esc(categories[r.category] ?? r.category)}</small></h2>
      <p style="margin:4px 0"><b>Automatic:</b> ${r.auto === true ? 'pass' : r.auto === false ? 'fail' : 'no original (visual only)'}${r.notes.length ? ` · ${r.notes.map(esc).join('; ')}` : ''}</p>
      ${r.flags.length ? `<p style="margin:4px 0;color:#b45309"><b>Flags:</b> ${r.flags.map(esc).join('; ')}</p>` : ''}
      ${r.blocking.length ? `<p style="margin:4px 0;color:#c0362c"><b>Release-blocking:</b> ${r.blocking.map(esc).join('; ')}</p>` : ''}
      <p style="margin:4px 0;font-size:12px">${r.metrics.map(([k, val]) => `${esc(k)}: <b>${esc(val)}</b>`).join(' · ')}</p>
      <div style="display:flex;gap:10px;flex-wrap:wrap">${panesHtml(v, 1, 0.5, 0.5)}</div>
      <p style="margin:6px 0 2px"><b>Enlarged 16×</b>${b ? ` at the first flagged area (${b.kind})` : ' where the outline is busiest'}, as for signage or large-format print:</p>
      <div style="display:flex;gap:10px;flex-wrap:wrap">${panesHtml(v, 16, fx, fy, 'white')}</div>
      <p style="margin:6px 0"><b>Manual review:</b> ${rv?.overall ? `send to printer: <b>${rv.overall}</b>` : '<i>not reviewed</i>'}${rv ? ` · ${CHECKS.filter((c) => rv.checks[c.key]).map((c) => `${c.label}: ${rv.checks[c.key]}`).join(' · ')}` : ''}${rv?.notes ? `<br>Notes: ${esc(rv.notes)}` : ''}</p>
    </section>`)
  }
  const cats = Object.entries(categories)
    .map(([k, l]) => {
      const rs = counted.filter((r) => r.category === k)
      return rs.length ? `<tr><td>${l}</td><td>${rs.length}</td><td>${rs.filter((r) => r.verdict === 'PASS').length}</td><td>${rs.filter((r) => r.verdict === 'REVIEW').length}</td><td>${rs.filter((r) => r.verdict === 'FAIL').length}</td></tr>` : ''
    })
    .join('')
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Vectorize acceptance report</title>
<style>body{font:13px/1.45 system-ui,sans-serif;margin:24px;color:#111;background:#fff} table{border-collapse:collapse} td,th{border-bottom:1px solid #ddd;padding:3px 10px;text-align:left} small{color:#666}</style></head><body>
<h1>Vectorize real-logo acceptance report</h1>
<p>${esc(meta.version)} · ${new Date().toLocaleString()} · ${counted.length} logos${rows.length > counted.length ? ` (+${rows.length - counted.length} not covered)` : ''}: <b style="color:${VERDICT_COLOUR.PASS}">${count('PASS')} PASS</b>, <b style="color:${VERDICT_COLOUR.REVIEW}">${count('REVIEW')} REVIEW</b>, <b style="color:${VERDICT_COLOUR.FAIL}">${count('FAIL')} FAIL</b></p>
<h2>Recommendation: ${rec.decision}</h2><ul>${rec.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
<p><small>RELEASE: no blocking problem, every logo reviewed, ≥ 80% acceptable as-is or with minor fixes, no category under 50%, at most 20% failing the enlargement check. REVISE: a confirmed, fixable defect (worse suggestion, invalid file, wrong font, open cut outlines). HOLD BACK: quality bar not met. INCOMPLETE: fewer than 10 logos or unreviewed logos. The V6 comparison (docs/real-logo-acceptance.md §6.2) is run separately.</small></p>
<table><tr><th>Category</th><th>Logos</th><th>PASS</th><th>REVIEW</th><th>FAIL</th></tr>${cats}</table>
${parts.join('')}
</body></html>`
}
