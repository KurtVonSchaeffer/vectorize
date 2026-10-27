# SIMD bake-off

The tracer's Gaussian blur (`blur` in `src/trace/index.ts`) built three ways with the libraries from
the SIMD research report, compiled to WebAssembly SIMD (128-bit, 4 floats per instruction), and
compared with the current TypeScript in the browser.

The Highway build was fastest. `src/trace/simd-blur.ts` loads it, and once it is turned on with
`useSimdBlur(true)`, `blur()` hands its work to it; until then, or if loading fails, the
TypeScript blur runs. Nothing in the app turns it on yet. Values match the TypeScript to about
1e-7, and traces keep the same paths with every coordinate within 0.02 px
(`src/trace/__tests__/simd-blur.test.ts`).

`simd/native/` compares native x64 builds (C++ + Highway, Rust + pulp, C# + .NET) on the tracer's
real blur calls.

## Results (Edge, 27 October 2026)

Median ms including copying in and out of WebAssembly memory. Absolute times varied between runs;
the ratios held.

| Image | σ | TypeScript | Rust + wide | Rust + fearless_simd | C++ + Highway |
| --- | --- | --- | --- | --- | --- |
| 600×400 | 0.7 | 31 | 8.1 (3.9×) | 5.4 (5.8×) | 4.3 (7.3×) |
| 1200×800 | 1.6 | 199 | 49 (4.1×) | 32 (6.2×) | 23 (8.5×) |
| 2400×1600 | 1.6 | 810 | 199 (4.1×) | 127 (6.4×) | 96 (8.5×) |

The Rust versions keep bounds checks in their inner loops and `wide`'s loads are built from four
scalars, so part of Highway's lead may be how they were written rather than the library.
`fearless_simd` panicked when called through `dispatch!` with a `Vec` of vectors inside the call; it
runs with the `WasmSimd128` token used directly and no allocation in the kernel.

| Folder | Language | Library | Licence |
| --- | --- | --- | --- |
| `rust-wide` | Rust | [`wide`](https://github.com/Lokathor/wide) | Zlib OR Apache-2.0 OR MIT |
| `rust-fearless` | Rust | [`fearless_simd`](https://github.com/linebender/fearless_simd) | Apache-2.0 OR MIT |
| `cpp-highway` | C++ | [Google Highway](https://github.com/google/highway) | Apache-2.0 OR BSD-3-Clause |

## One function, same in all three

```c
// Separable Gaussian blur of a w×h float image. `k` holds the 2r+1 weights (computed in JS, as
// blur() does). Rows by0..by1 get the horizontal pass over columns x0..x1; rows y0..y1 get the
// vertical pass over the same columns. Indices outside the image clamp to its edge. `out` and
// `tmp` are zeroed first, so everything outside the box is 0, as in blur().
void blur(const float* src, float* out, float* tmp, int w, int h, const float* k, int r,
          int x0, int x1, int y0, int y1, int by0, int by1);
```

Each module also exports `alloc(bytes)` and `release(ptr, bytes)` for buffers in its memory.

## Build

Toolchains live outside the repo (`%USERPROFILE%\simd-tools`): Rust (GNU host, target
`wasm32-unknown-unknown`) and the Emscripten SDK. Then:

```sh
node simd/build.mjs        # builds all three into public/simd/*.wasm
```

## Compare

With the dev server running, open `/simd-bench.html`: it runs the TypeScript blur and the three
WebAssembly builds on the same images and reports the median time and the largest difference from
the TypeScript output.
