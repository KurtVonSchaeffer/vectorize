// V8 redraw proof of concept page (EXPERIMENTAL; bench only). Each test logo is damaged into a
// realistic upload, traced by V7 and redrawn by V8, and both are scored against the clean
// original. Real logos can be added too (no original: pictures and file checks only).
import { Enhancer } from '../../src/ai/enhancer'
import { shapesFromSvg } from '../../src/export/path'
import { validateShapes } from '../../src/export/validate'
import { colourFidelity, compareRasters, inkChange } from '../../src/quality/compare'
import { rasterizeSvg } from '../../src/quality/render'
import type { LabelMap } from '../../src/trace'
import { DEFAULT_CLIENT, detailBoost, prepFor, traceParamsFor } from '../../src/vectorize/client'
import { detectArt } from '../../src/vectorize/detect'
import { bitmapToImageData, loadImage, type SourceImage } from '../../src/vectorize/image'
import { buildTraceJob, runFlat } from '../../src/vectorize/pipeline'
import { Tracer } from '../../src/vectorize/tracer'
import { simulateImprover } from '../improver-sim'
import { svgUrl, viewer, type Visual } from '../review'
import { REDRAW_CASES } from './cases'
import { DEFAULT_REDRAW, redraw, type RedrawResult } from './engine'

interface Scores {
  /** Detail missing + added against the clean original, % of its ink (lower is better). */
  error: number
  edgeF1: number
  meanDE: number
}
interface Geometry {
  /** Curve and line segments in the file. */
  segments: number
  /** Share of curve-to-curve joins with a 15–60° bend (lumps). */
  kinks: number
}
export interface RedrawRow {
  name: string
  tests: string
  upload: string
  v7: { scores: Scores | null; geometry: Geometry; fileProblems: string[]; ms: number }
  v8: { scores: Scores | null; geometry: Geometry; fileProblems: string[]; ms: number; heapMb: number | null; stats: RedrawResult['stats']; interpreted: number }
  verdict: 'better' | 'same' | 'worse' | 'n/a'
  svgs: { v7: string; v8: string }
}

const rows: RedrawRow[] = []
;(window as unknown as { __redraw: RedrawRow[] }).__redraw = rows
const tracer = new Tracer()
const enhancer = new Enhancer()
const list = document.getElementById('cases')!
const status = document.getElementById('status')!
const summary = document.getElementById('summary')!

/** A realistic customer upload from a clean SVG: shrunk to `width`, lightly blurred, saved as JPEG. */
async function damage(svg: string, width: number, quality: number): Promise<Blob> {
  const m = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/)!
  const h = Math.round((width * Number(m[2])) / Number(m[1]))
  const img = new Image()
  img.src = svgUrl(svg)
  await img.decode()
  const c = new OffscreenCanvas(width, h)
  const g = c.getContext('2d')!
  g.fillStyle = '#fff'
  g.fillRect(0, 0, width, h)
  g.filter = 'blur(0.6px)'
  g.imageSmoothingQuality = 'high'
  g.drawImage(img, 0, 0, width, h)
  return c.convertToBlob({ type: 'image/jpeg', quality })
}

function geometry(svg: string): Geometry {
  let segments = 0, joins = 0, kinks = 0
  for (const s of shapesFromSvg(svg))
    for (const sp of s.subpaths) {
      segments += sp.segs.length
      let prev = sp.start
      let lastT: [number, number] | null = null
      for (const g of sp.segs) {
        if (g.t === 'C') {
          const inT: [number, number] = [g.c1[0] - prev[0], g.c1[1] - prev[1]]
          if (lastT) {
            const a = Math.hypot(...inT) * Math.hypot(...lastT)
            if (a > 1e-9) {
              joins++
              const bend = (Math.acos(Math.max(-1, Math.min(1, (inT[0] * lastT[0] + inT[1] * lastT[1]) / a))) * 180) / Math.PI
              if (bend > 15 && bend < 60) kinks++
            }
          }
          lastT = [g.p[0] - g.c2[0], g.p[1] - g.c2[1]]
        } else lastT = null
        prev = g.p
      }
    }
  return { segments, kinks: joins ? +(kinks / joins).toFixed(3) : 0 }
}

