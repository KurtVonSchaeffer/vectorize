// Before/after validation of an engine change on real logos (docs/colour-validation.md). Each logo
// runs through two versions of the app's pipeline in this page, `main` (a git worktree, see
// below) and this checkout, with the same upload decode, the same renderer and the same original,
// and each result is scored against the original artwork. Logos are then sorted into improved,
// unchanged and regressed, with enlarged pictures for every change.
//
// Setup (once): git worktree add --detach node_modules/.cache/compare-main origin/main
//   ?base=/node_modules/.cache/compare-main   the "before" version (default)
// Naming as bench/real.html: category__name.png plus category__name.svg or .truth.png.
import { colourFidelity, compareRasters, inkChange } from '../src/quality/compare'
import { rasterizeSvg } from '../src/quality/render'
import { deltaE2000, rgbToLab } from '../src/palette/color'
import { bitmapToImageData, loadImage, type SourceImage } from '../src/vectorize/image'
import { compressionRipple, COMPRESSED_RIPPLE, isLossy } from '../src/vectorize/improve'
import { validate } from './exports'
import { compareShapes, missingColours, type MissingColour } from './review'

/** What counts as a meaningful change (smaller differences are anti-aliasing noise). */
export const MEANINGFUL = {
  /** Detail missing + added against the original, percentage points, and relative. */
  detailPoints: 1,
  detailRelative: 0.1,
  edgeF1: 0.01,
  meanDE: 1,
  /** Segments: both relative and absolute growth. */
  segmentsRelative: 0.5,
  segmentsAbsolute: 50,
}

/**
 * A colour counts as present in the upload when at least this many of its pixels survive within
 * ΔE `presentDE` (more for compressed uploads), or this share of the pixels it covers in the
 * original at the upload's size, whichever is larger. Otherwise it was destroyed before Vectorize
 * saw the file, and losing it is not a regression (nor should it be invented).
 */
const PRESENT = { minPixels: 3, share: 0.1, de: 6, deLossy: 10 }

interface Engine {
  label: string
  simulateImprover: (s: SourceImage, e: unknown, t: unknown) => Promise<Sim | null>
  makeEnhancer: () => unknown
  makeTracer: () => unknown
  downloadsFor: (purpose: 'print' | 'web' | 'cut', input: unknown) => { label: string; make: () => Promise<Blob> }[]
  inkNames: (o: unknown) => Map<number, string>
  enhancer?: unknown
  tracer?: unknown
}

interface Sim {
  first: { svg: string; result: { palette?: { color: number }[]; inks?: unknown[]; named?: unknown; paths: number } }
  plates: () => Promise<string>
  offered: { label: string; svg: string } | null
}

interface Colour extends MissingColour {
  /** Whether the upload still shows this colour. */
  inUpload: boolean
}

interface Scores {
  svg: string
  colours: string[]
  paths: number
  segments: number
  error: number
  edgeF1: number
  meanDE: number
  maxDE: number
  merged: number
  missing: Colour[]
  shapes: { merged: number; broken: number; missing: number; extra: number }
  exports: Record<string, string>
  offer: string | null
  /** The suggested version against the original (what a customer gets by choosing it). */
  offerError: number | null
  offerEdgeF1: number | null
  offerSvg: string | null
}

type Outcome = 'identical' | 'unchanged' | 'improved' | 'regressed' | 'mixed'

interface Row {
  file: string
  category: string
  original: string
  size: string
  compressed: boolean
  before: Scores
  after: Scores
  outcome: Outcome
  better: string[]
  worse: string[]
  /** Colours of the original the upload no longer shows (can't be expected back). */
  destroyed: string[]
  /** Changes that don't count either way (e.g. a different suggestion of equal quality). */
  notes?: string[]
  error?: string
}

const params = new URLSearchParams(location.search)
const BASE = params.get('base') ?? '/node_modules/.cache/compare-main'
const rows: Row[] = []
;(window as unknown as { __compare: Row[] }).__compare = rows
const status = document.getElementById('status')!
const summary = document.getElementById('summary')!
const sections = { regressed: document.getElementById('regressed')!, mixed: document.getElementById('mixed')!, improved: document.getElementById('improved')!, unchanged: document.getElementById('unchanged')! }

