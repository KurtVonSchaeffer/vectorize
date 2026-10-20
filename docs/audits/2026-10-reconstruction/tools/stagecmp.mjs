// Scores every captured stage (prepared input, colour map, final SVG) against the reference.
import { chromium } from 'playwright-core'
import fs from 'fs'
import { execFileSync } from 'child_process'
const A = process.argv[2]
const M = JSON.parse(fs.readFileSync(`${A}/manifest.json`, 'utf8'))
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' })
const page = await b.newPage()
await page.setContent('<html><body></body></html>')
await page.addScriptTag({ content: fs.readFileSync(new URL('./compare-page.js', import.meta.url), 'utf8') })
const b64 = (f, t) => `data:${t};base64,${fs.readFileSync(f).toString('base64')}`
const out = {}
for (const d of fs.readdirSync(`${A}/stages`).sort()) {
  const info = JSON.parse(fs.readFileSync(`${A}/stages/${d}/info.json`, 'utf8'))
  const m = M.find((x) => x.id === info.id)
  const tf = `${A}/${m.truth}`
  const [w, h] = execFileSync('identify', ['-format', '%w %h', tf]).toString().split(' ').map(Number)
  const args = { truth: b64(tf, 'image/png'), w, h, scale: m.truthScale, truthBg: m.truthBg ?? null, regions: m.regions ?? {} }
  const r = { info }
  r.input = await page.evaluate((a) => window.score(a), { ...args, src: b64(`${A}/stages/${d}/input.png`, 'image/png') })
  if (fs.existsSync(`${A}/stages/${d}/map.png`)) r.map = await page.evaluate((a) => window.score(a), { ...args, src: b64(`${A}/stages/${d}/map.png`, 'image/png') })
  r.vector = await page.evaluate((a) => window.score(a), { ...args, src: b64(`${A}/stages/${d}/result.svg`, 'image/svg+xml') })
  out[d] = r
  const f = (s) => (s ? `dE ${s.meanDE} edge ${s.edgeRecall1px}% wrong ${s.wrongPct}% ${Object.entries(s.regions).map(([k, v]) => `[${k}: edge ${v.edgeRecall1px}% wrong ${v.wrongPct}%]`).join(' ')}` : '—')
  console.log(`${d.padEnd(28)} INPUT ${f(r.input)}\n${''.padEnd(28)} MAP   ${f(r.map)}\n${''.padEnd(28)} SVG   ${f(r.vector)}`)
}
fs.writeFileSync(`${A}/stages.json`, JSON.stringify(out, null, 1))
await b.close()
