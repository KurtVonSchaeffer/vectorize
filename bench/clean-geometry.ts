// Clean geometry, before and after: each upload's master SVG made at the default settings as today
// and with cleanGeometry, each measured against the upload (assessFidelity), the two renders compared
// with each other, and SVG / PDF / DXF made from each.
//   ?dir=/audit-in/&files=a.png,b.jpg   Results: window.__clean once the status reads "Done".
import { DEMO_PALETTE } from '../src/palette/demo'
import { DEFAULT_INKS } from '../src/palette/quantize'
import { buildDxf } from '../src/export/dxf'
import { flatten, shapesFromSvg } from '../src/export/path'
import { buildPdf } from '../src/export/pdf'
import { assessFidelity } from '../src/quality/fidelity'
import { rasterizeSvg } from '../src/quality/render'
import { DEFAULT_CLIENT, detailBoost, prepFor, traceParamsFor } from '../src/vectorize/client'
import { detectArt } from '../src/vectorize/detect'
import { bitmapToImageData, finalizeSvg, loadImage } from '../src/vectorize/image'
import { buildTraceJob, runFlat } from '../src/vectorize/pipeline'

const MAX_SIDE = 1000

function thumb(img: ImageData): string {
  const c = document.createElement('canvas')
  c.width = img.width
  c.height = img.height
  const g = c.getContext('2d')!
  // Checkerboard, so transparency shows.
  for (let y = 0; y < c.height; y += 8) for (let x = 0; x < c.width; x += 8) (g.fillStyle = (x + y) % 16 ? '#ddd' : '#fff'), g.fillRect(x, y, 8, 8)
  const t = document.createElement('canvas')
  t.width = img.width
  t.height = img.height
  t.getContext('2d')!.putImageData(img, 0, 0)
  g.drawImage(t, 0, 0)
  return c.toDataURL('image/png')
}

/** Mean and worst per-pixel difference (0–255, colour premultiplied by alpha, plus alpha). */
function compare(a: ImageData, b: ImageData) {
  let sum = 0, worst = 0, changed = 0
  for (let i = 0; i < a.data.length; i += 4) {
    let d = Math.abs(a.data[i + 3] - b.data[i + 3])
    for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs((a.data[i + c] * a.data[i + 3]) / 255 - (b.data[i + c] * b.data[i + 3]) / 255))
    sum += d
    worst = Math.max(worst, d)
    if (d > 32) changed++
  }
  const n = a.data.length / 4
  return { mean: +(sum / n).toFixed(3), worst, changedShare: +(changed / n).toFixed(5) }
}