async function engine(root: string, label: string): Promise<Engine> {
  const [sim, tracer, enh, files, pipe] = await Promise.all([
    import(/* @vite-ignore */ `${root}/bench/improver-sim.ts`),
    import(/* @vite-ignore */ `${root}/src/vectorize/tracer.ts`),
    import(/* @vite-ignore */ `${root}/src/ai/enhancer.ts`),
    import(/* @vite-ignore */ `${root}/src/export/files.ts`),
    import(/* @vite-ignore */ `${root}/src/vectorize/pipeline.ts`),
  ])
  return { label, simulateImprover: sim.simulateImprover, makeEnhancer: () => new enh.Enhancer(), makeTracer: () => new tracer.Tracer(), downloadsFor: files.downloadsFor, inkNames: pipe.inkNames }
}

/** The original at w×h: SVG rendered, PNG resampled (as bench/real.ts). */
async function originalAt(file: File, w: number, h: number): Promise<ImageData> {
  if (/\.svg$/i.test(file.name)) return rasterizeSvg(await file.text(), w, h)
  const bmp = await createImageBitmap(file)
  const c = new OffscreenCanvas(w, h)
  const g = c.getContext('2d', { willReadFrequently: true })!
  g.imageSmoothingQuality = 'high'
  g.drawImage(bmp, 0, 0, w, h)
  bmp.close()
  return g.getImageData(0, 0, w, h)
}

function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** Whether the upload still shows `hex`, given how many pixels it covers in the original. */
function inUpload(upload: ImageData, original1: ImageData, hex: string, lossy: boolean): boolean {
  const lab = rgbToLab(hexRgb(hex))
  const limit = lossy ? PRESENT.deLossy : PRESENT.de
  const [r, g, b] = hexRgb(hex)
  let expected = 0
  for (let i = 0; i < original1.data.length; i += 4) if (original1.data[i + 3] >= 250 && Math.abs(original1.data[i] - r) + Math.abs(original1.data[i + 1] - g) + Math.abs(original1.data[i + 2] - b) <= 6) expected++
  let seen = 0
  const d = upload.data
  for (let i = 0; i < d.length; i += 4) if (d[i + 3] >= 250 && deltaE2000(lab, rgbToLab([d[i], d[i + 1], d[i + 2]])) <= limit) seen++
  return seen >= Math.max(PRESENT.minPixels, expected * PRESENT.share)
}

async function scoreVersion(e: Engine, source: SourceImage, original: File, upload: ImageData, lossy: boolean): Promise<Scores> {
  const sim = await e.simulateImprover(source, (e.enhancer ??= e.makeEnhancer()), (e.tracer ??= e.makeTracer()))
  if (!sim) throw new Error('not flat artwork (photo or pixel art)')
  const W = source.width
  const H = source.height
  const svg = sim.first.svg
  const [o2, v2, o1, v1] = await Promise.all([originalAt(original, W * 2, H * 2), rasterizeSvg(svg, W * 2, H * 2), originalAt(original, W, H), rasterizeSvg(svg, W, H)])
  const r = compareRasters(o2.data, v2.data, W * 2, H * 2, { tolerance: 1 })
  const ink = inkChange(o2.data, r)
  const f = colourFidelity(o1.data, v1.data, W, H)
  const missing = missingColours(o2, svg).map((m) => ({ ...m, inUpload: inUpload(upload, o1, m.colour, lossy) }))
  const shapes = compareShapes(o2, v2).shapes
  const res = sim.first.result
  const plates = await sim.plates()
  const names = res.palette ? e.inkNames({ palette: res.palette, inks: res.inks ?? [], named: res.named }) : new Map<number, string>()
  const exports: Record<string, string> = {}
  for (const purpose of ['print', 'web', 'cut'] as const)
    for (const d of e.downloadsFor(purpose, { svg, plateSvg: purpose === 'web' ? undefined : async () => plates, width: W, height: H, baseName: 'logo', names, spotNames: null, flat: (res.palette?.length ?? 0) <= 16 }))
      exports[`${purpose} ${d.label}`] = await validate(d.label, await d.make()).catch((err) => `error: ${err}`)
  return {
    svg,
    colours: (res.palette ?? []).map((p) => `#${p.color.toString(16).padStart(6, '0')}`),
    paths: res.paths,
    segments: (svg.match(/[CLQ]/g) ?? []).length,
    error: +((ink.missing + ink.extra) * 100).toFixed(2),
    edgeF1: +r.edgeF1.toFixed(3),
    meanDE: +f.meanDeltaE.toFixed(2),
    maxDE: +f.maxDeltaE.toFixed(2),
    merged: f.merged,
    missing,
    shapes: { merged: shapes.merged, broken: shapes.broken, missing: shapes.missing, extra: shapes.extra },
    exports,
    offer: sim.offered?.label ?? null,
    ...(await offerScores(sim.offered?.svg ?? null, o2, W, H)),
  }
}

