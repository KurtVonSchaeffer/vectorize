// V7 assessment: measurements behind the next round of work. No engine changes; each experiment
// runs the app's own pipeline and measures it against ground truth.
//   ?exp=proxy       can quality be judged without ground truth? (needed for automatic retry)
//   ?exp=typo        6–12 px lettering: traced vs rebuilt from the matched font (as the app does)
//   ?exp=lowres      low-resolution artwork with the built-in AI sharpening off / 2× / 4×
//   ?exp=colour      colour cases the V6 rules don't cover
//   ?exp=complexity  where SVG segments go, and how many are redundant
//   ?exp=improver    the background improver as the app runs it: what it offers, and whether that's truly better
// Results: window.__assess (rows) and window.__report() (summary text).
import { Enhancer } from '../src/ai/enhancer'
import { findText, matchFonts } from '../src/fonts/identify'
import { placeLine, type PlacedWord } from '../src/fonts/lettering'
import { deltaE2000, hexToRgb, rgbToLab } from '../src/palette/color'
import { colourFidelity, compareRasters } from '../src/quality/compare'
import { rasterizeSvg } from '../src/quality/render'
import { DEFAULT_CLIENT, detailBoost, prepFor, traceParamsFor, type ClientSettings } from '../src/vectorize/client'
import { detectArt, type Detection } from '../src/vectorize/detect'
import { bitmapToImageData, loadImage, type InputImage, type SourceImage } from '../src/vectorize/image'
import { compressionRipple, COMPRESSED_RIPPLE, isLossy, type Scored } from '../src/vectorize/improve'
import { buildTraceJob, runTraceJob } from '../src/vectorize/pipeline'
import { Tracer } from '../src/vectorize/tracer'
import { CASES, fidelity, input, inkShare, summary, svg, VALIDATION, type Case } from './cases'
import { simulateImprover } from './improver-sim'

const q = new URLSearchParams(location.search)
const exp = q.get('exp') ?? 'proxy'
const FORMATS: (number | null)[] = (q.get('formats') ?? 'png,0.75,0.4').split(',').map((f) => (f === 'png' ? null : Number(f)))
const only = q.get('cases')?.split(',')
const tracer = new Tracer()
const rows: Record<string, unknown>[] = []
;(window as unknown as { __assess: unknown }).__assess = rows
const status = document.getElementById('status')!
const table = document.getElementById('table')!
const fmt = (jpeg: number | null) => (jpeg === null ? 'png' : `q${jpeg}`)

interface Traced {
  svg: string
  det: Detection
  /** The raster the tracer received (working size). */
  image: ImageData
  palette: number[]
  segments: number
  ms: number
}

/** Traces like the app: automatic kind and detail boosts, on-screen (stacked) shapes. */
async function trace(source: SourceImage, client: ClientSettings, opts: { image?: InputImage; lettering?: PlacedWord[] } = {}): Promise<Traced> {
  const det = detectArt(bitmapToImageData(source.bitmap))
  const job = buildTraceJob(opts.image ?? source, source.width, {
    trace: traceParamsFor(det.kind, client, detailBoost(det, source.width, source.height)),
    prep: prepFor(det.kind, client),
    spot: null,
    removeColors: [],
    transparent: det.hasAlpha,
    knockout: false,
    exactShapes: client.exactShapes,
    gradients: client.gradients,
    lettering: opts.lettering,
  })
  const t0 = performance.now()
  const res = await runTraceJob({ vtracer: tracer, flat: null }, job, source, false)
  return { svg: res.svg, det, image: job.image, palette: res.palette?.map((p) => p.color) ?? [], segments: (res.svg.match(/[CLQ]/g) ?? []).length, ms: Math.round(performance.now() - t0) }
}

