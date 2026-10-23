// Edge fidelity lab: runs the app's flat trace job on uploads rendered from vector masters, and
// measures how far the traced edges lie from the master's edges (4× renders, in source pixels).
// window.__edgeLab(variants) -> rows. A variant patches the job's trace options.
// window.__regress() -> the benchmark cases (bench/cases.ts), first result vs truth.
// window.__audit() -> the audit uploads vs themselves. window.__fitView(id, x, y) draws a contour's fit.
// Inputs are third-party artwork and not committed: put the audit sources
// (docs/audits/2026-10-reconstruction/manifest.json) in public/audit-raw/ (explore-<topic>.png and
// the SVG masters) and the demo pack's harbour/kestrel/summit SVGs in public/demo-samples/.
import { DEFAULT_CLIENT, detailBoost, prepFor, traceParamsFor } from '../src/vectorize/client'
import { detectArt } from '../src/vectorize/detect'
import { bitmapToImageData, loadImage } from '../src/vectorize/image'
import { buildTraceJob, runTraceJob } from '../src/vectorize/pipeline'
import { Tracer } from '../src/vectorize/tracer'

const R = '/audit-raw/'
const Z = 4

type Master = { id: string; svg: string; w: number; h: number; bg: string | null; edit?: (s: string) => string; jpeg?: number }
export const MASTERS: Master[] = [
  { id: 'github-mark', svg: 'si-github.svg', w: 400, h: 400, bg: null, edit: (s) => s.replace('<path ', '<path fill="#181717" ') },
  { id: 'world-thin', svg: 'tabler-world.svg', w: 400, h: 400, bg: '#fff', edit: (s) => s.replace(/stroke="currentColor"/, 'stroke="#000"').replace(/stroke-width="2"/, 'stroke-width="0.35"') },
  { id: 'world-thin-200', svg: 'tabler-world.svg', w: 200, h: 200, bg: '#fff', edit: (s) => s.replace(/stroke="currentColor"/, 'stroke="#000"').replace(/stroke-width="2"/, 'stroke-width="0.6"') },
  { id: 'flag-br', svg: 'flag-br.svg', w: 600, h: 450, bg: '#fff' },
  { id: 'flag-sv', svg: 'flag-sv.svg', w: 600, h: 450, bg: '#fff' },
  { id: 'parrot', svg: 'fluent-parrot-flat.svg', w: 512, h: 512, bg: null },
  { id: 'harbour-300', svg: '/demo-samples/harbour.svg', w: 300, h: 87, bg: '#fff' },
  { id: 'harbour-600', svg: '/demo-samples/harbour.svg', w: 600, h: 173, bg: '#fff' },
  { id: 'harbour-300-q40', svg: '/demo-samples/harbour.svg', w: 300, h: 87, bg: '#fff', jpeg: 0.4 },
  { id: 'harbour-300-q75', svg: '/demo-samples/harbour.svg', w: 300, h: 87, bg: '#fff', jpeg: 0.75 },
  { id: 'harbour-600-q40', svg: '/demo-samples/harbour.svg', w: 600, h: 173, bg: '#fff', jpeg: 0.4 },
  { id: 'kestrel-q40', svg: '/demo-samples/kestrel.svg', w: 400, h: 240, bg: '#fff', jpeg: 0.4 },
  { id: 'kestrel', svg: '/demo-samples/kestrel.svg', w: 800, h: 480, bg: '#fff' },
  { id: 'summit', svg: '/demo-samples/summit.svg', w: 600, h: 227, bg: null },
]

async function svgText(m: Master) {
  let s = await (await fetch(m.svg.startsWith('/') ? m.svg : R + m.svg)).text()
  if (m.edit) s = m.edit(s)
  return s.replace(/<svg\b([^>]*)>/, (_, a: string) => `<svg${a.replace(/\s(width|height|preserveAspectRatio)="[^"]*"/g, '')} width="W" height="H" preserveAspectRatio="none">`)
}

