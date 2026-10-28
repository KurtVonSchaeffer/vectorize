# Native SIMD shootout

The tracer's Gaussian blur (`blur` in `src/trace/index.ts`) as three native x64 engines, all doing
the same work on the same inputs: C++ with Google Highway, C# with .NET SIMD (`Vector<float>`) and
Rust with `pulp`. Each is compared with the current TypeScript and with the Highway WebAssembly
build from the earlier bake-off (`src/trace/simd-blur.ts`, `simd/README.md`).

This answers one question: which language and library runs the same algorithm fastest. Whether that
speeds up Vectorize as a whole is a separate question. The blur is 6–8% of a flat run
(`PROFILE=1 npx vitest run bench/profile.test.ts`), and customers only ever run it in the browser,
as WebAssembly.

## Results (GitHub Actions windows-latest, 28 October 2026)

[Run 40646644617](https://github.com/KurtVonSchaeffer/vectorize/actions/runs/40646644617), commit
`7fa8189`. The runner was an AMD EPYC 7763 virtual machine with 2 cores / 4 threads, and 5 rounds
were run. Every engine chose AVX2, 8 floats per instruction (the runner has no AVX-512), so all
three ran at the same width. Times are the median over rounds of each round's median, for all of
a case's blur calls together. Round-to-round spread was within 4%, except .NET on the largest case
(21.7–24.5 ms).

| Case | TypeScript (V8) | Highway WebAssembly (V8) | C++ + Highway | Rust + pulp | C# + .NET |
| --- | --- | --- | --- | --- | --- |
| fine-outlines, 680×440 | 14.12 ms | 2.31 ms (6.1×) | **0.66 ms (21.3×)** | 0.78 ms (18.0×) | 0.78 ms (18.1×) |
| gradients, 720×400 | 10.17 ms | 1.59 ms (6.4×) | **0.46 ms (22.3×)** | 0.52 ms (19.4×) | 0.51 ms (19.8×) |
| similar-colours, 640×400 | 8.87 ms | 1.40 ms (6.3×) | **0.40 ms (22.2×)** | 0.47 ms (18.8×) | 0.45 ms (19.6×) |
| badge-large, 2000×1333 | 139.4 ms | 26.3 ms (5.3×) | **6.21 ms (22.4×)** | 7.15 ms (19.5×) | 7.16 ms (19.5×) |
| lettering-large, 2260×740 | 111.2 ms | 11.9 ms (9.4×) | **3.90 ms (28.5×)** | 4.44 ms (25.1×) | 4.39 ms (25.3×) |
| lettering-very-large, 4520×1480 | 460.5 ms | 50.5 ms (9.1×) | **18.41 ms (25.0×)** | 20.97 ms (22.0×) | 23.81 ms (19.3×) |

- **Speed:** Highway was fastest on every case. It was 11–18% ahead of `pulp` and .NET, and 29%
  ahead of .NET on the largest case. `pulp` and .NET were level within 5% everywhere else.
- **Output:** every engine was within 1–2e-7 of the TypeScript, and no pixel crossed 0.5. Traced
  back through the pipeline (`verify.test.ts`), all five engines give identical SVGs on all six
  cases, with no coordinate moved.
- **Memory:** peak working set on the largest case, which mostly holds the loaded calls: Highway
  209 MB, `pulp` 208 MB, .NET 299 MB (about 90 MB of runtime), TypeScript 368 MB, WebAssembly
  389 MB.

### What it means for Vectorize

The blur is 6–8% of a flat run. With the TypeScript blur at about 7% of a run:

| Blur | Speed-up | Share of a run left | Whole run saved |
| --- | --- | --- | --- |
| Highway WebAssembly (`src/trace/simd-blur.ts`) | 5–9× | ~1% | **~6%** |
| Best native (Highway) | 21–28× | ~0.3% | ~6.7% |
| Next native (`pulp` or .NET) | 18–25× | ~0.35% | ~6.65% |

The engines differ by under 0.1% of a run. Native code also cannot run where customers use
Vectorize, which is the browser. The WebAssembly build already gets about nine-tenths of what any
native engine could.

**Recommendation:** pick Highway, as the WebAssembly build the app already has, and turn it on
with `useSimdBlur(true)` in the tracing worker. Native C++, Rust or C# would only be worth it for
a server or desktop build. If that happens, Highway is the winner by 11–29%; it adds no runtime
and has the most permissive licence. A larger saving than all of this is in the quantizer:
`vetoDistantPartners` alone is 28–30% of a run on photo-like logos.

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
  dispatches. `pulp` with its default features picks x86-v3 (AVX2) at most: its AVX-512 level
  needs the `x86-v4` feature. .NET's JIT sizes `Vector<float>` for the CPU. Each engine reports
  the target it chose.
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
1.4.0 and the .NET 10 SDK. Rust is the stable toolchain, with `pulp` 0.22.3; it is the GNU host
locally and MSVC on the runner. `node simd/native/annotate.mjs` posts the results as annotations
on GitHub Actions, where anyone can read them without signing in.

| Folder | Language | Library | Licence |
| --- | --- | --- | --- |
| `cpp-highway` | C++17 | [Google Highway](https://github.com/google/highway) 1.4.0 | Apache-2.0 OR BSD-3-Clause |
| `rust-pulp` | Rust 2024 | [`pulp`](https://github.com/sarah-quinones/pulp) 0.22.3 | MIT |
| `csharp` | C# / .NET 10 | `System.Numerics.Vector<T>` | MIT |
