// Drives bench/audit-probe for each job in a JSON spec; writes probe/<id>--<variant>/<feature>/NN.png + stats.json.
// Checks the hooked default run still matches the production download geometry.
import { chromium } from 'playwright-core'
import fs from 'fs'
const [A, port, specFile] = process.argv.slice(2)
const M = JSON.parse(fs.readFileSync(`${A}/manifest.json`, 'utf8'))
const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'))
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' })
const dsets = (svg) => [...svg.matchAll(/\sd="([^"]+)"/g)].map((m) => m[1]).sort().join('|')
for (const job of spec) {
  const p = await b.newPage()
  p.on('pageerror', (e) => console.log('pageerror', e.message))
  const m = M.find((x) => x.id === job.id)
  const v = job.variant ?? 'default'
  await p.goto(`http://localhost:${port}/bench/audit-probe.html?file=${m.file}&variant=${v}&features=${encodeURIComponent(JSON.stringify(job.features))}${job.analyse ? "&analyse=1&tol=" + (job.tol ?? 1) : ""}${job.trace ? "&trace=" + encodeURIComponent(JSON.stringify(job.trace)) : ""}`)
  await p.waitForFunction(() => ['Done'].includes(document.getElementById('status')?.textContent), null, { timeout: 600000 })
  const r = await p.evaluate(() => window.__probe)
  const dir = `${A}/probe/${job.id}--${job.label ?? v}`
  fs.mkdirSync(dir, { recursive: true })
  if (v === 'default') {
    const prod = fs.readdirSync(`${A}/out/${job.id}`).find((f) => f.startsWith('website--') && f.endsWith('.svg'))
    r.svgMatches = dsets(fs.readFileSync(`${A}/out/${job.id}/${prod}`, 'utf8')) === dsets(r.svg)
  }
  fs.writeFileSync(`${dir}/result.svg`, r.svg)
  for (const f of r.features) {
    const fd = `${dir}/${f.name}`
    fs.mkdirSync(fd, { recursive: true })
    for (const [k, url] of Object.entries(f.panels)) fs.writeFileSync(`${fd}/${k.split(' ')[0]}.png`, Buffer.from(url.split(',')[1], 'base64'))
    f.panelNames = Object.keys(f.panels)
    delete f.panels
  }
  delete r.svg
  fs.writeFileSync(`${dir}/stats.json`, JSON.stringify(r, null, 1))
  if (r.attribution) console.log('ATTR', job.id, job.label ?? v, JSON.stringify(r.attribution))
  console.log(job.id, v, 'matchesProduction', r.svgMatches, 'quant', JSON.stringify(r.quant[0]), 'traceCalls', r.traceCalls)
  for (const f of r.features) console.log('  ', f.name, JSON.stringify(f.stats).slice(0, 600))
  await p.close()
}
await b.close()
