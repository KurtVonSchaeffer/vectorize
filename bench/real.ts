// Real-logo benchmark: drop customer logos (and, where they exist, their original vectors) and
// every one is vectorized with the app's automatic settings and scored. Files stay in the browser.
//   logo.png / logo.jpg …      vectorized and scored against itself (no ground truth needed)
//   logo.svg next to logo.png  the original vector: also scored against that ground truth
//   an .svg on its own         rendered, vectorized and scored against itself
// "Save as baseline" keeps the results in this browser; later runs show the change per file.
import { colourFidelity, compareRasters } from '../src/quality/compare'
import { rasterizeSvg } from '../src/quality/render'
import { DEFAULT_CLIENT, detailBoost, prepFor, traceParamsFor } from '../src/vectorize/client'
import { detectArt } from '../src/vectorize/detect'
import { FlatTracer } from '../src/vectorize/flat-tracer'
import { bitmapToImageData, loadImage } from '../src/vectorize/image'
import { buildTraceJob, runTraceJob } from '../src/vectorize/pipeline'
import { Tracer } from '../src/vectorize/tracer'
import { fidelity, inkShare, summary } from './cases'

interface Result {
  file: string
  truth: string | null
  size: string
  kind: string
  fine: number
  colours: number
  paths: number
  segments: number
  kb: number
  ms: number
  /** Against the upload: wrong beyond 1 px edges (%), ink missing / extra (%), edge F1. */
  upload: { wrong: number; miss: number; extra: number; f1: number; colourDE: number | null }
  /** Against the original vector, when supplied (at 2×). */
  vector: { miss: number; extra: number; f1: number; meanDE: number; merged: number } | null
  error?: string
}

const BASELINE = 'real-baseline'
const tracers = { vtracer: new Tracer(), flat: new FlatTracer() }
const results: Result[] = []
;(window as unknown as { __real: Result[] }).__real = results
const table = document.getElementById('rows')!
const status = document.getElementById('status')!

async function score(file: File, truthFile: File | null): Promise<Result> {
  const base: Result = { file: file.name, truth: truthFile?.name ?? null, size: '', kind: '', fine: 0, colours: 0, paths: 0, segments: 0, kb: 0, ms: 0, upload: { wrong: 0, miss: 0, extra: 0, f1: 0, colourDE: null }, vector: null }
  try {
    const source = await loadImage(file, file.name)
    const det = detectArt(bitmapToImageData(source.bitmap))
    const client = { ...DEFAULT_CLIENT, purpose: 'web' as const }
    const job = buildTraceJob(source, source.width, {
      trace: traceParamsFor(det.kind, client, detailBoost(det, source.width, source.height)),
      prep: prepFor(det.kind, client),
      spot: null,
      removeColors: [],
      transparent: det.hasAlpha || det.kind === 'lineart',
      knockout: false,
      exactShapes: true,
      gradients: true,
    })
    const t0 = performance.now()
    const res = await runTraceJob(tracers, job, source, false)
    const ms = Math.round(performance.now() - t0)
    const W = source.width
    const H = source.height
    const upload = bitmapToImageData(source.bitmap)
    const out1 = await rasterizeSvg(res.svg, W, H)
    const r = compareRasters(upload.data, out1.data, W, H, { tolerance: 1 })
    const ink = inkShare(upload, r)
    const cf = colourFidelity(upload.data, out1.data, W, H)
    let vector: Result['vector'] = null
    if (truthFile) {
      const truthSvg = await truthFile.text()
      const [t2, o2, t1] = await Promise.all([rasterizeSvg(truthSvg, W * 2, H * 2), rasterizeSvg(res.svg, W * 2, H * 2), rasterizeSvg(truthSvg, W, H)])
      const s = summary(compareRasters(t2.data, o2.data, W * 2, H * 2, { tolerance: 1 }), t2)
      const f = fidelity(colourFidelity(t1.data, out1.data, W, H))
      vector = { miss: s.missingInk, extra: s.extraInk, f1: s.edgeF1, meanDE: f.meanDE, merged: f.merged }
    }
    return {
      ...base,
      size: `${W}×${H}`,
      kind: det.kind,
      fine: +det.fine.toFixed(2),
      colours: res.palette?.length ?? 0,
      paths: res.paths,
      segments: (res.svg.match(/[CLQ]/g) ?? []).length,
      kb: +(new Blob([res.svg]).size / 1024).toFixed(1),
      ms,
      // Colour accuracy against an upload is only meaningful for lossless files (exact colours).
      upload: { wrong: +(r.tolerantWrongShare * 100).toFixed(2), miss: ink.missingInk, extra: ink.extraInk, f1: +r.edgeF1.toFixed(3), colourDE: cf.colours.length ? +cf.meanDeltaE.toFixed(2) : null },
      vector,
    }
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) }
  }
}

function baseline(): Map<string, Result> {
  try {
    return new Map((JSON.parse(localStorage.getItem(BASELINE) ?? '[]') as Result[]).map((r) => [r.file, r]))
  } catch {
    return new Map()
  }
}

