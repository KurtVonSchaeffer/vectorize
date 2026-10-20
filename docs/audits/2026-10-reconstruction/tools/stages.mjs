// Runs bench/audit-stages (dev server) and saves each stage: stages/<id>--<variant>/{input.png,map.png,result.svg,info.json}.
// Also checks the default variant reproduces the production download (same path geometry).
import { chromium } from 'playwright-core'
import fs from 'fs'
const [A, port, jobs] = process.argv.slice(2)
const M = JSON.parse(fs.readFileSync(`${A}/manifest.json`, 'utf8'))
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' })
const p = await b.newPage()
p.on('pageerror', (e) => console.log('pageerror', e.message))
const specs = jobs.split(',').map((j) => { const [id, v = 'default'] = j.split('|'); return { id, v, file: M.find((m) => m.id === id).file } })
await p.goto(`http://localhost:${port}/bench/audit-stages.html?jobs=${encodeURIComponent(specs.map((s) => `${s.file}|${s.v}`).join(','))}`)
await p.waitForFunction(() => document.getElementById('status')?.textContent === 'Done', null, { timeout: 1800000 })
const res = await p.evaluate(() => window.__stages)
const dsets = (svg) => [...svg.matchAll(/\sd="([^"]+)"/g)].map((m) => m[1]).sort().join('|')
for (const [k, r] of res.entries()) {
  const { id, v } = specs[k]
  const dir = `${A}/stages/${id}--${v}`
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(`${dir}/input.png`, Buffer.from(r.input.split(',')[1], 'base64'))
  if (r.map) fs.writeFileSync(`${dir}/map.png`, Buffer.from(r.map.split(',')[1], 'base64'))
  fs.writeFileSync(`${dir}/result.svg`, r.svg)
  let same = null
  if (v === 'default') {
    const prodDir = `${A}/out/${id}`
    const prod = fs.readdirSync(prodDir).find((f) => f.startsWith('website--') && f.endsWith('.svg'))
    same = dsets(fs.readFileSync(`${prodDir}/${prod}`, 'utf8')) === dsets(r.svg)
  }
  const info = { id, variant: v, kind: r.kind, det: r.det, jobKind: r.jobKind, size: r.size, colours: r.colours, ms: r.ms, paths: (r.svg.match(/<path/g) ?? []).length, matchesProduction: same }
  fs.writeFileSync(`${dir}/info.json`, JSON.stringify(info, null, 1))
  console.log(JSON.stringify(info))
}
await b.close()
