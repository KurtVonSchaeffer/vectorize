// Quality diagnostics: where does accuracy get lost? Each case isolates one kind of detail
// (small text, thin lines, dots, corners, similar colours, gradients, transparency, low
// resolution) and is measured against its ground truth at three stages:
//   input  – the raster the tracer receives (JPEG/downscaling loss; the floor)
//   map    – the cleaned colour map just before tracing (colour segmentation loss)
//   vector – the final SVG, at the working size and at 4× (edge reconstruction / curve loss)
// Open /bench/diagnose.html on the dev server. ?cases=text,lines&sweep=1
import { colorAt } from '../src/palette/gradients'
import { colourFidelity, compareRasters } from '../src/quality/compare'
import { rasterizeSvg } from '../src/quality/render'
import type { LabelMap } from '../src/trace'
import { DEFAULT_CLIENT, detailBoost, NO_BOOST, prepFor, traceParamsFor, type ClientSettings } from '../src/vectorize/client'
import { detectArt, type ArtKind } from '../src/vectorize/detect'
import { bitmapToImageData, finalizeSvg, loadImage } from '../src/vectorize/image'
import { buildTraceJob, runFlat, runTraceJob } from '../src/vectorize/pipeline'
import { Tracer } from '../src/vectorize/tracer'
import type { TraceParams } from '../src/vectorize/params'
import { CASES, fidelity, input, summary, type Case } from './cases'

const q = new URLSearchParams(location.search)
/** ?boost=0 turns off the per-image Detail additions (detailBoost), as before V6 fix 4. */
const boost = q.get('boost') !== '0'
const groups = q.get('cases')?.split(',')
const sweep = q.get('sweep') === '1'
const ablate = q.get('ablate') === '1'
/** JPEG quality for the compressed variant (default 0.75). */
const jpegQuality = Number(q.get('q') ?? 0.75)
/** Input formats per case: png and/or JPEG qualities (default png, 0.75 and 0.4). */
const FORMATS: (number | null)[] = (q.get('formats') ?? 'png,0.75,0.4').split(',').map((f) => (f === 'png' ? null : Number(f)))
/** Force an artwork type instead of the automatic guess (e.g. ?style=flat). */
const style = q.get('style') as ArtKind | null
/** ?mode=print traces print plates (shapes don't overlap) instead of the on-screen stacking. */
const knockout = q.get('mode') === 'print'
const tracer = new Tracer()
const out: Record<string, unknown>[] = []
;(window as unknown as { __diag: unknown }).__diag = out
/** One line per run: kind, 4× missing/extra ink %, edge F1, colour ΔE (mean/max, merged), colours, segments, ms. */
;(window as unknown as { __lines: () => string }).__lines = () =>
  out
    .filter((r) => r.vector4x)
    .map((r) => {
      const v = r.vector4x as { missingInk: number; extraInk: number; edgeF1: number }
      const c = r.colour as { meanDE: number; maxDE: number; merged: number }
      return `${r.group}/${r.name} ${r.format} [${r.kind} fine ${r.fine}] miss ${v.missingInk} extra ${v.extraInk} F1 ${v.edgeF1} ΔE ${c.meanDE}/${c.maxDE}${c.merged ? ` merged ${c.merged}` : ''} col ${r.colors} seg ${r.segments} ${r.ms}ms`
    })
    .join('\n')