async function offerScores(svg: string | null, o2: ImageData, W: number, H: number) {
  if (!svg) return { offerError: null, offerEdgeF1: null, offerSvg: null }
  const v2 = await rasterizeSvg(svg, W * 2, H * 2)
  const r = compareRasters(o2.data, v2.data, W * 2, H * 2, { tolerance: 1 })
  const ink = inkChange(o2.data, r)
  return { offerError: +((ink.missing + ink.extra) * 100).toFixed(2), offerEdgeF1: +r.edgeF1.toFixed(3), offerSvg: svg }
}

/** The best a customer can get from a version: the first result, or the suggestion if it's better. */
const bestError = (s: Scores) => (s.offerError !== null && s.offerError < s.error ? s.offerError : s.error)

/** Sorts the differences into meaningful improvements and regressions (see MEANINGFUL). */
function classify(row: Row) {
  row.notes = []
  const a = row.before
  const b = row.after
  const better: string[] = []
  const worse: string[] = []
  const note = (good: boolean, text: string) => (good ? better : worse).push(text)
  const dErr = b.error - a.error
  if (Math.abs(dErr) > Math.max(MEANINGFUL.detailPoints, a.error * MEANINGFUL.detailRelative)) note(dErr < 0, `detail error ${a.error}% → ${b.error}%`)
  if (Math.abs(b.edgeF1 - a.edgeF1) > MEANINGFUL.edgeF1) note(b.edgeF1 > a.edgeF1, `edge agreement ${a.edgeF1} → ${b.edgeF1}`)
  if (Math.abs(b.meanDE - a.meanDE) > MEANINGFUL.meanDE) note(b.meanDE < a.meanDE, `colour ΔE ${a.meanDE} → ${b.meanDE}`)
  if (b.merged !== a.merged) note(b.merged < a.merged, `merged brand colours ${a.merged} → ${b.merged}`)
  // Missing colours: only those the upload still shows can be expected back.
  const present = (s: Scores) => new Set(s.missing.filter((m) => m.inUpload).map((m) => m.colour))
  const pa = present(a)
  const pb = present(b)
  for (const c of pa) if (!pb.has(c)) note(true, `${c} recovered`)
  for (const c of pb) if (!pa.has(c)) note(false, `${c} lost (the upload shows it)`)
  for (const k of ['merged', 'broken', 'missing', 'extra'] as const) if (b.shapes[k] !== a.shapes[k]) note(b.shapes[k] < a.shapes[k], `${k} shapes ${a.shapes[k]} → ${b.shapes[k]}`)
  const dSeg = b.segments - a.segments
  if (Math.abs(dSeg) > Math.max(MEANINGFUL.segmentsAbsolute, a.segments * MEANINGFUL.segmentsRelative)) note(dSeg < 0, `segments ${a.segments} → ${b.segments}`)
  // Suggestions: what a customer can reach by accepting one (it's never applied automatically).
  if (a.offer !== b.offer) {
    const ba = bestError(a)
    const bb = bestError(b)
    const what = `suggestion ${a.offer ? `"${a.offer}" (${a.offerError}%)` : 'none'} → ${b.offer ? `"${b.offer}" (${b.offerError}%)` : 'none'}`
    if (Math.abs(bb - ba) > Math.max(MEANINGFUL.detailPoints, ba * MEANINGFUL.detailRelative)) note(bb < ba, `${what}; best available ${ba}% → ${bb}%`)
    else row.notes.push(what)
  }
  const exportsOk = (s: Scores) => Object.values(s.exports).every((v) => v === 'ok')
  if (exportsOk(a) !== exportsOk(b)) note(exportsOk(b), exportsOk(b) ? 'exports now valid' : `exports broken: ${Object.entries(b.exports).filter(([, v]) => v !== 'ok').map(([k, v]) => `${k} ${v}`).join(', ')}`)
  row.better = better
  row.worse = worse
  row.outcome = a.svg === b.svg ? 'identical' : worse.length && better.length ? 'mixed' : worse.length ? 'regressed' : better.length ? 'improved' : 'unchanged'
  row.destroyed = [...new Set([...a.missing, ...b.missing].filter((m) => !m.inUpload).map((m) => m.colour))]
}