/** Ground-truth scores: ink missing / added at 4× (½ px tolerance), edge F1, colour fidelity. */
async function truthScore(c: Case, out: string) {
  const W = c.w
  const H = c.h
  const [t4, v4, t1, v1] = await Promise.all([rasterizeSvg(c.svg, W * 4, H * 4), rasterizeSvg(out, W * 4, H * 4), rasterizeSvg(c.svg, W, H), rasterizeSvg(out, W, H)])
  const s = summary(compareRasters(t4.data, v4.data, W * 4, H * 4, { tolerance: 2 }), t4)
  return { miss: s.missingInk, extra: s.extraInk, f1: s.edgeF1, ...fidelity(colourFidelity(t1.data, v1.data, W, H)) }
}

/** Scores against the uploaded raster only, as the app could compute them for any upload. */
async function proxyScore(image: ImageData, out: string) {
  const v = await rasterizeSvg(out, image.width, image.height)
  const r = compareRasters(image.data, v.data, image.width, image.height, { tolerance: 1 })
  const ink = inkShare(image, r)
  return { wrong: +(r.tolerantWrongShare * 100).toFixed(3), f1: +r.edgeF1.toFixed(3), miss: ink.missingInk, extra: ink.extraInk }
}

const load = async (c: Case, jpeg: number | null) => loadImage(await input(c, jpeg), `${c.name}.${jpeg === null ? 'png' : 'jpg'}`)
const show = (cells: (string | number)[]) => {
  const tr = document.createElement('tr')
  tr.innerHTML = cells.map((v) => `<td>${v}</td>`).join('')
  table.append(tr)
}

// ---------- proxy: does an upload-only score rank settings the way ground truth does? ----------
async function proxyExperiment() {
  const details = [0.25, 0.5, 0.75]
  for (const c of CASES) {
    if (only && !only.includes(c.group)) continue
    for (const jpeg of FORMATS) {
      if (c.pngOnly && jpeg !== null) continue
      const source = await load(c, jpeg)
      for (const detail of details) {
        const t = await trace(source, { ...DEFAULT_CLIENT, purpose: 'web', detail })
        const truth = await truthScore(c, t.svg)
        const proxy = await proxyScore(t.image, t.svg)
        rows.push({ exp: 'proxy', group: c.group, name: c.name, format: fmt(jpeg), detail, truth, proxy, segments: t.segments })
        show([c.name, fmt(jpeg), detail, `${truth.miss}+${truth.extra}`, `${proxy.wrong}% · ${proxy.miss}+${proxy.extra} · F1 ${proxy.f1}`, t.segments])
      }
    }
  }
}

// ---------- typo: traced vs rebuilt from the matched font ----------
async function typoExperiment() {
  const textCases = CASES.filter((c) => c.group === 'text' && /(6|8|10|12)px/.test(c.name))
  for (const c of textCases) {
    for (const jpeg of FORMATS.filter((f) => f !== 0.4)) {
      const source = await load(c, jpeg)
      const client = { ...DEFAULT_CLIENT, purpose: 'web' as const }
      const traced = await trace(source, client)
      const base = await truthScore(c, traced.svg)
      // As the app's Fonts panel does automatically: read the text, match fonts, rebuild lines
      // whose best match scores at least 0.8.
      let ocr = ''
      let best = ''
      let score = 0
      let placed: PlacedWord[] = []
      let forced: PlacedWord[] = []
      try {
        const report = await findText(source.bitmap, traced.palette)
        const lines = await matchFonts(report, [])
        ocr = lines.map((l) => l.text).join(' / ')
        for (const line of lines) {
          const m = line.matches[0]
          if (!m) continue
          best = m.label
          score = +m.score.toFixed(2)
          const l = await placeLine(report, line, m)
          if (m.score >= 0.8) placed.push(...l.words)
          forced.push(...l.words)
        }
      } catch (err) {
        ocr = `error: ${err instanceof Error ? err.message : String(err)}`
      }
      const auto = placed.length ? await truthScore(c, (await trace(source, client, { lettering: placed })).svg) : null
      const anyTrace = forced.length ? await trace(source, client, { lettering: forced }) : null
      const any = anyTrace ? await truthScore(c, anyTrace.svg) : null
      // Could an upload-only score tell whether the rebuild is better than the traced letters?
      const proxy = { traced: await proxyScore(traced.image, traced.svg), rebuilt: anyTrace ? await proxyScore(anyTrace.image, anyTrace.svg) : null }
      rows.push({ exp: 'typo', name: c.name, format: fmt(jpeg), ocr, best, score, words: { auto: placed.length, any: forced.length }, traced: base, rebuilt: auto, rebuiltAnyScore: any, proxy })
      show([c.name, fmt(jpeg), `“${ocr}”`, `${best} ${score}`, `${base.miss}+${base.extra}`, auto ? `${auto.miss}+${auto.extra}` : '—', any ? `${any.miss}+${any.extra}` : '—'])
      placed = []
      forced = []
    }
  }
}