type Run = { group: string; name: string; format: string; kind: string; vector4x: { missingInk: number; extraInk: number; edgeF1: number }; colour: { meanDE: number; merged: number }; colors: number | null; segments: number; ms: number }
/** Saves this run as the baseline (in this browser), for __diff. */
;(window as unknown as { __save: (k?: string) => void }).__save = (k = 'diag-baseline') => localStorage.setItem(k, JSON.stringify(out.filter((r) => r.vector4x)))
/** Before → after against a saved baseline, for every run in both. */
;(window as unknown as { __diff: (k?: string) => string }).__diff = (k = 'diag-baseline') => {
  const before = new Map((JSON.parse(localStorage.getItem(k) ?? '[]') as Run[]).map((r) => [`${r.group}/${r.name} ${r.format}`, r]))
  return (out.filter((r) => r.vector4x) as unknown as Run[])
    .map((a) => {
      const id = `${a.group}/${a.name} ${a.format}`
      const b = before.get(id)
      if (!b) return `${id}: no baseline`
      const f = (x: number, y: number) => (x === y ? `${y}` : `${x}→${y}`)
      return `${id} ${b.kind === a.kind ? `[${a.kind}]` : `[${b.kind}→${a.kind}]`} miss ${f(b.vector4x.missingInk, a.vector4x.missingInk)} extra ${f(b.vector4x.extraInk, a.vector4x.extraInk)} F1 ${f(b.vector4x.edgeF1, a.vector4x.edgeF1)} ΔE ${f(b.colour.meanDE, a.colour.meanDE)} merged ${f(b.colour.merged, a.colour.merged)} col ${f(b.colors ?? 0, a.colors ?? 0)} seg ${f(b.segments, a.segments)} ms ${f(b.ms, a.ms)}`
    })
    .join('\n')
}
const table = document.getElementById('table')!

/** The colour map as an image: blended edge pixels mixed by coverage, gradients evaluated. */
function renderMap(map: LabelMap): ImageData {
  const img = new ImageData(map.w, map.h)
  const rgb = (l: number, x: number, y: number): [number, number, number] | null => {
    if (l >= 254 || map.colors[l] < 0) return null
    const f = map.fills?.[l]
    if (f) return colorAt(f, x + 0.5, y + 0.5)
    const c = map.colors[l]
    return [(c >> 16) & 255, (c >> 8) & 255, c & 255]
  }
  for (let y = 0; y < map.h; y++)
    for (let x = 0; x < map.w; x++) {
      const p = y * map.w + x
      const a = rgb(map.labels[p], x, y)
      const b = map.cov[p] < 1 ? rgb(map.second[p], x, y) : null
      const c = map.cov[p]
      const px = a && b ? a.map((v, k) => v * c + b[k] * (1 - c)) : a
      if (px) img.data.set([...px.map(Math.round), 255], p * 4)
    }
  return img
}

async function run(c: Case, jpeg: number | null, client: ClientSettings, tweak: Partial<TraceParams> = {}) {
  const source = await loadImage(await input(c, jpeg), `${c.name}.${jpeg !== null ? 'jpg' : 'png'}`)
  const det = detectArt(bitmapToImageData(source.bitmap))
  if (style) det.kind = style
  const job = buildTraceJob(source, source.width, {
    trace: { ...traceParamsFor(det.kind, client, boost ? detailBoost(det, source.width, source.height) : NO_BOOST), ...tweak },
    prep: prepFor(det.kind, client),
    spot: null,
    removeColors: [],
    transparent: det.hasAlpha,
    knockout,
    exactShapes: client.exactShapes,
    gradients: client.gradients,
  })
  const W = job.image.width
  const H = job.image.height
  const t0 = performance.now()
  let map: LabelMap | null = null
  let svgOut: string
  let paths: number
  if (job.kind === 'flat') {
    const res = runFlat(job.image, job.options, (m) => (map = m))
    svgOut = finalizeSvg(res.svg, job.image, source)
    paths = res.paths
  } else {
    const res = await runTraceJob({ vtracer: tracer, flat: null }, job, source, false)
    svgOut = res.svg
    paths = res.paths
  }
  const ms = Math.round(performance.now() - t0)
  const truthW = await rasterizeSvg(c.svg, W, H)
  const truth4 = await rasterizeSvg(c.svg, W * 4, H * 4)
  const vec1 = await rasterizeSvg(svgOut, W, H)
  const vec4 = await rasterizeSvg(svgOut, W * 4, H * 4)
  const cmp = (a: ImageData, b: ImageData, tol = 1) => compareRasters(a.data, b.data, a.width, a.height, { tolerance: tol })
  return {
    kind: det.kind,
    fine: +det.fine.toFixed(2),
    size: `${W}×${H}`,
    input: summary(cmp(truthW, job.image), truthW),
    map: map ? summary(cmp(truthW, renderMap(map)), truthW) : null,
    vector: summary(cmp(truthW, vec1), truthW),
    // At 4× a 1 px tolerance is ¼ source px: this is how exact the vector edges really are.
    vector4x: summary(cmp(truth4, vec4, 2), truth4),
    colour: fidelity(colourFidelity(truthW.data, vec1.data, W, H)),
    ms,
    colors: map ? new Set((map as LabelMap).labels).size : null,
    paths,
    segments: (svgOut.match(/[CLQ]/g) ?? []).length,
    svg: svgOut,
  }
}

