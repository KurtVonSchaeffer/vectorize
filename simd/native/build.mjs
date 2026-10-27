// Builds the three native shootout engines (simd/native/README.md). Toolchains are looked for in
// %USERPROFILE%\simd-tools (llvm-mingw, Highway, .NET SDK) and ~/.cargo/bin (Rust); on Linux and
// macOS, clang++ and dotnet on the PATH are used instead.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const tools = join(homedir(), 'simd-tools')
const win = process.platform === 'win32'
const exe = win ? '.exe' : ''
const only = process.argv.slice(2)
const want = (name) => !only.length || only.includes(name)
const ci = !!process.env.GITHUB_ACTIONS
const failed = []
let built = 0

/**
 * Runs one build. A failure is reported (on GitHub Actions as an annotation with the last lines of
 * output, since job logs need a login) and the other engines still build.
 */
function run(name, cmd, args, cwd, env = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 1 << 26 })
  const text = `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? String(r.error) : ''}`
  process.stdout.write(text)
  if (r.status === 0) {
    built++
    console.log(`built ${name}`)
    return
  }
  failed.push(name)
  const tail = text.trim().split(/\r?\n/).slice(-40).join('\n')
  if (ci) console.log(`::error title=${name} build failed::${tail.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}`)
  else console.error(`${name} build failed`)
}

if (want('highway')) {
  const mingw = win && existsSync(tools) && readdirSync(tools).find((d) => d.startsWith('llvm-mingw-'))
  const cxx = mingw ? join(tools, mingw, 'bin', 'x86_64-w64-mingw32-clang++.exe') : 'clang++'
  const hwy = process.env.HIGHWAY_DIR ?? join(tools, 'highway')
  const dir = join(here, 'cpp-highway')
  mkdirSync(join(dir, 'build'), { recursive: true })
  // No -march: Highway compiles every x86 target and picks one at run time.
  run('highway', cxx, ['-O3', '-std=c++17', '-fno-exceptions', ...(win ? ['-static'] : []), '-I', dir, '-I', hwy, 'blur.cc', 'main.cc',
    ...['targets', 'per_target', 'abort', 'print', 'timer'].map((f) => join(hwy, 'hwy', `${f}.cc`)),
    ...(win ? ['-lpsapi'] : []), '-o', join('build', `blur-highway${exe}`)], dir)
}

if (want('pulp')) {
  const cargoBin = join(homedir(), '.cargo', 'bin')
  run('pulp', join(cargoBin, `cargo${exe}`), ['build', '--release'], join(here, 'rust-pulp'), { PATH: `${cargoBin}${win ? ';' : ':'}${process.env.PATH}` })
}

if (want('dotnet')) {
  const local = join(tools, 'dotnet', `dotnet${exe}`)
  run('dotnet', existsSync(local) ? local : 'dotnet', ['build', '-c', 'Release'], join(here, 'csharp'), { DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' })
}

// run.mjs times whichever engines built and warns about the rest; none at all is a failure.
if (failed.length) console.error(`failed: ${failed.join(', ')}`)
if (!built) process.exit(1)
