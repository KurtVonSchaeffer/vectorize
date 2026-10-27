// SIMD bake-off (simd/README.md): the tracer's blur in TypeScript against the WebAssembly builds.
import { blur } from '../src/trace/index'

type Impl = { name: string; run: (src: Float32Array, w: number, h: number, sigma: number) => Float32Array }

const MODULES = [
  ['Rust + wide', '/simd/blur-wide.wasm'],
  ['Rust + fearless_simd', '/simd/blur-fearless.wasm'],
  ['C++ + Highway', '/simd/blur-highway.wasm'],
] as const

/** The same weights and box blur() uses, so every build gets identical inputs. */
function setup(w: number, h: number, sigma: number) {
  const r = Math.max(1, Math.ceil(sigma * 2.5))
  const k = new Float32Array(2 * r + 1)
  let sum = 0
  for (let i = -r; i <= r; i++) sum += k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma))
  for (let i = 0; i < k.length; i++) k[i] /= sum
  return { r, k, x0: 0, x1: w - 1, y0: 0, y1: h - 1, by0: 0, by1: h - 1 }
}

type Exports = {
  memory: WebAssembly.Memory
  alloc: (bytes: number) => number
  release: (ptr: number, bytes: number) => void
  blur: (src: number, out: number, tmp: number, w: number, h: number, k: number, r: number, x0: number, x1: number, y0: number, y1: number, by0: number, by1: number) => void
}

async function load(name: string, url: string): Promise<Impl | string> {
  const res = await fetch(url, { cache: 'no-store' })
  const bytes = res.ok ? await res.arrayBuffer() : new ArrayBuffer(0)
  // A missing file can come back as the dev server's HTML page, so check for the wasm header.
  if (new Uint32Array(bytes.slice(0, 4))[0] !== 0x6d736100) return `${name}: not built (${url}).`
  const mod = await WebAssembly.compile(bytes)
  // Standalone Emscripten output may import a few WASI calls it never uses here; stub them.
  const imports: Record<string, Record<string, () => number>> = {}
  for (const imp of WebAssembly.Module.imports(mod)) if (imp.kind === 'function') (imports[imp.module] ??= {})[imp.name] = () => 0
  const inst = await WebAssembly.instantiate(mod, imports)
  const e = inst.exports as unknown as Exports
  ;(inst.exports as { _initialize?: () => void })._initialize?.()
  return {
    name,
    run(src, w, h, sigma) {
      const s = setup(w, h, sigma)
      const n = w * h * 4
      const pSrc = e.alloc(n), pOut = e.alloc(n), pTmp = e.alloc(n), pK = e.alloc(s.k.length * 4)
      new Float32Array(e.memory.buffer, pSrc, w * h).set(src)
      new Float32Array(e.memory.buffer, pK, s.k.length).set(s.k)
      e.blur(pSrc, pOut, pTmp, w, h, pK, s.r, s.x0, s.x1, s.y0, s.y1, s.by0, s.by1)
      const out = new Float32Array(e.memory.buffer, pOut, w * h).slice()
      for (const [p, b] of [[pSrc, n], [pOut, n], [pTmp, n], [pK, s.k.length * 4]]) e.release(p, b)
      return out
    },
  }
}

/** Anti-aliased coverage of the example badge's shapes: what blur() is given in the tracer. */
function badgeField(w: number, h: number): Float32Array {
  const c = new OffscreenCanvas(w, h)
  const g = c.getContext('2d')!
  const s = w / 600
  g.scale(s, s)
  g.beginPath()
  for (let i = 0; i < 32; i++) {
    const a = (Math.PI * i) / 16 - Math.PI / 2
    const r = i % 2 ? 170 * 0.45 : 170
    g.lineTo(300 + r * Math.cos(a), 200 + r * Math.sin(a))
  }
  g.fill()
  g.globalCompositeOperation = 'destination-out'
  g.beginPath()
  g.arc(300, 200, 110, 0, 2 * Math.PI)
  g.fill()
  g.globalCompositeOperation = 'source-over'
  g.font = '900 52px Arial Black, Arial'
  g.textAlign = 'center'
  g.fillText('BREW', 300, 190)
  const d = g.getImageData(0, 0, w, h).data
  const f = new Float32Array(w * h)
  for (let i = 0; i < f.length; i++) f[i] = d[i * 4 + 3] / 255
  return f
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1]

function time(fn: () => void, runs: number): number {
  for (let i = 0; i < 3; i++) fn()
  const t: number[] = []
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now()
    fn()
    t.push(performance.now() - t0)
  }
  return median(t)
}

export async function runBench(log: (row: Record<string, string | number>) => void, note: (s: string) => void) {
  const loaded = await Promise.all(MODULES.map(([n, u]) => load(n, u)))
  const impls: Impl[] = [{ name: 'TypeScript (current)', run: (src, w, h, sigma) => blur(src, w, h, sigma) }]
  for (const l of loaded) typeof l === 'string' ? note(l) : impls.push(l)
  for (const [w, h] of [[600, 400], [1200, 800], [2400, 1600]]) {
    const src = badgeField(w, h)
    for (const sigma of [0.7, 1.6]) {
      const ref = blur(src, w, h, sigma)
      let base = 0
      for (const impl of impls) {
        const out = impl.run(src, w, h, sigma)
        let maxDiff = 0, flips = 0
        for (let i = 0; i < out.length; i++) {
          maxDiff = Math.max(maxDiff, Math.abs(out[i] - ref[i]))
          if (out[i] >= 0.5 !== ref[i] >= 0.5) flips++
        }
        const ms = time(() => impl.run(src, w, h, sigma), w * h > 2e6 ? 9 : 21)
        if (!base) base = ms
        log({ size: `${w}×${h}`, sigma, build: impl.name, 'median ms': +ms.toFixed(2), speedup: `${(base / ms).toFixed(2)}×`, 'max diff': maxDiff.toExponential(1), 'pixels flipped at 0.5': flips })
        await new Promise((r) => setTimeout(r))
      }
    }
  }
}
