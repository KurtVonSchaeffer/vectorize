// Design intent (prototype, docs/design-intent.md): the Simplified illustration as the app makes
// it, and the same with SAM objects redrawn one by one (silhouettes, smoothed tones, mirrored
// halves). Each is measured against the upload (SSIM on luminance, inside the logo) and by paths
// and size.  /bench/intent.html?file=gorilla.png&step=32   Results: window.__intent.
import { traceLabels, type LabelMap } from '../src/trace'
import { DEFAULT_CLIENT, prepFor, traceParamsFor } from '../src/vectorize/client'
import { texturedMask } from '../src/vectorize/illustration'
import { bitmapToImageData, finalizeSvg, loadImage } from '../src/vectorize/image'
import { buildTraceJob, runFlat } from '../src/vectorize/pipeline'
import { discover, embed, type ObjectMask } from '../src/intent/sam'
import { redrawObjects } from '../src/intent/redraw'
import { compoundPerColour, decompose } from '../src/intent/primitives'
import { semanticRedraw } from '../src/intent/semantic'

/** Shapes (4-connected areas of one label) that touch the texture: what the redraw drew. */
function shapesIn(map: LabelMap, texture: Uint8Array): number {
  const { w, h, labels } = map
  const n = w * h
  const seen = new Uint8Array(n)
  let count = 0
  for (let s = 0; s < n; s++) {
    if (!texture[s] || seen[s]) continue
    count++
    const l = labels[s]
    const stack = [s]
    seen[s] = 1
    while (stack.length) {
      const p = stack.pop()!
      const x = p % w
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w]) if (q >= 0 && q < n && !seen[q] && labels[q] === l && texture[q]) (seen[q] = 1), stack.push(q)
    }
  }
  void h
  return count
}

const q = new URLSearchParams(location.search)
const file = q.get('file') ?? 'gorilla.png'
const step = Number(q.get('step') ?? 32)
const status = document.getElementById('status')!
const say = (s: string) => (status.textContent = s)

async function render(svg: string, w: number, h: number): Promise<ImageData> {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
  const img = new Image()
  await new Promise((ok, bad) => ((img.onload = ok), (img.onerror = bad), (img.src = url)))
  const c = new OffscreenCanvas(w, h)
  const g = c.getContext('2d')!
  g.fillStyle = '#fff'
  g.fillRect(0, 0, w, h)
  g.drawImage(img, 0, 0, w, h)
  URL.revokeObjectURL(url)
  return g.getImageData(0, 0, w, h)
}

/** Mean SSIM of luminance in 8×8 windows (step 4) where `inside` holds. */
function ssim(a: ImageData, b: ImageData, inside: (x: number, y: number) => boolean): number {
  const { width: w, height: h } = a
  const L = (d: Uint8ClampedArray, i: number) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
  const C1 = (0.01 * 255) ** 2
  const C2 = (0.03 * 255) ** 2
  let sum = 0
  let n = 0
  for (let y = 0; y + 8 <= h; y += 4)
    for (let x = 0; x + 8 <= w; x += 4) {
      if (!inside(x + 4, y + 4)) continue
      let ma = 0, mb = 0
      for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) { const k = ((y + j) * w + x + i) * 4; ma += L(a.data, k); mb += L(b.data, k) }
      ma /= 64
      mb /= 64
      let va = 0, vb = 0, cv = 0
      for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) { const k = ((y + j) * w + x + i) * 4; const da = L(a.data, k) - ma, db = L(b.data, k) - mb; va += da * da; vb += db * db; cv += da * db }
      sum += ((2 * ma * mb + C1) * (2 * (cv / 63) + C2)) / ((ma * ma + mb * mb + C1) * (va / 63 + vb / 63 + C2))
      n++
    }
  return n ? sum / n : 1
}

const db = () =>
  new Promise<IDBDatabase>((ok, bad) => {
    const r = indexedDB.open('intent-bench', 1)
    r.onupgradeneeded = () => r.result.createObjectStore('objects')
    r.onsuccess = () => ok(r.result)
    r.onerror = () => bad(r.error)
  })
async function cached(key: string): Promise<ObjectMask[] | null> {
  const d = await db()
  return new Promise((ok) => {
    const r = d.transaction('objects').objectStore('objects').get(key)
    r.onsuccess = () => ok((r.result as ObjectMask[] | undefined) ?? null)
    r.onerror = () => ok(null)
  })
}
async function store(key: string, objects: ObjectMask[]) {
  const d = await db()
  await new Promise((ok) => {
    const t = d.transaction('objects', 'readwrite')
    t.objectStore('objects').put(objects, key)
    t.oncomplete = ok
    t.onerror = ok
  })
}

const stats = (svg: string) => ({ paths: (svg.match(/<path\b/g) ?? []).length, kb: Math.round(svg.length / 1024) })

