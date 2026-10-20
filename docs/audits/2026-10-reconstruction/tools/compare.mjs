// Visual accuracy and editability of each result, measured in Chromium against the reference image
// (the upload as found, or a 2x render of the vector master). Independent of Vectorize's code.
//   node compare.mjs <audit dir> [ids] [--variant=--one]
// For each image: metrics.json and gallery images in report/<id>/.
import { chromium } from 'playwright-core'
import fs from 'fs'
import { execFileSync } from 'child_process'

const A = process.argv[2]
const onlyArg = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : null
const variant = (process.argv.find((a) => a.startsWith('--variant=')) ?? '--variant=').slice(10)
const M = JSON.parse(fs.readFileSync(`${A}/manifest.json`, 'utf8'))
const ids = onlyArg ? onlyArg.split(',') : M.map((m) => m.id)
const b64 = (f) => fs.readFileSync(f).toString('base64')
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' })
const page = await b.newPage()
page.on('console', (m) => m.type() === 'error' && console.log('page:', m.text()))
await page.setContent('<html><body></body></html>')
await page.addScriptTag({ content: fs.readFileSync(new URL('./compare-page.js', import.meta.url), 'utf8') })

for (const id of ids) {
  const m = M.find((x) => x.id === id)
  const dir = `${A}/out/${id}${variant}`
  if (!fs.existsSync(dir)) { console.log(id, 'no output'); continue }
  const files = fs.readdirSync(dir)
  const master = files.find((f) => f.startsWith('website--') && f.endsWith('.svg')) ?? files.find((f) => f.startsWith('print--') && f.endsWith('.svg'))
  const printPdf = files.find((f) => f.startsWith('print--') && f.endsWith('.pdf'))
  if (!master) { console.log(id, 'no svg'); continue }
  const out = `${A}/report/${id}${variant}`
  fs.mkdirSync(out, { recursive: true })
  const truthFile = `${A}/${m.truth}`
  const size = execFileSync('identify', ['-format', '%w %h', truthFile]).toString().split(' ').map(Number)
  // The print PDF, rendered by poppler (independent of the browser) at the reference size.
  let pdfPng = null
  if (printPdf) {
    const prefix = `${out}/pdf-render`
    execFileSync('pdftoppm', ['-png', '-singlefile', '-scale-to-x', String(size[0]), '-scale-to-y', String(size[1]), `${dir}/${printPdf}`, prefix])
    pdfPng = `data:image/png;base64,${b64(prefix + '.png')}`
  }
  const res = await page.evaluate(
    (args) => window.audit(args),
    {
      truth: `data:image/png;base64,${b64(truthFile)}`,
      upload: `data:image/${m.file.endsWith('.jpg') ? 'jpeg' : 'png'};base64,${b64(`${A}/in/${m.file}`)}`,
      svg: fs.readFileSync(`${dir}/${master}`, 'utf8'),
      pdf: pdfPng,
      w: size[0], h: size[1], scale: m.truthScale, truthBg: m.truthBg ?? null, regions: m.regions ?? {},
    },
  )
  for (const [k, v] of Object.entries(res.images)) fs.writeFileSync(`${out}/${k}.png`, Buffer.from(v.split(',')[1], 'base64'))
  delete res.images
  res.id = id + variant
  res.master = master
  fs.writeFileSync(`${out}/metrics.json`, JSON.stringify(res, null, 1))
  const s = res.colour, e = res.edges
  console.log(`${id}${variant}: dE mean ${s.meanAll} p95 ${s.p95All} | edges in 1px ${e.truthWithin1}% (spurious ${e.vectorWithin1}%) | IoU ${res.shape.iou} | defects ${res.defects.length} | paths ${res.edit.paths} hidden ${res.edit.hiddenPaths} | recolour ${res.edit.recolourPure}% | AA 1x ${res.edit.aa1}% 8x ${res.edit.aa8}% | pdf dE ${res.pdf?.meanAll ?? '-'}`)
}
await b.close()
