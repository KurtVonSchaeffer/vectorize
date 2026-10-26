// Recreation mode (prototype, docs/design-intent.md): SAM regions, named by a vision model, become
// an object graph, and the SVG is built from the graph: one solid shape per object, details as
// cut-outs and overlays, the artwork around it as the flat tracer draws it.
//   /bench/recreate.html?file=gorilla.png&step=label   numbered regions to label (panels by size)
//   /bench/recreate.html?file=gorilla.png              builds from /_tmp-check/<file>.labels.json
// Regions are cached in this browser (?fresh=1 finds them again). Results: window.__recreate.
import type { LabelMap } from '../src/trace'
import { DEFAULT_CLIENT, prepFor, traceParamsFor } from '../src/vectorize/client'
import { texturedMask } from '../src/vectorize/illustration'
import { bitmapToImageData, finalizeSvg, loadImage } from '../src/vectorize/image'
import { buildTraceJob, runFlat } from '../src/vectorize/pipeline'
import { discover, embed, segmentAll, type ObjectMask } from '../src/intent/sam'
import { buildGraph, recreate, type Labels } from '../src/intent/graph'

const q = new URLSearchParams(location.search)
const file = q.get('file') ?? 'gorilla.png'
const step = q.get('step') ?? 'build'
const status = document.getElementById('status')!
const say = (s: string) => (status.textContent = s)

const db = () =>
  new Promise<IDBDatabase>((ok, bad) => {
    const r = indexedDB.open('recreate-bench', 1)
    r.onupgradeneeded = () => r.result.createObjectStore('regions')
    r.onsuccess = () => ok(r.result)
    r.onerror = () => bad(r.error)
  })
async function cached(key: string): Promise<ObjectMask[] | null> {
  const d = await db()
  return new Promise((ok) => {
    const r = d.transaction('regions').objectStore('regions').get(key)
    r.onsuccess = () => ok((r.result as ObjectMask[] | undefined) ?? null)
    r.onerror = () => ok(null)
  })
}
async function store(key: string, v: ObjectMask[]) {
  const d = await db()
  await new Promise((ok) => {
    const t = d.transaction('regions', 'readwrite')
    t.objectStore('regions').put(v, key)
    t.oncomplete = ok
    t.onerror = ok
  })
}

async function render(svg: string, w: number, h: number): Promise<ImageData> {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
  const img = new Image()
  await new Promise((ok, bad) => ((img.onload = ok), (img.onerror = bad), (img.src = url)))
  const c = new OffscreenCanvas(w, h)
  const g = c.getContext('2d')!
  g.fillStyle = '#fff'
  g.fillRect(0, 0, w, h)
  g.drawImage(img, 0, 0, w, h)
  return g.getImageData(0, 0, w, h)
}

/** Numbered outlines of regions over the image, cropped to `box`, one panel. */
function panel(img: ImageData, regions: { i: number; m: ObjectMask }[], box: [number, number, number, number], title: string): HTMLElement {
  const [x0, y0, x1, y1] = box
  const s = 2
  const c = document.createElement('canvas')
  c.width = (x1 - x0) * s
  c.height = (y1 - y0) * s
  const g = c.getContext('2d')!
  const t = new OffscreenCanvas(img.width, img.height)
  t.getContext('2d')!.putImageData(img, 0, 0)
  g.globalAlpha = 0.55
  g.drawImage(t, x0, y0, x1 - x0, y1 - y0, 0, 0, c.width, c.height)
  g.globalAlpha = 1
  const hues = [0, 210, 120, 300, 30, 180, 270, 60, 330, 90, 240, 150]
  regions.forEach(({ i, m }, k) => {
    const col = `hsl(${hues[k % hues.length]} 100% 45%)`
    g.fillStyle = col
    const w = img.width
    for (let y = Math.max(y0, m.box[1]); y <= Math.min(y1 - 1, m.box[3]); y++)
      for (let x = Math.max(x0, m.box[0]); x <= Math.min(x1 - 1, m.box[2]); x++) {
        const p = y * w + x
        if (!m.mask[p]) continue
        if (m.mask[p - 1] && m.mask[p + 1] && m.mask[p - w] && m.mask[p + w]) continue
        g.fillRect((x - x0) * s, (y - y0) * s, s, s)
      }
    // Number at the region's centre of mass.
    let sx = 0, sy = 0, n = 0
    for (let y = m.box[1]; y <= m.box[3]; y++) for (let x = m.box[0]; x <= m.box[2]; x++) if (m.mask[y * w + x]) (sx += x), (sy += y), n++
    const cx = (sx / n - x0) * s, cy = (sy / n - y0) * s
    g.font = 'bold 22px sans-serif'
    g.lineWidth = 4
    g.strokeStyle = '#fff'
    g.strokeText(String(i), cx - 8, cy + 8)
    g.fillStyle = col
    g.fillText(String(i), cx - 8, cy + 8)
  })
  const f = document.createElement('figure')
  c.style.width = '640px'
  f.appendChild(c)
  const cap = document.createElement('figcaption')
  cap.textContent = title
  f.appendChild(cap)
  return f
}