// ---------- lowres: AI sharpening before tracing ----------
async function lowresExperiment() {
  const enhancer = new Enhancer()
  const pick = CASES.filter((c) => /badge (120|200)px|sans 8px|serif 8px|sans 6px/.test(c.name))
  for (const c of pick) {
    for (const jpeg of FORMATS.filter((f) => f !== 0.4)) {
      const source = await load(c, jpeg)
      const client = { ...DEFAULT_CLIENT, purpose: 'web' as const }
      const result: Record<string, unknown> = {}
      for (const setting of ['off', '2x', '4x'] as const) {
        let image: InputImage | undefined
        let aiMs = 0
        if (setting !== 'off') {
          const t0 = performance.now()
          const up = await enhancer.upscale(`${c.name}|${fmt(jpeg)}`, bitmapToImageData(source.bitmap), setting)
          aiMs = Math.round(performance.now() - t0)
          if (!up) {
            result[setting] = 'too large'
            continue
          }
          image = { url: '', width: up.width, height: up.height, bitmap: await createImageBitmap(up) }
        }
        const t = await trace(source, client, { image })
        result[setting] = { ...(await truthScore(c, t.svg)), segments: t.segments, aiMs, traceMs: t.ms }
      }
      rows.push({ exp: 'lowres', name: c.name, format: fmt(jpeg), ...result })
      const cell = (r: unknown) => (typeof r === 'object' && r ? `${(r as { miss: number }).miss}+${(r as { extra: number }).extra} (${(r as { segments: number }).segments} seg)` : String(r))
      show([c.name, fmt(jpeg), cell(result.off), cell(result['2x']), cell(result['4x'])])
    }
  }
  enhancer.dispose()
}

// ---------- colour: cases V6 doesn't cover ----------
const de = (a: string, b: string) => +deltaE2000(rgbToLab(hexToRgb(a)!), rgbToLab(hexToRgb(b)!)).toFixed(1)
const COLOUR_CASES: (Case & { pairs: [string, string][] })[] = [
  {
    group: 'colour',
    name: 'tints not touching',
    svg: svg(400, 120, `<rect x="20" y="20" width="70" height="80" fill="#1c7ed6"/><rect x="110" y="20" width="70" height="80" fill="#2a86d9"/><rect x="210" y="20" width="70" height="80" fill="#e8402f"/><rect x="300" y="20" width="70" height="80" fill="#f0603f"/>`),
    w: 400,
    h: 120,
    pairs: [['#1c7ed6', '#2a86d9'], ['#e8402f', '#f0603f']],
  },
  {
    group: 'colour',
    name: 'adjacent tints dE 3-5',
    svg: svg(400, 120, `<rect x="20" y="20" width="80" height="80" fill="#2f6fb5"/><rect x="100" y="20" width="80" height="80" fill="#3a78bb"/><rect x="200" y="20" width="80" height="80" fill="#3d8b3d"/><rect x="280" y="20" width="80" height="80" fill="#4a974a"/>`),
    w: 400,
    h: 120,
    pairs: [['#2f6fb5', '#3a78bb'], ['#3d8b3d', '#4a974a']],
  },
  {
    group: 'colour',
    name: 'two-tint logo with text',
    svg: svg(360, 160, `<circle cx="80" cy="80" r="60" fill="#1c7ed6"/><circle cx="80" cy="80" r="34" fill="#4dabf7"/><text x="160" y="92" font-family="Arial" font-weight="700" font-size="34" fill="#1864ab">Tidal</text>`),
    w: 360,
    h: 160,
    pairs: [['#1c7ed6', '#1864ab'], ['#1c7ed6', '#4dabf7']],
  },
  {
    group: 'colour',
    name: 'flat tint beside gradient',
    svg: svg(420, 160, `<defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#ffd43b"/><stop offset="1" stop-color="#f76707"/></linearGradient></defs><rect x="20" y="30" width="260" height="100" rx="20" fill="url(#g)"/><rect x="300" y="30" width="100" height="100" rx="20" fill="#e8590c"/>`),
    w: 420,
    h: 160,
    pairs: [['#f76707', '#e8590c']],
  },
]