async function scores(original: string, svg: string, w: number, h: number): Promise<Scores> {
  const [o, c] = await Promise.all([rasterizeSvg(original, w, h), rasterizeSvg(svg, w, h)])
  const r = compareRasters(o.data, c.data, w, h, { tolerance: 2 })
  const { missing, extra } = inkChange(o.data, r)
  return { error: +((missing + extra) * 100).toFixed(2), edgeF1: +r.edgeF1.toFixed(3), meanDE: +colourFidelity(o.data, c.data, w, h).meanDeltaE.toFixed(2) }
}

const problems = (svg: string, width: number) =>
  validateShapes(shapesFromSvg(svg), { width, outputWidthMm: 200, plates: true })
    .filter((c) => c.status !== 'ok')
    .map((c) => `${c.id} ${c.count}`)

/** V7's colour map for an upload, as the app makes it (default settings, no lettering). */
function colourMap(source: SourceImage): { map: LabelMap; image: ImageData; ms: number } | null {
  const det = detectArt(bitmapToImageData(source.bitmap))
  if (det.kind !== 'flat' && det.kind !== 'lineart') return null
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
  if (job.kind !== 'flat') return null
  let map: LabelMap | null = null
  const t = performance.now()
  runFlat(job.image, job.options, (m) => (map = m))
  return map ? { map, image: job.image, ms: Math.round(performance.now() - t) } : null
}

const heap = () => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null

async function runOne(name: string, tests: string, upload: Blob, original: string | null) {
  const source = await loadImage(upload, `${name}.jpg`)
  const t7 = performance.now()
  const sim = await simulateImprover(source, enhancer, tracer)
  const ms7 = Math.round(performance.now() - t7)
  if (!sim) {
    list.insertAdjacentHTML('beforeend', `<p>${name}: not flat artwork, skipped.</p>`)
    return
  }
  const plates7 = await sim.plates()
  const cm = colourMap(source)
  if (!cm) return
  const h0 = heap()
  const t8 = performance.now()
  const v8 = redraw(cm.image, cm.map, DEFAULT_REDRAW)
  const ms8 = Math.round(performance.now() - t8) + cm.ms
  const h1 = heap()
  const W = source.width * 4, H = source.height * 4
  const row: RedrawRow = {
    name,
    tests,
    upload: `${source.width}×${source.height}`,
    v7: { scores: original ? await scores(original, sim.first.svg, W, H) : null, geometry: geometry(sim.first.svg), fileProblems: problems(plates7, source.width), ms: ms7 },
    v8: { scores: original ? await scores(original, v8.svg, W, H) : null, geometry: geometry(v8.svg), fileProblems: problems(v8.svg, source.width), ms: ms8, heapMb: h0 !== null && h1 !== null ? +((h1 - h0) / 1e6).toFixed(1) : null, stats: v8.stats, interpreted: v8.interpreted.length },
    verdict: 'n/a',
    svgs: { v7: sim.first.svg, v8: v8.svg },
  }
  if (row.v7.scores && row.v8.scores) {
    const d = row.v8.scores.error - row.v7.scores.error
    row.verdict = d < -0.5 ? 'better' : d > 0.5 ? 'worse' : 'same'
  }
  rows.push(row)
  render(row, {
    file: name,
    width: source.width,
    height: source.height,
    upload: URL.createObjectURL(upload),
    first: svgUrl(sim.first.svg),
    offer: { label: `${v8.interpreted.length} interpreted change(s) outlined`, src: svgUrl(v8.svg) },
    original: original ? svgUrl(original) : null,
    originalIsVector: true,
    boxes: v8.interpreted.map((p) => ({ x: (p.x - 3) / source.width, y: (p.y - 3) / source.height, w: 6 / source.width, h: 6 / source.height, kind: 'interpreted' as const, pane: 2 })),
    focus: { x: 0.5, y: 0.5 },
    titles: ['Damaged upload', 'V7 trace', 'V8 redraw (experimental)', 'Clean original'],
  }, v8)
  summarize()
}

const cell = (s: Scores | null, g: Geometry, files: string[], ms: number) =>
  `${s ? `error <b>${s.error}%</b> · edges ${s.edgeF1} · ΔE ${s.meanDE}<br>` : ''}${g.segments} segments · kinked joins ${Math.round(g.kinks * 100)}%<br>files: ${files.length ? `<span class="down">${files.join(', ')}</span>` : 'clean'} · ${ms} ms`

