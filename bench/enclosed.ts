// Diagnostic: the enclosed paper-coloured regions of uploads on paper, as the app traces them.
//   ?dir=/audit-in/&files=a.jpg   Results: window.__enclosed
import { DEMO_PALETTE } from '../src/palette/demo'
import { DEFAULT_INKS } from '../src/palette/quantize'
import { DEFAULT_CLIENT, detailBoost, prepFor, traceParamsFor } from '../src/vectorize/client'
import { detectArt } from '../src/vectorize/detect'
import { bitmapToImageData, loadImage } from '../src/vectorize/image'
import { enclosedRegions, paperMask, splitEnclosed } from '../src/vectorize/paper'
import { buildTraceJob, runFlat } from '../src/vectorize/pipeline'
import type { LabelMap } from '../src/trace'

const hex = (c: number) => '#' + c.toString(16).padStart(6, '0')
const rows: unknown[] = []
;(window as unknown as { __enclosed: unknown }).__enclosed = rows
const q = new URLSearchParams(location.search)
;(async () => {
  for (const f of q.get('files')!.split(',')) {
    const source = await loadImage(await (await fetch(q.get('dir')! + f)).blob(), f)
    const det = detectArt(bitmapToImageData(source.bitmap))
    const job = buildTraceJob(source, source.width, {
      trace: traceParamsFor(det.kind, DEFAULT_CLIENT, detailBoost(det, source.width, source.height)),
      prep: prepFor(det.kind, DEFAULT_CLIENT),
      spot: { settings: DEFAULT_INKS, palette: DEMO_PALETTE },
      removeColors: [], transparent: det.hasAlpha || det.kind === 'lineart', knockout: true,
      keepBlends: DEFAULT_CLIENT.keepBlends, exactShapes: DEFAULT_CLIENT.exactShapes, gradients: DEFAULT_CLIENT.gradients, brand: undefined, paperOut: 'border',
    })
    if (job.kind !== 'flat') continue
    let map: LabelMap | null = null
    // The map before paper is applied: run without the paper option and inspect.
    runFlat(job.image, { ...job.options, paper: undefined }, (m) => (map = m))
    const m = map! as LabelMap
    const counts = new Map<number, number>()
    for (let p = 0; p < m.w; p++) counts.set(m.labels[p], (counts.get(m.labels[p]) ?? 0) + 1)
    const bg = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0]
    const mask = paperMask(m, bg, job.image)!
    const word = q.get('word')?.split(',').map(Number) as [number, number, number, number] | undefined
    const split = word ? splitEnclosed(m, bg, mask, [word], []) : null
    rows.push({
      file: f, size: [m.w, m.h],
      split: split?.areas.filter((a) => a.area > 1000).map((a) => ({ kind: a.kind, box: a.box })),
      regions: enclosedRegions(m, bg, mask).map((r) => ({
        area: r.area, box: r.box, inradius: +r.inradius.toFixed(1), rim: +r.rim.toFixed(1),
        neighbours: [...r.neighbours].map(([l, c]) => `${l >= 254 ? 'paper' : hex(m.colors[l])}:${c}`),
      })),
    })
  }
  document.getElementById('status')!.textContent = 'Done'
})()