/** Transparent artwork (bg null) is uploaded transparent and compared on mid-grey, so white parts count. */
const COMPARE_BG = '#7f7f7f'

async function render(svg: string, w: number, h: number, bg: string | null): Promise<ImageData> {
  const img = new Image()
  img.src = URL.createObjectURL(new Blob([svg.replace('width="W"', `width="${w}"`).replace('height="H"', `height="${h}"`)], { type: 'image/svg+xml' }))
  await img.decode()
  const c = new OffscreenCanvas(w, h)
  const g = c.getContext('2d')!
  if (bg) {
    g.fillStyle = bg
    g.fillRect(0, 0, w, h)
  }
  g.drawImage(img, 0, 0, w, h)
  return g.getImageData(0, 0, w, h)
}

/** Pixels where the colour changes to a neighbour by more than `t` (summed RGB). */
function edges(d: ImageData, t = 90): Uint8Array {
  const { width: w, height: h, data } = d
  const e = new Uint8Array(w * h)
  const diff = (a: number, b: number) => Math.abs(data[a] - data[b]) + Math.abs(data[a + 1] - data[b + 1]) + Math.abs(data[a + 2] - data[b + 2])
  for (let y = 0; y < h - 1; y++)
    for (let x = 0; x < w - 1; x++) {
      const p = (y * w + x) * 4
      if (diff(p, p + 4) > t || diff(p, p + w * 4) > t) e[y * w + x] = 1
    }
  return e
}

/** Distance (px) from every pixel to the nearest set pixel (two-pass chamfer, 3-4). */
function distance(e: Uint8Array, w: number, h: number): Float32Array {
  const d = new Float32Array(w * h).fill(1e9)
  for (let i = 0; i < w * h; i++) if (e[i]) d[i] = 0
  const at = (x: number, y: number) => d[y * w + x]
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let v = d[y * w + x]
      if (x > 0) v = Math.min(v, at(x - 1, y) + 3)
      if (y > 0) v = Math.min(v, at(x, y - 1) + 3)
      if (x > 0 && y > 0) v = Math.min(v, at(x - 1, y - 1) + 4)
      if (x < w - 1 && y > 0) v = Math.min(v, at(x + 1, y - 1) + 4)
      d[y * w + x] = v
    }
  for (let y = h - 1; y >= 0; y--)
    for (let x = w - 1; x >= 0; x--) {
      let v = d[y * w + x]
      if (x < w - 1) v = Math.min(v, at(x + 1, y) + 3)
      if (y < h - 1) v = Math.min(v, at(x, y + 1) + 3)
      if (x < w - 1 && y < h - 1) v = Math.min(v, at(x + 1, y + 1) + 4)
      if (x > 0 && y < h - 1) v = Math.min(v, at(x - 1, y + 1) + 4)
      d[y * w + x] = v
    }
  for (let i = 0; i < w * h; i++) d[i] /= 3
  return d
}

function stats(from: Uint8Array, to: Float32Array) {
  const v: number[] = []
  for (let i = 0; i < from.length; i++) if (from[i]) v.push(to[i] / Z)
  v.sort((a, b) => a - b)
  const mean = v.reduce((s, x) => s + x, 0) / Math.max(1, v.length)
  return { mean: +mean.toFixed(3), p95: +(v[Math.floor(v.length * 0.95)] ?? 0).toFixed(3), max: +(v[v.length - 1] ?? 0).toFixed(2) }
}

/** Anchors per 100 px of outline: complexity, so a fix can't win by drawing more points. */
function anchors(svg: string) {
  return (svg.match(/[CLQ]/g) ?? []).length
}

const tracer = new Tracer()
const cache = new Map<string, { upload: Blob; truth: ImageData; truthEdges: Uint8Array; truthDist: Float32Array; master: Master }>()

