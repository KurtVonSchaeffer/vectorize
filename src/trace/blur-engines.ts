/**
 * Engines for the tracer's blur (`blur` in index.ts): one slot, several interchangeable methods.
 * Every engine takes the same weights and box and must give the TypeScript blur's values to within
 * float rounding, so a trace comes out byte for byte the same whichever engine ran
 * (__tests__/blur-engines.test.ts checks every registered engine, and the golden fixtures).
 *
 * Built in (simd/README.md):
 * - `typescript`: the blur in index.ts itself, the reference.
 * - `highway`: C++ with Google Highway, WebAssembly SIMD. The default: fastest in the comparison
 *   on `simd/native-shootout`, and a fixed memory.
 * - `rust-wide`, `rust-fearless`: Rust with the `wide` and `fearless_simd` crates, WebAssembly SIMD.
 *   Their memory grows, which slows the rest of the worker (simd/README.md, Memory), so they're for
 *   comparison, not the default.
 *
 * More can be registered with registerBlurEngine: another build (wasmBlurEngine), or one made from
 * others (combinedBlurEngine, e.g. one engine for small images and another for large).
 * useBlurEngine picks the engine later blurs use; an engine that can't load, or returns null for a
 * blur (an image too large for its memory), leaves that blur to the TypeScript.
 */
export type BlurCall = (src: Float32Array, w: number, h: number, k: Float32Array, r: number, x0: number, x1: number, y0: number, y1: number, by0: number, by1: number) => Float32Array | null

export interface BlurEngine {
  id: string
  label: string
  /** Its WebAssembly build in public/simd, if it has one. */
  file?: string
  /** Gets the engine ready (resolves false when it can't run here). `bytes` replaces the fetched module, for tests. */
  load: (bytes?: BufferSource) => Promise<boolean>
  /** The blurred field, or null to let the TypeScript blur run. */
  blur: BlurCall
}

export const DEFAULT_BLUR_ENGINE = 'highway'

const engines = new Map<string, BlurEngine>()
let current: BlurEngine | null = null
let selected = 'typescript'

export function registerBlurEngine(engine: BlurEngine): BlurEngine {
  engines.set(engine.id, engine)
  return engine
}

export function blurEngines(): BlurEngine[] {
  return [...engines.values()]
}

export function blurEngine(id: string): BlurEngine | undefined {
  return engines.get(id)
}

/**
 * Makes `id` the engine for later blurs once it has loaded; resolves whether it did. Until then, or
 * if it can't load (or `id` is unknown), the TypeScript blur runs. A load that finishes after
 * another engine was chosen changes nothing.
 */
export async function useBlurEngine(id: string, bytes?: BufferSource): Promise<boolean> {
  selected = id
  current = null
  const engine = engines.get(id)
  if (!engine) return false
  const ok = await engine.load(bytes)
  if (ok && selected === id) current = engine
  return ok
}

/** The id of the engine blurs use now ('typescript' while the chosen one is loading or failed). */
export function activeBlurEngine(): string {
  return current?.id ?? 'typescript'
}

/** The blur by the chosen engine, or null when the caller should blur in TypeScript. */
export const engineBlur: BlurCall = (...args) => current?.blur(...args) ?? null

registerBlurEngine({ id: 'typescript', label: 'TypeScript', load: async () => true, blur: () => null })

type Exports = {
  memory: WebAssembly.Memory
  alloc: (bytes: number) => number
  release: (ptr: number, bytes: number) => void
  blur: (src: number, out: number, tmp: number, w: number, h: number, k: number, r: number, x0: number, x1: number, y0: number, y1: number, by0: number, by1: number) => void
}

/** An engine from a WebAssembly build in public/simd that exports alloc, release and blur (simd/README.md). */
export function wasmBlurEngine(id: string, label: string, file: string): BlurEngine {
  let wasm: Exports | null = null
  let loading: Promise<boolean> | null = null
  const url = `${import.meta.env?.BASE_URL ?? '/'}simd/${file}`
  return {
    id,
    label,
    file,
    load(bytes) {
      loading ??= (async () => {
        try {
          const source = bytes ?? (await (await fetch(url)).arrayBuffer())
          const mod = await WebAssembly.compile(source)
          // Standalone Emscripten output may import WASI calls the blur never makes.
          const imports: Record<string, Record<string, () => number>> = {}
          for (const imp of WebAssembly.Module.imports(mod)) if (imp.kind === 'function') (imports[imp.module] ??= {})[imp.name] = () => 0
          const inst = await WebAssembly.instantiate(mod, imports)
          ;(inst.exports as { _initialize?: () => void })._initialize?.()
          wasm = inst.exports as unknown as Exports
          return true
        } catch {
          loading = null // a later call may try again
          return false
        }
      })()
      return loading
    },
    blur(src, w, h, k, r, x0, x1, y0, y1, by0, by1) {
      if (!wasm) return null
      const e = wasm
      const n = w * h * 4
      const pSrc = e.alloc(n), pOut = e.alloc(n), pTmp = e.alloc(n), pK = e.alloc(k.length * 4)
      try {
        if (!pSrc || !pOut || !pTmp || !pK) return null
        // Views are made after every alloc: a module whose memory grows replaces its buffer.
        new Float32Array(e.memory.buffer, pSrc, w * h).set(src)
        new Float32Array(e.memory.buffer, pK, k.length).set(k)
        e.blur(pSrc, pOut, pTmp, w, h, pK, r, x0, x1, y0, y1, by0, by1)
        return new Float32Array(e.memory.buffer, pOut, w * h).slice()
      } finally {
        for (const [p, b] of [[pSrc, n], [pOut, n], [pTmp, n], [pK, k.length * 4]]) if (p) e.release(p, b)
      }
    },
  }
}

/**
 * An engine made from registered ones: `pick` chooses which runs each blur, from its size and
 * radius. Loading loads every engine it names in `uses`; a blur whose engine isn't ready, or
 * returns null, falls to the TypeScript.
 */
export function combinedBlurEngine(id: string, label: string, uses: string[], pick: (w: number, h: number, r: number) => string): BlurEngine {
  const ready = new Set<string>()
  return {
    id,
    label,
    async load() {
      const loaded = await Promise.all(uses.map(async (u) => [u, (await engines.get(u)?.load()) ?? false] as const))
      for (const [u, ok] of loaded) if (ok) ready.add(u)
      return ready.size > 0
    },
    blur(src, w, h, k, r, ...box) {
      const chosen = pick(w, h, r)
      return ready.has(chosen) ? (engines.get(chosen)?.blur(src, w, h, k, r, ...box) ?? null) : null
    },
  }
}

registerBlurEngine(wasmBlurEngine('highway', 'C++ + Highway (WebAssembly SIMD)', 'blur-highway.wasm'))
registerBlurEngine(wasmBlurEngine('rust-wide', 'Rust + wide (WebAssembly SIMD)', 'blur-wide.wasm'))
registerBlurEngine(wasmBlurEngine('rust-fearless', 'Rust + fearless_simd (WebAssembly SIMD)', 'blur-fearless.wasm'))
