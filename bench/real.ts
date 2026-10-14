// Real-logo acceptance test (docs/real-logo-acceptance.md). Drop customer logos, and where they
// exist their originals; each logo goes through the app's first result and background improver
// (bench/improver-sim.ts), its downloads are checked, and it's scored against acceptance criteria.
// Files stay in the browser.
//   print__acme.png              a logo; the prefix before "__" is its category (see CATEGORIES)
//   print__acme.svg              its original vector, or
//   print__acme.truth.png        its original as a high-resolution PNG (export PDF / AI originals to either)
//   an .svg on its own           rendered, vectorized and scored against itself
// "Save as baseline" keeps the results in this browser; later runs show the change per file.
import { Enhancer } from '../src/ai/enhancer'
import { downloadsFor } from '../src/export/files'
import { colourFidelity, compareRasters, inkChange } from '../src/quality/compare'
import { rasterizeSvg } from '../src/quality/render'
import { bitmapToImageData, loadImage, type SourceImage } from '../src/vectorize/image'
import { compressionRipple, COMPRESSED_RIPPLE, isLossy } from '../src/vectorize/improve'
import { Tracer } from '../src/vectorize/tracer'
import { inkNames } from '../src/vectorize/pipeline'
import { simulateImprover } from './improver-sim'
import { finalVerdict, loadReviews, reportHtml, reviewForm, structureChecks, structureFlags, svgUrl, viewer, type ReportRow, type Review, type Structure, type Verdict, type Visual } from './review'

export const CATEGORIES: Record<string, string> = {
  print: 'Print-ready branding',
  lettering: 'Small lettering',
  colour: 'Colour fidelity',
  transparent: 'Transparency',
  gradient: 'Gradients',
  complex: 'Complex artwork',
}

/** Acceptance criteria against the original; see docs/real-logo-acceptance.md. */
export const CRITERIA = {
  /** Detail missing + added, percent of the original's ink, at 2× with ½ px tolerance. */
  maxDetailError: 2,
  maxDetailErrorLettering: 5,
  minEdgeF1: 0.95,
  /** Mean CIEDE2000 colour difference over the original's flat colours. */
  maxColourDE: 2,
  maxColourDELossy: 3,
  /** Share of pixels that changed between transparent and opaque, percent. */
  maxAlphaFlips: 0.5,
  /** An offered alternative may be at most this many points worse than the first result. */
  offerSlack: 0.5,
}

interface Against {
  error: number
  edgeF1: number
  meanDE: number
  merged: number
  alphaFlips: number
}

interface Result {
  file: string
  category: string
  original: string | null
  size: string
  kind: string
  compressed: boolean
  colours: number
  segments: number
  kb: number
  /** Against the upload (no ground truth): detail missing + added, percent; edge agreement. */
  upload: { error: number; edgeF1: number }
  /** First result against the original, when supplied. */
  first: Against | null
  /** What the improver offered (if anything), and how it compares with the original. */
  offer: { label: string; uploadError: number; vsOriginal: Against | null } | null
  /** Best alternative against the original, offered or not (what the improver could have gained). */
  bestPossible: { label: string; error: number } | null
  exports: Record<string, string>
  gradientsKept: boolean | null
  font: string | null
  verdict: string[]
  pass: boolean | null
  /** Structural checks (bench/review.ts): nodes, outlines, merged / broken / missing shapes, colours, cut pieces. */
  structure: Structure | null
  flags: string[]
  /** Final verdict: automatic criteria plus the manual review. */
  final: Verdict
  review: Review | null
  /** Fingerprint of the upload and its original; a saved review applies only to this exact content. */
  digest: string
  ms: number
  error?: string
}

const BASELINE = 'real-baseline-v2'
const tracer = new Tracer()
const enhancer = new Enhancer()
const results: Result[] = []
const visuals = new Map<string, Visual>()
;(window as unknown as { __visuals: Map<string, Visual> }).__visuals = visuals
const reviews = loadReviews()
;(window as unknown as { __real: Result[] }).__real = results
const table = document.getElementById('rows')!
const status = document.getElementById('status')!
const summaryEl = document.getElementById('summary')!

