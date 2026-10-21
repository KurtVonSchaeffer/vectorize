// Reconstruction before and after, measured against each upload (never against an earlier vector):
// the master SVG at the default settings with the settings in `a` and in `b` (comma-separated
// JobSettings flags, e.g. b=fineDetail), each measured with assessFidelity plus edge and path
// measures: anchors, roughness, error when zoomed in, crossings and tiny pieces.
//   ?dir=/audit-in/&files=a.png,b.jpg&a=&b=fineDetail   Results: window.__compare once "Done".
import { deltaE2000, rgbToLab } from '../src/palette/color'
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
import { buildTraceJob, runFlat, type JobSettings } from '../src/vectorize/pipeline'

const MAX_SIDE = 1000
const q = new URLSearchParams(location.search)
const flags = (s: string | null) => Object.fromEntries((s ?? '').split(',').filter(Boolean).map((f) => [f, true])) as Partial<JobSettings>

function thumb(img: ImageData): string {
  const c = document.createElement('canvas')
  c.width = img.width
  c.height = img.height
  const g = c.getContext('2d')!
  for (let y = 0; y < c.height; y += 8) for (let x = 0; x < c.width; x += 8) (g.fillStyle = (x + y) % 16 ? '#ddd' : '#fff'), g.fillRect(x, y, 8, 8)
  const t = document.createElement('canvas')
  t.width = img.width
  t.height = img.height
  t.getContext('2d')!.putImageData(img, 0, 0)
  g.drawImage(t, 0, 0)
  return c.toDataURL('image/png')
}

/** The upload drawn at `scale`, smoothly (what a viewer sees zooming into the original). */
function uploadAt(bitmap: ImageBitmap, w: number, h: number): ImageData {
  const c = new OffscreenCanvas(w, h)
  const g = c.getContext('2d', { willReadFrequently: true })!
  g.imageSmoothingQuality = 'high'
  g.drawImage(bitmap, 0, 0, w, h)
  return g.getImageData(0, 0, w, h)
}

/** Mean per-pixel difference (premultiplied colour and alpha, 0–255). */
function meanDiff(a: ImageData, b: ImageData): number {
  let s = 0
  for (let i = 0; i < a.data.length; i += 4) {
    let d = Math.abs(a.data[i + 3] - b.data[i + 3])
    for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs((a.data[i + c] * a.data[i + 3]) / 255 - (b.data[i + c] * b.data[i + 3]) / 255))
    s += d
  }
  return +(s / (a.data.length / 4)).toFixed(3)
}

/**
 * Path measures. Anchors: segment end points. Roughness: turning beyond what a clean closed
 * outline needs (one full turn), in degrees per 100 px of outline: wiggles and jagged steps add it.
 */
function pathStats(svg: string) {
  const shapes = shapesFromSvg(svg)
  let anchors = 0
  let extra = 0
  let length = 0
  for (const s of shapes)
    for (const sp of s.subpaths) {
      anchors += sp.segs.length
      // Repeated points (a closed outline's last point is its first) have no direction.
      const pts = flatten(sp, 0.05).filter((p, i, all) => {
        const q = all[(i + 1) % all.length]
        return all.length < 2 || Math.hypot(q[0] - p[0], q[1] - p[1]) > 1e-9
      })
      if (pts.length < 3) continue
      let total = 0
      let net = 0
      for (let i = 0; i < pts.length; i++) {
        const a = pts[(i - 1 + pts.length) % pts.length], b = pts[i], c = pts[(i + 1) % pts.length]
        const a1 = Math.atan2(b[1] - a[1], b[0] - a[0])
        const a2 = Math.atan2(c[1] - b[1], c[0] - b[0])
        let d = a2 - a1
        while (d > Math.PI) d -= 2 * Math.PI
        while (d < -Math.PI) d += 2 * Math.PI
        total += Math.abs(d)
        net += d
        length += Math.hypot(c[0] - b[0], c[1] - b[1])
      }
      extra += Math.max(0, total - Math.abs(net))
    }
  return { anchors, roughness: length ? +(((extra * 180) / Math.PI / length) * 100).toFixed(1) : 0 }
}