// ---------- Pictures ----------

/** Crops (fractions) around where the two results differ most. */
async function changedSpot(a: string, b: string, W: number, H: number) {
  const [ra, rb] = await Promise.all([rasterizeSvg(a, W, H), rasterizeSvg(b, W, H)])
  const side = Math.max(8, Math.round(Math.min(W, H) / 6))
  let best = { x: 0.5, y: 0.5, n: -1 }
  for (let y0 = 0; y0 + side <= H; y0 += Math.max(2, side >> 1))
    for (let x0 = 0; x0 + side <= W; x0 += Math.max(2, side >> 1)) {
      let n = 0
      for (let y = y0; y < y0 + side; y++)
        for (let x = x0; x < x0 + side; x++) {
          const i = (y * W + x) * 4
          if (Math.abs(ra.data[i] - rb.data[i]) + Math.abs(ra.data[i + 1] - rb.data[i + 1]) + Math.abs(ra.data[i + 2] - rb.data[i + 2]) + Math.abs(ra.data[i + 3] - rb.data[i + 3]) > 60) n++
        }
      if (n > best.n) best = { x: (x0 + side / 2) / W, y: (y0 + side / 2) / H, n }
    }
  return best
}

const PANEL = 240
async function cropCanvas(kind: 'svg' | 'bitmap', src: string | ImageBitmap, fx: number, fy: number, fw: number, fh: number, pixelated = false): Promise<string> {
  const c = new OffscreenCanvas(PANEL * 2, PANEL * 2)
  const g = c.getContext('2d')!
  if (kind === 'bitmap') {
    const bmp = src as ImageBitmap
    g.imageSmoothingEnabled = !pixelated
    g.drawImage(bmp, fx * bmp.width, fy * bmp.height, fw * bmp.width, fh * bmp.height, 0, 0, PANEL * 2, PANEL * 2)
  } else {
    const svg = src as string
    const root = svg.match(/<svg\b[^>]*>/i)?.[0] ?? ''
    const vb = root.match(/viewBox\s*=\s*["']([^"']+)["']/i)?.[1].trim().split(/[\s,]+/).map(Number)
    const num = (k: string) => parseFloat(root.match(new RegExp(`\\s${k}\\s*=\\s*["']([\\d.]+)`, 'i'))?.[1] ?? '100')
    const [x, y, w, h] = vb && vb.length === 4 ? vb : [0, 0, num('width'), num('height')]
    const cropped = svg.replace(/<svg\b([^>]*?)(\/?)>/i, (_, attrs: string, close: string) => `<svg${attrs.replace(/\s(width|height|viewBox|preserveAspectRatio)\s*=\s*("[^"]*"|'[^']*')/gi, '')} width="${PANEL * 2}" height="${PANEL * 2}" viewBox="${x + fx * w} ${y + fy * h} ${fw * w} ${fh * h}" preserveAspectRatio="none"${close}>`)
    g.putImageData(await rasterizeSvg(cropped, PANEL * 2, PANEL * 2), 0, 0)
  }
  const blob = await c.convertToBlob({ type: 'image/png' })
  return new Promise((resolve) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as string)
    r.readAsDataURL(blob)
  })
}

