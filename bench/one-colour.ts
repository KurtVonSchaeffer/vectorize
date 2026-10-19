// One-colour acceptance page (bench only). Each logo is made with the app's own job: the colour
// result and its print / cut plates (reference), the old one-colour behaviour (Maximum colors = 1
// before the fix), the new master (one ink, no gaps), and the new print / cut file with no gap,
// the default gap and the largest gap. Then checked: nothing empty, artwork and every piece of it
// kept, every hole and counter still open, gaps where colours met, and the file checks (open,
// empty, self-crossing, too-thin and too-small pieces) against the colour plates.
import { shapesFromSvg } from '../src/export/path'
import { validateShapes, type ExportCheck } from '../src/export/validate'
import { rasterizeSvg } from '../src/quality/render'
import { DEFAULT_CLIENT, detailBoost, prepFor, traceParamsFor } from '../src/vectorize/client'
import { detectArt, type Detection } from '../src/vectorize/detect'
import { bitmapToImageData, loadImage, type SourceImage } from '../src/vectorize/image'
import { buildTraceJob, runFlat, type OneColourSummary } from '../src/vectorize/pipeline'
import { svgUrl } from './review'

const OUTPUT_MM = 200
/** Separation gaps tested: off, the default, the largest the app offers. */
const GAPS = [0, 0.5, 2]

