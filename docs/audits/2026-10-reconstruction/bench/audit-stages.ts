// AUDIT ONLY (scratch copy of 4926f81, not committed): reproduces the production default job for an
// upload and captures each stage: the prepared input, the colour map just before tracing, and the SVG.
// ?jobs=<file>|<variant>,... variants: default, noexact, detail1, colours12, nogradients, blends
import { colorAt } from '../src/palette/gradients'
import { DEFAULT_INKS } from '../src/palette/quantize'
import { DEMO_PALETTE } from '../src/palette/demo'
import type { LabelMap } from '../src/trace'
import { DEFAULT_CLIENT, detailBoost, prepFor, traceParamsFor, type ClientSettings } from '../src/vectorize/client'
import { detectArt } from '../src/vectorize/detect'
import { bitmapToImageData, finalizeSvg, loadImage } from '../src/vectorize/image'
import { buildTraceJob, runFlat, runTraceJob } from '../src/vectorize/pipeline'
import { Tracer } from '../src/vectorize/tracer'

function renderMap(map: LabelMap): ImageData {
  const img = new ImageData(map.w, map.h)
  const rgb = (l: number, x: number, y: number): [number, number, number] | null => {
    if (l >= 254 || map.colors[l] < 0) return null
    const f = map.fills?.[l]
    if (f) return colorAt(f, x + 0.5, y + 0.5)
    const c = map.colors[l]
    return [(c >> 16) & 255, (c >> 8) & 255, c & 255]
  }
  for (let y = 0; y < map.h; y++)
    for (let x = 0; x < map.w; x++) {
      const p = y * map.w + x
      const a = rgb(map.labels[p], x, y)
      const b = map.cov[p] < 1 ? rgb(map.second[p], x, y) : null
      const c = map.cov[p]
      const px = a && b ? a.map((v, k) => v * c + b[k] * (1 - c)) : a
      if (px) img.data.set([...px.map(Math.round), 255], p * 4)
    }
  return img
}
const png = (d: ImageData) => { const c = document.createElement('canvas'); c.width = d.width; c.height = d.height; c.getContext('2d')!.putImageData(d, 0, 0); return c.toDataURL('image/png') }
const VARIANTS: Record<string, Partial<ClientSettings>> = { default: {}, noexact: { exactShapes: false }, detail1: { detail: 1 }, colours12: { maxColors: 12 }, nogradients: { gradients: false }, blends: { keepBlends: true } }
const tracer = new Tracer()
const out: Record<string, unknown>[] = []
;(window as unknown as { __stages: unknown }).__stages = out
for (const spec of (new URLSearchParams(location.search).get('jobs') ?? '').split(',').filter(Boolean)) {
  const [file, variant = 'default'] = spec.split('|')
  const blob = await (await fetch(`/audit-in/${file}`)).blob()
  const source = await loadImage(blob, file)
  const det = detectArt(bitmapToImageData(source.bitmap))
  const client = { ...DEFAULT_CLIENT, ...VARIANTS[variant] }
  const kind = det.kind
  const job = buildTraceJob(source, source.width, {
    trace: traceParamsFor(kind, client, detailBoost(det, source.width, source.height)),
    prep: prepFor(kind, client),
    spot: { settings: DEFAULT_INKS, palette: DEMO_PALETTE },
    removeColors: [],
    transparent: det.hasAlpha || kind === 'lineart',
    knockout: false,
    keepBlends: client.keepBlends,
    exactShapes: client.exactShapes,
    gradients: client.gradients,
    brand: undefined,
  })
  let map: LabelMap | null = null
  let svg: string
  const t0 = performance.now()
  if (job.kind === 'flat') {
    const res = runFlat(job.image, job.options, (m) => (map = m))
    svg = finalizeSvg(res.svg, job.image, source)
  } else svg = (await runTraceJob({ vtracer: tracer, flat: null }, job, source, false)).svg
  out.push({
    file, variant, kind, det: { kind: det.kind, fine: det.fine, hasAlpha: det.hasAlpha }, jobKind: job.kind, size: [job.image.width, job.image.height], ms: Math.round(performance.now() - t0),
    colours: map ? new Set((map as LabelMap).labels).size : null, input: png(job.image), map: map ? png(renderMap(map)) : null, svg,
  })
}
document.getElementById('status')!.textContent = 'Done'
