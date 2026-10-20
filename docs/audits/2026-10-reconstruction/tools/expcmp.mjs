// Scores probe/<id>--<label>/result.svg against the reference (same scorer as stagecmp).
import { chromium } from 'playwright-core'
import fs from 'fs'
import { execFileSync } from 'child_process'
const [A, labels] = process.argv.slice(2)
const M = JSON.parse(fs.readFileSync(`${A}/manifest.json`, 'utf8'))
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' })
const page = await b.newPage()
await page.setContent('<html><body></body></html>')
await page.addScriptTag({ content: fs.readFileSync(new URL('./compare-page.js', import.meta.url), 'utf8') })
const b64 = (f, t) => `data:${t};base64,${fs.readFileSync(f).toString('base64')}`
const out = {}
for (const m of M) {
  for (const label of labels.split(',')) {
    const f = `${A}/probe/${m.id}--${label}/result.svg`
    if (!fs.existsSync(f)) continue
    const tf = `${A}/${m.truth}`
    const [w, h] = execFileSync('identify', ['-format', '%w %h', tf]).toString().split(' ').map(Number)
    const svg = fs.readFileSync(f, 'utf8')
    const r = await page.evaluate((a) => window.score(a), { truth: b64(tf, 'image/png'), w, h, scale: m.truthScale, truthBg: m.truthBg ?? null, regions: m.regions ?? {}, src: b64(f, 'image/svg+xml') })
    r.paths = (svg.match(/<path/g) ?? []).length
    r.nodes = (svg.match(/[MLC]/g) ?? []).length
    out[`${m.id}|${label}`] = r
  }
}
fs.writeFileSync(`${A}/probe/expcmp.json`, JSON.stringify(out, null, 1))
await b.close()
console.log(Object.keys(out).length, 'scored')