const svg = (body: string, w = 600, h = 600) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="#FFFFFF"/>${body}</svg>`

interface Case {
  name: string
  tests: string
  /** Boundaries between former colours the print / cut file should separate (at least). */
  minGaps: number
  svg: string
}

/** Made for this test (not customer artwork). */
const CASES: Case[] = [
  { name: 'venn', tests: 'overlapping shapes: three colours touching', minGaps: 2, svg: svg('<circle cx="230" cy="300" r="160" fill="#3A86FF"/><circle cx="370" cy="300" r="160" fill="#FFBE0B"/><path d="M300 158.6A160 160 0 0 1 300 441.4A160 160 0 0 1 300 158.6Z" fill="#2D6A4F"/>') },
  { name: 'star-badge', tests: 'negative space: a white star on a teal badge', minGaps: 0, svg: svg('<rect x="90" y="90" width="420" height="420" rx="70" fill="#0F8A7E"/><path d="M300 150L335.3 251.4L442.7 253.6L357.1 318.6L388.2 421.4L300 360L211.8 421.4L242.9 318.6L157.3 253.6L264.7 251.4Z" fill="#FFFFFF"/>') },
  { name: 'target', tests: 'rings alternating ink and paper', minGaps: 0, svg: svg('<circle cx="300" cy="300" r="240" fill="#222"/><circle cx="300" cy="300" r="170" fill="#FFF"/><circle cx="300" cy="300" r="100" fill="#E63946"/><circle cx="300" cy="300" r="40" fill="#FFF"/>') },
  { name: 'lettering', tests: 'letters with counters, two colours of text on a panel', minGaps: 1, svg: svg('<rect x="40" y="200" width="520" height="200" rx="24" fill="#1B3A8C"/><text x="300" y="335" font-family="Arial, Helvetica, sans-serif" font-weight="700" font-size="120" text-anchor="middle" fill="#FFFFFF">BOAT</text><text x="300" y="140" font-family="Arial, Helvetica, sans-serif" font-weight="700" font-size="90" text-anchor="middle" fill="#E2231A">Ag8 Co</text><rect x="60" y="420" width="480" height="60" fill="#E2231A"/><rect x="40" y="400" width="520" height="20" fill="#F29F05"/>') },
  { name: 'gradient', tests: 'a gradient pill with a flat disc: no gaps inside the gradient', minGaps: 1, svg: svg('<defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#EC4899"/><stop offset="1" stop-color="#581C87"/></linearGradient></defs><rect x="60" y="200" width="480" height="200" rx="100" fill="url(#g)"/><circle cx="300" cy="300" r="70" fill="#2B2D42"/>') },
  { name: 'fine-stripes', tests: 'detailed: thin stripes of other colours inside a shape (gaps must not eat them)', minGaps: 1, svg: svg('<rect x="100" y="100" width="400" height="400" fill="#B3122E"/><rect x="100" y="200" width="400" height="6" fill="#F5C518"/><rect x="100" y="300" width="400" height="4" fill="#0F8A7E"/><rect x="100" y="400" width="400" height="10" fill="#F5C518"/><circle cx="300" cy="150" r="5" fill="#FFFFFF"/>') },
]

interface Run {
  svg: string
  ms: number
  /** Share of the artwork's pixels drawn in ink; of its enclosed paper pixels left open; of the surrounding paper wrongly inked. */
  inkKept: number
  negativeKept: number | null
  spill: number
  /** Holes of the upload (counters, white shapes; at least 9 px) left at least 80% open, of all. */
  holes: { open: number; total: number; isOpen: boolean[]; closed: { x: number; y: number; px: number }[] }
  /** Ink pieces of the master that keep at least half their ink here, of all (at least 9 px). */
  pieces: { kept: number; total: number; lost: { x: number; y: number; px: number }[] }
  oneColour: OneColourSummary | null
  colours: number
}
type File = Run & { gapMm: number; checks: ExportCheck[] }
export interface OneColourRow {
  name: string
  tests: string
  size: string
  kind: string
  /** Line art is one ink on paper already; Maximum colors isn't offered for it. */
  applies: boolean
  colour: Run
  colourPlates: File
  old: Run
  master: Run
  files: File[]
  /** Border seams in the master (not artwork; not checked). */
  seams: number
  /** The default gap without tracing the ink as one piece (the previous version), for comparison. */
  unmerged: File
  results: { test: string; pass: boolean; detail: string }[]
}

const rows: OneColourRow[] = []
;(window as unknown as { __one: OneColourRow[] }).__one = rows
const list = document.getElementById('cases')!
const status = document.getElementById('status')!
const summary = document.getElementById('summary')!

async function pngOf(svgText: string, width: number): Promise<Blob> {
  const img = new Image()
  img.src = svgUrl(svgText)
  await img.decode()
  const c = new OffscreenCanvas(width, width)
  const g = c.getContext('2d')!
  g.drawImage(img, 0, 0, width, width)
  return c.convertToBlob({ type: 'image/png' })
}

interface Make {
  colours: 'auto' | 'old' | 'one'
  /** A print / cut file (knockout plates). */
  file: boolean
  gapMm?: number
  /** Trace a one-colour file's ink as one piece (default, as the app does). */
  merge?: boolean
}
function make(source: SourceImage, det: Detection, m: Make) {
  const client = { ...DEFAULT_CLIENT, maxColors: m.colours === 'auto' ? null : 1 }
  let trace = traceParamsFor(det.kind, client, detailBoost(det, source.width, source.height))
  // Before the fix, Maximum colors = 1 asked the colour step for one colour (background included).
  if (m.colours === 'old') trace = { ...trace, colors: 1 }
  const job = buildTraceJob(source, source.width, {
    trace,
    prep: prepFor(det.kind, client),
    spot: null,
    removeColors: [],
    transparent: det.hasAlpha,
    knockout: m.file,
    exactShapes: true,
    gradients: true,
    oneColour: m.colours === 'one' ? { ink: 0x000000, gapMm: m.gapMm ?? 0, outputWidthMm: OUTPUT_MM } : undefined,
  })
  if (job.kind !== 'flat') return null
  const options = m.merge === false && job.options.oneColour ? { ...job.options, oneColour: { ...job.options.oneColour, production: false } } : job.options
  const t = performance.now()
  const r = runFlat(job.image, options)
  return { r, image: job.image, ms: Math.round(performance.now() - t) }
}
type Made = NonNullable<ReturnType<typeof make>>

/** Pixel classes of the prepared image: paper (near the background or transparent), artwork, and enclosed paper (holes, counters). */
function classes(img: ImageData, paper: number) {
  const { width: w, height: h, data } = img
  const pr = (paper >> 16) & 255, pg = (paper >> 8) & 255, pb = paper & 255
  const isPaper = new Uint8Array(w * h)
  for (let p = 0; p < w * h; p++) {
    const i = p * 4
    isPaper[p] = data[i + 3] < 128 || Math.hypot(data[i] - pr, data[i + 1] - pg, data[i + 2] - pb) < 40 ? 1 : 0
  }
  // Paper reached from the border is the surround; the rest is negative space inside the art.
  const outside = new Uint8Array(w * h)
  const stack: number[] = []
  const push = (p: number) => {
    if (isPaper[p] && !outside[p]) {
      outside[p] = 1
      stack.push(p)
    }
  }
  for (let x = 0; x < w; x++) [push(x), push((h - 1) * w + x)]
  for (let y = 0; y < h; y++) [push(y * w), push(y * w + w - 1)]
  while (stack.length) {
    const p = stack.pop()!
    const x = p % w
    if (x > 0) push(p - 1)
    if (x + 1 < w) push(p + 1)
    if (p >= w) push(p - w)
    if (p + w < w * h) push(p + w)
  }
  const holes = pieces(w, h, (p) => isPaper[p] === 1 && !outside[p]).filter((px) => px.length >= 9)
  return { isPaper, outside, holes }
}

/** Connected pieces (4-connected) of the pixels `take` accepts. */
function pieces(w: number, h: number, take: (p: number) => boolean): number[][] {
  const seen = new Uint8Array(w * h)
  const out: number[][] = []
  for (let s = 0; s < w * h; s++) {
    if (seen[s] || !take(s)) continue
    const px: number[] = []
    const stack = [s]
    seen[s] = 1
    while (stack.length) {
      const p = stack.pop()!
      px.push(p)
      const x = p % w
      for (const q of [x > 0 ? p - 1 : -1, x + 1 < w ? p + 1 : -1, p - w, p + w])
        if (q >= 0 && q < w * h && !seen[q] && take(q)) {
          seen[q] = 1
          stack.push(q)
        }
    }
    out.push(px)
  }
  return out
}

/** Ink per pixel of a rendered SVG: drawn and not the paper colour. */
async function inkOf(svgText: string, w: number, h: number, paper: number): Promise<Uint8Array> {
  const out = await rasterizeSvg(svgText, w, h)
  const pr = (paper >> 16) & 255, pg = (paper >> 8) & 255, pb = paper & 255
  const ink = new Uint8Array(w * h)
  for (let p = 0; p < w * h; p++) {
    const i = p * 4
    ink[p] = out.data[i + 3] >= 128 && Math.hypot(out.data[i] - pr, out.data[i + 1] - pg, out.data[i + 2] - pb) >= 40 ? 1 : 0
  }
  return ink
}

async function measure(m: Made, paper: number, cls: ReturnType<typeof classes>, refPieces: number[][] | null): Promise<Run> {
  const { width: w, height: h } = m.image
  const ink = await inkOf(m.r.svg, w, h, paper)
  let art = 0, artInk = 0, neg = 0, negOpen = 0, sur = 0, surInk = 0
  for (let p = 0; p < w * h; p++) {
    if (!cls.isPaper[p]) [art, artInk] = [art + 1, artInk + ink[p]]
    else if (!cls.outside[p]) [neg, negOpen] = [neg + 1, negOpen + (1 - ink[p])]
    else [sur, surInk] = [sur + 1, surInk + ink[p]]
  }
  const pct = (a: number, b: number) => +((100 * a) / Math.max(1, b)).toFixed(1)
  const share = (px: number[], v: number) => px.filter((p) => ink[p] === v).length / px.length
  const ps = refPieces ?? []
  return {
    svg: m.r.svg,
    ms: m.ms,
    inkKept: pct(artInk, art),
    negativeKept: neg > 50 ? pct(negOpen, neg) : null,
    spill: pct(surInk, sur),
    holes: {
      open: cls.holes.filter((px) => share(px, 0) >= 0.8).length,
      total: cls.holes.length,
      isOpen: cls.holes.map((px) => share(px, 0) >= 0.8),
      closed: cls.holes.filter((px) => share(px, 0) < 0.8).map((px) => ({ x: px[0] % w, y: Math.floor(px[0] / w), px: px.length })),
    },
    pieces: { kept: ps.filter((px) => share(px, 1) >= 0.5).length, total: ps.length, lost: ps.filter((px) => share(px, 1) < 0.5).map((px) => ({ x: px[0] % w, y: Math.floor(px[0] / w), px: px.length })) },
    oneColour: m.r.oneColour,
    colours: m.r.palette.filter((e) => !e.background).length,
  }
}

const checksOf = (m: Made) => validateShapes(shapesFromSvg(m.r.svg), { width: m.image.width, outputWidthMm: OUTPUT_MM })
const count = (f: File, id: ExportCheck['id']) => f.checks.find((k) => k.id === id)?.count ?? 0
/** Pieces a cutter would trip over: broken, self-crossing, too thin or too small. */
const cutProblems = (f: File) => count(f, 'open') + count(f, 'zero-area') + count(f, 'self-intersection') + count(f, 'sliver') + count(f, 'small')

async function runOne(name: string, tests: string, minGaps: number | null, blob: Blob) {
  const source = await loadImage(blob, name)
  const det = detectArt(bitmapToImageData(source.bitmap))
  const colour = make(source, det, { colours: 'auto', file: false })
  if (!colour) {
    list.insertAdjacentHTML('beforeend', `<p>${escapeHtml(name)}: ${det.kind}, not traced as flat art; skipped.</p>`)
    return
  }
  const paper = det.hasAlpha ? 0xffffff : (colour.r.background ?? det.background ?? 0xffffff)
  const cls = classes(colour.image, paper)
  const { width: w, height: h } = colour.image
  const master = make(source, det, { colours: 'one', file: false })!
  const masterInk = await inkOf(master.r.svg, w, h, paper)
  // Strips under 1.5 px wide along the image border are the faint frame V7 traces from some
  // uploads (Phase 1 'seams', fixed on the V8 branch), not artwork: counted, not checked.
  const isSeam = (px: number[]) => {
    const set = new Set(px)
    let rim = 0, border = 0
    for (const p of px) {
      const x = p % w, y = Math.floor(p / w)
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) border++
      for (const q of [p - 1, p + 1, p - w, p + w]) if (!set.has(q)) rim++
    }
    return (2 * px.length) / Math.max(1, rim) < 1.5 && border > 0.5 * px.length
  }
  const seams = pieces(w, h, (p) => masterInk[p] === 1).filter((px) => px.length >= 9 && isSeam(px)).length
  // The pieces of artwork, from the prepared image itself (not the master, so a piece the master
  // dropped is still checked).
  const artPieces = pieces(w, h, (p) => !cls.isPaper[p]).filter((px) => px.length >= 9)
  const file = async (m: Made, gapMm: number): Promise<File> => ({ ...(await measure(m, paper, cls, artPieces)), gapMm, checks: checksOf(m) })
  const row: OneColourRow = {
    name,
    tests,
    size: `${source.width}×${source.height}`,
    kind: det.kind,
    applies: det.kind === 'flat',
    colour: await measure(colour, paper, cls, null),
    colourPlates: await file(make(source, det, { colours: 'auto', file: true })!, 0),
    old: await measure(make(source, det, { colours: 'old', file: false })!, paper, cls, null),
    master: await measure(master, paper, cls, artPieces),
    files: [],
    seams,
    unmerged: await file(make(source, det, { colours: 'one', file: true, gapMm: 0.5, merge: false })!, 0.5),
    results: [],
  }
  for (const g of GAPS) row.files.push(await file(make(source, det, { colours: 'one', file: true, gapMm: g })!, g))
  const t = (test: string, pass: boolean, detail: string) => row.results.push({ test, pass, detail })
  const [off, std, max] = row.files
  if (!row.applies) t('one colour applies', true, 'n/a: line art is one ink on paper already, and Maximum colors is not offered for it; checked for intact lettering only')
  t('not empty', row.master.inkKept > 0 && row.files.every((f) => f.inkKept > 0), `master ${row.master.inkKept}% of the artwork in ink`)
  if (row.applies) t('one ink', row.master.colours === 1 && row.files.every((f) => f.colours === 1), `master ${row.master.colours}, files ${row.files.map((f) => f.colours).join('/')}`)
  t('artwork kept (master ≥ 97%)', row.master.inkKept >= 97 || !row.applies, `${row.master.inkKept}% (colour version ${row.colour.inkKept}%)`)
  t('every hole and counter the colour version keeps is open (master and all files)', [row.master, ...row.files].every((r) => row.colour.holes.isOpen.every((open, i) => !open || r.holes.isOpen[i])), `colour ${row.colour.holes.open}/${row.colour.holes.total}; master ${row.master.holes.open}; files ${row.files.map((f) => f.holes.open).join(', ')}`)
  t('no ink outside the artwork (< 1%)', row.master.spill < 1, `${row.master.spill}%`)
  t('every piece of artwork kept in the master and every file', [row.master, ...row.files].every((f) => f.pieces.kept === f.pieces.total), `master ${row.master.pieces.kept}/${row.master.pieces.total}, ` + row.files.map((f) => `${f.gapMm} mm: ${f.pieces.kept}/${f.pieces.total}`).join(', ') + (seams ? ` (${seams} border seam(s) not counted)` : ''))
  if (row.applies && minGaps !== null) t(`boundaries separated at the default gap (≥ ${minGaps})`, (std.oneColour?.gaps ?? 0) >= minGaps, `${std.oneColour?.gaps ?? 0}`)
  t('master has no gaps', (row.master.oneColour?.gaps ?? 0) === 0, `${row.master.oneColour?.gaps ?? 0}`)
  t('no gaps when the gap is off', (off.oneColour?.gaps ?? 0) === 0, `${off.oneColour?.gaps ?? 0}`)
  const broken = row.files.flatMap((f) => f.checks.filter((k) => k.status === 'fail').map((k) => `${f.gapMm} mm: ${k.message}`))
  t('files have no broken outlines', !broken.length, broken.join(' ') || 'ok')
  t('default gap adds no cutting problems (vs gap off)', cutProblems(std) <= cutProblems(off), `${cutProblems(off)} → ${cutProblems(std)} (largest gap: ${cutProblems(max)})`)
  t('file has no more cutting problems than the colour plates', cutProblems(std) <= cutProblems(row.colourPlates), `colour plates ${cutProblems(row.colourPlates)}, one colour at the default gap ${cutProblems(std)}`)
  rows.push(row)
  render(row, URL.createObjectURL(blob), w)
}

const escapeHtml = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

function render(r: OneColourRow, upload: string, w: number) {
  const marked = (f: File) => f.svg.replace('</svg>', (f.oneColour?.flags ?? []).map((x) => `<circle cx="${x.x}" cy="${x.y}" r="${Math.max(4, w / 40)}" fill="none" stroke="#c0362c" stroke-width="${Math.max(1.5, w / 200)}"/>`).join('') + '</svg>')
  const fig = (src: string, title: string, note: string) => `<figure><img src="${src}"><figcaption><b>${title}</b><br>${note}</figcaption></figure>`
  const run = (x: Run) => `ink ${x.inkKept}% · open ${x.negativeKept ?? '–'}% · holes ${x.holes.open}/${x.holes.total}`
  const cut = (f: File) => f.checks.filter((k) => k.status !== 'ok' && k.id !== 'inks').map((k) => `${k.id} ${k.count}`).join(', ') || 'no file problems'
  list.insertAdjacentHTML(
    'beforeend',
    `<section><h2>${escapeHtml(r.name)} <small>${r.size} · ${r.kind} · ${r.tests}</small></h2><div class="row">${fig(upload, 'Upload', '')}${fig(svgUrl(r.colour.svg), 'Colour (reference)', `${run(r.colour)}<br>plates: ${cut(r.colourPlates)}`)}${fig(svgUrl(r.old.svg), 'Old: Maximum colors = 1', run(r.old))}${fig(svgUrl(r.master.svg), 'New master (no gaps)', run(r.master))}${r.files.map((f) => fig(svgUrl(marked(f)), `Print / cut file, ${f.gapMm ? `${f.gapMm} mm gap` : 'gap off'}`, `${run(f)}<br>gaps ${f.oneColour?.gaps ?? 0} · joined ${f.oneColour?.flags.length ?? 0} (red)<br>${cut(f)}`)).join('')}</div><table>${r.results.map((x) => `<tr><td class="${x.pass ? 'pass' : 'fail'}">${x.pass ? 'PASS' : 'FAIL'}</td><td>${x.test}</td><td>${x.detail}</td></tr>`).join('')}<tr><td>note</td><td>previous file (0.5 mm, ink not one piece)</td><td>${cut(r.unmerged)}</td></tr></table></section>`,
  )
}

function report() {
  const all = rows.flatMap((r) => r.results)
  summary.innerHTML = `<p><b>${all.filter((x) => x.pass).length} of ${all.length} checks pass</b> on ${rows.length} logos (${rows.filter((r) => !r.applies).length} line art, one colour not applicable).</p>`
}

async function runCases() {
  for (const c of CASES) {
    status.textContent = `Running ${c.name}…`
    await runOne(c.name, c.tests, c.minGaps, await pngOf(c.svg, 300))
  }
  report()
  status.textContent = 'Done.'
}

document.getElementById('run')!.addEventListener('click', runCases)
document.getElementById('files')!.addEventListener('change', async (e) => {
  for (const f of (e.target as HTMLInputElement).files ?? []) {
    status.textContent = `Running ${f.name}…`
    // One file that can't be read doesn't stop the others.
    try {
      await runOne(f.name, 'uploaded logo', null, f)
    } catch (err) {
      list.insertAdjacentHTML('beforeend', `<p>${escapeHtml(f.name)}: not run (${escapeHtml(err instanceof Error ? err.message : String(err))}).</p>`)
    }
  }
  report()
  status.textContent = 'Done.'
})
if (new URLSearchParams(location.search).has('auto')) runCases()
