// Reconstruction benchmark: V7 against the experimental V8 redraw on identical damaged uploads of
// artwork with clean original SVGs, judged for production suitability, not pixel error alone:
// geometry (evaluator), path validity, cut-path suitability, export integrity, lettering, colour,
// curve quality, node count and time.
//
// Three columns, so the comparison is fair:
//   V7 app    the app's first result (production `main`): AI sharpening and lettering included
//   V7 trace  V7's tracer on the same colour map V8 starts from (no AI, no lettering)
//   V8        the redraw from that colour map (`v8-reconstruction`)
// "V7 trace" against "V8" isolates what V8's reconstruction adds; "V7 app" is what customers get.
//
// Setup (read-only git worktrees, never committed):
//   git worktree add --detach node_modules/.cache/compare-main origin/main
//   git worktree add --detach node_modules/.cache/compare-v8 origin/v8-reconstruction
// Reproducibility: every upload and each engine's source files are fingerprinted (SHA-256) in the
// JSON export, which also holds every SVG, so results can be checked independently. The uploads
// are generated deterministically; V7 trace and V8 are deterministic; V7 app's AI sharpening and
// OCR can vary slightly between runs.
//   ?fast   skip the V7 app column (no AI): about 10× quicker
// No third-party vectorizer output is used anywhere.
import { CASES, VALIDATION } from './cases'

const MAIN = '/node_modules/.cache/compare-main'
const V8 = '/node_modules/.cache/compare-v8'
const FAST = new URLSearchParams(location.search).has('fast')

type Check = { id: string; status: string; count: number }

interface Version {
  ms: number
  svg: string
  /** Detail missing + added vs original at 4× (2 px tolerance), %; edge agreement; mean colour ΔE. */
  error: number
  edgeF1: number
  meanDE: number
  /** V8's evaluator: regions, edges, corners, halos, shades, bulges, topology (flat originals only). */
  quality: { pass: boolean; defects: number; kinds: Record<string, number>; worstIou: number; edgeP95: number; corners: string } | null
  paths: number
  segments: number
  /** Share of segments that are straight lines; for V8 see primitiveShare (arcs are written as cubics). */
  lineShare: number
  /** Share of curve-to-curve joins with a 15–60° bend (lumps). */
  kinks: number
  /** The drawing's own outlines: open, zero-area, self-intersecting. */
  geometry: Record<string, number>
  /** The cut geometry at 200 mm wide (V7: its non-overlapping plates; V8: its planar output). */
  cut: Record<string, number>
  cutReady: boolean
  /** SVG, print PDF and cut DXF as the app makes them, each validated. */
  exports: Record<string, string>
  /** OCR on the rendered result: truth words found, and words that aren't in the artwork. */
  textFound: number | null
  textWrong: string[]
}

interface Row {
  case: string
  category: string
  damage: string
  upload: string
  uploadSha: string
  truthWords: number
  ocrOnOriginal: number | null
  v7app: Version | null
  v7trace: Version | null
  v8: (Version & { primitiveShare: number; interpreted: number }) | null
  error?: string
}

const rows: Row[] = []
const meta: { started: string; fast: boolean; engines: Record<string, string> } = { started: new Date().toISOString(), fast: FAST, engines: {} }
;(window as unknown as { __bench: Row[]; __benchMeta: unknown }).__bench = rows
;(window as unknown as { __benchMeta: unknown }).__benchMeta = meta
const status = document.getElementById('status')!
const out = document.getElementById('out')!

const sha256 = async (data: BufferSource | string) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? new TextEncoder().encode(data) : data))].map((b) => b.toString(16).padStart(2, '0')).join('')

/** Download validation: SVG parses and renders, PDF is complete with fills, DXF has outlines. */
async function validFile(label: string, blob: Blob): Promise<string> {
  if (!blob.size) return 'empty'
  const text = await blob.text()
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
  return 'ok'
}

type Case = { name: string; category: string; svg: string }