async function prepare(m: Master) {
  const hit = cache.get(m.id)
  if (hit) return hit
  const svg = await svgText(m)
  const up = await render(svg, m.w, m.h, m.bg)
  const c = new OffscreenCanvas(m.w, m.h)
  c.getContext('2d')!.putImageData(up, 0, 0)
  const upload = await c.convertToBlob(m.jpeg ? { type: 'image/jpeg', quality: m.jpeg } : { type: 'image/png' })
  const truth = await render(svg, m.w * Z, m.h * Z, m.bg ?? COMPARE_BG)
  const truthEdges = edges(truth)
  const v = { upload, truth, truthEdges, truthDist: distance(truthEdges, m.w * Z, m.h * Z), master: m }
  cache.set(m.id, v)
  return v
}

export type Variant = { name: string; patch?: (trace: Record<string, unknown>) => void }

export async function run(variants: Variant[], ids?: string[]) {
  const rows: Record<string, unknown>[] = []
  for (const m of MASTERS.filter((m) => !ids || ids.includes(m.id))) {
    const p = await prepare(m)
    const source = await loadImage(p.upload, `${m.id}.${m.jpeg ? 'jpg' : 'png'}`)
    const det = detectArt(bitmapToImageData(source.bitmap))
    for (const v of variants) {
      const job = buildTraceJob(source, source.width, {
        trace: traceParamsFor(det.kind, DEFAULT_CLIENT, detailBoost(det, source.width, source.height)),
        prep: prepFor(det.kind, DEFAULT_CLIENT),
        spot: null,
        removeColors: [],
        transparent: det.hasAlpha || det.kind === 'lineart',
        knockout: false,
        exactShapes: true,
        gradients: true,
      })
      if (job.kind === 'flat' && v.patch) v.patch(job.options.trace as unknown as Record<string, unknown>)
      const res = await runTraceJob({ vtracer: tracer, flat: null }, job, source, false)
      const out = await render(res.svg.replace(/<svg\b([^>]*)>/, (_, a: string) => `<svg${a.replace(/\s(width|height)="[^"]*"/g, '')} width="W" height="H">`), m.w * Z, m.h * Z, m.bg ?? COMPARE_BG)
      const oe = edges(out)
      const toTruth = stats(oe, p.truthDist)
      const fromTruth = stats(p.truthEdges, distance(oe, m.w * Z, m.h * Z))
      rows.push({ id: m.id, kind: det.kind, variant: v.name, trace: job.kind === 'flat' ? { s: job.options.trace.smoothing, e: (job.options.trace as unknown as { error: number }).error } : null, outToTruth: toTruth, truthToOut: fromTruth, anchors: anchors(res.svg), svg: res.svg })
    }
  }
  return rows
}

/**
 * The navy layer's coverage around a point, at each tracing stage: raw membership, blurred, and
 * after keepThin. Shows whether a thin stroke falls under the contour level (0.5).
 */
