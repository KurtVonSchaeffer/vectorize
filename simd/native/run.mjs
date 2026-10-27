// Runs the native SIMD shootout (simd/native/README.md): every engine on every recorded case, for a
// number of rounds, engines in a different order each round so heat and clock changes even out.
// Each run is pinned to one core at high priority. Results go to out/results.jsonl and out/results.md.
//   node simd/native/run.mjs [rounds=5] [cpu=2]
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const root = join(here, '..', '..')
const rounds = +(process.argv[2] ?? 5)
const cpu = +(process.argv[3] ?? 2)
const win = process.platform === 'win32'
const exe = win ? '.exe' : ''
const data = join(here, 'data')
const out = join(here, 'out')
const recorded = JSON.parse(readFileSync(join(data, 'cases.json'), 'utf8'))
const cases = recorded.map((c) => c.case)
// Fewer timed passes for the biggest images, as in baseline.test.ts.
const repsFor = (c) => (recorded.find((r) => r.case === c).size.split('×').reduce((a, b) => a * b) > 4e6 ? 15 : 30)
const dotnet = existsSync(join(homedir(), 'simd-tools', 'dotnet', `dotnet${exe}`)) ? join(homedir(), 'simd-tools', 'dotnet', `dotnet${exe}`) : 'dotnet'

const ENGINES = [
  { id: 'highway', cmd: [join(here, 'cpp-highway', 'build', `blur-highway${exe}`)] },
  { id: 'pulp', cmd: [join(here, 'rust-pulp', 'target', 'release', `blur-pulp${exe}`)] },
  { id: 'dotnet', cmd: [dotnet, join(here, 'csharp', 'bin', 'Release', 'net10.0', 'blur-dotnet.dll')] },
]

// Engines that failed to build are left out (build.mjs reports why).
for (const e of ENGINES.filter((e) => !existsSync(e.cmd.at(-1)))) console.log(`${process.env.GITHUB_ACTIONS ? "::warning::" : ""}${e.id} not built, skipped`)
const BUILT = ENGINES.filter((e) => existsSync(e.cmd.at(-1)))

/** One process, pinned to `cpu` at high priority. */
function pinned(cmd, args, env = {}) {
  const [file, ...rest] = win
    ? ['cmd.exe', '/d', '/c', 'start', '""', '/b', '/wait', '/high', '/affinity', (1 << cpu).toString(16), ...cmd, ...args]
    : ['taskset', '-c', String(cpu), ...cmd, ...args]
  const r = spawnSync(file, rest, { encoding: 'utf8', cwd: root, env: { ...process.env, ...env }, shell: false, maxBuffer: 1 << 24 })
  if (r.status !== 0) throw new Error(`${cmd.join(' ')} ${args.join(' ')} failed (${r.status}): ${r.stderr || r.stdout}`)
  return r.stdout
}

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
const results = join(out, 'results.jsonl')
for (let round = 0; round < rounds; round++) {
  const order = [...BUILT.slice(round % BUILT.length), ...BUILT.slice(0, round % BUILT.length)]
  for (const e of order) {
    mkdirSync(join(out, e.id), { recursive: true })
    for (const c of cases) {
      const reps = repsFor(c)
      const line = pinned(e.cmd, [join(data, `${c}.bin`), join(data, `${c}.ref`), round === 0 ? join(out, e.id, `${c}.out`) : '-', String(reps)]).trim().split('\n').pop()
      appendFileSync(results, JSON.stringify({ ...JSON.parse(line), case: c, round }) + '\n')
      console.log(`round ${round + 1}/${rounds} ${e.id} ${c}: ${JSON.parse(line).median_ms.toFixed(2)} ms`)
    }
  }
  pinned([win ? 'npx.cmd' : 'npx'], ['vitest', 'run', 'simd/native/baseline.test.ts'], { BASELINE: '1', ROUND: String(round) })
  console.log(`round ${round + 1}/${rounds} baselines done`)
}

// Summary: per case and engine, the median over rounds of each round's median.
const rows = readFileSync(results, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
const med = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1]
const engines = [...new Set(rows.map((r) => r.engine))]
const big = recorded.reduce((a, b) => (b['blurred px'] > a['blurred px'] ? b : a)).case
const ts = (c) => med(rows.filter((r) => r.case === c && r.engine === 'typescript').map((r) => r.median_ms))
let md = `| Case | ${engines.join(' | ')} |\n| --- | ${engines.map(() => '---').join(' | ')} |\n`
for (const c of cases) {
  md += `| ${c} | ` + engines.map((e) => {
    const rs = rows.filter((r) => r.case === c && r.engine === e)
    const m = med(rs.map((r) => r.median_ms))
    return `${m.toFixed(2)} ms (${(ts(c) / m).toFixed(1)}×), diff ${Math.max(...rs.map((r) => r.max_diff)).toExponential(0)}, flips ${Math.max(...rs.map((r) => r.flips))}`
  }).join(' | ') + ' |\n'
}
md += `\nTargets: ${engines.map((e) => `${e}: ${rows.find((r) => r.engine === e).target}`).join('; ')}\n`
md += `Peak working set on ${big}: ${engines.map((e) => `${e} ${med(rows.filter((r) => r.case === big && r.engine === e).map((r) => r.peak_mb)).toFixed(0)} MB`).join(', ')}\n`
writeFileSync(join(out, 'results.md'), md)
console.log('\n' + md)
