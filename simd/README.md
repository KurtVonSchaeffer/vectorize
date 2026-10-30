# Blur engines

The tracer's Gaussian blur (`blur` in `src/trace/index.ts`) is one slot with several interchangeable
engines, kept in `src/trace/blur-engines.ts`:

| id | Engine | Notes |
|---|---|---|
| `typescript` | The blur in `index.ts` | The reference. Always available; every other engine falls back to it. |
| `highway` | C++ with [Google Highway](https://github.com/google/highway) (Apache-2.0 OR BSD-3-Clause), WebAssembly SIMD | **The default.** Fastest; fixed memory. |
| `rust-wide` | Rust with [`wide`](https://crates.io/crates/wide) (Zlib OR Apache-2.0 OR MIT), WebAssembly SIMD | For comparison. Its memory grows. |
| `rust-fearless` | Rust with [`fearless_simd`](https://crates.io/crates/fearless_simd) (Apache-2.0 OR MIT), WebAssembly SIMD | For comparison. Its memory grows. |

All use 128-bit WebAssembly SIMD (4 floats per instruction). They were compared on the
`simd/native-shootout` branch, which also has native C++, Rust and C# (.NET) builds. The C# build
isn't here: .NET runs in a browser only as a large WebAssembly runtime, so it stays a native benchmark.

## Same output, whichever engine

Every engine gets the same weights and box, and gives the TypeScript blur's values to within float
rounding (about 1e-7: its sums are 32-bit). That leaves traces byte for byte the same. The tests run
every registered engine:
- `src/trace/__tests__/blur-engines.test.ts`: values against the TypeScript blur at several sizes
  and strengths, and a whole trace byte for byte;
- `src/vectorize/__tests__/fidelity/golden.test.ts`: every golden fixture (SVG, knockout, One
  colour, PDF, DXF) against its recorded hash.

A new engine is covered by both as soon as it's registered.

## Choosing an engine

The tracing worker (`src/vectorize/flat-worker.ts`) uses the default, Highway. Where an engine can't
load (a browser without WebAssembly SIMD), or an image is too large for its memory, that blur runs
in TypeScript.

To compare engines in the app (`blurEngineChoice` in `src/quality/flags.ts`):
- **Dev server** (`npm run dev`): add `?blur=<id>` to the address, e.g. `?blur=rust-wide`.
- **A Preview build** with `VITE_BLUR_ENGINE=preview`: the same `?blur=<id>`.
- **A build** with `VITE_BLUR_ENGINE=<id>`: that engine for everyone using it (a release decision).
- **Any other build, production included,** ignores the address and uses Highway.

## Adding or combining engines

`registerBlurEngine` adds one. An engine is `{ id, label, load, blur }`; `blur` returns the blurred
field, or `null` to leave that blur to the TypeScript.
- **Another WebAssembly build** that exports `alloc`, `release` and `blur` with the same arguments
  as `cpp-highway/blur.cc`: `wasmBlurEngine(id, label, 'blur-x.wasm')`, with the file in
  `public/simd`.
- **One made from others**: `combinedBlurEngine(id, label, uses, pick)`, where `pick(w, h, r)` names
  the engine for each blur. For example, one engine for small images and another for large:

```ts
registerBlurEngine(combinedBlurEngine('by-size', 'Highway for large, TypeScript for small',
  ['highway', 'typescript'], (w, h) => (w * h >= 250_000 ? 'highway' : 'typescript')))
```

## Memory

Highway's module has a fixed 128 MB memory: enough for the three buffers of a blur of about 10
megapixels. It never grows, because growing WebAssembly memory detaches its old `ArrayBuffer`, and
after any detach V8 checks every typed-array access in that worker. That made the quantizer about
20% slower on a 2000×1333 image, much more than the blur saves. The Rust builds use Rust's own
allocator, whose memory grows, so they carry that cost. That's why they aren't the default.

## Build

The `.wasm` files in `public/simd/` are committed. To rebuild them:
- Highway: put the Emscripten SDK and Highway in `%USERPROFILE%\simd-tools` (`emsdk`, `highway`).
- Rust: install Rust with the `wasm32-unknown-unknown` target.

```sh
node simd/build.mjs                  # all
node simd/build.mjs highway          # one: highway, rust-wide or rust-fearless
```

## Measure

```sh
BENCH=1 npx vitest run bench/blur-engines.test.ts                    # every engine, side by side
PROFILE=1 npx vitest run bench/profile.test.ts                       # whole pipeline, default engine
BLUR_ENGINE=typescript PROFILE=1 npx vitest run bench/profile.test.ts   # whole pipeline, another engine
```

Measured on 30 Oct 2026 (Node, i.e. V8 as in Chrome; median of 15 blurs):

| Image, strength | TypeScript | Highway | Rust + wide | Rust + fearless_simd |
|---|---|---|---|---|
| 600×400, σ 0.7 | 9.3 ms | **0.9 ms** | 2.0 ms | 1.1 ms |
| 2000×1333, σ 0.7 | 104 ms | **9.9 ms** | 21.7 ms | 12.3 ms |
| 2000×1333, σ 1.6 | 156 ms | **15.7 ms** | 36.2 ms | 19.2 ms |