async function colourExperiment() {
  for (const c of COLOUR_CASES) {
    for (const jpeg of FORMATS) {
      const source = await load(c, jpeg)
      const t = await trace(source, { ...DEFAULT_CLIENT, purpose: 'web' })
      const s = await truthScore(c, t.svg)
      const pairs = c.pairs.map(([a, b]) => `${a}/${b} ΔE ${de(a, b)}`).join(', ')
      rows.push({ exp: 'colour', name: c.name, format: fmt(jpeg), pairs, ...s, colours: t.palette.length, segments: t.segments })
      show([c.name, fmt(jpeg), pairs, `merged ${s.merged}`, `ΔE ${s.meanDE}/${s.maxDE}`, `${t.palette.length} colours`, `${s.miss}+${s.extra}`])
    }
  }
}

// ---------- complexity: where segments go ----------
/** Path statistics: segments, and those that add nodes without changing the shape visibly. */
function analyse(out: string) {
  let lines = 0, curves = 0, tiny = 0, collinear = 0, flatCurves = 0, coordChars = 0
  for (const m of out.matchAll(/\sd="([^"]+)"/g)) {
    const d = m[1]
    coordChars += (d.match(/[-\d.]/g) ?? []).length
    for (const sub of d.split('M').slice(1)) {
      const tokens = sub.match(/[LC]|-?[\d.]+/g) ?? []
      let i = 0
      const num = () => Number(tokens[i++])
      let p: [number, number] = [num(), num()]
      let prevDir: [number, number] | null = null
      while (i < tokens.length) {
        const cmd = tokens[i++]
        if (cmd === 'L') {
          const q2: [number, number] = [num(), num()]
          const dx = q2[0] - p[0], dy = q2[1] - p[1]
          const len = Math.hypot(dx, dy)
          lines++
          if (len < 0.5) tiny++
          const dir: [number, number] = len ? [dx / len, dy / len] : [0, 0]
          if (prevDir && dir[0] * prevDir[0] + dir[1] * prevDir[1] > Math.cos((2 * Math.PI) / 180)) collinear++
          prevDir = dir
          p = q2
        } else if (cmd === 'C') {
          const c1: [number, number] = [num(), num()], c2: [number, number] = [num(), num()], q2: [number, number] = [num(), num()]
          curves++
          const len = Math.hypot(q2[0] - p[0], q2[1] - p[1])
          if (len < 0.5) tiny++
          // Controls on the chord: drawable as a straight line.
          const off = (c: [number, number]) => (len ? Math.abs((q2[0] - p[0]) * (p[1] - c[1]) - (p[0] - c[0]) * (q2[1] - p[1])) / len : Math.hypot(c[0] - p[0], c[1] - p[1]))
          if (Math.max(off(c1), off(c2)) < 0.1) flatCurves++
          prevDir = null
          p = q2
        } else i++
      }
    }
  }
  return { segments: lines + curves, lines, curves, tiny, collinear, flatCurves, coordChars, kb: +(new Blob([out]).size / 1024).toFixed(1) }
}