async function validate(label: string, blob: Blob): Promise<string> {
  if (!blob.size) return 'empty'
  const text = label === 'PNG' ? '' : await blob.text()
  if (label === 'SVG') {
    if (new DOMParser().parseFromString(text, 'image/svg+xml').querySelector('parsererror')) return 'does not parse'
    const url = URL.createObjectURL(blob)
    try {
      const img = new Image()
      img.src = url
      await img.decode()
    } catch {
      return 'does not render'
    } finally {
      URL.revokeObjectURL(url)
    }
  }
  if (label === 'PDF' && (!text.startsWith('%PDF-') || !text.trim().endsWith('%%EOF') || !/f\*/.test(text))) return 'incomplete'
  if (label === 'DXF' && (!text.includes('AC1009') || !/\nPOLYLINE\n/.test(text))) return 'no outlines'
  if (label === 'PNG') {
    const b = new Uint8Array(await blob.slice(0, 8).arrayBuffer())
    if (b[1] !== 0x50 || b[2] !== 0x4e || b[3] !== 0x47) return 'bad signature'
  }
  return 'ok'
}

/** The original as a raster at w×h (SVG rendered, PNG resampled). */
async function originalRaster(file: File, w: number, h: number): Promise<ImageData> {
  if (/\.svg$/i.test(file.name)) return rasterizeSvg(await file.text(), w, h)
  const bmp = await createImageBitmap(file)
  const c = new OffscreenCanvas(w, h)
  const g = c.getContext('2d', { willReadFrequently: true })!
  g.imageSmoothingQuality = 'high'
  g.drawImage(bmp, 0, 0, w, h)
  bmp.close()
  return g.getImageData(0, 0, w, h)
}

async function against(original: File, svg: string, w: number, h: number): Promise<Against> {
  const [o2, v2, o1, v1] = await Promise.all([originalRaster(original, w * 2, h * 2), rasterizeSvg(svg, w * 2, h * 2), originalRaster(original, w, h), rasterizeSvg(svg, w, h)])
  const r = compareRasters(o2.data, v2.data, w * 2, h * 2, { tolerance: 1 })
  const { missing, extra } = inkChange(o2.data, r)
  const f = colourFidelity(o1.data, v1.data, w, h)
  return { error: +((missing + extra) * 100).toFixed(2), edgeF1: +r.edgeF1.toFixed(3), meanDE: +f.meanDeltaE.toFixed(2), merged: f.merged, alphaFlips: +(r.alphaFlips * 100).toFixed(2) }
}

function judge(r: Result): void {
  const v: string[] = []
  if (Object.values(r.exports).some((x) => x !== 'ok')) v.push('export failed')
  if (r.gradientsKept === false) v.push('gradient lost')
  if (r.first) {
    const maxError = r.category === 'lettering' ? CRITERIA.maxDetailErrorLettering : CRITERIA.maxDetailError
    if (r.first.error > maxError) v.push(`detail ${r.first.error}% > ${maxError}%`)
    if (r.first.edgeF1 < CRITERIA.minEdgeF1) v.push(`edges ${r.first.edgeF1} < ${CRITERIA.minEdgeF1}`)
    const maxDE = r.compressed ? CRITERIA.maxColourDELossy : CRITERIA.maxColourDE
    if (r.first.meanDE > maxDE) v.push(`colour ΔE ${r.first.meanDE} > ${maxDE}`)
    if (r.first.merged) v.push(`${r.first.merged} brand colour pair(s) merged`)
    if (r.category === 'transparent' && r.first.alphaFlips > CRITERIA.maxAlphaFlips) v.push(`transparency changed on ${r.first.alphaFlips}% of pixels`)
    if (r.offer?.vsOriginal && r.offer.vsOriginal.error > r.first.error + CRITERIA.offerSlack) v.push(`OFFER WORSE: ${r.offer.label} ${r.first.error}% → ${r.offer.vsOriginal.error}%`)
    r.pass = v.length === 0
  } else {
    r.pass = v.length ? false : null
    v.push('no original: check visually')
  }
  r.verdict = v
}

