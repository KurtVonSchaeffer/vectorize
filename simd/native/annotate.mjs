// Posts the shootout's results as GitHub Actions notice annotations (simd/native/README.md): unlike
// the job summary and artifacts, annotations on a public repository can be read without a login.
//   node simd/native/annotate.mjs
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const out = join(new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'out')
const read = (f) => (existsSync(join(out, f)) ? readFileSync(join(out, f), 'utf8').trim() : null)
const notice = (title, text) => console.log(`::notice title=${title}::${text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}`)

const machine = read('machine.txt')
if (machine) notice('SIMD machine', machine)
const md = read('results.md')
if (md) notice('SIMD results', md)

// Every round's median per case and engine, so the spread between rounds can be judged.
const jsonl = read('results.jsonl')
if (jsonl) {
  const rows = jsonl.split('\n').map((l) => JSON.parse(l))
  const lines = new Map()
  for (const r of rows) {
    const key = `${r.case} | ${r.engine} | ${r.target}`
    lines.set(key, [...(lines.get(key) ?? []), `${r.median_ms.toFixed(2)} (min ${r.min_ms.toFixed(2)}, p90 ${r.p90_ms.toFixed(2)}, ${Math.round(r.peak_mb)} MB)`])
  }
  notice('SIMD rounds', [...lines].map(([k, v]) => `${k}: ${v.join('; ')}`).join('\n'))
}

const verify = read('verify.json')
if (verify) notice('SIMD verify', JSON.parse(verify).map((r) => `${r.case} | ${r.engine} | same paths ${r['same paths']} | max move ${r['max coordinate change (px)']} px | unused ${r['unused outputs']}`).join('\n'))
