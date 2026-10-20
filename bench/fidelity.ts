// Fidelity baseline: each upload goes through the production job at the default settings (as the
// app runs it, before any background improvement) and the result is measured against the upload
// with assessFidelity. Measurement only: nothing here changes how artwork is processed.
//   ?dir=/audit-in/&files=a.png,b.jpg   uploads served by the dev server (e.g. a symlink in public/)
//   or choose files with the picker
// Results: window.__fidelity (rows, one per upload) once the status reads "Done".
// The audit set and how to fetch it: docs/audits/2026-10-reconstruction (manifest.json).
import { DEMO_PALETTE } from '../src/palette/demo'
import { DEFAULT_INKS } from '../src/palette/quantize'
import { assessFidelity, type FidelityReport } from '../src/quality/fidelity'
import { rasterizeSvg } from '../src/quality/render'
import { DEFAULT_CLIENT, detailBoost, prepFor, traceParamsFor } from '../src/vectorize/client'
import { detectArt } from '../src/vectorize/detect'
import { bitmapToImageData, finalizeSvg, loadImage } from '../src/vectorize/image'
import { buildTraceJob, runFlat, runTraceJob } from '../src/vectorize/pipeline'
import { Tracer } from '../src/vectorize/tracer'

/** Largest side measured; bigger uploads are compared scaled down, as the app's other checks are. */
const MAX_SIDE = 1000

interface Row {
  file: string
  kind: string
  size: [number, number]
  /** SHA-256 of the SVG, so a later run can show the processing result is unchanged. */
  svgHash: string
  paths: number
  report: Omit<FidelityReport, 'issues'> & { issues: { id: string; severity: string; count: number; message: string; where: unknown[] }[] }
  /** Whole job (trace and measure), and the measurement alone. */
  ms: number
  assessMs: number
}

const status = document.getElementById('status')!
const table = document.getElementById('rows')!
const rows: Row[] = []
;(window as unknown as { __fidelity: Row[] }).__fidelity = rows
const tracer = new Tracer()

async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function measure(blob: Blob, file: string): Promise<Row> {
  const t0 = performance.now()
  const source = await loadImage(blob, file)
  const det = detectArt(bitmapToImageData(source.bitmap))
  const job = buildTraceJob(source, source.width, {
    trace: traceParamsFor(det.kind, DEFAULT_CLIENT, detailBoost(det, source.width, source.height)),
    prep: prepFor(det.kind, DEFAULT_CLIENT),
    spot: { settings: DEFAULT_INKS, palette: DEMO_PALETTE },
    removeColors: [],
    transparent: det.hasAlpha || det.kind === 'lineart',
    knockout: false,
    keepBlends: DEFAULT_CLIENT.keepBlends,
    exactShapes: DEFAULT_CLIENT.exactShapes,
    gradients: DEFAULT_CLIENT.gradients,
    brand: undefined,
  })
  const svg = job.kind === 'flat' ? finalizeSvg(runFlat(job.image, job.options).svg, job.image, source) : (await runTraceJob({ vtracer: tracer, flat: null }, job, source, false)).svg
  const k = Math.min(1, MAX_SIDE / Math.max(source.width, source.height))
  const w = Math.max(1, Math.round(source.width * k))
  const h = Math.max(1, Math.round(source.height * k))
  const c = new OffscreenCanvas(w, h)
  const g = c.getContext('2d', { willReadFrequently: true })!
  g.drawImage(source.bitmap, 0, 0, w, h)
  const upload = g.getImageData(0, 0, w, h)
  const vector = await rasterizeSvg(svg, w, h)
  const t1 = performance.now()
  const report = assessFidelity(upload, vector, svg)
  const assessMs = Math.round(performance.now() - t1)
  return {
    file,
    kind: det.kind,
    size: [source.width, source.height],
    svgHash: await sha256(svg),
    paths: (svg.match(/<path\b/g) ?? []).length,
    report: { ...report, issues: report.issues.map(({ id, severity, count, message, where }) => ({ id, severity, count, message, where: where.slice(0, 8) })) },
    ms: Math.round(performance.now() - t0),
    assessMs,
  }
}

function show(r: Row) {
  const f = r.report
  const tr = document.createElement('tr')
  const cells = [r.file, f.verdict, f.visual, f.geometryVerdict, (f.edgeRecall * 100).toFixed(1), `${f.features.lost}/${f.features.fine}`, (f.features.lostArea * 100).toFixed(0), String(f.features.changed), (f.shading.share * 100).toFixed(0), String(f.geometry.copiedOutlines), String(f.geometry.selfIntersecting), String(f.geometry.tiny), f.geometry.paperShape ? 'yes' : '', f.issues.map((i) => i.message).join(' ')]
  for (const c of cells) {
    const td = document.createElement('td')
    td.textContent = c
    tr.append(td)
  }
  table.append(tr)
}

async function run(items: { name: string; blob: () => Promise<Blob> }[]) {
  for (const [i, it] of items.entries()) {
    status.textContent = `Measuring ${i + 1} of ${items.length}: ${it.name}`
    const r = await measure(await it.blob(), it.name)
    rows.push(r)
    show(r)
  }
  status.textContent = 'Done'
}

const q = new URLSearchParams(location.search)
const dir = q.get('dir')
const files = q.get('files')?.split(',').filter(Boolean)
if (dir && files?.length) void run(files.map((name) => ({ name, blob: async () => (await fetch(dir + name)).blob() })))
else {
  status.textContent = 'Choose uploads to measure.'
  document.getElementById('pick')!.addEventListener('change', (e) => {
    const list = [...((e.target as HTMLInputElement).files ?? [])]
    void run(list.map((f) => ({ name: f.name, blob: async () => f })))
  })
}