export async function field(id: string, cx: number, cy: number, r = 6) {
  const { runFlat } = await import('../src/vectorize/pipeline')
  const { blur, keepThin } = await import('../src/trace/index')
  const m = MASTERS.find((x) => x.id === id)!
  const p = await prepare(m)
  const source = await loadImage(p.upload, `${m.id}.${m.jpeg ? 'jpg' : 'png'}`)
  const det = detectArt(bitmapToImageData(source.bitmap))
  const job = buildTraceJob(source, source.width, {
    trace: traceParamsFor(det.kind, DEFAULT_CLIENT, detailBoost(det, source.width, source.height)),
    prep: prepFor(det.kind, DEFAULT_CLIENT),
    spot: null,
    removeColors: [],
    transparent: det.hasAlpha || det.kind === 'lineart',
    knockout: false,
    exactShapes: true,
    gradients: true,
  })
  if (job.kind !== 'flat') return 'not flat'
  let map: { w: number; h: number; labels: Uint8Array; second: Uint8Array; cov: Float32Array; colors: number[] } | null = null
  runFlat(job.image, job.options, (mm) => (map = mm as unknown as typeof map))
  const M = map!
  // The darkest colour is the lettering.
  const lum = (c: number) => ((c >> 16) & 255) + ((c >> 8) & 255) + (c & 255)
  const ink = M.colors.map((c, i) => [lum(c), i]).filter(([, i]) => M.colors[i] >= 0).sort((a, b) => a[0] - b[0])[0][1]
  const n = M.w * M.h
  const raw = new Float32Array(n)
  for (let q = 0; q < n; q++) raw[q] = (M.labels[q] === ink ? M.cov[q] : 0) + (M.second[q] === ink ? 1 - M.cov[q] : 0)
  const sigma = job.options.trace.smoothing
  const b = blur(raw, M.w, M.h, sigma)
  const k = keepThin(b, M.w, M.h, 0.5, sigma)
  const grid = (f: Float32Array) => {
    const rows: string[] = []
    for (let y = cy - r; y <= cy + r; y++) {
      let s = ''
      for (let x = cx - r; x <= cx + r; x++) s += (f[y * M.w + x] >= 0.5 ? '#' : f[y * M.w + x] >= 0.25 ? '+' : '.') + (f[y * M.w + x] * 9).toFixed(0)
      rows.push(s)
    }
    return rows.join('\n')
  }
  return { sigma, colors: M.colors.map((c) => c.toString(16)), ink, raw: grid(raw), blurred: grid(b), kept: grid(k), field: k, w: M.w, h: M.h, trace: job.options.trace }
}

/** Draws the contour through (px, py) and its fitted curves at `z`×, with corners marked. */
export async function fitView(id: string, px: number, py: number, z = 24) {
  const f = await field(id, px, py, 2)
  if (typeof f === 'string') return f
  const { contours } = await import('../src/trace/contours')
  const { fitClosed, findCorners, resample } = await import('../src/trace/fit')
  const loops = contours(f.field, f.w, f.h, 0.5)
  const inBox = (l: [number, number][]) => {
    const xs = l.map((p) => p[0]), ys = l.map((p) => p[1])
    return Math.min(...xs) <= px && Math.max(...xs) >= px && Math.min(...ys) <= py && Math.max(...ys) >= py
  }
  const mine = loops.filter((l) => inBox(l as [number, number][])).sort((a, b) => a.length - b.length)
  const t = f.trace as unknown as { error: number; cornerAngle: number }
  const all = mine.map((loop) => {
    const curves = fitClosed(loop, { error: t.error, cornerAngle: t.cornerAngle })
    const pts = resample(loop, 0.5)
    return { loop, curves, corners: findCorners(pts, t.cornerAngle).map((i) => pts[i]) }
  })
  const xs = all.flatMap((a) => a.loop.map((p) => p[0])), ys = all.flatMap((a) => a.loop.map((p) => p[1]))
  const x0 = Math.floor(Math.min(...xs)) - 1, y0 = Math.floor(Math.min(...ys)) - 1
  const W = (Math.ceil(Math.max(...xs)) + 1 - x0) * z, H = (Math.ceil(Math.max(...ys)) + 1 - y0) * z
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const g = c.getContext('2d')!
  g.fillStyle = '#fff'
  g.fillRect(0, 0, W, H)
  const X = (v: number) => (v - x0) * z, Y = (v: number) => (v - y0) * z
  // Pixel grid with the field's coverage.
  for (let y = y0; y < y0 + H / z; y++)
    for (let x = x0; x < x0 + W / z; x++) {
      const v = f.field[y * f.w + x] ?? 0
      g.fillStyle = `rgba(25,29,99,${Math.max(0, Math.min(1, v)) * 0.35})`
      g.fillRect(X(x), Y(y), z, z)
    }
  for (const a of all) {
    g.strokeStyle = '#0a0'
    g.lineWidth = 1
    g.beginPath()
    a.loop.forEach((p, i) => (i ? g.lineTo(X(p[0]), Y(p[1])) : g.moveTo(X(p[0]), Y(p[1]))))
    g.closePath()
    g.stroke()
    g.strokeStyle = '#d00'
    g.lineWidth = 2
    g.beginPath()
    a.curves.forEach((cv, i) => {
      if (!i) g.moveTo(X(cv[0][0]), Y(cv[0][1]))
      g.bezierCurveTo(X(cv[1][0]), Y(cv[1][1]), X(cv[2][0]), Y(cv[2][1]), X(cv[3][0]), Y(cv[3][1]))
    })
    g.stroke()
    g.fillStyle = '#f80'
    for (const p of a.corners) g.fillRect(X(p[0]) - 4, Y(p[1]) - 4, 8, 8)
  }
  document.getElementById('__fv')?.remove()
  c.id = '__fv'
  c.style.cssText = 'position:fixed;left:0;top:0;z-index:9;max-width:100vw;max-height:100vh;background:#fff'
  document.body.append(c)
  return { loops: all.length, corners: all.map((a) => a.corners.length), curves: all.map((a) => a.curves.length), trace: t }
}

