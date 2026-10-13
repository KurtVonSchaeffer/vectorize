import { hexToRgb, rgbToLab } from '../src/palette/color'
import { DEFAULT_INKS } from '../src/palette/quantize'
import { DEFAULT_CLIENT, prepFor, traceParamsFor, type ClientSettings } from '../src/vectorize/client'
import { detectArt } from '../src/vectorize/detect'
import { FlatTracer } from '../src/vectorize/flat-tracer'
import { bitmapToImageData, loadImage } from '../src/vectorize/image'
import { buildTraceJob, runTraceJob, type SpotOptions } from '../src/vectorize/pipeline'
import { Tracer } from '../src/vectorize/tracer'
import { ARTWORK, degrade, score, type Score } from './artwork'

// Runs the same path a client gets: automatic detection and default settings.
// Usage: /bench/index.html?cases=logo,badge&configs=web,print,spot&detail=0.5&corners=0.75&shapes=0
//   web   = on-screen result (stacked shapes)
//   print = print/cut geometry (each color only covers its own area)
//   spot  = matched to a brand palette made of the artwork's true colors
const q = new URLSearchParams(location.search)
const cases = (q.get('cases') ?? Object.keys(ARTWORK).join(',')).split(',')
const configs = (q.get('configs') ?? 'web,print,spot').split(',')
const client: ClientSettings = {
  ...DEFAULT_CLIENT,
  detail: Number(q.get('detail') ?? DEFAULT_CLIENT.detail),
  corners: Number(q.get('corners') ?? DEFAULT_CLIENT.corners),
}

/** The artwork's own colors, as a brand palette would be. */
function truthPalette(svg: string): SpotOptions['palette'] {
  const hexes = [...new Set([...svg.matchAll(/(?:fill|stroke)="(#[0-9a-f]{6})"/gi)].map((m) => m[1].toUpperCase()))]
  return { name: 'truth', swatches: hexes.map((h) => ({ name: h, rgb: hexToRgb(h)!, lab: rgbToLab(hexToRgb(h)!) })) }
}

const tracer = new Tracer()
const flat = new FlatTracer()
const results: Record<string, Score & { ms: number; kind: string }> = {}
;(window as unknown as { __results: unknown }).__results = results

for (const name of cases) {
  const truth = ARTWORK[name]
  const blob = await degrade(truth, 600, 400, 0.75)
  const source = await loadImage(blob, `${name}.jpg`)
  const detected = detectArt(bitmapToImageData(source.bitmap))
  for (const config of configs) {
    const palette = truthPalette(truth)
    const spot: SpotOptions | null =
      config === 'spot' ? { settings: { ...DEFAULT_INKS, enabled: true, maxInks: palette.swatches.length, whiteIsPaper: false }, palette } : null
    const t0 = performance.now()
    const job = buildTraceJob(source, source.width, {
      trace: traceParamsFor(detected.kind, client),
      prep: prepFor(detected.kind, client),
      spot,
      removeColors: [],
      transparent: false,
      knockout: config === 'print',
      exactShapes: q.get('shapes') !== '0',
    })
    const { svg } = await runTraceJob({ vtracer: tracer, flat }, job, source, !!spot)
    const ms = Math.round(performance.now() - t0)
    const s = { ...(await score(svg, truth)), ms, kind: detected.kind }
    results[`${name}/${config}`] = s
    const row = document.createElement('tr')
    row.innerHTML = `<td>${name}/${config} <small>(${detected.kind})</small></td>` + [s.meanError, s.wrongPixels, s.wrongBeyondEdges, s.edgeF1, s.missing, s.artefacts, s.paths, s.segments, s.kb, s.ms].map((v) => `<td>${v}</td>`).join('')
    document.getElementById('table')!.append(row)
    const img = document.createElement('img')
    img.title = `${name}/${config}`
    img.src = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
    document.getElementById('images')!.append(img)
  }
}
document.getElementById('status')!.textContent = 'Done'
