// Copies the OCR engine (Tesseract.js worker, core and English data) into public/ so the app
// serves it itself: text recognition stays on the user's computer, works offline, and avoids
// cross-origin worker restrictions under the app's isolation headers.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'public', 'ocr')
mkdirSync(out, { recursive: true })
const files = [
  ['node_modules/tesseract.js/dist/worker.min.js', 'worker.min.js'],
  ...['tesseract-core-simd-lstm', 'tesseract-core-lstm', 'tesseract-core-relaxedsimd-lstm'].flatMap((n) => [
    [`node_modules/tesseract.js-core/${n}.js`, `${n}.js`],
    [`node_modules/tesseract.js-core/${n}.wasm`, `${n}.wasm`],
    [`node_modules/tesseract.js-core/${n}.wasm.js`, `${n}.wasm.js`],
  ]),
  ['node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz', 'eng.traineddata.gz'],
]
for (const [from, to] of files) {
  const src = join(root, from)
  if (existsSync(src)) copyFileSync(src, join(out, to))
  else console.warn(`missing ${from}`)
}
