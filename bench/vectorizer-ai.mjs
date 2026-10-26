// Side-by-side with Vectorizer.AI (docs/admin-panel.md, "A second engine"): sends every image in a
// folder to its API in free test mode and saves the SVGs next to a copy of each input, so the
// Layout team can compare them with this app's output in bench/real.html or CorelDRAW.
//
//   VECTORIZER_AI_ID=… VECTORIZER_AI_SECRET=… node bench/vectorizer-ai.mjs <images folder> [out folder] [--mode test|test_preview|production]
//
// Only Barron's own artwork: the vendor's terms (23 Oct 2025) allow training on uploads, with no
// opt-out, and there is no data-processing agreement for customer logos (POPIA). `test` mode is
// free and watermarked; `production` spends a credit per image, so it needs --mode production.
import { mkdir, readdir, readFile, writeFile, copyFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'

const ENDPOINT = 'https://api.vectorizer.ai/api/v1/vectorize'
const IMAGES = /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i
const MAX_BYTES = 30 * 1024 * 1024

const args = process.argv.slice(2)
const modeAt = args.indexOf('--mode')
const mode = modeAt >= 0 ? args.splice(modeAt, 2)[1] : 'test'
const [input, output = 'bench-out/vectorizer-ai'] = args
const id = process.env.VECTORIZER_AI_ID
const secret = process.env.VECTORIZER_AI_SECRET

if (!input || !id || !secret || !['test', 'test_preview', 'production'].includes(mode)) {
  console.error('Usage: VECTORIZER_AI_ID=… VECTORIZER_AI_SECRET=… node bench/vectorizer-ai.mjs <images folder> [out folder] [--mode test|test_preview|production]')
  process.exit(1)
}

const auth = 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64')
const files = (await readdir(input)).filter((f) => IMAGES.test(f)).sort()
await mkdir(output, { recursive: true })
const rows = [['file', 'status', 'ms', 'bytes', 'paths', 'error'].join(',')]

for (const file of files) {
  const data = await readFile(join(input, file))
  const name = basename(file, extname(file))
  if (data.length > MAX_BYTES) {
    rows.push([file, 'skipped', '', '', '', 'over 30 MB'].join(','))
    continue
  }
  const body = new FormData()
  body.set('image', new Blob([data]), file)
  body.set('mode', mode)
  body.set('output.file_format', 'svg')
  // Nothing kept on their side beyond the call itself.
  body.set('policy.retention_days', '0')
  const started = performance.now()
  try {
    const res = await fetch(ENDPOINT, { method: 'POST', headers: { Authorization: auth }, body })
    const ms = Math.round(performance.now() - started)
    if (!res.ok) {
      const err = await res.text()
      rows.push([file, res.status, ms, '', '', JSON.stringify(err.slice(0, 200))].join(','))
      console.log(`${file}: failed (${res.status})`)
      continue
    }
    const svg = await res.text()
    await writeFile(join(output, `${name}.vectorizer-ai.svg`), svg)
    await copyFile(join(input, file), join(output, file))
    rows.push([file, 'ok', ms, svg.length, (svg.match(/<path/g) ?? []).length, ''].join(','))
    console.log(`${file}: ${ms} ms`)
  } catch (err) {
    rows.push([file, 'error', '', '', '', JSON.stringify(String(err))].join(','))
    console.log(`${file}: ${err}`)
  }
}

await writeFile(join(output, 'results.csv'), rows.join('\n') + '\n')
console.log(`\n${files.length} images, results in ${join(output, 'results.csv')}`)