async function main() {
  const blob = await fetch(`/_tmp-check/${file}`).then((r) => r.blob())
  const source = await loadImage(blob, file)
  const img = bitmapToImageData(source.bitmap)
  const { width: w, height: h } = img
  const texture = texturedMask(img)
  const key = `${file}|fine|${w}x${h}`
  let regions = q.get('fresh') ? null : await cached(key)
  if (!regions) {
    say('Segment Anything: loading and encoding…')
    const e = await embed(img, (m) => say(m))
    regions = await discover(e, texture, { step: 16, minShare: 0.00008, maxShare: 0.2, minScore: 0.85, onProgress: (i, n) => say(`Finding regions: ${i}/${n}`) })
    await store(key, regions)
  }
  ;(window as unknown as { __regions: unknown }).__regions = regions
  const out = document.getElementById('out')!
  const n = w * h

  if (step === 'label') {
    // The gorilla's box, and three panels by size so numbers stay readable.
    let bx0 = w, by0 = h, bx1 = 0, by1 = 0
    for (const r of regions) (bx0 = Math.min(bx0, r.box[0])), (by0 = Math.min(by0, r.box[1])), (bx1 = Math.max(bx1, r.box[2])), (by1 = Math.max(by1, r.box[3]))
    const all = regions.map((m, i) => ({ i, m }))
    out.append(
      panel(img, all.filter(({ m }) => m.area >= n * 0.01), [bx0, by0, bx1 + 1, by1 + 1], 'Large regions (≥ 1%)'),
      panel(img, all.filter(({ m }) => m.area < n * 0.01 && m.area >= n * 0.001), [bx0, by0, bx1 + 1, by1 + 1], 'Medium regions (0.1–1%)'),
      panel(img, all.filter(({ m }) => m.area < n * 0.001), [Math.max(0, 480), Math.max(0, 180), Math.min(w, 720), Math.min(h, 420)], 'Small regions (< 0.1%), face area'),
    )
    document.getElementById('stats')!.innerHTML = `<pre>${regions.map((r, i) => `${i}: ${r.area} px, box ${r.box.join(',')}, score ${r.score.toFixed(2)}`).join('\n')}</pre>`
    say(`Done: ${regions.length} regions`)
    return
  }

  // Build: labels from the vision step, the graph, and the reconstruction.
  const labels = (await fetch(`/_tmp-check/${file}.labels.json`, { cache: 'no-store' }).then((r) => r.json())) as Labels
  if (q.get('budget')) labels.budget = Number(q.get('budget'))
  // Parts given as points are segmented now, and become regions of their own.
  if (labels.parts.some((p) => p.points?.length)) {
    say('Segment Anything: segmenting the parts the vision step pointed at…')
    const e = await embed(img, (m) => say(m))
    for (const p of labels.parts) {
      if (!p.points?.length) continue
      const masks = (await segmentAll(e, p.points)).filter((m) => m.score >= 0.6 && m.area > 0)
      if (!masks.length) continue
      const m = p.pick === 'small' ? masks.reduce((a, b) => (b.area < a.area ? b : a)) : p.pick === 'large' ? masks.reduce((a, b) => (b.area > a.area ? b : a)) : masks.reduce((a, b) => (b.score > a.score ? b : a))
      p.regions = [...(p.regions ?? []), regions.push(m) - 1]
    }
  }
  const c = DEFAULT_CLIENT
  const job = buildTraceJob(source, w, {
    trace: traceParamsFor('flat', c), prep: prepFor('flat', c), spot: null, removeColors: [], transparent: false, knockout: false,
    exactShapes: true, cleanGeometry: true, fineDetail: true, straightEdges: true, exactArcs: true, gradients: true, simplified: true,
  })
  if (job.kind !== 'flat') throw new Error('not a flat job')
  say('Tracing the artwork…')
  await new Promise((r) => setTimeout(r, 30))
  let map: LabelMap | null = null
  const simple = runFlat(job.image, job.options, (m) => (map = m))
  const simpleSvg = finalizeSvg(simple.svg, job.image, source)
  say('Building the object graph…')
  const graph = buildGraph(regions, labels, img)
  say('Recreating…')
  const t0 = performance.now()
  const rec = recreate(map!, graph, img, job.options.trace)
  const recSvg = finalizeSvg(rec.svg, job.image, source)
  const ms = Math.round(performance.now() - t0)
  const [rs, rr] = await Promise.all([render(simpleSvg, w, h), render(recSvg, w, h)])
  void rs
  void rr
  const stats = (svg: string) => ({ paths: (svg.match(/<path\b/g) ?? []).length, kb: Math.round(svg.length / 1024) })
  const result = { ms, simplified: stats(simpleSvg), recreated: { ...stats(recSvg), objects: rec.objects, illustrationPaths: rec.paths }, graph: rec.tree }
  ;(window as unknown as { __recreate: unknown; __svgs: unknown }).__recreate = result
  ;(window as unknown as { __svgs: unknown }).__svgs = { simpleSvg, recSvg }
  const url = (svg: string) => URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
  out.innerHTML = `<figure><img src="${source.url}"><figcaption>Original</figcaption></figure><figure><img src="${url(simpleSvg)}"><figcaption>Simplified (app) · ${result.simplified.paths} paths</figcaption></figure><figure><img src="${url(recSvg)}"><figcaption>Recreated from the object graph · ${rec.objects} objects · ${rec.paths} paths in the illustration</figcaption></figure>`
  document.getElementById('stats')!.innerHTML = `<pre>${rec.tree}</pre>`
  say('Done')
}

main().catch((err) => say(`Failed: ${err instanceof Error ? err.stack : err}`))