async function measure(blob: Blob, file: string) {
  const source = await loadImage(blob, file)
  const det = detectArt(bitmapToImageData(source.bitmap))
  const k = Math.min(1, MAX_SIDE / Math.max(source.width, source.height))
  const w = Math.max(1, Math.round(source.width * k))
  const h = Math.max(1, Math.round(source.height * k))
  const c = new OffscreenCanvas(w, h)
  const g = c.getContext('2d', { willReadFrequently: true })!
  g.drawImage(source.bitmap, 0, 0, w, h)
  const upload = g.getImageData(0, 0, w, h)
  const row: Record<string, unknown> = { file, kind: det.kind }
  const renders: Record<string, ImageData> = {}
  for (const clean of [false, true]) {
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
      cleanGeometry: clean,
    })
    if (job.kind !== 'flat') {
      row.note = 'photo: traced by VTracer, unaffected'
      return { row, thumbs: null }
    }
    const t0 = performance.now()
    const svg = finalizeSvg(runFlat(job.image, job.options).svg, job.image, source)
    const ms = Math.round(performance.now() - t0)
    const vector = await rasterizeSvg(svg, w, h)
    renders[clean ? 'after' : 'before'] = vector
    const f = assessFidelity(upload, vector, svg, { geometryWidth: source.width })
    const shapes = shapesFromSvg(svg)
    const vb = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/)!
    const pdf = buildPdf(shapes.map((shape) => ({ shape })), { width: +vb[1], height: +vb[2], title: 'x' })
    const dxf = buildDxf(shapes.map((shape) => ({ shape, name: 'C' })), { width: +vb[1], height: +vb[2] })
    if (clean) row.pairs = copiedPairs(svg)
    if (clean) row.copiedWhere = f.issues.find((i) => i.id === 'copied-outlines')?.where ?? []
    row[clean ? "after" : "before"] = {
      paths: (svg.match(/<path\b/g) ?? []).length,
      subpaths: shapes.reduce((t, s) => t + s.subpaths.length, 0),
      bytes: svg.length,
      ms,
      copied: f.geometry.copiedOutlines,
      selfX: f.geometry.selfIntersecting,
      tiny: f.geometry.tiny,
      verdict: f.verdict,
      edgeRecall: +f.edgeRecall.toFixed(4),
      meanError: +f.meanError.toFixed(3),
      lost: f.features.lost,
      changed: f.features.changed,
      pdfBytes: pdf.length,
      pdfOk: new TextDecoder('latin1').decode(pdf.slice(0, 8)).startsWith('%PDF') && new TextDecoder('latin1').decode(pdf.slice(-8)).includes('%%EOF'),
      dxfEntities: (dxf.match(/\nLWPOLYLINE\n|\nPOLYLINE\n|\nSPLINE\n/g) ?? []).length,
      dxfOk: dxf.trimEnd().endsWith('EOF'),
    }
  }
  row.renderDiff = compare(renders.before, renders.after)
  // New transparency: opaque in the upload and before, see-through after (a gap or a lost shape).
  let opened = 0
  const A = renders.after.data, B = renders.before.data, U = upload.data
  for (let i = 3; i < A.length; i += 4) if (U[i] > 250 && B[i] > 250 && A[i] < 200) opened++
  row.newTransparency = opened
  return { row, thumbs: { upload: thumb(upload), before: thumb(renders.before), after: thumb(renders.after) } }
}

/** Diagnostic: outlines (filled rings) that appear in two paths, with both colours and nesting. */
function copiedPairs(svg: string) {
  const shapes = shapesFromSvg(svg)
  const hex = (c: number) => '#' + c.toString(16).padStart(6, '0')
  const rings = shapes.flatMap((s, k) =>
    s.subpaths.map((sp) => {
      const pts = flatten(sp, 0.2)
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1])
      let a = 0
      for (let i = 0; i < pts.length; i++) a += pts[i][0] * pts[(i + 1) % pts.length][1] - pts[(i + 1) % pts.length][0] * pts[i][1]
      return { k, fill: s.gradient ? 'gradient' : hex(s.color), area: Math.abs(a / 2), box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], n: s.subpaths.length }
    }),
  )
  const out: string[] = []
  for (let i = 0; i < rings.length; i++)
    for (let j = i + 1; j < rings.length; j++) {
      const a = rings[i], b = rings[j]
      if (a.k === b.k || a.area < 4) continue
      if (Math.abs(a.area - b.area) <= 0.03 * a.area && a.box.every((v, n) => Math.abs(v - b.box[n]) <= 1))
        out.push(`${a.fill}(path ${a.k}, ${a.n} rings) = ${b.fill}(path ${b.k}, ${b.n} rings) area ${Math.round(a.area)} at ${a.box.map(Math.round).join(',')}`)
    }
  return out
}

const status = document.getElementById('status')!
const out: unknown[] = []
;(window as unknown as { __clean: unknown }).__clean = out
const q = new URLSearchParams(location.search)
;(async () => {
  const files = q.get('files')!.split(',')
  for (const [i, f] of files.entries()) {
    status.textContent = `Measuring ${i + 1} of ${files.length}: ${f}`
    out.push(await measure(await (await fetch(q.get('dir')! + f)).blob(), f))
  }
  status.textContent = 'Done'
})()
