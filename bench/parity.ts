// Checks that bench/improver-sim.ts (used by the acceptance test, bench/real.html) reproduces the
// app: each synthetic case is opened in the real app (in an iframe, with its own workers) and run
// through the simulation, then the first SVG and the improver's offer are compared.
//   ?only=badge,validation   case groups or name fragments
//   ?sharpen=off             AI sharpening unavailable in both (as offline, or the model failed to load)
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
  /** The typeface suggested by name ("Try …"), if any. */
  appSuggests: string | null
  simSuggests: string[]
  sameSuggestion: boolean
  appTimedOut: boolean
}

const rows: Row[] = []
;(window as unknown as { __parity: Row[] }).__parity = rows
const out = document.getElementById('rows')!
const status = document.getElementById('status')!
const frame = document.getElementById('app') as HTMLIFrameElement
const tracer = new Tracer()
const sharpenOff = new URLSearchParams(location.search).get('sharpen') === 'off'
const enhancer = sharpenOff ? ({ upscale: () => Promise.reject(new Error('Sharpening unavailable (offline)')), dispose: () => {} } as unknown as Enhancer) : new Enhancer()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const OFFER_SETTLED = 20_000

/** Opens the file in a fresh copy of the app and waits for its first result and improver check. */
async function inApp(file: File): Promise<{ svg: string; offer: string | null; suggests: string | null; timedOut: boolean }> {
  await new Promise<void>((resolve) => {
    frame.onload = () => resolve()
    frame.src = `/?parity=${Date.now()}`
  })
  if (sharpenOff) {
    // The sharpening worker can't start, as when its model can't be downloaded. The app starts it
    // only when sharpening is first asked for, after the file is opened, so this is in time.
    const win = frame.contentWindow as unknown as { Worker: typeof Worker }
    const Base = win.Worker
    win.Worker = class extends Base {
      constructor(url: string | URL, options?: WorkerOptions) {
        if (String(url).includes('/ai/worker')) throw new Error('Sharpening unavailable (offline)')
        super(url, options)
      }
    }
  }
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
  // A later candidate can replace an offer that is already shown (a lower score wins), and the
  // app gives no sign that the last one has been checked: an offer counts once it hasn't changed
  // for OFFER_SETTLED ms.
  let offerSince = 0
  let lastOffer: string | null = null
  while (performance.now() - started < 180_000) {
    await sleep(100)
    const t = doc().body.textContent ?? ''
    const shown = /A cleaner version is ready: (.*?)\.\s*Use it/s.exec(t)?.[1] ?? null
    if (shown !== lastOffer) {
      lastOffer = shown
      offerSince = performance.now()
    }
    if ((shown && performance.now() - offerSince >= OFFER_SETTLED) || (!shown && seen && !/Looking for a cleaner version/.test(t))) {
      timedOut = false
      break
    }
  }
  watch.disconnect()
  const img = doc().querySelector<HTMLImageElement>('img[alt="Vector result"]')
  const svg = img ? await (await fetch(img.src)).text() : ''
  const offer = /A cleaner version is ready: (.*?)\.\s*Use it/s.exec(text())?.[1] ?? null
  const suggests = /looks like (.*?) \(\d+% match\)/s.exec(text())?.[1] ?? null
  return { svg, offer, suggests, timedOut }
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
    const simSuggests = sim.suggestions?.fonts ?? []
    const sameSuggestion = app.suggests === null ? !simSuggests.length : simSuggests.includes(app.suggests)
    const row: Row = { file: name, sameSvg, scoreDiff, appOffer: app.offer, simOffer: sim.offered?.label ?? null, sameOffer: app.offer === (sim.offered?.label ?? null), appSuggests: app.suggests, simSuggests, sameSuggestion, appTimedOut: app.timedOut }
    rows.push(row)
    const tr = document.createElement('tr')
    tr.innerHTML = [row.file, row.sameSvg ? '<b class="up">same</b>' : `<b class="down">differs</b> (${row.scoreDiff})`, row.appOffer ?? '—', row.simOffer ?? '—', row.sameOffer ? '<b class="up">same</b>' : '<b class="down">differs</b>', `${row.appSuggests ?? '—'} / ${row.simSuggests.join(', ') || '—'} ${row.sameSuggestion ? '<b class="up">same</b>' : '<b class="down">differs</b>'}`, row.appTimedOut ? '<b class="down">timed out</b>' : ''].map((x) => `<td>${x}</td>`).join('')
    out.append(tr)
  }
  status.textContent = `Done: ${rows.length} cases, ${rows.filter((r) => r.sameSvg).length} identical SVGs, ${rows.filter((r) => r.sameOffer).length} identical offers, ${rows.filter((r) => r.sameSuggestion).length} identical font suggestions${sharpenOff ? ' (sharpening unavailable)' : ''}.`
}

void main()