async function complexityExperiment() {
  for (const c of CASES) {
    if (only && !only.includes(c.group)) continue
    for (const jpeg of FORMATS) {
      if (c.pngOnly && jpeg !== null) continue
      const source = await load(c, jpeg)
      const t = await trace(source, { ...DEFAULT_CLIENT, purpose: 'web' })
      const a = analyse(t.svg)
      const s = await truthScore(c, t.svg)
      rows.push({ exp: 'complexity', group: c.group, name: c.name, format: fmt(jpeg), ...a, miss: s.miss, extra: s.extra, ms: t.ms })
      show([c.name, fmt(jpeg), a.segments, `${a.curves}C ${a.lines}L`, `tiny ${a.tiny}`, `collinear ${a.collinear}`, `flat curves ${a.flatCurves}`, `${a.kb} KB`, `${s.miss}+${s.extra}`, `${t.ms} ms`])
    }
  }
}

// ---------- summary ----------
/** Spearman rank correlation. */
function spearman(a: number[], b: number[]): number {
  const rank = (v: number[]) => {
    const order = v.map((x, i) => [x, i]).sort((p, q2) => p[0] - q2[0])
    const r = new Array(v.length)
    order.forEach(([, i], k) => (r[i] = k))
    return r as number[]
  }
  const ra = rank(a), rb = rank(b)
  const n = a.length
  const d2 = ra.reduce((s, r, i) => s + (r - rb[i]) ** 2, 0)
  return n > 1 ? 1 - (6 * d2) / (n * (n * n - 1)) : 1
}

;(window as unknown as { __report: () => string }).__report = () => {
  const lines: string[] = []
  const proxy = rows.filter((r) => r.exp === 'proxy') as { name: string; format: string; detail: number; truth: { miss: number; extra: number }; proxy: { wrong: number; f1: number; miss: number; extra: number } }[]
  if (proxy.length) {
    const truthOf = (r: (typeof proxy)[number]) => r.truth.miss + r.truth.extra
    const metrics: [string, (r: (typeof proxy)[number]) => number][] = [
      ['wrong %', (r) => r.proxy.wrong],
      ['missing+extra vs upload', (r) => r.proxy.miss + r.proxy.extra],
      ['1 − edge F1', (r) => 1 - r.proxy.f1],
    ]
    // Across all runs, and within each image (what a retry has to get right: pick the better candidate).
    for (const [label, f] of metrics) lines.push(`proxy ${label}: Spearman vs truth over all runs ${spearman(proxy.map(f), proxy.map(truthOf)).toFixed(2)}`)
    const groups = new Map<string, typeof proxy>()
    for (const r of proxy) groups.set(`${r.name} ${r.format}`, [...(groups.get(`${r.name} ${r.format}`) ?? []), r])
    for (const [label, f] of metrics) {
      let chosen = 0, def = 0, oracle = 0, agree = 0, n = 0
      for (const g of groups.values()) {
        const best = [...g].sort((a, b) => f(a) - f(b))[0]
        const ideal = [...g].sort((a, b) => truthOf(a) - truthOf(b))[0]
        const dflt = g.find((r) => r.detail === 0.5)!
        chosen += truthOf(best)
        def += truthOf(dflt)
        oracle += truthOf(ideal)
        if (truthOf(best) <= truthOf(ideal) + 0.05) agree++
        n++
      }
      lines.push(`retry by ${label}: mean truth error default ${(def / n).toFixed(2)}, chosen ${(chosen / n).toFixed(2)}, best possible ${(oracle / n).toFixed(2)}; picks the best (±0.05) in ${agree}/${n}`)
    }
  }
  for (const r of rows.filter((x) => x.exp !== 'proxy')) lines.push(JSON.stringify(r))
  return lines.join('\n')
}