/** SHA-256 of the upload followed by its original, as hex. */
async function digestOf(file: File, original: File | null): Promise<string> {
  const parts = await Promise.all([file, ...(original && original !== file ? [original] : [])].map((f) => f.arrayBuffer()))
  const all = new Uint8Array(parts.reduce((n, p) => n + p.byteLength + 1, 0))
  let at = 0
  for (const p of parts) {
    all.set(new Uint8Array(p), at)
    at += p.byteLength + 1
  }
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', all))].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function score(file: File, original: File | null, category: string): Promise<Result> {
  const digest = await digestOf(file, original)
  const base: Result = { file: file.name, category, original: original?.name ?? null, size: '', kind: '', compressed: false, colours: 0, segments: 0, kb: 0, upload: { error: 0, edgeF1: 0 }, first: null, offer: null, bestPossible: null, exports: {}, gradientsKept: null, font: null, verdict: [], pass: null, structure: null, flags: [], final: 'REVIEW', review: null, digest, ms: 0 }
  try {
    const source: SourceImage = await loadImage(file, file.name)
    const sim = await simulateImprover(source, enhancer, tracer)
    if (!sim) return { ...base, size: `${source.width}×${source.height}`, kind: 'photo or pixel art (not covered)', verdict: ['not flat artwork'], pass: null }
    const W = source.width
    const H = source.height
    const r: Result = {
      ...base,
      size: `${W}×${H}`,
      kind: sim.det.kind,
      compressed: isLossy(file.name) || compressionRipple(bitmapToImageData(source.bitmap)) >= COMPRESSED_RIPPLE,
      colours: sim.first.colours,
      segments: sim.first.proxy.segments,
      kb: +(new Blob([sim.first.svg]).size / 1024).toFixed(1),
      upload: { error: +sim.first.proxy.score.toFixed(2), edgeF1: +sim.first.proxy.edgeF1.toFixed(3) },
      font: sim.first.font,
      ms: sim.ms,
    }
    // Downloads, as the app makes them (print and cut files from the non-overlapping plates).
    const plates = await sim.plates()
    const res = sim.first.result
    const names = res.palette ? inkNames({ palette: res.palette, inks: res.inks ?? [], named: res.named }) : new Map<number, string>()
    for (const purpose of ['print', 'web', 'cut'] as const)
      for (const d of downloadsFor(purpose, { svg: sim.first.svg, plateSvg: purpose === 'web' ? undefined : async () => plates, width: W, height: H, baseName: 'logo', names, spotNames: null, flat: r.colours <= 16 }))
        r.exports[`${purpose} ${d.label}`] = await validate(d.label, await d.make()).catch((e) => `error: ${e}`)
    if (original) {
      r.first = await against(original, sim.first.svg, W, H)
      if (/\.svg$/i.test(original.name)) r.gradientsKept = /<(linear|radial)Gradient/.test(await original.text()) ? /<(linear|radial)Gradient/.test(sim.first.svg) : null
      let best: { label: string; error: number } | null = null
      for (const o of sim.options) {
        const a = await against(original, o.svg, W, H)
        if (!best || a.error < best.error) best = { label: o.label, error: a.error }
        if (o === sim.offered) r.offer = { label: o.label, uploadError: +o.proxy.score.toFixed(2), vsOriginal: a }
      }
      r.bestPossible = best && best.error < r.first.error ? best : null
    } else if (sim.offered) r.offer = { label: sim.offered.label, uploadError: +sim.offered.proxy.score.toFixed(2), vsOriginal: null }
    judge(r)
    // Structural checks against the original (or the upload when there is none), and the pictures.
    const k = Math.min(original ? 2 : 1, 1600 / Math.max(W, H))
    const w = Math.max(1, Math.round(W * k))
    const h = Math.max(1, Math.round(H * k))
    const reference = original ? await originalRaster(original, w, h) : await originalRaster(file, w, h)
    const resultImg = await rasterizeSvg(sim.first.svg, w, h)
    const [ref1, res1] = await Promise.all([original ? originalRaster(original, W, H) : originalRaster(file, W, H), rasterizeSvg(sim.first.svg, W, H)])
    r.structure = structureChecks({
      svg: sim.first.svg,
      plateSvg: plates,
      width: W,
      height: H,
      reference,
      result: resultImg,
      against: original ? 'original' : 'upload',
      originalSvg: original && /\.svg$/i.test(original.name) ? await original.text() : null,
      colours: colourFidelity(ref1.data, res1.data, W, H).colours,
    })
    r.flags = structureFlags(r.structure)
    visuals.set(file.name, {
      file: file.name,
      width: W,
      height: H,
      upload: URL.createObjectURL(file),
      first: svgUrl(sim.first.svg),
      offer: sim.offered ? { label: sim.offered.label, src: svgUrl(sim.offered.svg) } : null,
      original: original && original !== file ? URL.createObjectURL(original) : null,
      originalIsVector: !!original && /\.svg$/i.test(original.name),
      boxes: r.structure.boxes,
      focus: r.structure.focus,
    })
    return r
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err), verdict: ['failed'], pass: false, final: 'FAIL' }
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
  const verdict = r.pass === true ? '<b class="up">PASS</b>' : r.pass === false ? '<b class="down">FAIL</b>' : '<b>REVIEW</b>'
  if (r.error) {
    tr.innerHTML = `<td>${verdict}</td><td>${r.file}</td><td colspan="8" class="down">${r.error}</td>`
  } else {
    const f = r.first
    tr.innerHTML = [
      verdict,
      `${r.file}<br><small>${CATEGORIES[r.category] ?? r.category}${r.original ? ` · vs ${r.original}` : ''}</small>`,
      `${r.size}<br><small>${r.kind}${r.compressed ? ' · compressed' : ''}</small>`,
      f ? `${change(f.error, before?.first?.error)}%<br><small>F1 ${f.edgeF1}</small>` : '—',
      f ? `ΔE ${f.meanDE}${f.merged ? ` · <span class="down">${f.merged} merged</span>` : ''}${r.category === 'transparent' ? `<br><small>alpha ${f.alphaFlips}%</small>` : ''}` : '—',
      `${change(r.upload.error, before?.upload.error)}%<br><small>F1 ${r.upload.edgeF1}</small>`,
      r.offer ? `${r.offer.label}<br><small>${r.offer.vsOriginal ? `${f?.error}% → ${r.offer.vsOriginal.error}%` : `upload ${r.upload.error}% → ${r.offer.uploadError}%`}</small>` : r.bestPossible ? `<small>none (best: ${r.bestPossible.label} ${r.bestPossible.error}%)</small>` : '<small>none</small>',
      `${r.colours} / ${change(r.segments, before?.segments)}<br><small>${r.kb} KB${r.font ? ` · ${r.font}` : ''}</small>`,
      Object.entries(r.exports).filter(([, v]) => v !== 'ok').map(([k, v]) => `${k}: ${v}`).join('<br>') || `<small>${Object.keys(r.exports).length} ok</small>`,
      r.verdict.join('<br>'),
    ]
      .map((c) => `<td>${c}</td>`)
      .join('')
  }
  table.append(tr)
  const v = visuals.get(r.file)
  if (!v) return
  // A saved review counts only for the exact same files; a different file with the same name starts fresh.
  const saved = reviews[r.file]
  const review: Review = saved && saved.digest === r.digest ? saved : { checks: {}, notes: '', digest: r.digest }
  const extra = document.createElement('tr')
  const td = document.createElement('td')
  td.colSpan = 10
  td.style.paddingBottom = '18px'
  const head = document.createElement('div')
  const setFinal = () => {
    r.review = review
    r.final = finalVerdict(r.pass, review)
    head.innerHTML = `<b style="font-size:15px" class="${r.final === 'PASS' ? 'up' : r.final === 'FAIL' ? 'down' : ''}">${r.final}</b> ${r.file} <small>(final: automatic + manual review)</small>${r.flags.length ? `<br><span style="color:#b45309">Flags: ${r.flags.join('; ')}</span>` : ''}${r.structure ? `<br><small>nodes ${r.structure.nodes}${r.structure.originalNodes ? ` (original ${r.structure.originalNodes})` : ''} · ${r.structure.nodesPer100px} per 100 px outline · short segments ${Math.round(r.structure.shortSegments * 100)}% · kinked joins ${Math.round(r.structure.kinks * 100)}% · shapes ${r.structure.shapes.result} vs ${r.structure.shapes.reference} in the ${r.structure.against} · cut pieces ${r.structure.cutPieces}, open ${r.structure.openOutlines}${r.font ? ` · font rebuilt: ${r.font}` : ''}</small>` : ''}`
    summarize()
  }
  td.append(head, viewer(v), reviewForm(r.file, review, setFinal))
  extra.append(td)
  table.append(extra)
  setFinal()
}

