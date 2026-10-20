// AUDIT ONLY (scratch copy of 4926f81, not committed). Runs the production default flat job for one upload
// with the no-op audit hooks enabled, and renders each stage for a set of feature crops.
// ?file=<upload>&variant=<v>&features=<json [{name, box:[x0,y0,x1,y1] in 0..1, at:[fx,fy]}]>
import type { Point } from '../src/trace/contours'
import { colorAt } from '../src/palette/gradients'
import { DEFAULT_INKS } from '../src/palette/quantize'
import { DEMO_PALETTE } from '../src/palette/demo'
import type { LabelMap } from '../src/trace'
import { DEFAULT_CLIENT, detailBoost, prepFor, traceParamsFor, type ClientSettings } from '../src/vectorize/client'
import { detectArt } from '../src/vectorize/detect'
import { bitmapToImageData, finalizeSvg, loadImage } from '../src/vectorize/image'
import { buildTraceJob, runFlat } from '../src/vectorize/pipeline'

type Q = { step: string; labels: Uint8Array | Uint16Array | number[]; colors?: number[]; [k: string]: unknown }
type T = { layer: number; label: number; color: number; field: Float32Array; blurred: Float32Array; smooth: Float32Array; raw: Point[][]; all: Point[][]; loops: Point[][]; kept?: Point[][]; decisions: string[]; parts: string[]; opts: Record<string, unknown> }
const qs: Q[] = []
type G = { size: number; explained: number; rms: number; range: number; fitted: boolean; kind?: string; border: number; pixels: Uint32Array }
const gs: G[] = []
const ts: T[][] = []
;(globalThis as unknown as { __audit: unknown }).__audit = {
  q: (x: Q) => qs.push(x),
  g: (x: G) => gs.push(x),
  t: (x: T) => {
    if (x.layer === 0 || !ts.length) ts.push([])
    ts[ts.length - 1].push(x)
  },
}
const P = new URLSearchParams(location.search)
const file = P.get('file')!
const VARIANTS: Record<string, Partial<ClientSettings>> = { default: {}, noexact: { exactShapes: false }, blends: { keepBlends: true }, detail1: { detail: 1 } }
const features: { name: string; box: [number, number, number, number]; at?: [number, number]; color?: string }[] = JSON.parse(P.get('features') ?? '[]')
const blob = await (await fetch(`/audit-in/${file}`)).blob()
const source = await loadImage(blob, file)
const det = detectArt(bitmapToImageData(source.bitmap))
const client = { ...DEFAULT_CLIENT, ...VARIANTS[P.get('variant') ?? 'default'] }
const job = buildTraceJob(source, source.width, {
  trace: traceParamsFor(det.kind, client, detailBoost(det, source.width, source.height)),
  prep: prepFor(det.kind, client),
  spot: { settings: DEFAULT_INKS, palette: DEMO_PALETTE },
  removeColors: [],
  transparent: det.hasAlpha || det.kind === 'lineart',
  knockout: false,
  keepBlends: client.keepBlends,
  exactShapes: client.exactShapes,
  gradients: client.gradients,
  brand: undefined,
})
if (job.kind !== 'flat') throw new Error('not a flat job')
if (P.get('trace')) Object.assign(job.options.trace, JSON.parse(P.get('trace')!))
let map: LabelMap | null = null
const res = runFlat(job.image, job.options, (m) => (map = m))
const svg = finalizeSvg(res.svg, job.image, source)
const W = job.image.width
const H = job.image.height
const M = map as unknown as LabelMap
const trace = ts[ts.length - 1]