status.textContent = `Running ${exp}…`
// ---------- improver: validate the background improvement rules ----------
interface Option {
  label: string
  proxy: Scored
  truth: { miss: number; extra: number }
  ok: boolean
  /** A lettering rebuild (judged with LETTERING_RATIO in the app). */
  lettering?: boolean
}

async function improverExperiment() {
  const enhancer = new Enhancer()
  for (const c of [...CASES, ...VALIDATION]) {
    if (only && !only.includes(c.group)) continue
    for (const jpeg of FORMATS) {
      if (c.pngOnly && jpeg !== null) continue
      // "jpeg saved as png": JPEG pixels in a file named .png.
      let blob = await input(c, c.name === 'jpeg saved as png' ? (jpeg ?? 0.6) : jpeg)
      const name = `${c.name}.${jpeg === null || c.name === 'jpeg saved as png' ? 'png' : 'jpg'}`
      if (c.name === 'jpeg saved as png') {
        const bmp = await createImageBitmap(blob)
        const cv = new OffscreenCanvas(bmp.width, bmp.height)
        cv.getContext('2d')!.drawImage(bmp, 0, 0)
        blob = await cv.convertToBlob({ type: 'image/png' })
      }
      const source = await loadImage(blob, name)
      const sim = await simulateImprover(source, enhancer, tracer)
      if (!sim) continue
      const firstTruth = await truthScore(c, sim.first.svg)
      const compressed = isLossy(name) || compressionRipple(bitmapToImageData(source.bitmap)) >= COMPRESSED_RIPPLE
      const options: Option[] = []
      for (const o of sim.options) {
        const t = await truthScore(c, o.svg)
        options.push({ label: o.label, proxy: o.proxy, truth: { miss: t.miss, extra: t.extra }, ok: o.ok, lettering: o.lettering })
      }
      const ms = sim.ms
      const offered = options.find((o) => o.label === sim.offered?.label) ?? null
      rows.push({ exp: 'improver', group: c.group, name: c.name, format: fmt(jpeg), compressed, first: { proxy: sim.first.proxy, truth: { miss: firstTruth.miss, extra: firstTruth.extra } }, options, offered: offered?.label ?? null, ms })
      const t = (x: { miss: number; extra: number }) => (x.miss + x.extra).toFixed(2)
      show([c.name, fmt(jpeg), compressed ? 'compressed' : '', `first ${t(firstTruth)}`, offered ? `offers ${offered.label}: ${t(offered.truth)}` : 'no offer', options.map((o) => `${o.label} ${o.proxy.score.toFixed(2)}→${t(o.truth)}${o.ok ? '✓' : ''}`).join('; '), `${ms} ms`])
    }
  }
  enhancer.dispose()
}

