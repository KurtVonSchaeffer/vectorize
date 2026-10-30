// Builds the tracer's WebAssembly SIMD blur engines (simd/README.md) into public/simd/:
// blur-highway.wasm, blur-wide.wasm, blur-fearless.wasm. Name engines to build only those:
//   node simd/build.mjs highway
// Emscripten and Highway are looked for in %USERPROFILE%\simd-tools, Rust in %USERPROFILE%\.cargo\bin.
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const out = join(root, 'public', 'simd')
const tools = join(homedir(), 'simd-tools')
const cargoBin = join(homedir(), '.cargo', 'bin')
const exe = process.platform === 'win32' ? '.exe' : ''
mkdirSync(out, { recursive: true })

const only = process.argv.slice(2)
const want = (name) => !only.length || only.includes(name)

function emsdkPython() {
  const dir = join(tools, 'emsdk', 'python')
  if (process.platform !== 'win32' || !existsSync(dir)) return undefined
  const version = readdirSync(dir).find((d) => existsSync(join(dir, d, 'python.exe')))
  return version && join(dir, version, 'python.exe')
}

const emcc = join(tools, 'emsdk', 'upstream', 'emscripten', process.platform === 'win32' ? 'emcc.exe' : 'emcc')
if (want('highway') && !existsSync(emcc)) {
  console.error('Emscripten not found in', join(tools, 'emsdk'))
  process.exit(1)
}
if (want('highway')) {
  execFileSync(emcc, [
    join(root, 'simd', 'cpp-highway', 'blur.cc'),
    '-I', join(tools, 'highway'),
    '-O3', '-msimd128', '-std=c++17', '-fno-exceptions',
    '-DHWY_COMPILE_ONLY_STATIC=1',
    // Fixed memory: growing it detaches its ArrayBuffer, and one detached buffer makes V8 check every
    // typed-array access in the worker from then on, which slows the quantizer far more than this saves.
    // 128 MB holds the three buffers of a 10-megapixel blur; larger ones fail to allocate and the
    // TypeScript blur runs instead.
    '--no-entry', '-sSTANDALONE_WASM', '-sALLOW_MEMORY_GROWTH=0', '-sINITIAL_MEMORY=128MB', '-sABORTING_MALLOC=0',
    '-sEXPORTED_FUNCTIONS=_blur,_alloc,_release',
    '-o', join(out, 'blur-highway.wasm'),
  ], {
    stdio: 'inherit',
    // emcc runs on Python: on Windows, the one emsdk installed alongside it.
    env: { ...process.env, ...(emsdkPython() ? { EMSDK_PYTHON: emsdkPython() } : {}) },
  })
  console.log('built public/simd/blur-highway.wasm')
}

// Rust engines: memory grows as they allocate (simd/README.md, Memory).
for (const [dir, crate, name] of [['rust-wide', 'blur_wide', 'wide'], ['rust-fearless', 'blur_fearless', 'fearless']]) {
  if (!want(`rust-${name}`)) continue
  const cwd = join(root, 'simd', dir)
  execFileSync(join(cargoBin, `cargo${exe}`), ['build', '--release', '--target', 'wasm32-unknown-unknown'], {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, PATH: `${cargoBin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`, RUSTFLAGS: '-C target-feature=+simd128' },
  })
  copyFileSync(join(cwd, 'target', 'wasm32-unknown-unknown', 'release', `${crate}.wasm`), join(out, `blur-${name}.wasm`))
  console.log(`built public/simd/blur-${name}.wasm`)
}
