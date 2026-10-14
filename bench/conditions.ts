// Robustness suite: runs many kinds of input through the same functions the app uses (load →
// detect → trace for each purpose → build both downloads) and checks every output is valid.
// Open /bench/conditions.html on the dev server.
import { downloadsFor } from '../src/export/files'
import { colorNames } from '../src/palette/names'
import { DEFAULT_INKS } from '../src/palette/quantize'
import { DEFAULT_CLIENT, detailBoost, prepFor, traceParamsFor, type Purpose } from '../src/vectorize/client'
import { detectArt, type ArtKind } from '../src/vectorize/detect'
import { exampleImage } from '../src/vectorize/example'
import { FlatTracer } from '../src/vectorize/flat-tracer'
import { bitmapToImageData, hasVisiblePixels, loadImage } from '../src/vectorize/image'
import { buildTraceJob, runTraceJob } from '../src/vectorize/pipeline'
import { Tracer } from '../src/vectorize/tracer'
import { DEMO_PALETTE } from '../src/palette/demo'
import type { RasterComparison } from '../src/quality/compare'
import { compareSvg } from '../src/quality/render'

interface Case {
  name: string
  make: () => Promise<{ blob: Blob; filename: string }>
  /** Expected detection, or an error message pattern the loader/pipeline must produce. */
  expect: { kind?: ArtKind; colors?: [number, number]; error?: RegExp; transparent?: boolean; gradients?: number; maxError?: number }
}

const canvas = (w: number, h: number, draw: (g: OffscreenCanvasRenderingContext2D) => void) => {
  const c = new OffscreenCanvas(w, h)
  draw(c.getContext('2d')!)
  return c
}
const blobOf = async (c: OffscreenCanvas, type = 'image/png', quality?: number) => c.convertToBlob({ type, quality })
const file = async (c: OffscreenCanvas, filename: string, type = 'image/png', quality?: number) => ({ blob: await blobOf(c, type, quality), filename })

const logo = (g: OffscreenCanvasRenderingContext2D, w: number, h: number, bg: string | null) => {
  if (bg) {
    g.fillStyle = bg
    g.fillRect(0, 0, w, h)
  }
  const r = Math.min(w, h) * 0.38
  g.fillStyle = '#1c7ed6'
  g.beginPath(); g.arc(w / 2, h / 2, r, 0, 7); g.fill()
  g.fillStyle = '#ffffff'
  g.beginPath(); g.arc(w / 2, h / 2, r * 0.55, 0, 7); g.fill()
  g.fillStyle = '#e8402f'
  g.beginPath(); g.arc(w / 2, h / 2, r * 0.28, 0, 7); g.fill()
}

const pill = (g: OffscreenCanvasRenderingContext2D, x: number, y: number, w: number, h: number) => {
  const r = h / 2
  g.beginPath(); g.arc(x + r, y + r, r, Math.PI / 2, Math.PI * 1.5); g.arc(x + w - r, y + r, r, -Math.PI / 2, Math.PI / 2); g.closePath()
}