type ImproverRow = { name: string; format: string; compressed: boolean; first: { proxy: Scored; truth: { miss: number; extra: number } }; options: Option[] }
/** Outcome of a decision rule over the recorded options: offers that are truly better / worse. */
;(window as unknown as { __rule: (ratio: number, minGain: number, guard?: boolean) => string }).__rule = (ratio, minGain, guard = true) => {
  const tr = (x: { miss: number; extra: number }) => x.miss + x.extra
  let offers = 0, better = 0, worse = 0, gain = 0, possible = 0
  const bad: string[] = []
  for (const r of rows.filter((x) => x.exp === 'improver') as unknown as ImproverRow[]) {
    const f = r.first
    const ok = r.options.filter((o) => {
      if (o.proxy.score > f.proxy.score * ratio || f.proxy.score - o.proxy.score < minGain) return false
      if (guard && r.compressed && (o.proxy.segments > f.proxy.segments * 2 || o.proxy.colours > f.proxy.colours || o.proxy.edgeF1 < f.proxy.edgeF1 - 0.01)) return false
      return true
    })
    const best = r.options.reduce((m, o) => Math.min(m, tr(o.truth)), tr(f.truth))
    possible += tr(f.truth) - best
    const pick = ok.sort((a, b) => a.proxy.score - b.proxy.score)[0]
    if (!pick) continue
    offers++
    const d = tr(pick.truth) - tr(f.truth)
    gain -= d
    if (d < -0.1) better++
    else if (d > 0.1) {
      worse++
      bad.push(`${r.name} ${r.format}: ${pick.label} ${tr(f.truth).toFixed(2)}→${tr(pick.truth).toFixed(2)}`)
    }
  }
  return `ratio ${ratio} minGain ${minGain}${guard ? '' : ' (no JPEG guard)'}: ${offers} offers, ${better} truly better, ${worse} worse; total truth gain ${gain.toFixed(1)} of ${possible.toFixed(1)} possible${bad.length ? `\n  worse: ${bad.join('; ')}` : ''}`
}

/**
 * The shipped offer rule (guards on every image), with a separate ratio for lettering rebuilds:
 * offers that are truly better / no better / worse against the original, and genuine improvements
 * missed (an option at least `realGain` points better than the first result, but not offered).
 */
;(window as unknown as { __letteringRule: (ratio: number, realGain?: number) => string }).__letteringRule = (ratio, realGain = 1) => {
  const tr = (x: { miss: number; extra: number }) => x.miss + x.extra
  let offers = 0, better = 0, neutral = 0, worse = 0, missed = 0, gain = 0
  const bad: string[] = []
  const miss: string[] = []
  for (const r of rows.filter((x) => x.exp === 'improver') as unknown as ImproverRow[]) {
    const f = r.first
    const ok = r.options.filter((o) => {
      const limit = o.lettering ? ratio : 0.5
      return o.proxy.score <= f.proxy.score * limit && f.proxy.score - o.proxy.score >= 0.3 && o.proxy.segments <= f.proxy.segments * 2 && o.proxy.colours <= f.proxy.colours && o.proxy.edgeF1 >= f.proxy.edgeF1 - 0.01
    })
    const pick = ok.sort((a, b) => a.proxy.score - b.proxy.score)[0]
    const bestOpt = r.options.reduce((m: Option | null, o) => (!m || tr(o.truth) < tr(m.truth) ? o : m), null)
    if (pick) {
      offers++
      const d = tr(pick.truth) - tr(f.truth)
      gain -= d
      if (d < -0.1) better++
      else if (d > 0.1) {
        worse++
        bad.push(`${r.name} ${r.format}: ${pick.label} ${tr(f.truth).toFixed(2)}→${tr(pick.truth).toFixed(2)}`)
      } else neutral++
    } else if (bestOpt && tr(f.truth) - tr(bestOpt.truth) >= realGain) {
      missed++
      miss.push(`${r.name} ${r.format}: ${bestOpt.label.slice(0, 40)} ${tr(f.truth).toFixed(2)}→${tr(bestOpt.truth).toFixed(2)} (ratio ${(bestOpt.proxy.score / f.proxy.score).toFixed(2)})`)
    }
  }
  return `lettering ratio ${ratio}: ${offers} offers (${better} better, ${neutral} no better, ${worse} worse), gain ${gain.toFixed(1)}; ${missed} genuine improvements (≥${realGain}) not offered${bad.length ? `\n  worse: ${bad.join('; ')}` : ''}${miss.length ? `\n  missed: ${miss.join('; ')}` : ''}`
}

const experiments: Record<string, () => Promise<void>> = { proxy: proxyExperiment, typo: typoExperiment, lowres: lowresExperiment, colour: colourExperiment, complexity: complexityExperiment, improver: improverExperiment }
await experiments[exp]()
status.textContent = 'Done'