async function cases(): Promise<Case[]> {
  const { REDRAW_CASES } = await import(/* @vite-ignore */ `${V8}/bench/redraw/cases.ts`)
  const geometric = (REDRAW_CASES as { name: string; tests: string; svg: string }[]).map((c) => ({
    name: c.name,
    category: /symmetry|regular|equal/.test(c.tests) ? 'geometric · symmetrical' : /overlap/.test(c.tests) ? 'overlapping shapes' : 'geometric',
    svg: c.svg,
  }))
  let samples: Case[] = []
  try {
    const s = (await (await fetch('/node_modules/.cache/samples.json')).json()) as Record<string, string>
    // Fictional sample logos, if present locally (the origin-unverified barron wordmark is left out).
    samples = ['kestrel', 'summit', 'bloom'].filter((k) => s[k]).map((k) => ({ name: `sample ${k}`, category: k === 'bloom' ? 'overlapping shapes' : 'simple flat logo', svg: s[k] }))
  } catch {
    // Samples are optional.
  }
  const pick = (name: string) => [...CASES, ...VALIDATION].find((c) => c.name === name)
  const fromCases: [string, string][] = [
    ['scene', 'complex multicolour'],
    ['similar colours side by side', 'similar colours'],
    ['gradient pill with text', 'gradient · lettering'],
    ['small gradient logo', 'gradient · lettering'],
    ['wordmark with tiny tagline', 'thin lettering · tagline'],
    ['badge 200px wide', 'complex multicolour · lettering'],
  ]
  const textCase = [...CASES].find((c) => c.group === 'text' && /12px/.test(c.name))
  const curved = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600" width="600" height="600"><rect width="600" height="600" fill="#ffffff"/>${body}</svg>`
  return [
    ...geometric,
    ...samples,
    ...fromCases.flatMap(([n, cat]) => (pick(n) ? [{ name: n, category: cat, svg: pick(n)!.svg }] : [])),
    ...(textCase ? [{ name: textCase.name, category: 'lettering', svg: textCase.svg }] : []),
    {
      name: 'bird (flat, curved)',
      category: 'curved illustration',
      svg: curved(
        '<path d="M110 360C140 250 250 200 330 250C380 170 470 120 540 110C490 190 450 270 380 330C320 390 220 420 110 360Z" fill="#E4572E"/>' +
          '<path d="M330 250C380 170 470 120 540 110C500 160 450 200 400 230Z" fill="#F3A712"/>' +
          '<path d="M150 380C210 350 280 360 330 390C280 450 200 460 150 380Z" fill="#29335C"/>' +
          '<circle cx="190" cy="320" r="12" fill="#29335C"/>',
      ),
    },
    {
      name: 'bird (gradient)',
      category: 'curved illustration · gradient',
      svg: curved(
        '<defs><linearGradient id="a" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f7a541"/><stop offset=".5" stop-color="#e2245f"/><stop offset="1" stop-color="#5b2bd6"/></linearGradient></defs>' +
          '<path d="M110 360C140 250 250 200 330 250C380 170 470 120 540 110C490 190 450 270 380 330C320 390 220 420 110 360Z" fill="url(#a)"/>' +
          '<path d="M150 380C210 350 280 360 330 390C280 450 200 460 150 380Z" fill="#1e3fae"/>',
      ),
    },
  ]
}

const DAMAGE: { label: string; width: number; quality: number | null }[] = [
  { label: 'clean 240 px PNG', width: 240, quality: null },
  { label: 'light 160 px JPEG 0.55', width: 160, quality: 0.55 },
  { label: 'heavy 64 px JPEG 0.30', width: 64, quality: 0.3 },
]

/** An upload from a clean SVG: shrunk to `width`, lightly blurred, and saved as JPEG (or PNG). */
async function damage(svg: string, width: number, quality: number | null): Promise<Blob> {
  const m = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/)!
  const h = Math.max(1, Math.round((width * Number(m[2])) / Number(m[1])))
  const img = new Image()
  img.src = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
  await img.decode()
  const c = new OffscreenCanvas(width, h)
  const g = c.getContext('2d')!
  g.fillStyle = '#fff'
  g.fillRect(0, 0, width, h)
  if (quality !== null) g.filter = 'blur(0.6px)'
  g.imageSmoothingQuality = 'high'
  g.drawImage(img, 0, 0, width, h)
  return c.convertToBlob(quality === null ? { type: 'image/png' } : { type: 'image/jpeg', quality })
}

const truthWordsOf = (svg: string) => [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].flatMap((m) => m[1].split(/[\s·]+/)).filter((w) => w.replace(/[^\p{L}\p{N}]/gu, '').length >= 2)
const alnum = (t: string) => t.replace(/[^\p{L}\p{N}]/gu, '').toUpperCase()

