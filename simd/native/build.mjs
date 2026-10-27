// Builds the three native shootout engines (simd/native/README.md). Toolchains are looked for in
// %USERPROFILE%\simd-tools (llvm-mingw, Highway, .NET SDK) and ~/.cargo/bin (Rust); on Linux and
// macOS, clang++ and dotnet on the PATH are used instead.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const tools = join(homedir(), 'simd-tools')
const win = process.platform === 'win32'
const exe = win ? '.exe' : ''
const only = process.argv.slice(2)
const want = (name) => !only.length || only.includes(name)
const run = (cmd, args, cwd, env = {}) => execFileSync(cmd, args, { cwd, stdio: 'inherit', env: { ...process.env, ...env } })

if (want('highway')) {
  const mingw = win && readdirSync(tools).find((d) => d.startsWith('llvm-mingw-'))
  const cxx = mingw ? join(tools, mingw, 'bin', 'x86_64-w64-mingw32-clang++.exe') : 'clang++'
  const hwy = process.env.HIGHWAY_DIR ?? join(tools, 'highway')
  const dir = join(here, 'cpp-highway')
  mkdirSync(join(dir, 'build'), { recursive: true })
  // No -march: Highway compiles every x86 target and picks one at run time.
  run(cxx, ['-O3', '-std=c++17', '-fno-exceptions', ...(win ? ['-static'] : []), '-I', dir, '-I', hwy, 'blur.cc', 'main.cc',
    ...['targets', 'per_target', 'abort', 'print', 'timer'].map((f) => join(hwy, 'hwy', `${f}.cc`)),
    ...(win ? ['-lpsapi'] : []), '-o', join('build', `blur-highway${exe}`)], dir)
  console.log('built cpp-highway/build/blur-highway' + exe)
}

if (want('pulp')) {
  const cargoBin = join(homedir(), '.cargo', 'bin')
  run(join(cargoBin, `cargo${exe}`), ['build', '--release'], join(here, 'rust-pulp'), { PATH: `${cargoBin}${win ? ';' : ':'}${process.env.PATH}` })
  console.log('built rust-pulp/target/release/blur-pulp' + exe)
}

if (want('dotnet')) {
  const local = join(tools, 'dotnet', `dotnet${exe}`)
  run(existsSync(local) ? local : 'dotnet', ['build', '-c', 'Release'], join(here, 'csharp'), { DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' })
  console.log('built csharp/bin/Release/net10.0/blur-dotnet.dll')
}