const rgbOf = (c: number) => [(c >> 16) & 255, (c >> 8) & 255, c & 255]
function labelImg(labels: ArrayLike<number>, colors: number[], blend = false): ImageData {
  const img = new ImageData(W, H)
  for (let p = 0; p < W * H; p++) {
    const l = labels[p]
    if (l >= 254 || colors[l] < 0 || colors[l] === undefined) { img.data.set([255, 0, 255, 60], p * 4); continue }
    let px = M.fills?.[l] && blend ? colorAt(M.fills[l]!, (p % W) + 0.5, ((p / W) | 0) + 0.5) : rgbOf(colors[l])
    if (blend && M.cov[p] < 1 && M.second[p] < 254 && M.colors[M.second[p]] >= 0) {
      const b = rgbOf(M.colors[M.second[p]])
      px = px.map((v, k) => v * M.cov[p] + b[k] * (1 - M.cov[p]))
    }
    img.data.set([...px.map(Math.round), 255], p * 4)
  }
  return img
}
function fieldImg(f: Float32Array): ImageData {
  const img = new ImageData(W, H)
  for (let p = 0; p < W * H; p++) { const v = Math.round(255 * (1 - Math.min(1, Math.max(0, f[p])))); img.data.set([v, v, v, 255], p * 4) }
  return img
}
const toCanvas = (d: ImageData) => { const c = document.createElement('canvas'); c.width = d.width; c.height = d.height; c.getContext('2d')!.putImageData(d, 0, 0); return c }
const svgImg = await new Promise<HTMLImageElement>((ok) => { const i = new Image(); i.onload = () => ok(i); i.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg) })
const inputC = toCanvas(job.image)
const bb = (l: Point[]) => { let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9; for (const [x, y] of l) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y) } return [x0, y0, x1, y1] }
const polyArea = (l: Point[]) => { let a = 0; for (let i = 0; i < l.length; i++) { const [x0, y0] = l[i], [x1, y1] = l[(i + 1) % l.length]; a += x0 * y1 - x1 * y0 } return a / 2 }