const CASES: Case[] = [
  {
    name: 'Gradient logo (JPEG q80)',
    make: () =>
      file(
        canvas(600, 300, (g) => {
          g.fillStyle = '#fff8e7'; g.fillRect(0, 0, 600, 300)
          const gr = g.createLinearGradient(60, 0, 540, 0)
          gr.addColorStop(0, '#ec4899'); gr.addColorStop(1, '#581c87')
          g.fillStyle = gr; pill(g, 60, 70, 480, 160); g.fill()
          g.fillStyle = '#2b2d42'; g.beginPath(); g.arc(160, 150, 52, 0, 7); g.fill()
          g.fillStyle = '#ffffff'; g.font = 'bold 84px Arial'; g.fillText('GLOW', 250, 180)
        }),
        'glow.jpg', 'image/jpeg', 0.8,
      ),
    expect: { kind: 'flat', gradients: 1, colors: [2, 4], maxError: 8 },
  },
  {
    name: 'Radial gradient badge (PNG)',
    make: () =>
      file(
        canvas(400, 400, (g) => {
          g.fillStyle = '#ffffff'; g.fillRect(0, 0, 400, 400)
          const gr = g.createRadialGradient(200, 200, 0, 200, 200, 150)
          gr.addColorStop(0, '#ffd43b'); gr.addColorStop(1, '#e8590c')
          g.fillStyle = gr; g.beginPath(); g.arc(200, 200, 150, 0, 7); g.fill()
          g.fillStyle = '#1c1c3c'; g.beginPath()
          for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + (i * Math.PI) / 5, r = i % 2 ? 26 : 62; g.lineTo(200 + r * Math.cos(a), 200 + r * Math.sin(a)) }
          g.fill()
        }),
        'radial.png',
      ),
    expect: { kind: 'flat', gradients: 1, colors: [2, 3], maxError: 6 },
  },
  {
    name: 'Three-color gradient background (JPEG q85)',
    make: () =>
      file(
        canvas(640, 360, (g) => {
          const gr = g.createLinearGradient(0, 0, 0, 360)
          gr.addColorStop(0, '#1e3a8a'); gr.addColorStop(0.55, '#db2777'); gr.addColorStop(1, '#fbbf24')
          g.fillStyle = gr; g.fillRect(0, 0, 640, 360)
          g.fillStyle = '#ffffff'; g.beginPath(); g.arc(320, 180, 90, 0, 7); g.fill()
        }),
        'sunset.jpg', 'image/jpeg', 0.85,
      ),
    expect: { kind: 'flat', gradients: 1, colors: [1, 2], maxError: 8 },
  },
  { name: 'Example badge (JPEG q75)', make: async () => ({ blob: await exampleImage(), filename: 'badge.jpg' }), expect: { kind: 'flat', colors: [3, 3] } },
  { name: 'Logo on transparent PNG', make: () => file(canvas(500, 500, (g) => logo(g, 500, 500, null)), 'logo.png'), expect: { kind: 'flat', colors: [3, 3], transparent: true } },
  { name: 'Logo, low-quality JPEG (q40)', make: () => file(canvas(400, 300, (g) => logo(g, 400, 300, '#fffdf5')), 'logo.jpg', 'image/jpeg', 0.4), expect: { kind: 'flat', colors: [3, 3] } },
  { name: 'Tiny icon 24×24', make: () => file(canvas(24, 24, (g) => logo(g, 24, 24, '#ffffff')), 'icon.png'), expect: { kind: 'flat', colors: [2, 4] } },
  {
    name: 'Pixel art sprite 16×16',
    make: () =>
      file(
        canvas(16, 16, (g) => {
          const rows = ['....RRRRR.......', '...RRRRRRRRR....', '...BBBSSBS......', '..BSBSSSBSSS....', '..BSBBSSSBSSS...', '..BBSSSSBBBB....', '....SSSSSSS.....', '...RRBRRR.......', '..RRRBRRBRRR....', '.RRRRBBBBRRRR...', '.SSRBYBBYBRSS...', '.SSSBBBBBBSSS...', '.SSBBBBBBBBSS...', '...BBB..BBB.....', '..BBBB..BBBB....', '................']
          const col: Record<string, string> = { R: '#e03131', B: '#7a4a12', S: '#ffc078', Y: '#ffd43b' }
          rows.forEach((r, y) => [...r].forEach((ch, x) => { if (col[ch]) { g.fillStyle = col[ch]; g.fillRect(x, y, 1, 1) } }))
        }),
        'sprite.png',
      ),
    expect: { kind: 'pixel' },
  },
  {
    name: 'Photo-like gradient (JPEG)',
    make: () =>
      file(
        canvas(640, 427, (g) => {
          const gr = g.createLinearGradient(0, 0, 640, 427)
          gr.addColorStop(0, '#1e3c72'); gr.addColorStop(0.5, '#e96443'); gr.addColorStop(1, '#ffd89b')
          g.fillStyle = gr; g.fillRect(0, 0, 640, 427)
          for (let i = 0; i < 60; i++) { g.fillStyle = `hsla(${i * 37},60%,${30 + (i % 5) * 10}%,0.35)`; g.beginPath(); g.arc((i * 97) % 640, (i * 53) % 427, 20 + (i % 7) * 9, 0, 7); g.fill() }
        }),
        'photo.jpg', 'image/jpeg', 0.85,
      ),
    expect: { kind: 'photo' },
  },
  {
    name: 'Pencil sketch scan (gray paper)',
    make: () =>
      file(
        canvas(800, 600, (g) => {
          g.fillStyle = '#ebe8df'; g.fillRect(0, 0, 800, 600)
          for (let i = 0; i < 4000; i++) { g.fillStyle = `rgba(0,0,0,${Math.random() * 0.04})`; g.fillRect(Math.random() * 800, Math.random() * 600, 2, 2) }
          g.strokeStyle = '#2a2a2a'; g.lineCap = 'round'
          g.lineWidth = 6; g.beginPath(); g.moveTo(80, 450); g.bezierCurveTo(200, 100, 400, 100, 500, 350); g.stroke()
          g.lineWidth = 3; g.beginPath(); g.arc(560, 200, 90, 0, 7); g.stroke()
          g.font = 'italic 48px Georgia'; g.fillStyle = '#2a2a2a'; g.fillText('Sketch', 300, 540)
        }),
        'sketch.jpg', 'image/jpeg', 0.8,
      ),
    expect: { kind: 'lineart', colors: [1, 1] },
  },
  { name: 'Single solid color', make: () => file(canvas(300, 200, (g) => { g.fillStyle = '#2e9e4a'; g.fillRect(0, 0, 300, 200) }), 'solid.png'), expect: { colors: [1, 1] } },
  { name: 'Grayscale logo', make: () => file(canvas(400, 400, (g) => { logo(g, 400, 400, '#ffffff'); const d = g.getImageData(0, 0, 400, 400); for (let i = 0; i < d.data.length; i += 4) { const y = 0.3 * d.data[i] + 0.59 * d.data[i + 1] + 0.11 * d.data[i + 2]; d.data[i] = d.data[i + 1] = d.data[i + 2] = y } g.putImageData(d, 0, 0) }), 'gray.png'), expect: { colors: [2, 3] } },
  { name: 'Wide banner 3000×200', make: () => file(canvas(3000, 200, (g) => { g.fillStyle = '#111827'; g.fillRect(0, 0, 3000, 200); g.fillStyle = '#f59e0b'; g.font = 'bold 120px Arial'; g.fillText('WIDE BANNER TEXT', 200, 150) }), 'banner.png'), expect: { kind: 'flat', colors: [2, 2] } },
  { name: 'White logo on transparent', make: () => file(canvas(300, 300, (g) => { g.fillStyle = '#ffffff'; g.beginPath(); g.arc(150, 150, 100, 0, 7); g.fill() }), 'white.png'), expect: { colors: [1, 1], transparent: true } },
  { name: 'Huge image 7000×4600 (gets scaled on load)', make: () => file(canvas(7000, 4600, (g) => logo(g, 7000, 4600, '#ffffff')), 'huge.png'), expect: { kind: 'flat', colors: [3, 3] } },
  {
    name: 'SVG file input',
    make: async () => ({ blob: new Blob(['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 60"><rect width="100" height="60" fill="#fef3c7"/><circle cx="50" cy="30" r="20" fill="#b91c1c"/></svg>'], { type: 'image/svg+xml' }), filename: 'input.svg' }),
    expect: { kind: 'flat', colors: [2, 2] },
  },
  { name: 'Fully transparent PNG', make: () => file(canvas(100, 100, () => {}), 'empty.png'), expect: { error: /completely transparent/ } },
  { name: '1×1 pixel', make: () => file(canvas(1, 1, (g) => { g.fillStyle = '#000'; g.fillRect(0, 0, 1, 1) }), 'dot.png'), expect: { error: /too small/ } },
  { name: 'Corrupt file named .png', make: async () => ({ blob: new Blob([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])], { type: 'image/png' }), filename: 'broken.png' }), expect: { error: /Couldn't read/ } },
  { name: 'iPhone HEIC', make: async () => ({ blob: new Blob([new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 104, 101, 105, 99])], { type: 'image/heic' }), filename: 'IMG_0042.HEIC' }), expect: { error: /HEIC/ } },
]

