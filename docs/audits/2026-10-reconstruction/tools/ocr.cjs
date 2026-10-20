// Lettering check: OCR (Tesseract, English, local data) on the reference and on the vector result,
// rendered by librsvg via sharp (a renderer independent of the browser). Compares the words found.
//   node ocr.cjs <audit dir> <node_modules dir> id:expected text,...
const fs = require('fs')
const path = require('path')
const [A, NM, ...specs] = process.argv.slice(2)
const sharp = require(path.join(NM, 'sharp'))
const { createWorker } = require(path.join(NM, 'tesseract.js'))
const M = JSON.parse(fs.readFileSync(`${A}/manifest.json`, 'utf8'))
const norm = (s) => s.toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
function lev(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
  return d[a.length][b.length]
}
// Share of the expected text's characters recovered (1 - edit distance / length), best window.
function score(found, expected) {
  const f = norm(found).replace(/ /g, ''), e = norm(expected).replace(/ /g, '')
  if (!e.length) return null
  let best = Infinity
  for (let s = 0; s <= Math.max(0, f.length - e.length); s++) best = Math.min(best, lev(f.slice(s, s + e.length), e))
  if (f.length < e.length) best = lev(f, e)
  return +Math.max(0, 1 - best / e.length).toFixed(2)
}
;(async () => {
  const w = await createWorker('eng', 1, { langPath: path.join(NM, '@tesseract.js-data/eng/4.0.0_best_int'), gzip: true, cachePath: path.join(A, '.ocr-cache') })
  await w.setParameters({ tessedit_pageseg_mode: '11' })
  const out = {}
  for (const spec of specs) {
    const [idv, expected] = spec.split(':')
    const [id, variant = ''] = idv.split('@')
    const m = M.find((x) => x.id === id)
    const dir = `${A}/out/${id}${variant}`
    const svgFile = fs.readdirSync(dir).find((f) => f.startsWith('website--') && f.endsWith('.svg'))
    const truthFile = `${A}/${m.truth}`
    const meta = await sharp(truthFile).metadata()
    // OCR at 3x the reference so small lettering has enough pixels for the recogniser.
    const W = meta.width * 3, H = meta.height * 3
    const truthPng = await sharp(truthFile).resize(W, H, { kernel: 'lanczos3' }).flatten({ background: '#ffffff' }).png().toBuffer()
    const vecPng = await sharp(fs.readFileSync(`${dir}/${svgFile}`), { density: 72 * 3 * (meta.width / (await sharp(fs.readFileSync(`${dir}/${svgFile}`)).metadata()).width) }).resize(W, H).flatten({ background: '#ffffff' }).png().toBuffer()
    fs.writeFileSync(`${A}/report/${id}${variant}/ocr-vector.png`, vecPng)
    const t = (await w.recognize(truthPng)).data.text
    const v = (await w.recognize(vecPng)).data.text
    out[id + variant] = { expected, reference: norm(t), vector: norm(v), referenceScore: score(t, expected), vectorScore: score(v, expected) }
    console.log(id + variant, JSON.stringify(out[id + variant]))
  }
  fs.writeFileSync(`${A}/ocr.json`, JSON.stringify(out, null, 1))
  await w.terminate()
})()