;(window as unknown as { __edgeLab: typeof run; __field: typeof field }).__edgeLab = run
;(window as unknown as { __field: typeof field }).__field = field
;(window as unknown as { __fitView: typeof fitView }).__fitView = fitView
document.getElementById('status')!.textContent = 'ready'

/**
 * Regression over the benchmark cases (bench/cases.ts), PNG / JPEG 75 / JPEG 40: the first result
 * as the app traces it (no improver, no sharpening), scored against the case's truth as
 * bench/assess.ts scores it (ink missing + added at 4×, ½ px tolerance), plus segments.
 */
export async function regress() {
  const { CASES, VALIDATION, input, summary } = await import('./cases')
  const { compareRasters } = await import('../src/quality/compare')
  const { rasterizeSvg } = await import('../src/quality/render')
  const out: [string, string, number, number, number][] = []
  for (const c of [...CASES, ...VALIDATION])
    for (const q of [null, 0.75, 0.4]) {
      if (c.pngOnly && q !== null) continue
      const name = `${c.name}.${q === null ? 'png' : 'jpg'}`
      const source = await loadImage(await input(c, q), name)
      const det = detectArt(bitmapToImageData(source.bitmap))
      const job = buildTraceJob(source, source.width, {
        trace: traceParamsFor(det.kind, DEFAULT_CLIENT, detailBoost(det, source.width, source.height)),
        prep: prepFor(det.kind, DEFAULT_CLIENT),
        spot: null,
        removeColors: [],
        transparent: det.hasAlpha || det.kind === 'lineart',
        knockout: false,
        exactShapes: true,
        gradients: true,
      })
      const res = await runTraceJob({ vtracer: tracer, flat: null }, job, source, false)
      const W = c.w * 4, H = c.h * 4
      const [t4, v4] = await Promise.all([rasterizeSvg(c.svg, W, H), rasterizeSvg(res.svg, W, H)])
      const s = summary(compareRasters(t4.data, v4.data, W, H, { tolerance: 2 }), t4)
      out.push([c.name, q === null ? 'png' : `q${q * 100}`, +(s.missingInk + s.extraInk).toFixed(3), +s.edgeF1.toFixed(4), (res.svg.match(/[CLQ]/g) ?? []).length])
    }
  return out
}
;(window as unknown as { __regress: typeof regress }).__regress = regress

/**
 * The audit uploads (public/audit-raw, as in docs/audits/2026-10-reconstruction): each traced as the
 * app traces it, compared with the upload at its own size (mean |ΔRGB| on white, share of pixels off
 * by more than 48), plus segments and self-crossing subpaths.
 */