/**
 * Colour against the upload (both over white), in CIEDE2000: the mean over every pixel; the mean
 * over detail pixels (an upload pixel at least DETAIL_DE from the median colour of its 5×5
 * neighbourhood: thin lines, lettering, small marks, edges); and faded pixels, detail pixels the
 * vector paints in the surrounding colour instead (more than FADED_DE from the upload, within
 * SURROUND_DE of the neighbourhood's median).
 */
function colourStats(upload: ImageData, vector: ImageData) {
  const { width: w, height: h } = upload
  const over = (d: Uint8ClampedArray, i: number): [number, number, number] => {
    const a = d[i + 3] / 255
    return [d[i] * a + 255 * (1 - a), d[i + 1] * a + 255 * (1 - a), d[i + 2] * a + 255 * (1 - a)]
  }
  const U = new Array<[number, number, number]>(w * h)
  for (let p = 0; p < w * h; p++) U[p] = over(upload.data, p * 4)
  const labCache = new Map<number, ReturnType<typeof rgbToLab>>()
  const lab = (c: [number, number, number]) => {
    const key = (Math.round(c[0]) << 16) | (Math.round(c[1]) << 8) | Math.round(c[2])
    let v = labCache.get(key)
    if (!v) labCache.set(key, (v = rgbToLab([Math.round(c[0]), Math.round(c[1]), Math.round(c[2])])))
    return v
  }
  let all = 0, detail = 0, nDetail = 0, faded = 0
  const fadedAt = new Uint8Array(w * h)
  const ch: number[][] = [[], [], []]
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = y * w + x
      const u = U[p]
      const v = over(vector.data, p * 4)
      const de = deltaE2000(lab(u), lab(v))
      all += de
      for (const c of ch) c.length = 0
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const q = Math.min(h - 1, Math.max(0, y + dy)) * w + Math.min(w - 1, Math.max(0, x + dx))
          for (let k = 0; k < 3; k++) ch[k].push(U[q][k])
        }
      const med = ch.map((c) => c.sort((a, b) => a - b)[12]) as [number, number, number]
      if (deltaE2000(lab(u), lab(med)) < DETAIL_DE) continue
      nDetail++
      detail += de
      if (de > FADED_DE && deltaE2000(lab(v), lab(med)) < SURROUND_DE) faded++, (fadedAt[p] = 1)
    }
  return { colourDE: +(all / (w * h)).toFixed(3), detailDE: +(nDetail ? detail / nDetail : 0).toFixed(3), detailPx: nDetail, fadedPx: faded, fadedWhere: regions(fadedAt, w, h) }
}
/** Boxes around groups of marked pixels (within 3 px of each other), largest first, at most 8. */
function regions(mask: Uint8Array, w: number, h: number) {
  const seen = new Uint8Array(w * h)
  const out: { x: number; y: number; w: number; h: number; n: number }[] = []
  for (let s = 0; s < w * h; s++) {
    if (!mask[s] || seen[s]) continue
    const stack = [s]
    seen[s] = 1
    let x0 = w, y0 = h, x1 = 0, y1 = 0, n = 0
    while (stack.length) {
      const p = stack.pop()!
      const x = p % w, y = (p / w) | 0
      n++
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y)
      for (let dy = -3; dy <= 3; dy++)
        for (let dx = -3; dx <= 3; dx++) {
          const xx = x + dx, yy = y + dy
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue
          const q = yy * w + xx
          if (mask[q] && !seen[q]) (seen[q] = 1), stack.push(q)
        }
    }
    out.push({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, n })
  }
  return out.sort((a, b) => b.n - a.n).slice(0, 8)
}
const DETAIL_DE = 12
const FADED_DE = 20
const SURROUND_DE = 10