const PURPOSES: Purpose[] = ['web', 'print', 'cut']
const tracers = { vtracer: new Tracer(), flat: new FlatTracer() }
const out = document.getElementById('rows')!
const summary = { pass: 0, fail: 0 }
;(window as unknown as { __conditions: unknown }).__conditions = { summary, rows: [] as unknown[] }

/** The rendered SVG compared with the source image (both over white). */
async function compareWithSource(svg: string, bitmap: ImageBitmap): Promise<RasterComparison> {
  const { width: w, height: h } = bitmap
  return compareSvg(svg, canvas(w, h, (g) => g.drawImage(bitmap, 0, 0)).getContext('2d')!.getImageData(0, 0, w, h))
}

async function validateDownload(label: string, blob: Blob): Promise<string | null> {
  if (!blob.size) return `${label} is empty`
  if (label === 'SVG') {
    const text = await blob.text()
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml')
    if (doc.querySelector('parsererror')) return 'SVG does not parse'
    const url = URL.createObjectURL(blob)
    try {
      const img = new Image()
      img.src = url
      await img.decode()
    } catch {
      return 'SVG does not render'
    } finally {
      URL.revokeObjectURL(url)
    }
    if (!/<path\b/.test(text)) return 'SVG has no shapes'
  }
  if (label === 'PDF') {
    const t = new TextDecoder('latin1').decode(await blob.arrayBuffer())
    if (!t.startsWith('%PDF-')) return 'PDF header missing'
    const xref = Number(t.match(/startxref\n(\d+)/)?.[1])
    if (t.slice(xref, xref + 4) !== 'xref') return 'PDF xref offset wrong'
    if (!/\nf\*\n/.test(t)) return 'PDF has no fills'
    if (/\/Pattern cs/.test(t) && !/\/ShadingType [23]/.test(t)) return 'PDF gradient has no shading'
  }
  if (label === 'DXF') {
    const t = await blob.text()
    if (!t.includes('AC1009') || !t.trim().endsWith('EOF')) return 'DXF incomplete'
    if (!/\nPOLYLINE\n/.test(t)) return 'DXF has no outlines'
  }
  if (label === 'PNG') {
    const b = new Uint8Array(await blob.slice(0, 8).arrayBuffer())
    if (b[1] !== 0x50 || b[2] !== 0x4e || b[3] !== 0x47) return 'PNG signature wrong'
  }
  return null
}