const change = (now: number, before: number | undefined, lowerIsBetter = true) => {
  if (before === undefined || before === now) return `${now}`
  const better = lowerIsBetter ? now < before : now > before
  return `${now} <small class="${better ? 'up' : 'down'}">(${before})</small>`
}

function render(r: Result, before: Result | undefined) {
  const tr = document.createElement('tr')
  if (r.error) {
    tr.innerHTML = `<td>${r.file}</td><td colspan="9" class="down">${r.error}</td>`
  } else {
    const v = r.vector
    tr.innerHTML = [
      `${r.file}${r.truth ? `<br><small>vs ${r.truth}</small>` : ''}`,
      `${r.size}<br><small>${r.kind} · fine ${r.fine}</small>`,
      change(r.upload.miss + r.upload.extra, before ? before.upload.miss + before.upload.extra : undefined),
      change(r.upload.wrong, before?.upload.wrong),
      change(r.upload.f1, before?.upload.f1, false),
      r.upload.colourDE ?? '—',
      v ? `${change(v.miss, before?.vector?.miss)} / ${change(v.extra, before?.vector?.extra)}<br><small>F1 ${v.f1} · ΔE ${v.meanDE}${v.merged ? ` · merged ${v.merged}` : ''}</small>` : '—',
      `${r.colours} / ${change(r.segments, before?.segments)}`,
      `${r.kb} KB`,
      change(r.ms, before?.ms),
    ]
      .map((c) => `<td>${c}</td>`)
      .join('')
  }
  table.append(tr)
}

async function run(files: File[]) {
  results.length = 0
  table.innerHTML = ''
  const byBase = new Map<string, File[]>()
  for (const f of files) {
    const key = f.name.replace(/\.[^.]+$/, '').toLowerCase()
    byBase.set(key, [...(byBase.get(key) ?? []), f])
  }
  const jobs: [File, File | null][] = []
  for (const group of byBase.values()) {
    const rasters = group.filter((f) => !/\.svg$/i.test(f.name))
    const svg = group.find((f) => /\.svg$/i.test(f.name)) ?? null
    if (rasters.length) for (const r of rasters) jobs.push([r, svg])
    else if (svg) jobs.push([svg, svg])
  }
  const before = baseline()
  for (let i = 0; i < jobs.length; i++) {
    status.textContent = `Vectorizing ${i + 1} of ${jobs.length}: ${jobs[i][0].name}`
    const r = await score(...jobs[i])
    results.push(r)
    render(r, before.get(r.file))
  }
  const ok = results.filter((r) => !r.error)
  const mean = (f: (r: Result) => number) => (ok.length ? (ok.reduce((s, r) => s + f(r), 0) / ok.length).toFixed(2) : '—')
  status.textContent = `Done: ${ok.length} logos (${results.length - ok.length} failed). Mean against upload: missing+extra ${mean((r) => r.upload.miss + r.upload.extra)}%, wrong ${mean((r) => r.upload.wrong)}%, edge F1 ${mean((r) => r.upload.f1)}; segments ${mean((r) => r.segments)}; ${mean((r) => r.ms)} ms.`
}

const download = (name: string, text: string, type: string) => {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([text], { type }))
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

const picker = document.getElementById('files') as HTMLInputElement
picker.addEventListener('change', () => picker.files && run([...picker.files]))
document.body.addEventListener('dragover', (e) => e.preventDefault())
document.body.addEventListener('drop', (e) => {
  e.preventDefault()
  if (e.dataTransfer?.files.length) void run([...e.dataTransfer.files])
})
document.getElementById('save')!.addEventListener('click', () => {
  try {
    localStorage.setItem(BASELINE, JSON.stringify(results))
    status.textContent = `Saved ${results.length} results as the baseline.`
  } catch {
    status.textContent = 'Could not save in this browser.'
  }
})
document.getElementById('json')!.addEventListener('click', () => download('vectorize-real-logos.json', JSON.stringify(results, null, 2), 'application/json'))
document.getElementById('csv')!.addEventListener('click', () => {
  const head = ['file', 'truth', 'size', 'kind', 'fine', 'colours', 'paths', 'segments', 'kb', 'ms', 'upload_wrong', 'upload_miss', 'upload_extra', 'upload_f1', 'upload_colour_de', 'vector_miss', 'vector_extra', 'vector_f1', 'vector_de', 'vector_merged', 'error']
  const rows = results.map((r) => [r.file, r.truth ?? '', r.size, r.kind, r.fine, r.colours, r.paths, r.segments, r.kb, r.ms, r.upload.wrong, r.upload.miss, r.upload.extra, r.upload.f1, r.upload.colourDE ?? '', r.vector?.miss ?? '', r.vector?.extra ?? '', r.vector?.f1 ?? '', r.vector?.meanDE ?? '', r.vector?.merged ?? '', r.error ?? ''])
  download('vectorize-real-logos.csv', [head, ...rows].map((row) => row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n'), 'text/csv')
})