async function main() {
  const blob = await fetch(`/_tmp-check/${file}`).then((r) => r.blob())
  const source = await loadImage(blob, file)
  const img = bitmapToImageData(source.bitmap)
  const { width: w, height: h } = img
  const c = DEFAULT_CLIENT
  // The flat job as the app builds it for an illustration in Simplified.
  const job = buildTraceJob(source, w, {
    trace: traceParamsFor('flat', c), prep: prepFor('flat', c), spot: null, removeColors: [], transparent: false, knockout: false,
    exactShapes: true, cleanGeometry: true, fineDetail: true, straightEdges: true, exactArcs: true, gradients: true, simplified: true,
  })
  if (job.kind !== 'flat') throw new Error('not a flat job')
  say('Tracing Simplified…')
  await new Promise((r) => setTimeout(r, 30))
  let map: LabelMap | null = null
  const t0 = performance.now()
  const simple = runFlat(job.image, job.options, (m) => (map = m))
  const tSimple = performance.now() - t0
  const simpleSvg = finalizeSvg(simple.svg, job.image, source)

  const texture = texturedMask(job.image)
  // Objects are cached in this browser per image and grid step (?fresh=1 finds them again), so the
  // redraw can be tuned without waiting for SAM each time.
  const key = `${file}|${step}|${w}x${h}`
  let objects = q.get('fresh') ? null : await cached(key)
  let tEmbed = 0
  let tDiscover = 0
  if (!objects) {
    say('Segment Anything: loading and encoding…')
    const t1 = performance.now()
    const e = await embed(job.image, (m) => say(m))
    tEmbed = performance.now() - t1
    say('Finding objects…')
    const t2 = performance.now()
    objects = await discover(e, texture, { step, onProgress: (i, n) => say(`Finding objects: ${i}/${n}`) })
    tDiscover = performance.now() - t2
    await store(key, objects)
  }

  say('Redrawing objects…')
  const t3 = performance.now()
  const params = Object.fromEntries([...q].filter(([k]) => k !== 'file' && k !== 'step').map(([k, v]) => [k, Number(v)]))
  const { map: redrawn, report } = redrawObjects(map!, objects, job.image, texture, params)
  const traced = traceLabels(redrawn, job.options.trace)
  const intentSvg = finalizeSvg(traced.svg, job.image, source)
  const tRedraw = performance.now() - t3

  say('Decomposing into primitives…')
  const t4 = performance.now()
  const dec = decompose(map!, objects, job.image, texture, params)
  const primStacked = compoundPerColour(finalizeSvg(traceLabels(dec.map, job.options.trace).svg, job.image, source))
  const primKnockout = compoundPerColour(finalizeSvg(traceLabels(dec.map, { ...job.options.trace, mode: 'knockout', spread: 0 }).svg, job.image, source))
  const tPrim = performance.now() - t4

  say('Semantic redraw…')
  const t5 = performance.now()
  const sem = semanticRedraw(map!, objects, job.image, texture, job.options.trace, params)
  const semSvg = finalizeSvg(sem.svg, job.image, source)
  const tSem = performance.now() - t5

  const logo = (x: number, y: number) => Math.hypot(x - w / 2, y - h / 2) < Math.min(w, h) * 0.4
  const [rs, ri, rp, rk, rm] = await Promise.all([render(simpleSvg, w, h), render(intentSvg, w, h), render(primStacked, w, h), render(primKnockout, w, h), render(semSvg, w, h)])
  const result = {
    file,
    objects: objects.length,
    report,
    primitives: { count: dec.primitives.length, bases: dec.primitives.filter((p) => p.kind === 'base').length, shadows: dec.primitives.filter((p) => p.kind === 'shadow').length, highlights: dec.primitives.filter((p) => p.kind === 'highlight').length, palette: dec.palette.length, parents: dec.parents, mirrored: dec.mirrored.length },
    ms: { simplified: Math.round(tSimple), embed: Math.round(tEmbed), discover: Math.round(tDiscover), redraw: Math.round(tRedraw), primitives: Math.round(tPrim) },
    simplified: { ...stats(simpleSvg), shapes: shapesIn(map!, texture), ssim: +ssim(img, rs, logo).toFixed(4) },
    intent: { ...stats(intentSvg), shapes: shapesIn(redrawn, texture), ssim: +ssim(img, ri, logo).toFixed(4) },
    primitivesStacked: { ...stats(primStacked), shapes: shapesIn(dec.map, texture), ssim: +ssim(img, rp, logo).toFixed(4) },
    primitivesKnockout: { ...stats(primKnockout), ssim: +ssim(img, rk, logo).toFixed(4) },
    semantic: { ...stats(semSvg), shapes: sem.shapes, ssim: +ssim(img, rm, logo).toFixed(4), ms: Math.round(tSem), objects: sem.objects.map((o) => `${o.name} (${o.role}, ${o.area} px, sym ${o.symmetry})`), features: sem.features.map((f) => `${f.name} ${f.area} px`) },
  }
  ;(window as unknown as { __intent: unknown; __svgs: unknown }).__intent = result
  ;(window as unknown as { __svgs: unknown }).__svgs = { simpleSvg, intentSvg, primStacked, primKnockout, semSvg }

  const out = document.getElementById('out')!
  const fig = (src: string, cap: string) => `<figure><img src="${src}"><figcaption>${cap}</figcaption></figure>`
  const url = (svg: string) => URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
  out.innerHTML =
    fig(source.url, 'Original') +
    fig(url(simpleSvg), `Simplified · ${result.simplified.shapes} shapes in the art · ${result.simplified.paths} paths · ${result.simplified.kb} KB · SSIM ${result.simplified.ssim}`) +
    fig(url(intentSvg), `Objects, tones · ${result.intent.shapes} shapes · ${result.intent.paths} paths · ${result.intent.kb} KB · SSIM ${result.intent.ssim}`) +
    fig(url(primKnockout), `Primitives, knockout · ${result.primitivesStacked.shapes} shapes · ${result.primitivesKnockout.paths} paths · ${result.primitivesKnockout.kb} KB · SSIM ${result.primitivesKnockout.ssim}`) +
    fig(url(semSvg), `Semantic · ${result.semantic.shapes} named shapes · ${result.semantic.paths} paths · ${result.semantic.kb} KB · SSIM ${result.semantic.ssim}`)
  document.getElementById('stats')!.innerHTML = `<pre>${JSON.stringify(result, null, 1)}</pre>`
  say('Done')
}

main().catch((err) => say(`Failed: ${err instanceof Error ? err.stack : err}`))