/** Enlarged side-by-side of the spot that changed most: upload, original, before, after. */
async function pictures(row: Row, source: SourceImage, original: File, zoom = 8): Promise<string> {
  const W = source.width
  const H = source.height
  const spot = await changedSpot(row.before.svg, row.after.svg, W, H)
  const fw = Math.min(1, PANEL / zoom / W)
  const fh = Math.min(1, PANEL / zoom / H)
  const fx = Math.min(1 - fw, Math.max(0, spot.x - fw / 2))
  const fy = Math.min(1 - fh, Math.max(0, spot.y - fh / 2))
  const originalPanel = /\.svg$/i.test(original.name) ? await cropCanvas('svg', await original.text(), fx, fy, fw, fh) : await cropCanvas('bitmap', await createImageBitmap(original), fx, fy, fw, fh)
  const panels: [string, string][] = [
    [`Upload · ${zoom}×`, await cropCanvas('bitmap', source.bitmap, fx, fy, fw, fh, true)],
    [`Original · ${zoom}×`, originalPanel],
    [`Before (main) · ${zoom}×`, await cropCanvas('svg', row.before.svg, fx, fy, fw, fh)],
    [`After (this branch) · ${zoom}×`, await cropCanvas('svg', row.after.svg, fx, fy, fw, fh)],
  ]
  return `<div class="row">${panels.map(([label, src]) => `<figure><img src="${src}" width="${PANEL}" height="${PANEL}"><figcaption>${label}</figcaption></figure>`).join('')}</div>`
}

// ---------- Report ----------

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
const swatches = (cs: string[]) => cs.map((c) => `<span class="sw" style="background:${c}" title="${c}"></span>`).join('')