function summarize() {
  const lines: string[] = []
  const withOriginal = results.filter((r) => r.first)
  const offers = withOriginal.filter((r) => r.offer?.vsOriginal)
  const worse = offers.filter((r) => r.offer!.vsOriginal!.error > r.first!.error + CRITERIA.offerSlack)
  const better = offers.filter((r) => r.offer!.vsOriginal!.error < r.first!.error - 0.1)
  lines.push(`<b>${results.length}</b> logos: <b>${results.filter((r) => r.pass === true).length}</b> pass, <b>${results.filter((r) => r.pass === false).length}</b> fail, ${results.filter((r) => r.pass === null).length} need visual review (no original).`)
  lines.push(`Improver against originals: ${offers.length} offers, <b>${better.length}</b> better, <b class="${worse.length ? 'down' : ''}">${worse.length}</b> worse${worse.length ? ' (release-blocking)' : ''}.`)
  for (const [key, label] of Object.entries(CATEGORIES)) {
    const rs = results.filter((r) => r.category === key)
    if (rs.length) lines.push(`${label}: ${rs.filter((r) => r.pass === true).length}/${rs.length} pass`)
  }
  const exportFails = results.filter((r) => Object.values(r.exports).some((x) => x !== 'ok'))
  if (exportFails.length) lines.push(`<span class="down">Export problems: ${exportFails.map((r) => r.file).join(', ')}</span>`)
  const finals = (v: Verdict) => results.filter((r) => r.final === v).length
  lines.unshift(`<b>Final (with manual review): ${finals('PASS')} PASS, ${finals('REVIEW')} REVIEW, ${finals('FAIL')} FAIL.</b>`)
  summaryEl.innerHTML = lines.join('<br>')
}