const cell = (s: { err: number; wrong: number; edgeF1: number; missingInk: number; extraInk: number } | null) =>
  s ? `${s.err} · ${s.wrong}% · F1 ${s.edgeF1} · −${s.missingInk}% +${s.extraInk}%` : '—'

for (const c of ablate ? [] : CASES) {
  if (groups && !groups.includes(c.group)) continue
  for (const jpeg of FORMATS) {
    if (c.pngOnly && jpeg !== null) continue
    const r = await run(c, jpeg, { ...DEFAULT_CLIENT, purpose: 'web' })
    const { svg: svgOut, ...rest } = r
    out.push({ group: c.group, name: c.name, format: jpeg === null ? 'png' : `q${jpeg}`, ...rest })
    const row = document.createElement('tr')
    row.innerHTML = `<td>${c.group}</td><td>${c.name} <small>${jpeg !== null ? `JPEG ${jpeg}` : 'PNG'} ${r.size} ${r.kind}</small></td><td>${cell(r.input)}</td><td>${cell(r.map)}</td><td>${cell(r.vector)}</td><td>${cell(r.vector4x)}</td><td>${r.colors ?? '—'}</td><td>${r.paths}</td><td>${r.segments}</td>`
    const img = document.createElement('img')
    img.src = URL.createObjectURL(new Blob([svgOut], { type: 'image/svg+xml' }))
    const td = document.createElement('td')
    td.append(img)
    row.append(td)
    table.append(row)
  }
  if (sweep) {
    // Does the best Detail / Corners setting depend on the image?
    const grid: Record<string, unknown>[] = []
    for (const detail of [0, 0.25, 0.5, 0.75, 1])
      for (const corners of [0.25, 0.75]) {
        const r = await run(c, jpegQuality, { ...DEFAULT_CLIENT, purpose: 'web', detail, corners })
        grid.push({ detail, corners, wrong4x: r.vector4x.wrong, missing4x: r.vector4x.missingInk, extra4x: r.vector4x.extraInk, segments: r.segments, colors: r.colors })
      }
    out.push({ group: c.group, name: c.name, sweep: grid })
  }
}
if (ablate) {
  // Which of the settings tied to Detail (and the smoothing tied to Corners) causes the loss?
  // Each is changed alone from the default, to the value Detail = 1 (or Corners = 1) gives.
  const TWEAKS: [string, Partial<TraceParams>][] = [
    ['default', {}],
    ['speck 1', { filterSpeckle: 1 }],
    ['curve tol 0.1', { curveTolerance: 0.1 }],
    ['colour merge 4', { colorMerge: 4 }],
    ['smoothing 0.5', { smoothing: 0.5 }],
    ['speck 1 + smoothing 0.5', { filterSpeckle: 1, smoothing: 0.5 }],
    // The three settings Detail 0.75 changes, one at a time.
    ['speck 2', { filterSpeckle: 2 }],
    ['colour merge 7', { colorMerge: 7 }],
    ['curve tol 0.3', { curveTolerance: 0.3 }],
  ]
  for (const c of CASES) {
    if (groups && !groups.includes(c.group)) continue
    const rows: Record<string, unknown>[] = []
    for (const [label, tweak] of TWEAKS) {
      const r = await run(c, jpegQuality, { ...DEFAULT_CLIENT, purpose: 'web' }, tweak)
      rows.push({ label, missing4x: r.vector4x.missingInk, extra4x: r.vector4x.extraInk, mapMissing: r.map?.missingInk, segments: r.segments, colors: r.colors })
    }
    out.push({ group: c.group, name: c.name, ablation: rows })
  }
}
document.getElementById('status')!.textContent = 'Done'