function card(row: Row, pics: string): string {
  const a = row.before
  const b = row.after
  const line = (label: string, x: string | number, y: string | number) => `<tr><td>${label}</td><td>${x}</td><td>${y}</td></tr>`
  const missing = (s: Scores) => s.missing.map((m) => `${m.colour}${m.inUpload ? '' : ' <small>(not in upload)</small>'}`).join(', ') || '—'
  return `<section class="card ${row.outcome}"><div class="head"><b class="badge ${row.outcome}">${row.outcome.toUpperCase()}</b> <b>${esc(row.file)}</b> <small>${esc(row.category)} · ${row.size}${row.compressed ? ' · compressed' : ''} · vs ${esc(row.original)}</small></div>
${row.worse.length ? `<p class="down">Worse: ${row.worse.map(esc).join('; ')}</p>` : ''}${row.better.length ? `<p class="up">Better: ${row.better.map(esc).join('; ')}</p>` : ''}${row.notes?.length ? `<p><small>Also: ${row.notes.map(esc).join('; ')}</small></p>` : ''}${row.destroyed.length ? `<p><small>Not in the upload any more (can't be expected back): ${row.destroyed.join(', ')}</small></p>` : ''}
${pics}
<table class="m"><tr><th></th><th>before (main)</th><th>after</th></tr>
${line('colours', swatches(a.colours), swatches(b.colours))}
${line('detail error vs original', `${a.error}%`, `${b.error}%`)}
${line('edge agreement', a.edgeF1, b.edgeF1)}
${line('colour ΔE mean / max', `${a.meanDE} / ${a.maxDE}`, `${b.meanDE} / ${b.maxDE}`)}
${line('missing colours', missing(a), missing(b))}
${line('shapes merged / broken / missing / extra', Object.values(a.shapes).join(' / '), Object.values(b.shapes).join(' / '))}
${line('paths / segments', `${a.paths} / ${a.segments}`, `${b.paths} / ${b.segments}`)}
${line('exports', Object.values(a.exports).every((v) => v === 'ok') ? 'all valid' : 'FAILED', Object.values(b.exports).every((v) => v === 'ok') ? 'all valid' : 'FAILED')}
${line('suggestion (error vs original)', a.offer ? `${esc(a.offer)} (${a.offerError}%)` : '—', b.offer ? `${esc(b.offer)} (${b.offerError}%)` : '—')}
${line('best available to the customer', `${bestError(a)}%`, `${bestError(b)}%`)}
</table></section>`
}

function summarize() {
  const n = (o: Outcome) => rows.filter((r) => r.outcome === o).length
  const failed = rows.filter((r) => r.error)
  summary.innerHTML = `<b>${rows.length}</b> logos: <b class="down">${n('regressed')}</b> regressed, ${n('mixed')} mixed, <b class="up">${n('improved')}</b> improved, ${n('unchanged')} unchanged, ${n('identical')} identical.${failed.length ? ` <span class="down">${failed.length} failed to run.</span>` : ''}<br><small>Before: <code>${esc(BASE)}</code> (main) · After: this checkout. Same upload decode, renderer and original for both.</small>`
}

const reportParts: string[] = []

async function run(files: File[]) {
  rows.length = 0
  reportParts.length = 0
  Object.values(sections).forEach((s) => (s.innerHTML = ''))
  status.textContent = 'Loading both versions…'
  const before = await engine(BASE, 'main')
  const after = await engine('', 'this branch')
  const key = (name: string) => name.replace(/\.(truth|original)(?=\.)/i, '').replace(/\.[^.]+$/, '').toLowerCase()
  const groups = new Map<string, File[]>()
  for (const f of files) groups.set(key(f.name), [...(groups.get(key(f.name)) ?? []), f])
  const jobs: [File, File, string][] = []
  const skipped: string[] = []
  for (const [k, group] of groups) {
    const original = group.find((f) => /\.svg$/i.test(f.name)) ?? group.find((f) => /\.(truth|original)\.png$/i.test(f.name))
    const uploads = group.filter((f) => f !== original)
    if (!original) skipped.push(...group.map((f) => f.name))
    else for (const u of uploads) jobs.push([u, original, k.includes('__') ? k.split('__')[0] : 'uncategorised'])
  }
  for (let i = 0; i < jobs.length; i++) {
    const [file, original, category] = jobs[i]
    status.textContent = `Comparing ${i + 1} of ${jobs.length}: ${file.name}`
    try {
      const source = await loadImage(file, file.name)
      const upload = bitmapToImageData(source.bitmap)
      const lossy = isLossy(file.name) || compressionRipple(upload) >= COMPRESSED_RIPPLE
      const row: Row = { file: file.name, category, original: original.name, size: `${source.width}×${source.height}`, compressed: lossy, before: await scoreVersion(before, source, original, upload, lossy), after: await scoreVersion(after, source, original, upload, lossy), outcome: 'unchanged', better: [], worse: [], destroyed: [] }
      classify(row)
      rows.push(row)
      const pics = row.outcome === 'identical' ? '' : await pictures(row, source, original)
      const html = card(row, pics)
      reportParts.push(html)
      const target = row.outcome === 'identical' ? sections.unchanged : sections[row.outcome]
      target.insertAdjacentHTML('beforeend', html)
    } catch (err) {
      rows.push({ file: file.name, category, original: original.name, size: '', compressed: false, before: null as unknown as Scores, after: null as unknown as Scores, outcome: 'unchanged', better: [], worse: [], destroyed: [], error: err instanceof Error ? err.message : String(err) })
      sections.regressed.insertAdjacentHTML('beforeend', `<section class="card"><b class="down">FAILED</b> ${esc(file.name)}: ${esc(err instanceof Error ? err.message : String(err))}</section>`)
    }
    summarize()
  }
  status.textContent = `Done: ${rows.length} logos${skipped.length ? `; skipped (no original): ${skipped.join(', ')}` : ''}.`
}

const download = (name: string, data: string, type: string) => {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([data], { type }))
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
document.getElementById('report')!.addEventListener('click', () => {
  const style = document.getElementById('style')!.textContent
  const order: Outcome[] = ['regressed', 'mixed', 'improved', 'unchanged', 'identical']
  const byOutcome = order.map((o) => [o, reportParts.filter((_, i) => rows[i]?.outcome === o)] as const).filter(([, p]) => p.length)
  download('vectorize-before-after.html', `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Vectorize before/after</title><style>${style}</style></head><body><h1>Before/after validation</h1><p>${summary.innerHTML}</p>${byOutcome.map(([o, p]) => `<h2>${o}</h2>${p.join('')}`).join('')}</body></html>`, 'text/html')
})
document.getElementById('json')!.addEventListener('click', () => download('vectorize-before-after.json', JSON.stringify(rows.map((r) => ({ ...r, before: r.before && { ...r.before, svg: undefined, offerSvg: undefined }, after: r.after && { ...r.after, svg: undefined, offerSvg: undefined } })), null, 2), 'application/json'))
