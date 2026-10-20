// Drives the production build (main at 4926f81) like a customer: upload, keep the default settings,
// and download every file from every purpose (Website, Print, Cutting). With "one", switches Color
// mode to One color first. Records what the page says. Writes out/<id>[--one]/ and run.json.
import { chromium } from 'playwright-core'
import fs from 'fs'
import path from 'path'

const [A, port, mode = 'default', only] = process.argv.slice(2)
const M = JSON.parse(fs.readFileSync(`${A}/manifest.json`, 'utf8'))
const ids = only ? only.split(',') : M.map((m) => m.id)
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' })
const ready = async (p) => {
  await p.waitForTimeout(1200)
  await p.waitForFunction(() => {
    const x = [...document.querySelectorAll('button')].find((y) => y.textContent?.trim().startsWith('Download'))
    return x && !x.disabled && !/Working|Tracing|Reading/.test(document.body.innerText)
  }, null, { timeout: 300000 })
  await p.waitForTimeout(800)
}
const save = async (p, which, dir, role) => {
  const loc = which === 0 ? p.locator('button:has-text("Download")').first() : p.locator('button:has-text("Also get")').first()
  if (!(await loc.count())) return null
  const [d] = await Promise.all([p.waitForEvent('download', { timeout: 120000 }), loc.click()])
  const f = path.join(dir, `${role}--${d.suggestedFilename()}`)
  await d.saveAs(f)
  return path.basename(f)
}
const results = fs.existsSync(`${A}/run-${mode}.json`) ? JSON.parse(fs.readFileSync(`${A}/run-${mode}.json`, 'utf8')) : {}
for (const id of ids) {
  const m = M.find((x) => x.id === id)
  const dir = `${A}/out/${id}${mode === 'one' ? '--one' : ''}`
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const ctx = await b.newContext({ viewport: { width: 1440, height: 1300 }, acceptDownloads: true })
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  const r = { id, mode, errors, files: {} }
  const t0 = Date.now()
  try {
    await p.goto(`http://localhost:${port}/`)
    await p.setInputFiles('input[type=file]', `${A}/in/${m.file}`)
    await ready(p)
    r.ms = Date.now() - t0
    if (mode === 'one') {
      if (!(await p.locator('button:text-is("One color")').count())) throw new Error('One color not offered for this image')
      await p.locator('button:text-is("One color")').click()
      await ready(p)
    }
    const body = await p.locator('body').innerText()
    r.pressed = await p.locator('button[aria-pressed="true"]').allInnerTexts()
    r.notes = body.split('\n').map((l) => l.trim()).filter((l) => l.length > 25 && /color|colour|ink|traced|letter|gradient|shape|detail|photo|line|kept|smooth|sharpen/i.test(l)).slice(0, 14)
    await p.screenshot({ path: `${dir}/app.png`, fullPage: true })
    for (const purpose of ['Website', 'Print', 'Cutting']) {
      const btn = p.locator(`button[aria-pressed]:has-text("${purpose}")`).first()
      if (!(await btn.count())) continue
      await btn.click()
      await ready(p)
      r.files[purpose] = [await save(p, 0, dir, purpose.toLowerCase()), await save(p, 1, dir, purpose.toLowerCase())].filter(Boolean)
    }
  } catch (e) {
    r.failure = String(e.message || e).split('\n')[0]
    await p.screenshot({ path: `${dir}/FAILED.png`, fullPage: true }).catch(() => {})
  }
  results[id] = r
  fs.writeFileSync(`${A}/run-${mode}.json`, JSON.stringify(results, null, 1))
  console.log(id, r.failure ? 'FAIL ' + r.failure : `${r.ms} ms`, JSON.stringify(r.files), errors.length ? 'ERR ' + errors[0] : '')
  await ctx.close()
}
await b.close()