// ---------- Whole-image attribution: where does each part of the pixel outline get lost? ----------
type Seg = [number, number, number, number]
function flatten(d: string): Point[][] {
  const loops: Point[][] = []
  const tok = d.match(/[MLCZ]|-?\d*\.?\d+(?:e-?\d+)?/gi) ?? []
  let i = 0, cur: Point[] = [], x = 0, y = 0
  const num = () => parseFloat(tok[i++])
  while (i < tok.length) {
    const c = tok[i++]
    if (c === 'M') { if (cur.length) loops.push(cur); x = num(); y = num(); cur = [[x, y]] }
    else if (c === 'L') { x = num(); y = num(); cur.push([x, y]) }
    else if (c === 'C') {
      const x1 = num(), y1 = num(), x2 = num(), y2 = num(), x3 = num(), y3 = num()
      for (let k = 1; k <= 16; k++) { const t = k / 16, u = 1 - t; cur.push([u * u * u * x + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3, u * u * u * y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3]) }
      x = x3; y = y3
    } else if (c === 'Z' || c === 'z') { if (cur.length) loops.push(cur); cur = [] }
  }
  if (cur.length) loops.push(cur)
  return loops
}
class Hash {
  cells = new Map<number, Seg[]>()
  constructor(loops: Point[][]) { for (const l of loops) for (let k = 0; k < l.length; k++) { const a = l[k], b = l[(k + 1) % l.length]; const s: Seg = [a[0], a[1], b[0], b[1]]; for (let cx = Math.floor(Math.min(a[0], b[0]) / 4); cx <= Math.floor(Math.max(a[0], b[0]) / 4); cx++) for (let cy = Math.floor(Math.min(a[1], b[1]) / 4); cy <= Math.floor(Math.max(a[1], b[1]) / 4); cy++) { const key = cx * 100003 + cy; let v = this.cells.get(key); if (!v) this.cells.set(key, (v = [])); v.push(s) } } }
  dist(x: number, y: number, max = 8): number {
    let best = max
    const cx = Math.floor(x / 4), cy = Math.floor(y / 4), r = Math.ceil(max / 4)
    for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) for (const s of this.cells.get((cx + i) * 100003 + cy + j) ?? []) {
      const dx = s[2] - s[0], dy = s[3] - s[1], L = dx * dx + dy * dy
      const t = L ? Math.max(0, Math.min(1, ((x - s[0]) * dx + (y - s[1]) * dy) / L)) : 0
      const d = Math.hypot(s[0] + t * dx - x, s[1] + t * dy - y)
      if (d < best) best = d
    }
    return best
  }
}
function selfIntersects(l: Point[]): boolean {
  const n = l.length
  if (n < 4 || n > 4000) return false
  for (let i = 0; i < n; i++) {
    const a = l[i], b = l[(i + 1) % n]
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue
      const c = l[j], d = l[(j + 1) % n]
      const o = (p: Point, q: Point, r: Point) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
      const d1 = o(a, b, c), d2 = o(a, b, d), d3 = o(c, d, a), d4 = o(c, d, b)
      if (d1 * d2 < 0 && d3 * d4 < 0) return true
    }
  }
  return false
}
function cornersOf(l: Point[]): { p: Point; concave: boolean }[] {
  // Resample at 0.25 px, turning angle between chords 1.5 px either side; keep local maxima above 40°.
  const pts: Point[] = []
  for (let k = 0; k < l.length; k++) { const a = l[k], b = l[(k + 1) % l.length]; const s = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.25)); for (let t = 0; t < s; t++) pts.push([a[0] + ((b[0] - a[0]) * t) / s, a[1] + ((b[1] - a[1]) * t) / s]) }
  const n = pts.length, K = 6
  if (n < 4 * K) return []
  const orient = Math.sign(polyArea(l))
  const ang = pts.map((p, i) => { const a = pts[(i - K + n) % n], b = pts[(i + K) % n]; const u = [p[0] - a[0], p[1] - a[1]], v = [b[0] - p[0], b[1] - p[1]]; const cr = u[0] * v[1] - u[1] * v[0], dt = u[0] * v[0] + u[1] * v[1]; return Math.atan2(cr, dt) * 180 / Math.PI })
  const out: { p: Point; concave: boolean }[] = []
  for (let i = 0; i < n; i++) { const a = Math.abs(ang[i]); if (a < 40) continue; let max = true; for (let j = -K; j <= K; j++) if (Math.abs(ang[(i + j + n) % n]) > a) { max = false; break } if (max) out.push({ p: pts[i], concave: Math.sign(ang[i]) !== orient }) }
  return out
}
let attribution: unknown = null
const cornerMarks: { label: number; x: number; y: number; stage: string | null; concave: boolean }[] = []
const TOL = Number(P.get('tol') ?? 1)
if (P.get('analyse')) {
  const tot = { outline: 0, lostBlur: 0, lostFilter: 0, lostShape: 0, lostFit: 0, corners: 0, concave: 0, cornerLost: { blur: 0, filter: 0, shape: 0, fit: 0 }, concaveLost: { blur: 0, filter: 0, shape: 0, fit: 0 }, rawIslands: 0, tracedIslands: 0, keptIslands: 0, microLoops: 0, srcSelfX: 0, fitSelfX: 0, fittedLoops: 0, exact: 0, maxDev: [] as number[] }
  const layerGeom: { color: string; loops: { area: number; bbox: number[]; decision: string }[] }[] = []
  for (const L of trace) {
    const kept = L.kept ?? L.loops
    const hb = new Hash(L.all), hk = new Hash(kept)
    const fitted = kept.map((_, i) => flatten(L.parts[i] ?? ''))
    const exactLoops = fitted.filter((_, i) => L.decisions[i]?.startsWith('exact') || L.decisions[i] === 'split' || L.decisions[i] === 'canvas').flat()
    const fitLoops = fitted.filter((_, i) => L.decisions[i] === 'fit').flat()
    const hAll = new Hash(fitted.flat()), hFit = new Hash(fitLoops), hEx = new Hash(exactLoops)
    tot.rawIslands += L.raw.length; tot.tracedIslands += L.all.length; tot.keptIslands += kept.length
    const stage = (x: number, y: number): 'blur' | 'filter' | 'shape' | 'fit' | null => {
      if (hb.dist(x, y) > TOL) return 'blur'
      if (hk.dist(x, y) > TOL) return 'filter'
      if (hAll.dist(x, y) <= TOL) return null
      return hEx.dist(x, y) <= hFit.dist(x, y) ? 'shape' : 'fit'
    }
    for (const r of L.raw) {
      // Skip the image border: it is not artwork outline.
      for (let k = 0; k < r.length; k++) {
        const a = r[k], b = r[(k + 1) % r.length]
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]); const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2
        if (mx < 0.6 || my < 0.6 || mx > W - 0.6 || my > H - 0.6) continue
        tot.outline += len
        const s = stage(mx, my)
        if (s === 'blur') tot.lostBlur += len; else if (s === 'filter') tot.lostFilter += len; else if (s === 'shape') tot.lostShape += len; else if (s === 'fit') tot.lostFit += len
      }
      for (const c of cornersOf(r)) {
        const [x, y] = c.p
        if (x < 1 || y < 1 || x > W - 1 || y > H - 1) continue
        tot.corners++; if (c.concave) tot.concave++
        const s = stage(x, y)
        cornerMarks.push({ label: L.label, x, y, stage: s, concave: c.concave })
        if (s) { tot.cornerLost[s]++; if (c.concave) tot.concaveLost[s]++ }
      }
    }
    const geom: { area: number; bbox: number[]; decision: string }[] = []
    kept.forEach((l, i) => {
      const a = Math.abs(polyArea(l))
      if (a < 4) tot.microLoops++
      if (selfIntersects(l)) tot.srcSelfX++
      for (const f of fitted[i]) { tot.fittedLoops++; if (selfIntersects(f)) tot.fitSelfX++ }
      if (L.decisions[i]?.startsWith('exact')) tot.exact++
      geom.push({ area: Math.round(a * 10) / 10, bbox: bb(l).map((v) => Math.round(v * 10) / 10), decision: L.decisions[i] })
    })
    layerGeom.push({ color: '#' + L.color.toString(16).padStart(6, '0'), loops: geom })
  }
  // Same outline drawn in two layers (stacked copies): area within 3% and box within 1 px.
  let copies = 0
  const copyPairs: string[] = []
  layerGeom.forEach((A, i) => A.loops.forEach((a) => { for (let j = i + 1; j < layerGeom.length; j++) for (const b of layerGeom[j].loops) if (a.area > 4 && Math.abs(a.area - b.area) <= 0.03 * a.area && a.bbox.every((v, k) => Math.abs(v - b.bbox[k]) <= 1)) { copies++; if (copyPairs.length < 12) copyPairs.push(`${A.color}→${layerGeom[j].color} area ${a.area}`) } }))
  attribution = { ...tot, copies, copyPairs }
}
const out: Record<string, unknown>[] = []
for (const f of features) {
  const x0 = Math.floor(f.box[0] * W), y0 = Math.floor(f.box[1] * H), x1 = Math.ceil(f.box[2] * W), y1 = Math.ceil(f.box[3] * H)
  const cw = x1 - x0, ch = y1 - y0
  const Z = Math.max(2, Math.floor(420 / Math.max(cw, ch)))
  const panel = (draw: (g: CanvasRenderingContext2D) => void) => {
    const c = document.createElement('canvas'); c.width = cw * Z; c.height = ch * Z
    const g = c.getContext('2d')!; g.imageSmoothingEnabled = false; g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height)
    draw(g); return c.toDataURL('image/png')
  }
  const raster = (src: CanvasImageSource) => panel((g) => { g.fillStyle = '#e8e8e8'; for (let y = 0; y < ch * Z; y += 8) for (let x = (y / 8) % 2 ? 8 : 0; x < cw * Z; x += 16) g.fillRect(x, y, 8, 8); g.drawImage(src, x0, y0, cw, ch, 0, 0, cw * Z, ch * Z) })
  const inBox = (l: Point[]) => { const [a, b, c, d] = bb(l); return c >= x0 && a <= x1 && d >= y0 && b <= y1 }
  const stroke = (g: CanvasRenderingContext2D, l: Point[], color: string, width: number, dash: number[] = []) => {
    g.save(); g.setTransform(Z, 0, 0, Z, -x0 * Z, -y0 * Z); g.beginPath(); l.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); g.restore()
    g.save(); g.setLineDash(dash); g.strokeStyle = color; g.lineWidth = width; g.stroke(); g.restore()
  }
  // The layer that draws the feature: the final label at the chosen point (or the nearest colour).
  let lab = -1
  if (f.at) lab = M.labels[Math.floor(f.at[1] * H) * W + Math.floor(f.at[0] * W)]
  if (f.color) { const t = rgbOf(parseInt(f.color.slice(1), 16)); let best = 1e9; M.colors.forEach((c, i) => { if (c < 0) return; const d = rgbOf(c).reduce((s, v, k) => s + (v - t[k]) ** 2, 0); if (d < best) { best = d; lab = i } }) }
  const L = trace.find((t) => t.label === lab)
  const qa = qs.find((q) => q.step === 'assigned')!, qm = qs.find((q) => q.step === 'majority')!, qsp = qs.find((q) => q.step === 'specks')!
  const panels: Record<string, string> = {
    '1 upload': raster(inputC),
    '2 colour clusters (k-means, per pixel)': raster(toCanvas(labelImg(qa.labels, qa.colors as number[]))),
    '3 after majority filter': raster(toCanvas(labelImg(qm.labels, qa.colors as number[]))),
    '4 after speck removal (final colour map)': raster(toCanvas(labelImg(qsp.labels, M.colors))),
  }
  const stats: Record<string, unknown> = { label: lab, color: L ? '#' + L.color.toString(16).padStart(6, '0') : null, zoom: Z, crop: [x0, y0, x1, y1] }
  if (L) {
    const rawIn = L.raw.filter(inBox), allIn = L.all.filter(inBox), loopsIn = L.loops.filter(inBox)
    const dropped = allIn.filter((l) => !L.loops.includes(l))
    const keptArr = L.kept ?? L.loops
    const suppressed = loopsIn.filter((l) => !keptArr.includes(l))
    panels['5 layer mask (pixels) + pixel-exact outline (red)'] = panel((g) => { g.drawImage(toCanvas(fieldImg(L.field)), x0, y0, cw, ch, 0, 0, cw * Z, ch * Z); rawIn.forEach((l) => stroke(g, l, '#e0202a', 2)) })
    panels['6 after blur + thin-line fix: traced outline (blue) vs pixel outline (red); dropped as specks (orange)'] = panel((g) => {
      g.drawImage(toCanvas(fieldImg(L.smooth)), x0, y0, cw, ch, 0, 0, cw * Z, ch * Z)
      rawIn.forEach((l) => stroke(g, l, 'rgba(224,32,42,.55)', 1.5))
      loopsIn.forEach((l) => stroke(g, l, '#1f5fe0', 2.5))
      dropped.forEach((l) => stroke(g, l, '#f08a00', 3, [6, 4]))
      suppressed.forEach((l) => stroke(g, l, '#a000c0', 3, [2, 3]))
    })
    const dec: { decision: string; area: number; nodes: number; bbox: number[] }[] = []
    panels['7 shape decision + fitted path (green) over pixel outline (red)'] = panel((g) => {
      g.drawImage(inputC, x0, y0, cw, ch, 0, 0, cw * Z, ch * Z)
      g.fillStyle = 'rgba(255,255,255,.55)'; g.fillRect(0, 0, cw * Z, ch * Z)
      rawIn.forEach((l) => stroke(g, l, 'rgba(224,32,42,.8)', 1.5))
      keptArr.forEach((l, i) => {
        if (!inBox(l)) return
        const d = L.decisions[i], part = L.parts[i]
        const col = d?.startsWith('exact') ? '#d000d0' : d === 'split' ? '#ff6000' : '#0a9a3a'
        g.save(); g.setTransform(Z, 0, 0, Z, -x0 * Z, -y0 * Z); const p2 = new Path2D(part); g.restore()
        g.save(); g.setTransform(Z, 0, 0, Z, -x0 * Z, -y0 * Z); g.strokeStyle = col; g.lineWidth = 2.5 / Z; g.stroke(p2); g.restore()
        dec.push({ decision: d, area: Math.round(Math.abs(polyArea(l)) * 10) / 10, nodes: (part.match(/[MLCQZ]/gi) ?? []).length, bbox: bb(l).map((v) => Math.round(v * 10) / 10) })
      })
    })
    stats.layer = { rawLoops: rawIn.length, tracedLoops: allIn.length, keptLoops: loopsIn.length, droppedAsSpeck: dropped.map((l) => Math.round(Math.abs(polyArea(l)) * 10) / 10), suppressedFragments: suppressed.length, decisions: dec, detailArea: L.opts.detailArea, minArea: L.opts.minArea, smoothing: L.opts.smoothing, error: L.opts.error, cornerAngle: L.opts.cornerAngle }
  }
  panels['8 final SVG'] = raster(svgImg)
  const gIn = gs.filter((g) => { let n = 0; for (const p of g.pixels) { const x = p % W, y = (p / W) | 0; if (x >= x0 && x < x1 && y >= y0 && y < y1) n++ } return n > 0.1 * g.pixels.length || n > 0.3 * cw * ch })
  if (gIn.length) {
    stats.gradientCandidates = gIn.map((g) => ({ size: g.size, range: g.range, explained: g.explained, rms: g.rms, fitted: g.fitted, kind: g.kind, verdict: g.fitted ? 'gradient' : g.range < 28 ? 'flat (range < 28)' : g.rms > 7 ? 'rejected: rms > 7' : 'rejected: explains < 85%' }))
    panels['10 gradient finder regions: accepted (green), rejected (red), flat (grey)'] = panel((g) => {
      g.drawImage(inputC, x0, y0, cw, ch, 0, 0, cw * Z, ch * Z)
      const ov = new ImageData(W, H)
      for (const r of gIn) { const c = r.fitted ? [0, 170, 60] : r.range < 28 ? [120, 120, 120] : [230, 30, 40]; for (const p of r.pixels) ov.data.set([...c, 150], p * 4) }
      g.drawImage(toCanvas(ov), x0, y0, cw, ch, 0, 0, cw * Z, ch * Z)
    })
  }
  if (cornerMarks.length && L) panels['9 corners on the pixel outline: kept (green), lost to blur (orange), to curve fitting (red), to shape snapping (magenta)'] = panel((g) => {
    g.drawImage(svgImg, x0, y0, cw, ch, 0, 0, cw * Z, ch * Z)
    g.fillStyle = 'rgba(255,255,255,.5)'; g.fillRect(0, 0, cw * Z, ch * Z)
    L.raw.filter(inBox).forEach((l) => stroke(g, l, 'rgba(224,32,42,.6)', 1))
    for (const m of cornerMarks) {
      if (m.label !== L.label || m.x < x0 || m.y < y0 || m.x > x1 || m.y > y1) continue
      g.fillStyle = m.stage === null ? '#0a9a3a' : m.stage === 'blur' ? '#f08a00' : m.stage === 'fit' ? '#e0202a' : m.stage === 'shape' ? '#d000d0' : '#555'
      g.beginPath(); g.arc((m.x - x0) * Z, (m.y - y0) * Z, Math.max(3, Z * 0.35), 0, 7); g.fill()
    }
  })
  out.push({ name: f.name, panels, stats })
}
;(window as unknown as { __probe: unknown }).__probe = { attribution,
  file, W, H, det: { kind: det.kind, fine: det.fine, hasAlpha: det.hasAlpha }, svgMatches: null, svg,
  quant: qs.map((q) => ({ step: q.step, kmeans: q.kmeans, afterBlendDrop: q.afterBlendDrop, afterMerge: q.afterMerge, binsUsed: q.binsUsed, mergeDelta: q.mergeDelta, maxColors: q.maxColors, minArea: q.minArea, colours: new Set(Array.from(q.labels)).size })),
  traceCalls: ts.length, gradients: gs.map((g) => ({ ...g, pixels: undefined })), layers: trace.map((t) => ({ label: t.label, color: '#' + t.color.toString(16).padStart(6, '0'), raw: t.raw.length, traced: t.all.length, kept: (t.kept ?? t.loops).length, decisions: t.decisions })),
  features: out,
}
document.getElementById('status')!.textContent = 'Done'