async function run(files: File[]) {
  results.length = 0
  table.innerHTML = ''
  for (const v of visuals.values()) for (const u of [v.upload, v.first, v.offer?.src, v.original]) if (u) URL.revokeObjectURL(u)
  visuals.clear()
  const key = (name: string) => name.replace(/\.(truth|original)(?=\.)/i, '').replace(/\.[^.]+$/, '').toLowerCase()
  const groups = new Map<string, File[]>()
  for (const f of files) groups.set(key(f.name), [...(groups.get(key(f.name)) ?? []), f])
  const jobs: [File, File | null, string][] = []
  for (const [k, group] of groups) {
    const category = k.includes('__') ? k.split('__')[0] : 'uncategorised'
    const original = group.find((f) => /\.svg$/i.test(f.name)) ?? group.find((f) => /\.(truth|original)\.png$/i.test(f.name)) ?? null
    const uploads = group.filter((f) => f !== original)
    if (uploads.length) for (const u of uploads) jobs.push([u, original, category])
    else if (original && /\.svg$/i.test(original.name)) jobs.push([original, original, category])
  }
  const before = baseline()
  for (let i = 0; i < jobs.length; i++) {
    status.textContent = `Testing ${i + 1} of ${jobs.length}: ${jobs[i][0].name}`
    const r = await score(...jobs[i])
    results.push(r)
    render(r, before.get(r.file))
    summarize()
  }
  status.textContent = `Done: ${results.length} logos.`
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
function reportRows(): ReportRow[] {
  return results.map((r): ReportRow => {
      // Not tested (it failed to run) is a failure; photos and pixel art are outside this test.
      if (r.error) return { file: r.file, category: r.category, verdict: 'FAIL', auto: false, notes: r.verdict, flags: [], metrics: [], review: undefined, visual: null, blocking: [`could not be tested: ${r.error}`] }
      if (!visuals.has(r.file)) return { file: r.file, category: r.category, verdict: 'REVIEW', auto: null, notes: r.verdict, flags: [], metrics: [], review: undefined, visual: null, blocking: [], excluded: `${r.kind}: not covered by this test` }
      const blocking = Object.entries(r.exports).filter(([, v]) => v !== 'ok').map(([k, v]) => `${k} export ${v}`)
      blocking.push(...r.verdict.filter((x) => x.startsWith('OFFER WORSE')))
      if (r.structure?.openOutlines) blocking.push(`cut file has ${r.structure.openOutlines} open outline(s)`)
      if (r.font && r.review?.checks.lettering === 'fail') blocking.push(`lettering rebuilt as ${r.font} failed review (possible wrong font)`)
      if (r.review?.checks.offer === 'fail') blocking.push('suggested improvement looks worse')
      const metrics: [string, string][] = [['size', r.size], ['colours', `${r.colours}`], ['segments', `${r.segments}`], ['SVG', `${r.kb} KB`], ['vs upload', `${r.upload.error}% / F1 ${r.upload.edgeF1}`]]
      if (r.first) metrics.push(['vs original', `${r.first.error}% / F1 ${r.first.edgeF1}`], ['colour ΔE', `${r.first.meanDE}`])
      if (r.offer) metrics.push(['suggestion', r.offer.label])
      if (r.font) metrics.push(['font rebuilt', r.font])
      return { file: r.file, category: r.category, verdict: r.final, auto: r.pass, notes: r.verdict, flags: r.flags, metrics, review: r.review ?? undefined, visual: visuals.get(r.file)!, blocking }
    })
}
document.getElementById('report')!.addEventListener('click', async () => {
  status.textContent = 'Building report…'
  download('vectorize-acceptance-report.html', await reportHtml(reportRows(), CATEGORIES, { version: 'V7 (v7-assessment)' }), 'text/html')
  status.textContent = `Report saved (${results.length} logos).`
})
document.getElementById('json')!.addEventListener('click', () => download('vectorize-acceptance.json', JSON.stringify(results, null, 2), 'application/json'))
document.getElementById('csv')!.addEventListener('click', () => {
  const head = ['final', 'manual', 'flags', 'verdict', 'file', 'category', 'original', 'size', 'kind', 'compressed', 'colours', 'segments', 'kb', 'upload_error', 'upload_f1', 'orig_error', 'orig_f1', 'orig_de', 'orig_merged', 'orig_alpha_flips', 'offer', 'offer_vs_orig', 'best_possible', 'best_possible_error', 'gradients_kept', 'font', 'exports_failed', 'notes']
  const rows = results.map((r) => [r.final, r.review?.overall ?? '', r.flags.join('; '), r.pass === true ? 'PASS' : r.pass === false ? 'FAIL' : 'REVIEW', r.file, r.category, r.original ?? '', r.size, r.kind, r.compressed, r.colours, r.segments, r.kb, r.upload.error, r.upload.edgeF1, r.first?.error ?? '', r.first?.edgeF1 ?? '', r.first?.meanDE ?? '', r.first?.merged ?? '', r.first?.alphaFlips ?? '', r.offer?.label ?? '', r.offer?.vsOriginal?.error ?? '', r.bestPossible?.label ?? '', r.bestPossible?.error ?? '', r.gradientsKept ?? '', r.font ?? '', Object.entries(r.exports).filter(([, v]) => v !== 'ok').map(([k]) => k).join('; '), [...r.verdict, r.error ?? ''].filter(Boolean).join('; ')])
  download('vectorize-acceptance.csv', [head, ...rows].map((row) => row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n'), 'text/csv')
})
