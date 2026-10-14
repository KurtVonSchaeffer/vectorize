// Checks that bench/improver-sim.ts (used by the acceptance test, bench/real.html) reproduces the
// app: each synthetic case is opened in the real app (in an iframe, with its own workers) and run
// through the simulation, then the first SVG and the improver's offer are compared.
//   ?only=badge,validation   case groups or name fragments
import { Enhancer } from '../src/ai/enhancer'
import { scoreAgainstUpload } from '../src/quality/render'
import { loadImage } from '../src/vectorize/image'
import { Tracer } from '../src/vectorize/tracer'
import { CASES, input, VALIDATION } from './cases'
import { simulateImprover } from './improver-sim'

interface Row {
  file: string
  sameSvg: boolean
  /** Score difference against the upload when the SVGs differ. */
  scoreDiff: number | null
  appOffer: string | null
  simOffer: string | null
  sameOffer: boolean
  appTimedOut: boolean
}

const rows: Row[] = []
;(window as unknown as { __parity: Row[] }).__parity = rows
const out = document.getElementById('rows')!
const status = document.getElementById('status')!
const frame = document.getElementById('app') as HTMLIFrameElement
const tracer = new Tracer()
const enhancer = new Enhancer()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Opens the file in a fresh copy of the app and waits for its first result and improver check. */
async function inApp(file: File): Promise<{ svg: string; offer: string | null; timedOut: boolean }> {
  await new Promise<void>((resolve) => {
    frame.onload = () => resolve()
    frame.src = `/?parity=${Date.now()}`
  })
  const doc = () => frame.contentDocument!
  let picker: HTMLInputElement | null = null
  for (let i = 0; i < 100 && !(picker = doc().querySelector('input[type=file]')); i++) await sleep(100)
  // The improver starts once the result is final (after automatic lettering) and shows a note
  // while it checks; done when that note has gone or an offer is shown. The check can take well
  // under a second (AI sharpening is often cached by then), so the note is watched for changes.
  const text = () => doc().body.innerText
  let seen = false
  const watch = new MutationObserver(() => {
    if (/Looking for a cleaner version/.test(doc().body.textContent ?? '')) seen = true
  })
  watch.observe(doc().body, { subtree: true, childList: true, characterData: true })
  const dt = new DataTransfer()
  dt.items.add(file)
  picker!.files = dt.files
  picker!.dispatchEvent(new Event('change', { bubbles: true }))
  const started = performance.now()
  let timedOut = true
  while (performance.now() - started < 180_000) {
    await sleep(100)
    const t = doc().body.textContent ?? ''
    if (/A cleaner version is ready/.test(t) || (seen && !/Looking for a cleaner version/.test(t))) {
      timedOut = false
      break
    }
  }
  watch.disconnect()
  const img = doc().querySelector<HTMLImageElement>('img[alt="Vector result"]')
  const svg = img ? await (await fetch(img.src)).text() : ''
  const offer = /A cleaner version is ready: (.*?)\.\s*Use it/s.exec(text())?.[1] ?? null
  return { svg, offer, timedOut }
}

async function main() {
  try {
    if (localStorage.getItem('vectorizer.brand.v1')) status.textContent = 'Warning: brand colours are saved in this browser; the app will use them and the simulation will not.'
  } catch {
    // Storage unavailable: nothing saved.
  }
  const only = new URLSearchParams(location.search).get('only')?.split(',')
  const cases = [...CASES, ...VALIDATION].filter((c) => !only || only.some((o) => c.group === o || c.name.includes(o)))
  const jobs = cases.flatMap((c) => (c.pngOnly ? [[c, null] as const] : [[c, null] as const, [c, 0.75] as const]))
  for (let i = 0; i < jobs.length; i++) {
    const [c, jpeg] = jobs[i]
    const name = `${c.name}.${jpeg === null ? 'png' : 'jpg'}`
    status.textContent = `${i + 1} of ${jobs.length}: ${name}`
    const blob = await input(c, jpeg)
    const file = new File([blob], name, { type: blob.type })
    const source = await loadImage(file, name)
    const sim = await simulateImprover(source, enhancer, tracer)
    if (!sim) continue
    const app = await inApp(file)
    const sameSvg = app.svg === sim.first.svg
    const scoreDiff = sameSvg || !app.svg ? null : +((await scoreAgainstUpload(source.bitmap, app.svg)).score - sim.first.proxy.score).toFixed(2)
    const row: Row = { file: name, sameSvg, scoreDiff, appOffer: app.offer, simOffer: sim.offered?.label ?? null, sameOffer: app.offer === (sim.offered?.label ?? null), appTimedOut: app.timedOut }
    rows.push(row)
    const tr = document.createElement('tr')
    tr.innerHTML = [row.file, row.sameSvg ? '<b class="up">same</b>' : `<b class="down">differs</b> (${row.scoreDiff})`, row.appOffer ?? '—', row.simOffer ?? '—', row.sameOffer ? '<b class="up">same</b>' : '<b class="down">differs</b>', row.appTimedOut ? '<b class="down">timed out</b>' : ''].map((x) => `<td>${x}</td>`).join('')
    out.append(tr)
  }
  status.textContent = `Done: ${rows.length} cases, ${rows.filter((r) => r.sameSvg).length} identical SVGs, ${rows.filter((r) => r.sameOffer).length} identical offers.`
}

void main()
