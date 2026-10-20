// Print files before and after: each upload's print plates (knockout) as made today, with the paper
// background left out ('border', white ink for the artwork only) and with no white ink ('all'),
// plus the sizes of the print and cut files with and without the print-files flag.
//   ?dir=/audit-in/&files=a.png,b.jpg
// Results: window.__printFiles once the status reads "Done". Each row's `renders` are the plates
// drawn over a dark garment colour, as data URLs.
import { DEMO_PALETTE } from '../src/palette/demo'
import { DEFAULT_INKS } from '../src/palette/quantize'
import { downloadsFor, printWidthMm } from '../src/export/files'
import { shapesFromSvg } from '../src/export/path'
import { rasterizeSvg } from '../src/quality/render'
import { DEFAULT_CLIENT, detailBoost, prepFor, traceParamsFor } from '../src/vectorize/client'
import { detectArt } from '../src/vectorize/detect'
import { bitmapToImageData, loadImage } from '../src/vectorize/image'
import { buildTraceJob, runFlat, type JobSettings } from '../src/vectorize/pipeline'

const GARMENT = '#1f3b2d'
const hex = (c: number) => '#' + c.toString(16).padStart(6, '0')

async function render(svg: string, w: number, h: number): Promise<string> {
  const img = await rasterizeSvg(svg, w, h)
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const g = c.getContext('2d')!
  g.fillStyle = GARMENT
  g.fillRect(0, 0, w, h)
  const t = document.createElement('canvas')
  t.width = w
  t.height = h
  t.getContext('2d')!.putImageData(img, 0, 0)
  g.drawImage(t, 0, 0)
  return c.toDataURL('image/png')
}

async function measure(blob: Blob, file: string) {
  const source = await loadImage(blob, file)
  const det = detectArt(bitmapToImageData(source.bitmap))
  const settings = (paperOut?: 'border' | 'all'): JobSettings => ({
    trace: traceParamsFor(det.kind, DEFAULT_CLIENT, detailBoost(det, source.width, source.height)),
    prep: prepFor(det.kind, DEFAULT_CLIENT),
    spot: { settings: DEFAULT_INKS, palette: DEMO_PALETTE },
    removeColors: [],
    transparent: det.hasAlpha || det.kind === 'lineart',
    knockout: true,
    keepBlends: DEFAULT_CLIENT.keepBlends,
    exactShapes: DEFAULT_CLIENT.exactShapes,
    gradients: DEFAULT_CLIENT.gradients,
    brand: undefined,
    ...(paperOut ? { paperOut } : {}),
  })
  const row: Record<string, unknown> = { file, kind: det.kind, size: [source.width, source.height] }
  const renders: Record<string, string> = {}
  for (const [name, paperOut] of [['today', undefined], ['artwork', 'border'], ['none', 'all']] as const) {
    const job = buildTraceJob(source, source.width, settings(paperOut))
    if (job.kind !== 'flat') {
      row.note = 'photo: traced by VTracer, unaffected'
      break
    }
    const r = runFlat(job.image, job.options)
    const shapes = shapesFromSvg(r.svg)
    const W = job.image.width, H = job.image.height
    row.paper = r.paper
    row[name] = {
      plates: [...new Set(shapes.map((s) => hex(s.color)))],
      // A near-white shape covering ≥ 97% of the image: the paper printed as a plate.
      paperPlate: shapes.some((s) => Math.min((s.color >> 16) & 255, (s.color >> 8) & 255, s.color & 255) >= 235 && s.subpaths.some((sp) => sp.segs.length >= 3 && bboxArea(sp) >= 0.97 * W * H)),
      paths: (r.svg.match(/<path\b/g) ?? []).length,
    }
    renders[name] = await render(r.svg, Math.min(400, W), Math.round((Math.min(400, W) * H) / W))
  }
  // Sizes of the print and cut files, today and with the flag.
  const w = source.width, h = source.height
  const base = { svg: '<svg width="1" height="1"></svg>', width: w, height: h, baseName: 'x', names: new Map<number, string>(), spotNames: null, flat: true }
  const dxfMm = async (input: Parameters<typeof downloadsFor>[1]) => {
    const lines = (await (await downloadsFor('cut', input)[1].make()).text()).split('\n')
    return Number(lines[lines.indexOf('$EXTMAX') + 2])
  }
  row.sizes = {
    pdfLongMm: 254,
    dxfWidthMm: { today: await dxfMm(base), flag: await dxfMm({ ...base, printWidthMm: printWidthMm(w, h) }) },
    pdfWidthMm: Math.round(printWidthMm(w, h) * 100) / 100,
  }
  row.renders = renders
  return row
}

function bboxArea(sp: { start: [number, number]; segs: { p: [number, number] }[] }) {
  const xs = [sp.start[0], ...sp.segs.map((g) => g.p[0])]
  const ys = [sp.start[1], ...sp.segs.map((g) => g.p[1])]
  return (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys))
}

const status = document.getElementById('status')!
const rows: Record<string, unknown>[] = []
;(window as unknown as { __printFiles: unknown }).__printFiles = rows
const q = new URLSearchParams(location.search)
const dir = q.get('dir')
const files = q.get('files')?.split(',').filter(Boolean) ?? []
;(async () => {
  for (const [i, f] of files.entries()) {
    status.textContent = `Measuring ${i + 1} of ${files.length}: ${f}`
    rows.push(await measure(await (await fetch(dir + f)).blob(), f))
  }
  status.textContent = 'Done'
})()