for (const c of CASES) {
  const row = document.createElement('tr')
  out.append(row)
  const problems: string[] = []
  const notes: string[] = []
  const t0 = performance.now()
  try {
    const { blob, filename } = await c.make()
    let source
    try {
      source = await loadImage(blob, filename)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (c.expect.error?.test(msg)) notes.push(`rejected: “${msg}”`)
      else problems.push(`load failed: ${msg}`)
      throw 'done'
    }
    notes.push(`${source.width}×${source.height}`)
    const det = detectArt(bitmapToImageData(source.bitmap))
    notes.push(det.kind)
    if (c.expect.kind && det.kind !== c.expect.kind) problems.push(`detected ${det.kind}, expected ${c.expect.kind}`)
    const transparent = det.hasAlpha || det.kind === 'lineart'
    if (c.expect.transparent !== undefined && det.hasAlpha !== c.expect.transparent) problems.push(`transparency ${det.hasAlpha}`)

    for (const purpose of PURPOSES) {
      const job = buildTraceJob(source, source.width, {
        trace: traceParamsFor(det.kind, DEFAULT_CLIENT, detailBoost(det, source.width, source.height)),
        prep: prepFor(det.kind, DEFAULT_CLIENT),
        spot: { settings: DEFAULT_INKS, palette: DEMO_PALETTE },
        removeColors: [],
        transparent,
        knockout: purpose !== 'web',
        gradients: true,
      })
      if (!hasVisiblePixels(job.image)) {
        if (c.expect.error?.test('This image is completely transparent')) notes.push('rejected: completely transparent')
        else problems.push('no visible pixels')
        break
      }
      const res = await runTraceJob(tracers, job, source, false)
      if (c.expect.error) problems.push('expected an error but traced fine')
      if (res.paths === 0) problems.push(`${purpose}: no shapes`)
      const colors = res.palette?.length ?? null
      if (purpose === 'web') notes.push(colors != null ? `${colors} colors` : `${res.paths} paths`)
      if (purpose === 'web' && c.expect.gradients !== undefined) {
        notes.push(`${res.gradients.kept} gradients`)
        if (res.gradients.kept !== c.expect.gradients) problems.push(`${res.gradients.kept} gradients kept, expected ${c.expect.gradients}`)
      }
      if (c.expect.gradients !== undefined && res.gradients.kept !== c.expect.gradients) problems.push(`${purpose}: ${res.gradients.kept} gradients kept`)
      if (purpose === 'web' && c.expect.maxError !== undefined) {
        const q = await compareWithSource(res.svg, source.bitmap)
        const err = q.meanError
        notes.push(`error ${err.toFixed(1)}`, `edge F1 ${q.edgeF1.toFixed(2)}`, `${q.missingDetails.length} missing details`)
        if (err > c.expect.maxError) problems.push(`error ${err.toFixed(1)} > ${c.expect.maxError}`)
      }
      if (purpose === 'web' && c.expect.colors && colors != null && (colors < c.expect.colors[0] || colors > c.expect.colors[1])) problems.push(`${colors} colors, expected ${c.expect.colors.join('–')}`)
      const names = new Map((res.palette ?? []).map((p, i) => [p.color, colorNames(res.palette!.map((q) => q.color))[i]]))
      for (const d of downloadsFor(purpose, { svg: res.svg, width: res.width, height: res.height, baseName: 'test', names, spotNames: null, flat: colors != null && colors <= 16 })) {
        const problem = await validateDownload(d.label, await d.make())
        if (problem) problems.push(`${purpose} ${d.label}: ${problem}`)
      }
    }
  } catch (err) {
    if (err !== 'done') problems.push(`crashed: ${err instanceof Error ? err.message : String(err)}`)
  }
  const ok = problems.length === 0
  ok ? summary.pass++ : summary.fail++
  ;(window as unknown as { __conditions: { rows: unknown[] } }).__conditions.rows.push({ name: c.name, ok, notes, problems })
  row.innerHTML = `<td class="${ok ? 'ok' : 'bad'}">${ok ? 'PASS' : 'FAIL'}</td><td>${c.name}</td><td>${notes.join(' · ')}</td><td>${problems.join('<br>')}</td><td>${Math.round(performance.now() - t0)} ms</td>`
}
document.getElementById('status')!.textContent = `Done: ${summary.pass} passed, ${summary.fail} failed`
