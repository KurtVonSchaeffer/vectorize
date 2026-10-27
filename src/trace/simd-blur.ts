/**
 * The tracer's blur as WebAssembly SIMD, built from C++ with Google Highway (simd/README.md). Behind
 * the simd-blur flag: once load() has finished, blur() in index.ts hands its work here; until then,
 * or if loading fails, the TypeScript blur runs. Same weights, same edges; sums are 32-bit, so
 * values differ from the TypeScript by about 1e-7.
 */
type Exports = {
  memory: WebAssembly.Memory
  alloc: (bytes: number) => number
  release: (ptr: number, bytes: number) => void
  blur: (src: number, out: number, tmp: number, w: number, h: number, k: number, r: number, x0: number, x1: number, y0: number, y1: number, by0: number, by1: number) => void
}

let wasm: Exports | null = null
let loading: Promise<boolean> | null = null
let enabled = false

const URL_ = `${import.meta.env?.BASE_URL ?? '/'}simd/blur-highway.wasm`

/** Loads the module once (resolves false when it can't), and turns it on or off for later blurs. */
export async function useSimdBlur(on: boolean, bytes?: BufferSource): Promise<boolean> {
  enabled = on
  if (!on) return false
  loading ??= (async () => {
    try {
      const source = bytes ?? (await (await fetch(URL_)).arrayBuffer())
      const mod = await WebAssembly.compile(source)
      // Standalone Emscripten output may import WASI calls the blur never makes.
      const imports: Record<string, Record<string, () => number>> = {}
      for (const imp of WebAssembly.Module.imports(mod)) if (imp.kind === 'function') (imports[imp.module] ??= {})[imp.name] = () => 0
      const inst = await WebAssembly.instantiate(mod, imports)
      ;(inst.exports as { _initialize?: () => void })._initialize?.()
      wasm = inst.exports as unknown as Exports
      return true
    } catch {
      return false
    }
  })()
  return loading
}

/** The blur in WebAssembly, or null when it is off or not loaded (the caller then blurs itself). */
export function simdBlur(src: Float32Array, w: number, h: number, k: Float32Array, r: number, x0: number, x1: number, y0: number, y1: number, by0: number, by1: number): Float32Array | null {
  if (!enabled || !wasm) return null
  const e = wasm
  const n = w * h * 4
  const pSrc = e.alloc(n), pOut = e.alloc(n), pTmp = e.alloc(n), pK = e.alloc(k.length * 4)
  try {
    if (!pSrc || !pOut || !pTmp || !pK) return null
    new Float32Array(e.memory.buffer, pSrc, w * h).set(src)
    new Float32Array(e.memory.buffer, pK, k.length).set(k)
    e.blur(pSrc, pOut, pTmp, w, h, pK, r, x0, x1, y0, y1, by0, by1)
    return new Float32Array(e.memory.buffer, pOut, w * h).slice()
  } finally {
    for (const [p, b] of [[pSrc, n], [pOut, n], [pTmp, n], [pK, k.length * 4]]) if (p) e.release(p, b)
  }
}