async function measure(blob: Blob, file: string) {
  const source = await loadImage(blob, file)
  const det = detectArt(bitmapToImageData(source.bitmap))
  const k = Math.min(1, MAX_SIDE / Math.max(source.width, source.height))
  const w = Math.max(1, Math.round(source.width * k))
  const h = Math.max(1, Math.round(source.height * k))
  const upload = uploadAt(source.bitmap, w, h)
  const row: Record<string, unknown> = { file, kind: det.kind }
  const renders: Record<string, ImageData> = {}
  for (const side of ['a', 'b'] as const) {
    const job = buildTraceJob(source, source.width, {
      trace: traceParamsFor(det.kind, DEFAULT_CLIENT, detailBoost(det, source.width, source.height)),
      prep: prepFor(det.kind, DEFAULT_CLIENT),
      spot: { settings: DEFAULT_INKS, palette: DEMO_PALETTE },
      removeColors: [],
      transparent: det.hasAlpha || det.kind === 'lineart',
      // ?knockout=1: the print plates and cut files (knockout) instead of the master.
      knockout: q.get('knockout') === '1',
      keepBlends: DEFAULT_CLIENT.keepBlends,
      exactShapes: DEFAULT_CLIENT.exactShapes,
      gradients: DEFAULT_CLIENT.gradients,
      brand: undefined,
      ...flags(q.get(side)),
    })
    if (job.kind !== 'flat') {
      row.note = 'photo: traced by VTracer, unaffected'
      return { row, thumbs: null }
    }
    // Diagnostics: ?aq= / ?bt= (JSON) patch the colour reduction / tracer options of one side.
    const patch = (k: string) => (q.get(k) ? JSON.parse(q.get(k)!) : {})
    const options = { ...job.options, quantize: { ...job.options.quantize, ...patch(side + 'q') }, trace: { ...job.options.trace, ...patch(side + 't') } }
    const t0 = performance.now()
    const svg = finalizeSvg(runFlat(job.image, options).svg, job.image, source)
    const ms = Math.round(performance.now() - t0)
    const vector = await rasterizeSvg(svg, w, h)
    renders[side] = vector
    const f = assessFidelity(upload, vector, svg, { geometryWidth: source.width })
    // Zoomed in: the vector drawn larger against the upload drawn larger (on uploads up to 400 px).
    const zoom: Record<string, number> = {}
    for (const z of [2, 4]) if (Math.max(w, h) * z <= 1600) zoom[`x${z}`] = meanDiff(uploadAt(source.bitmap, w * z, h * z), await rasterizeSvg(svg, w * z, h * z))
    const shapes = shapesFromSvg(svg)
    const vb = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/)!
    const pdf = buildPdf(shapes.map((shape) => ({ shape })), { width: +vb[1], height: +vb[2], title: 'x' })
    const dxf = buildDxf(shapes.map((shape) => ({ shape, name: 'C' })), { width: +vb[1], height: +vb[2] })
    if (q.get('keep')) row[side + 'Svg'] = svg
    row[side] = {
      paths: (svg.match(/<path\b/g) ?? []).length,
      ...pathStats(svg),
      bytes: svg.length,
      ms,
      colours: [...new Set(shapes.filter((s) => !s.gradient).map((s) => s.color))].length,
      copied: f.geometry.copiedOutlines,
      selfX: f.geometry.selfIntersecting,
      tiny: f.geometry.tiny,
      verdict: f.verdict,
      edgeRecall: +f.edgeRecall.toFixed(4),
      edgePrecision: +f.edgePrecision.toFixed(4),
      meanError: +f.meanError.toFixed(3),
      fine: f.features.fine,
      lost: f.features.lost,
      lostArea: +f.features.lostArea.toFixed(4),
      changed: f.features.changed,
      zoom,
      ...colourStats(upload, vector),
      exportsOk: new TextDecoder('latin1').decode(pdf.slice(0, 5)) === '%PDF-' && dxf.trimEnd().endsWith('EOF'),
      lostWhere: f.issues.find((i) => i.id === 'lost-detail')?.where ?? [],
      crossWhere: f.issues.find((i) => i.id === 'self-intersections')?.where ?? [],
      tinyWhere: f.issues.find((i) => i.id === 'tiny-contours')?.where ?? [],
    }
  }
  let opened = 0
  const A = renders.a.data, B = renders.b.data, U = upload.data
  for (let i = 3; i < A.length; i += 4) if (U[i] > 250 && A[i] > 250 && B[i] < 200) opened++
  row.newTransparency = opened
  return { row, thumbs: { upload: thumb(upload), a: thumb(renders.a), b: thumb(renders.b) } }
}

const status = document.getElementById('status')!
const out: unknown[] = []
;(window as unknown as { __compare: unknown }).__compare = out
;(async () => {
  const files = q.get('files')!.split(',')
  for (const [i, f] of files.entries()) {
    status.textContent = `Measuring ${i + 1} of ${files.length}: ${f}`
    out.push(await measure(await (await fetch(q.get('dir')! + f)).blob(), f))
  }
  status.textContent = 'Done'
})()
