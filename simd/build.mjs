// Builds the tracer's WebAssembly SIMD blur (simd/README.md) into public/simd/blur-highway.wasm.
// Emscripten and Highway are looked for in %USERPROFILE%\simd-tools.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const out = join(root, 'public', 'simd')
const tools = join(homedir(), 'simd-tools')
mkdirSync(out, { recursive: true })

function emsdkPython() {
  const dir = join(tools, 'emsdk', 'python')
  if (process.platform !== 'win32' || !existsSync(dir)) return undefined
  const version = readdirSync(dir).find((d) => existsSync(join(dir, d, 'python.exe')))
  return version && join(dir, version, 'python.exe')
}

const emcc = join(tools, 'emsdk', 'upstream', 'emscripten', process.platform === 'win32' ? 'emcc.exe' : 'emcc')
if (!existsSync(emcc)) {
  console.error('Emscripten not found in', join(tools, 'emsdk'))
  process.exit(1)
}
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
