# Native SIMD shootout

The tracer's Gaussian blur (`blur` in `src/trace/index.ts`) as three native x64 engines, all doing
the same work on the same inputs: C++ with Google Highway, C# with .NET SIMD (`Vector<float>`) and
Rust with `pulp`. Each is compared with the current TypeScript and with the Highway WebAssembly
build from the earlier bake-off (`src/trace/simd-blur.ts`, `simd/README.md`).

This answers one question: which language and library runs the same algorithm fastest. Whether that
speeds up Vectorize as a whole is a separate question. The blur is 6–8% of a flat run
(`PROFILE=1 npx vitest run bench/profile.test.ts`), and customers only ever run it in the browser,
as WebAssembly.

## Same work in every engine

- **Inputs are real calls.** `record.test.ts` runs the flat pipeline at production settings and
  saves every `blur()` call the tracer makes. The synthetic inputs are hairlines, a gradient band,
  tone-on-tone colours, a 2000×1333 JPEG-like badge, and lettering at 2260×740 and 4520×1480. When
  the local images are present, it adds tiny text, a small logo, an illustration, a 2260×740 logo
  and a 4520×1480 logo.
  It also saves the TypeScript result for each call. Production always blurs at σ 0.7 (5 taps), on
  a box per colour layer.
- **Same algorithm.** It is the one in `simd/cpp-highway/blur.cc`. The horizontal pass does N
  outputs at a time where every tap is inside the row, with scalar code at the edges. The vertical
  pass does N columns at once. Both use fused multiply-add and 32-bit sums. `out` and `tmp` are
  cleared on every call, as `blur()` does when it allocates them.
- **Widest vectors each library chooses at run time.** Highway compiles every x86 target and
  dispatches. `pulp` picks x86-v3 or v4. .NET's JIT sizes `Vector<float>` for the CPU.
- **Same driver steps.** Load a case. Run every call once, compare it with the TypeScript (largest
  difference, and pixels that cross 0.5) and save the output. Warm up for at least 10 passes and
  0.5 s, which also covers the .NET JIT's tiering. Then time N passes and report the median, the
  minimum, the 90th percentile and the process's peak working set.
- **Same conditions.** `run.mjs` pins every process to one core at high priority. It runs several
  rounds and changes the engine order each round.
- **Same output, checked end to end.** `verify.test.ts` feeds each engine's saved outputs back into
  the tracer in place of the TypeScript blur. It requires the same SVG paths, with every coordinate
  within 0.02 px.

## On GitHub Actions

`.github/workflows/simd-shootout.yml` runs everything on a `windows-latest` runner. It starts on a
push to `simd/native-shootout` or from **Run workflow** (with a number of rounds). A Linux job
records the calls and passes them to the Windows job as the `simd-recordings` artifact. The
Windows job builds, times and verifies. Results appear in the run summary and in the
`simd-results` artifact. Only the synthetic cases run there; the logo cases need local artwork.
Shared runners are virtual machines with noisy neighbours, so compare engines within one run
rather than across runs.

## Steps

```sh
RECORD=1 npx vitest run simd/native/record.test.ts   # data/: ~160 MB, needs public/_tmp-check images
node simd/native/build.mjs                            # all three engines
node simd/native/run.mjs 5                            # 5 rounds → out/results.md
VERIFY=1 npx vitest run simd/native/verify.test.ts    # out/verify.json
```

Toolchains are kept outside the repo, in `%USERPROFILE%\simd-tools`: llvm-mingw 20261020, Highway
1.4.0 and the .NET 10 SDK. Rust is the stable GNU toolchain, with `pulp` 0.22.3.

| Folder | Language | Library | Licence |
| --- | --- | --- | --- |
| `cpp-highway` | C++17 | [Google Highway](https://github.com/google/highway) 1.4.0 | Apache-2.0 OR BSD-3-Clause |
| `rust-pulp` | Rust 2024 | [`pulp`](https://github.com/sarah-quinones/pulp) 0.22.3 | MIT |
| `csharp` | C# / .NET 10 | `System.Numerics.Vector<T>` | MIT |
