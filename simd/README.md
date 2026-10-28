# WebAssembly SIMD blur

The tracer's Gaussian blur (`blur` in `src/trace/index.ts`) in C++ with
[Google Highway](https://github.com/google/highway) (Apache-2.0 OR BSD-3-Clause), compiled to
WebAssembly SIMD (128-bit, 4 floats per instruction). It was the fastest of the engines compared on
the `simd/native-shootout` branch, which also has the native C++, Rust and C# builds and the
benchmarks.

The tracing worker (`src/vectorize/flat-worker.ts`) loads it with `useSimdBlur(true)`
(`src/trace/simd-blur.ts`), and `blur()` hands its work to it. Where it can't load (a browser
without WebAssembly SIMD), or an image is too large for its memory, the TypeScript blur runs.

Output is byte for byte the same either way: the golden fixtures are checked with both blurs
(`src/vectorize/__tests__/fidelity/golden.test.ts`, `src/trace/__tests__/simd-blur.test.ts`).

## Memory

The module has a fixed 128 MB memory: enough for the three buffers of a blur of about 10 megapixels.
It never grows, because growing WebAssembly memory detaches its old `ArrayBuffer`, and after any
detach V8 checks every typed-array access in that worker. That made the quantizer about 20%
slower on a 2000×1333 image, much more than the blur saves.

## Build

`public/simd/blur-highway.wasm` is committed. To rebuild it from `cpp-highway/blur.cc`, put the
Emscripten SDK and Highway in `%USERPROFILE%\simd-tools` (`emsdk`, `highway`), then:

```sh
node simd/build.mjs
```

## Measure

```sh
PROFILE=1 npx vitest run bench/profile.test.ts               # WebAssembly blur, as in the app
SIMD_BLUR=0 PROFILE=1 npx vitest run bench/profile.test.ts   # TypeScript blur
```
