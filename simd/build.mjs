// Builds the SIMD bake-off modules (simd/README.md) into public/simd/. Toolchains are looked for in
// %USERPROFILE%\simd-tools (Emscripten, Highway) and %USERPROFILE%\.cargo\bin (Rust).
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const out = join(root, 'public', 'simd')
const tools = join(homedir(), 'simd-tools')
const cargoBin = join(homedir(), '.cargo', 'bin')
const exe = process.platform === 'win32' ? '.exe' : ''
mkdirSync(out, { recursive: true })

function emsdkPython() {
  const dir = join(tools, 'emsdk', 'python')
  if (process.platform !== 'win32' || !existsSync(dir)) return undefined
  const version = readdirSync(dir).find((d) => existsSync(join(dir, d, 'python.exe')))
  return version && join(dir, version, 'python.exe')
}

const only = process.argv.slice(2)
const want = (name) => !only.length || only.includes(name)

for (const [dir, crate, name] of [['rust-wide', 'blur_wide', 'wide'], ['rust-fearless', 'blur_fearless', 'fearless']]) {
  if (!want(name)) continue
  const cwd = join(root, 'simd', dir)
  execFileSync(join(cargoBin, `cargo${exe}`), ['build', '--release', '--target', 'wasm32-unknown-unknown'], {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, PATH: `${cargoBin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`, RUSTFLAGS: '-C target-feature=+simd128' },
  })
  copyFileSync(join(cwd, 'target', 'wasm32-unknown-unknown', 'release', `${crate}.wasm`), join(out, `blur-${name}.wasm`))
  console.log(`built public/simd/blur-${name}.wasm`)
}

if (want('highway')) {
  const emcc = join(tools, 'emsdk', 'upstream', 'emscripten', process.platform === 'win32' ? 'emcc.exe' : 'emcc')
  if (!existsSync(emcc)) {
    console.warn('skipped highway: Emscripten not found in', join(tools, 'emsdk'))
  } else {
    execFileSync(emcc, [
      join(root, 'simd', 'cpp-highway', 'blur.cc'),
      '-I', join(tools, 'highway'),
      '-O3', '-msimd128', '-std=c++17', '-fno-exceptions',
      '-DHWY_COMPILE_ONLY_STATIC=1',
      '--no-entry', '-sSTANDALONE_WASM', '-sALLOW_MEMORY_GROWTH=1',
      '-sEXPORTED_FUNCTIONS=_blur,_alloc,_release',
      '-o', join(out, 'blur-highway.wasm'),
    ], {
      stdio: 'inherit',
      // emcc runs on Python: on Windows, the one emsdk installed alongside it.
      env: { ...process.env, ...(emsdkPython() ? { EMSDK_PYTHON: emsdkPython() } : {}) },
    })
    console.log('built public/simd/blur-highway.wasm')
  }
}