function render(r: RedrawRow, v: Visual, res: RedrawResult) {
  const el = document.createElement('section')
  const s = res.stats.segments
  el.innerHTML = `<h2>${r.name} <small>${r.tests} · upload ${r.upload}</small> <b class="${r.verdict === 'better' ? 'up' : r.verdict === 'worse' ? 'down' : ''}">${r.verdict === 'n/a' ? '' : `V8 ${r.verdict}`}</b></h2>
    <table><tr><th></th><th>V7 trace</th><th>V8 redraw (experimental)</th></tr>
    <tr><td>vs clean original · geometry · files · time</td><td>${cell(r.v7.scores, r.v7.geometry, r.v7.fileProblems, r.v7.ms)}</td><td>${cell(r.v8.scores, r.v8.geometry, r.v8.fileProblems, r.v8.ms)}</td></tr>
    <tr><td>redraw</td><td></td><td>${s.line} lines · ${s.arc} arcs · ${s.circle} circles · ${s.bezier} curves (${Math.round(res.stats.primitiveShare * 100)}% of the outline as lines and arcs) · ${res.stats.edges} shared edges · symmetry: ${res.stats.symmetry} · ${res.interpreted.length} interpreted${r.v8.heapMb !== null ? ` · heap +${r.v8.heapMb} MB` : ''}</td></tr></table>`
  el.append(viewer(v))
  list.append(el)
}

function summarize() {
  const scored = rows.filter((r) => r.v7.scores && r.v8.scores)
  const mean = (f: (r: RedrawRow) => number) => (scored.length ? +(scored.reduce((s, r) => s + f(r), 0) / scored.length).toFixed(2) : 0)
  const segs = (k: 'v7' | 'v8') => rows.reduce((s, r) => s + r[k].geometry.segments, 0)
  summary.innerHTML = `${rows.length} logos (${scored.length} with originals) · V8 better ${scored.filter((r) => r.verdict === 'better').length}, same ${scored.filter((r) => r.verdict === 'same').length}, <b class="${scored.some((r) => r.verdict === 'worse') ? 'down' : ''}">worse ${scored.filter((r) => r.verdict === 'worse').length}</b><br>
    mean error vs original: V7 ${mean((r) => r.v7.scores!.error)}% → V8 ${mean((r) => r.v8.scores!.error)}% · edges ${mean((r) => r.v7.scores!.edgeF1)} → ${mean((r) => r.v8.scores!.edgeF1)}<br>
    segments: V7 ${segs('v7')} → V8 ${segs('v8')} · files with problems: V7 ${rows.filter((r) => r.v7.fileProblems.length).length} → V8 ${rows.filter((r) => r.v8.fileProblems.length).length} · mean time: V7 ${Math.round(rows.reduce((s, r) => s + r.v7.ms, 0) / Math.max(1, rows.length))} ms, V8 ${Math.round(rows.reduce((s, r) => s + r.v8.ms, 0) / Math.max(1, rows.length))} ms`
}

async function runSet() {
  rows.length = 0
  list.innerHTML = ''
  const width = Number((document.getElementById('width') as HTMLInputElement).value) || 160
  const quality = Number((document.getElementById('quality') as HTMLInputElement).value) || 0.55
  for (let i = 0; i < REDRAW_CASES.length; i++) {
    const c = REDRAW_CASES[i]
    status.textContent = `Redrawing ${i + 1} of ${REDRAW_CASES.length}: ${c.name}`
    await runOne(c.name, c.tests, await damage(c.svg, width, quality), c.svg)
  }
  status.textContent = `Done: ${rows.length} logos.`
}

document.getElementById('run')!.addEventListener('click', () => void runSet())
const picker = document.getElementById('files') as HTMLInputElement
picker.addEventListener('change', async () => {
  for (const f of [...(picker.files ?? [])]) {
    status.textContent = `Redrawing ${f.name}`
    await runOne(f.name, 'your logo (no original: compare by eye)', f, null)
  }
  status.textContent = `Done: ${rows.length} logos.`
})
document.getElementById('json')!.addEventListener('click', () => {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([JSON.stringify(rows, null, 2)], { type: 'application/json' }))
  a.download = 'v8-redraw-results.json'
  a.click()
})
if (new URLSearchParams(location.search).has('auto')) void runSet()