async function run() {
  status.textContent = 'Loading the engines…'
  const [simM, trM, enM, rd, ev, va, path, cmp, rnd, cl, dt, im, pp, id, files] = await Promise.all([
    import(/* @vite-ignore */ `${MAIN}/bench/improver-sim.ts`),
    import(/* @vite-ignore */ `${MAIN}/src/vectorize/tracer.ts`),
    import(/* @vite-ignore */ `${MAIN}/src/ai/enhancer.ts`),
    import(/* @vite-ignore */ `${V8}/bench/redraw/engine.ts`),
    import(/* @vite-ignore */ `${V8}/bench/redraw/evaluate.ts`),
    import(/* @vite-ignore */ `${V8}/src/export/validate.ts`),
    import(/* @vite-ignore */ `${V8}/src/export/path.ts`),
    import('../src/quality/compare'),
    import('../src/quality/render'),
    import(/* @vite-ignore */ `${V8}/src/vectorize/client.ts`),
    import(/* @vite-ignore */ `${V8}/src/vectorize/detect.ts`),
    import(/* @vite-ignore */ `${V8}/src/vectorize/image.ts`),
    import(/* @vite-ignore */ `${V8}/src/vectorize/pipeline.ts`),
    import('../src/fonts/identify'),
    import(/* @vite-ignore */ `${V8}/src/export/files.ts`),
  ])
  // Fingerprint the engine sources actually loaded, to tie results to exact code.
  for (const [k, f] of Object.entries({ 'main pipeline': `${MAIN}/src/vectorize/pipeline.ts`, 'main quantize': `${MAIN}/src/palette/quantize.ts`, 'main trace': `${MAIN}/src/trace/index.ts`, 'v8 engine': `${V8}/bench/redraw/engine.ts`, 'v8 pipeline': `${V8}/src/vectorize/pipeline.ts`, 'v8 trace': `${V8}/src/trace/index.ts`, 'v8 evaluate': `${V8}/bench/redraw/evaluate.ts` }))
    meta.engines[k] = (await sha256(await (await fetch(`${f}?raw`)).text())).slice(0, 16)
  const tracer = new trM.Tracer()
  const enhancer = FAST ? null : new enM.Enhancer()

  const curveStats = (svg: string) => {
    let segments = 0, lines = 0, joins = 0, kinks = 0, paths = 0
    for (const s of path.shapesFromSvg(svg))
      for (const sp of s.subpaths) {
        paths++
        segments += sp.segs.length
        let prev = sp.start
        let lastT: [number, number] | null = null
        for (const g of sp.segs) {
          if (g.t === 'L') lines++
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
    return { paths, segments, lineShare: segments ? +(lines / segments).toFixed(2) : 0, kinks: joins ? +(kinks / joins).toFixed(3) : 0 }
  }
  const checks = (svg: string, width: number, plates: boolean) => {
    const all = va.validateShapes(path.shapesFromSvg(svg), { width, outputWidthMm: 200, plates }) as Check[]
    return Object.fromEntries(all.filter((k) => k.status !== 'ok' && k.id !== 'inks').map((k) => [k.id, k.count])) as Record<string, number>
  }

  const ocrWords = async (svg: string, w: number, h: number): Promise<string[]> => {
    const img = await rnd.rasterizeSvg(svg, w, h)
    const c = new OffscreenCanvas(w, h)
    c.getContext('2d')!.putImageData(img, 0, 0)
    const report = await id.findText(await createImageBitmap(c), [])
    return report.lines.flatMap((l: { text: string }) => l.text.split(/\s+/))
  }

  /** Every production measure for one result. `cutSvg`: the geometry a cut file is made from. */
  const score = async (c: Case, svg: string, cutSvg: string, uploadW: number, uploadH: number, truth: string[], names: Map<number, string>): Promise<Omit<Version, 'ms'>> => {
    const W = uploadW * 4, H = uploadH * 4
    const [o, r] = await Promise.all([rnd.rasterizeSvg(c.svg, W, H), rnd.rasterizeSvg(svg, W, H)])
    const cr = cmp.compareRasters(o.data, r.data, W, H, { tolerance: 2 })
    const ink = cmp.inkChange(o.data, cr)
    let quality: Version['quality'] = null
    if (!/Gradient/.test(c.svg)) {
      try {
        const m = c.svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/)!
        const ow = Math.round(Number(m[1])), oh = Math.round(Number(m[2]))
        const q = await ev.evaluate(c.svg, svg, ow, oh, { scale: ow / uploadW })
        const kinds: Record<string, number> = {}
        for (const d of q.defects) kinds[d.kind] = (kinds[d.kind] ?? 0) + 1
        quality = { pass: q.pass, defects: q.defects.length, kinds, worstIou: q.regions.length ? +Math.min(...q.regions.map((x: { iou: number }) => x.iou)).toFixed(2) : 1, edgeP95: q.edges.p95, corners: `${q.corners.kept}/${q.corners.total}` }
      } catch {
        quality = null
      }
    }
    const geometry = checks(svg, uploadW, false)
    delete geometry['sliver']
    delete geometry['small']
    const cut = checks(cutSvg, uploadW, true)
    const cutReady = !cut['open'] && !cut['zero-area'] && !cut['self-intersection'] && !cut['plate-overlap'] && !cut['sliver']
    const exports: Record<string, string> = {}
    for (const purpose of ['web', 'print', 'cut'] as const)
      for (const d of files.downloadsFor(purpose, { svg, plateSvg: purpose === 'web' ? undefined : async () => cutSvg, width: uploadW, height: uploadH, baseName: 'logo', names, spotNames: null, flat: true }))
        if (d.label !== 'PNG') exports[`${purpose} ${d.label}`] = await validFile(d.label, await d.make()).catch((e) => `error: ${e}`)
    let textFound: number | null = null
    let textWrong: string[] = []
    if (truth.length) {
      const words = await ocrWords(svg, W, H)
      const truthSet = new Set(truth.map(alnum))
      textFound = truth.filter((t) => words.some((w) => alnum(w) === alnum(t))).length
      textWrong = words.filter((w) => alnum(w).length >= 2 && !truthSet.has(alnum(w)))
    }
    return {
      svg,
      error: +((ink.missing + ink.extra) * 100).toFixed(2),
      edgeF1: +cr.edgeF1.toFixed(3),
      meanDE: +cmp.colourFidelity(o.data, r.data, W, H).meanDeltaE.toFixed(2),
      quality,
      ...curveStats(svg),
      geometry,
      cut,
      cutReady,
      exports,
      textFound,
      textWrong,
    }
  }

  const list = await cases()
  const jobs = list.flatMap((c) => DAMAGE.map((d) => ({ c, d })))
  for (const [n, { c, d }] of jobs.entries()) {
    status.textContent = `${n + 1} of ${jobs.length}: ${c.name} · ${d.label}`
    const truth = truthWordsOf(c.svg)
    const row: Row = { case: c.name, category: c.category, damage: d.label, upload: '', uploadSha: '', truthWords: truth.length, ocrOnOriginal: null, v7app: null, v7trace: null, v8: null }
    try {
      const blob = await damage(c.svg, d.width, d.quality)
      row.uploadSha = (await sha256(await blob.arrayBuffer())).slice(0, 16)
      const source = await im.loadImage(blob, `${c.name}.${d.quality === null ? 'png' : 'jpg'}`)
      const W = source.width, H = source.height
      row.upload = `${W}×${H}`
      if (truth.length) {
        const words = await ocrWords(c.svg, W * 4, H * 4)
        row.ocrOnOriginal = truth.filter((t) => words.some((w) => alnum(w) === alnum(t))).length
      }
      const det = dt.detectArt(im.bitmapToImageData(source.bitmap))
      if (det.kind !== 'flat' && det.kind !== 'lineart') throw new Error(`classified as ${det.kind}: neither engine reconstructs it`)
      const settings = (knockout: boolean) => ({ trace: cl.traceParamsFor(det.kind, cl.DEFAULT_CLIENT, cl.detailBoost(det, W, H)), prep: cl.prepFor(det.kind, cl.DEFAULT_CLIENT), spot: null, removeColors: [], transparent: det.hasAlpha || det.kind === 'lineart', knockout, exactShapes: true, gradients: true })
      // V7 app: the app's first result (production main), lettering and AI included.
      if (!FAST) {
        const t7 = performance.now()
        const sim = await simM.simulateImprover(source, enhancer, tracer)
        const ms7 = Math.round(performance.now() - t7)
        if (sim) {
          const res = sim.first.result
          const names = res.palette ? pp.inkNames({ palette: res.palette, inks: res.inks ?? [], named: res.named }) : new Map<number, string>()
          row.v7app = { ms: ms7, ...(await score(c, sim.first.svg, await sim.plates(), W, H, truth, names)) }
        }
      }
      // V7 trace and V8: both from the same colour map.
      const job = pp.buildTraceJob(source, W, settings(false))
      if (job.kind !== 'flat') throw new Error('not traced as flat colour')
      let map = null
      const t0 = performance.now()
      const traced = pp.runFlat(job.image, job.options, (m: unknown) => (map = m))
      const msTrace = Math.round(performance.now() - t0)
      const plates = pp.runFlat(job.image, pp.buildTraceJob(source, W, settings(true)).options)
      const traceNames = new Map<number, string>()
      row.v7trace = { ms: msTrace, ...(await score(c, traced.svg, plates.svg, W, H, truth, traceNames)) }
      if (map) {
        const t8 = performance.now()
        const res = rd.redraw(job.image, map, rd.DEFAULT_REDRAW)
        const ms8 = Math.round(performance.now() - t8) + msTrace
        // V8's map is planar (no overlaps): its own output is its cut geometry.
        row.v8 = { ms: ms8, ...(await score(c, res.svg, res.svg, W, H, truth, traceNames)), primitiveShare: res.stats.primitiveShare, interpreted: res.interpreted.length }
      }
    } catch (err) {
      row.error = err instanceof Error ? err.message : String(err)
    }
    rows.push(row)
    render()
  }
  enhancer?.dispose()
  status.textContent = `Done: ${rows.length} runs.`
}

type Col = 'v7app' | 'v7trace' | 'v8'
const COLS: [Col, string][] = [
  ['v7app', 'V7 app'],
  ['v7trace', 'V7 trace'],
  ['v8', 'V8'],
]

function render() {
  const cols = COLS.filter(([k]) => rows.some((r) => r[k]))
  const ok = rows.filter((r) => cols.every(([k]) => r[k]))
  const groups = (key: 'damage' | 'category') => [...new Set(ok.map((r) => r[key]))]
  const fmt = (sel: Row[], f: (v: Version) => number, digits = 1) => cols.map(([k]) => (sel.length ? (sel.reduce((s, r) => s + f(r[k]!), 0) / sel.length).toFixed(digits) : '–')).join(' / ')
  const count = (sel: Row[], f: (v: Version) => boolean) => cols.map(([k]) => sel.filter((r) => f(r[k]!)).length).join(' / ')
  const line = (sel: Row[], label: string) => {
    const judged = sel.filter((r) => cols.every(([k]) => r[k]!.quality)).length
    return `<tr><td>${label}</td><td>${sel.length}</td><td>${count(sel, (v) => !!v.quality?.pass)} <small>of ${judged}</small></td><td>${fmt(sel, (v) => v.quality?.defects ?? 0)}</td><td>${fmt(sel, (v) => v.quality?.kinds.corner ?? 0)}</td><td>${count(sel, (v) => !Object.keys(v.geometry).length)}</td><td>${count(sel, (v) => v.cutReady)}</td><td>${count(sel, (v) => Object.values(v.exports).every((x) => x === 'ok'))}</td><td>${fmt(sel, (v) => v.meanDE, 2)}</td><td>${fmt(sel, (v) => v.kinks * 100)}</td><td>${fmt(sel, (v) => v.segments, 0)}</td><td>${fmt(sel, (v) => v.error, 2)}</td><td>${fmt(sel, (v) => v.ms, 0)}</td></tr>`
  }
  const textRows = ok.filter((r) => r.truthWords)
  const text = textRows.length
    ? `<p><b>Lettering</b> (words OCR finds in each result; on the original at the same size: ${textRows.reduce((s, r) => s + (r.ocrOnOriginal ?? 0), 0)} of ${textRows.reduce((s, r) => s + r.truthWords, 0)}): ${cols.map(([k, l]) => `${l} ${textRows.reduce((s, r) => s + (r[k]!.textFound ?? 0), 0)}, wrong words ${textRows.reduce((s, r) => s + r[k]!.textWrong.length, 0)}`).join(' · ')}</p>`
    : ''
  out.innerHTML = `<p>Columns: <b>${cols.map(([, l]) => l).join(' / ')}</b>. Engines: <code>${Object.entries(meta.engines).map(([k, v]) => `${k} ${v}`).join(', ')}</code></p>
<table><thead><tr><th>group</th><th>runs</th><th>evaluator pass</th><th>defects</th><th>corner defects</th><th>valid geometry</th><th>cut-ready</th><th>exports valid</th><th>colour ΔE</th><th>kinked joins %</th><th>segments</th><th>pixel error %</th><th>ms</th></tr></thead><tbody>
${line(ok, '<b>all</b>')}
${groups('damage').map((d) => line(ok.filter((r) => r.damage === d), d)).join('')}
${groups('category').map((c) => line(ok.filter((r) => r.category === c), c)).join('')}
</tbody></table>${text}<p><small>${rows.filter((r) => r.error).map((r) => `${r.case} · ${r.damage}: ${r.error}`).join('<br>')}</small></p>`
}

document.getElementById('json')!.addEventListener('click', () => {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([JSON.stringify({ meta, rows }, null, 2)], { type: 'application/json' }))
  a.download = 'vectorize-reconstruction-benchmark.json'
  a.click()
})

void run()
