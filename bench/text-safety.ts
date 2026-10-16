// Text safety: lettering must never be rebuilt with a misread character. Each case reads real
// lettering with OCR, then forges misreadings by swapping characters in what OCR reported (every
// digit for every other digit, letters for their look-alikes) while the pixels stay real, exactly
// as when OCR misreads, and checks that placing the lettering flags every forged word as doubtful
// (PlacedWord.doubts), so it's never rebuilt or offered automatically. Correct readings are
// counted too (false alarms). The "1998" read as "1898" case found in validation must always pass.
//   ?only=tagline   a case name fragment
import { findText, matchFonts, type TextLine } from '../src/fonts/identify'
import { placeLine } from '../src/fonts/lettering'
import { bitmapToImageData, loadImage } from '../src/vectorize/image'
import { Enhancer } from '../src/ai/enhancer'
import { CASES, input, VALIDATION } from './cases'

interface Result {
  case: string
  word: string
  forged: string
  flagged: boolean
  why: string
}

const results: Result[] = []
const correct: { case: string; word: string; flagged: boolean; why: string }[] = []
;(window as unknown as { __safety: unknown }).__safety = { results, correct }
const status = document.getElementById('status')!
const out = document.getElementById('out')!

const DIGITS = '0123456789'
const LETTER_SWAPS: Record<string, string> = { O: '0Q', S: '58', E: 'F', B: '8', I: '1', C: 'G', R: 'P', A: '4' }

/** Every single-character misreading worth forging for a word. */
function forgeries(word: string): string[] {
  const out: string[] = []
  ;[...word].forEach((ch, i) => {
    const swaps = DIGITS.includes(ch) ? DIGITS.replace(ch, '') : (LETTER_SWAPS[ch] ?? '')
    for (const s of swaps) out.push(word.slice(0, i) + s + word.slice(i + 1))
  })
  return out
}

async function run() {
  const only = new URLSearchParams(location.search).get('only')
  const enhancer = new Enhancer()
  const cases = [
    ...VALIDATION.filter((c) => c.name === 'wordmark with tiny tagline').flatMap((c) => [null, 0.75].map((q) => ({ c, q }))),
    ...CASES.filter((c) => /sans (10|12|16)px|serif (12|16)px|badge (200|300)px/.test(c.name)).map((c) => ({ c, q: null as number | null })),
  ].filter(({ c }) => !only || c.name.includes(only))
  for (const [n, { c, q }] of cases.entries()) {
    const name = `${c.name} ${q ?? 'png'}`
    status.textContent = `${n + 1} of ${cases.length}: ${name}`
    const src = await loadImage(await input(c, q), name)
    const up = await enhancer.upscale(name, bitmapToImageData(src.bitmap), '2x').catch(() => null)
    const sharp = up ? await createImageBitmap(up) : null
    const report = await findText(sharp ?? src.bitmap, [])
    if (sharp) report.scale *= sharp.width / src.width
    for (const line of await matchFonts(report, [])) {
      const match = line.matches[0]
      if (!match) continue
      for (const shape of line.shapes) {
        // Glyph labels must line up with the word's letters to forge them one by one.
        const letters = shape.glyphs.filter((g) => /[\p{L}\p{N}]/u.test(g.char)).map((g) => g.char).join('')
        if (letters !== shape.text.replace(/[^\p{L}\p{N}]/gu, '')) continue
        const single = { ...line, shapes: [shape] }
        const honest = (await placeLine(report, single, match)).words[0]
        if (honest) correct.push({ case: name, word: shape.text, flagged: !!honest.doubts?.length, why: (honest.doubts ?? []).map((d) => (d.at < 0 ? `reads ${d.rival}` : `${d.char}→${d.rival}`)).join(', ') })
        for (const f of forgeries(letters)) {
          // The k-th letter glyph gets the k-th forged letter; the pixels stay the real ones.
          let k = 0
          const forgedLine: TextLine = { ...line, shapes: [{ ...shape, text: f, readings: undefined, glyphs: shape.glyphs.map((g) => (/[\p{L}\p{N}]/u.test(g.char) ? { ...g, char: f[k++] } : g)) }] }
          const w = (await placeLine(report, forgedLine, match)).words[0]
          // Not placed at all (the forged letter doesn't line up) also means it isn't rebuilt.
          results.push({ case: name, word: shape.text, forged: f, flagged: !w || !!w.doubts?.length, why: w ? (w.doubts ?? []).map((d) => `${d.char}→${d.rival} ${d.fit}/${d.rivalFit}`).join(', ') : 'not placed' })
        }
      }
    }
    sharp?.close()
    render()
  }
  status.textContent = `Done: ${results.length} forged misreadings over ${cases.length} cases.`
  enhancer.dispose()
}

function render() {
  const caught = results.filter((r) => r.flagged).length
  const missed = results.filter((r) => !r.flagged)
  const digitMissed = missed.filter((r) => /\d/.test(r.word))
  const key = results.find((r) => r.word === '1998' && r.forged === '1898')
  const alarms = correct.filter((c) => c.flagged)
  out.innerHTML = `<p><b>${caught} of ${results.length}</b> forged misreadings flagged (${digitMissed.length} digit misreadings missed). "1998" read as "1898": <b class="${key ? (key.flagged ? 'up' : 'down') : ''}">${key ? (key.flagged ? 'FLAGGED' : 'MISSED') : 'not tested'}</b>. Correct readings flagged (false alarms): ${alarms.length} of ${correct.length}.</p>
${missed.length ? `<p class="down">Missed: ${missed.map((r) => `${r.case}: ${r.word}→${r.forged}`).join('; ')}</p>` : ''}
${alarms.length ? `<p><small>False alarms: ${alarms.map((a) => `${a.case}: ${a.word} [${a.why}]`).join('; ')}</small></p>` : ''}`
}

void run()