export async function audit() {
  const shrink = async (blob: Blob, w: number, q: number) => {
    const b = await createImageBitmap(blob)
    const c = new OffscreenCanvas(w, Math.round((b.height * w) / b.width))
    const g = c.getContext('2d')!
    g.fillStyle = '#fff'
    g.fillRect(0, 0, c.width, c.height)
    g.drawImage(b, 0, 0, c.width, c.height)
    return c.convertToBlob({ type: 'image/jpeg', quality: q })
  }
  const png = async (svgFile: string, w: number, h: number, bg: string | null, edit?: (s: string) => string) => {
    const m = { id: svgFile, svg: svgFile, w, h, bg, edit }
    const up = await render(await svgText(m), w, h, bg)
    const c = new OffscreenCanvas(w, h)
    c.getContext('2d')!.putImageData(up, 0, 0)
    return c.convertToBlob({ type: 'image/png' })
  }
  const B: Record<string, Blob> = {}
  for (const t of ['android', 'javascript', 'vue', 'kubernetes', 'rust', 'react', 'docker', 'go', 'python', 'angular', 'firefox', 'ruby', 'linux'])
    B[`${t}.png`] = await (await fetch(`${R}explore-${t}.png`)).blob()
  B['flag-br.png'] = await png('flag-br.svg', 600, 450, '#fff')
  B['flag-mx.png'] = await png('flag-mx.svg', 600, 450, '#fff')
  B['flag-sv.png'] = await png('flag-sv.svg', 600, 450, '#fff')
  B['fluent-rocket.png'] = await png('fluent-rocket-color.svg', 512, 512, null)
  B['fluent-parrot.png'] = await png('fluent-parrot-flat.svg', 512, 512, null)
  B['flag-br-web.jpg'] = await shrink(B['flag-br.png'], 240, 0.55)
  B['docker-small.jpg'] = await shrink(B['docker.png'], 160, 0.6)
  B['python-tiny.jpg'] = await shrink(B['python.png'], 96, 0.6)
  const rows: [string, number, number, number, number][] = []
  for (const [name, blob] of Object.entries(B)) {
    const source = await loadImage(blob, name)
    const det = detectArt(bitmapToImageData(source.bitmap))
    const job = buildTraceJob(source, source.width, {
      trace: traceParamsFor(det.kind, DEFAULT_CLIENT, detailBoost(det, source.width, source.height)),
      prep: prepFor(det.kind, DEFAULT_CLIENT),
      spot: null,
      removeColors: [],
      transparent: det.hasAlpha || det.kind === 'lineart',
      knockout: false,
      exactShapes: true,
      gradients: true,
    })
    const res = await runTraceJob({ vtracer: tracer, flat: null }, job, source, false)
    const w = source.width, h = source.height
    const onWhite = async (src: Blob | string) => {
      const img = typeof src === 'string' ? Object.assign(new Image(), { src: URL.createObjectURL(new Blob([src], { type: 'image/svg+xml' })) }) : null
      if (img) await img.decode()
      const c = new OffscreenCanvas(w, h)
      const g = c.getContext('2d')!
      g.fillStyle = '#fff'
      g.fillRect(0, 0, w, h)
      g.drawImage(img ?? (await createImageBitmap(src as Blob)), 0, 0, w, h)
      return g.getImageData(0, 0, w, h).data
    }
    const a = await onWhite(blob), b = await onWhite(res.svg)
    let sum = 0, big = 0
    for (let i = 0; i < a.length; i += 4) {
      const d = (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])) / 3
      sum += d
      if (d > 48) big++
    }
    rows.push([name, +(sum / (w * h)).toFixed(3), +((100 * big) / (w * h)).toFixed(3), (res.svg.match(/[CLQ]/g) ?? []).length, res.svg.length])
  }
  return rows
}
;(window as unknown as { __audit: typeof audit }).__audit = audit
