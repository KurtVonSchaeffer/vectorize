# V7: AI memory investigation

**Question:** can the AI sharpening model's memory be released after processing or when idle, without causing repeated downloads? What does that cost in memory, processing time and later uploads?

## How the AI is held

- `Enhancer` (`src/ai/enhancer.ts`) runs Swin2SR 2× in a worker on onnxruntime's multi-threaded WebAssembly backend.
- **Before this change** the worker was created with the app's first AI use and never stopped, so the model session, its WASM memory and onnxruntime's threads stayed for the rest of the session.
- **Model files are already cached.** transformers.js stores the model (8.1 MB) and the onnxruntime WASM files (26.9 MB binary plus its loader) in the browser's Cache Storage (`transformers-cache`). After the first visit they're read from disk: 35 ms for the WASM, 11 ms for the model, and no requests to Hugging Face or jsdelivr.

## Measurements

Desktop app browser pane (Chromium), 8-core Mac with 8 GB of memory, 200–300 px logos. Renderer memory is from the operating system (`ps` RSS and `footprint`, which also counts compressed memory). Times are from the start of the AI request, or of the upload, to the given step.

### Memory

| State | Renderer |
|---|---|
| Model loaded, after two 2× runs | 555 MB RSS |
| Model session disposed, worker kept (`pipeline.dispose()`) | 549 MB RSS (−6 MB) |
| Worker stopped | 305 MB RSS (**−244 MB**) |
| In the app: model loaded, after 3 uploads | 1,045 MB footprint, 25 threads |
| In the app: after a 3-minute idle release (first trial) | 660 MB footprint (**−385 MB**), 20 threads |
| In the app: model loaded, after 2 uploads (5-minute version) | 842 MB footprint, 27 threads |
| In the app: after the 5-minute idle release | 507 MB footprint (**−335 MB**), 20 threads; released about 300 s after the last job |

**Disposing the model session frees almost nothing:** WebAssembly memory can grow but never shrink. Stopping the worker is the only way to give the memory back.

### Time

| Step | Time |
|---|---|
| Worker start (code loaded) | 87–97 ms |
| Model set-up from the cache (`pipeline()`, onnxruntime session creation) | **8.0–8.7 s** (5 runs) |
| Reading and compiling the cached WASM on its own | 0.1 s |
| 2× sharpening, model already loaded, 200 px | 6.7–9.6 s |
| First run after set-up | about 1.3 s slower than later runs |

The 8 s set-up is onnxruntime building and optimising the session, not downloading or compiling. **Every session already pays it once**, on its first AI sharpening.

### Later uploads in the app

The same 220 px logo (one that gets an AI-sharpening offer) uploaded three times. The first SVG appeared at once each time; this is when the offer appeared:

| Upload | Model | Offer after |
|---|---|---|
| 1st, fresh page | Set up from the cache | 19.3 s |
| 2nd, 30 s later | Already loaded | 10.7 s |
| 3rd, after the 3-minute idle release | Set up from the cache again | 18.1 s (+7.4 s) |

Repeated with the final 5-minute timeout: 18.3 s (fresh page), 10.7 s (warm), then **19.7 s (+9.0 s)** for an upload 308 s later, after the release.

The model wasn't downloaded again. The 3rd upload pays the same set-up as the 1st.

## Change

`Enhancer` now stops its worker after **5 minutes without AI work** (`IDLE_RELEASE_MS`; 3 minutes in the first version) and starts a new one on the next request:

- The release timer starts only when no AI job is running. Any new request cancels it, and each finished job restarts it. A running job is never cut off.
- **Failures:** if the worker crashes (for example, out of memory) or can't start, its jobs fail with an error, which the app already handles (silent fallback for the background check and font matching, a message for the manual AI setting). The next request starts a fresh worker.
- **Stale results:** messages from a stopped worker are ignored, and request ids never repeat, so an old worker can't answer a newer request. The app also checks each result belongs to the current image.
- Sharpened results stay in the existing per-image cache on the main thread, so "Use it", going back, or changing settings never needs the worker again for the same image.
- Nothing else changes: no new dependency, same worker, same model, same results.
- Tests: `src/ai/__tests__/enhancer.test.ts` (9 tests):
  - the 5-minute default, and the timer restarting when a job finishes;
  - no stop while a job runs, and one worker through a run of uploads;
  - restart after release, after a crash, and after a failed start;
  - cancellation, and a stopped worker unable to answer a newer request;
  - cached results served without the worker.

**Trade-off:** a customer who pauses for more than 5 minutes and then uploads another small logo waits about 8 s longer for the offer. For small lettering, the automatic font match also waits, since it reads the sharpened copy. The first SVG is never delayed. Customers working through several logos in a row keep the warm model.

### Not pursued

- **Disposing the session only:** frees about 6 MB (above).
- **Faster session set-up** (for example a lower onnxruntime graph-optimisation level, or a pre-optimised model file) might reduce the 8 s. It changes how the model runs, so it would need checking for identical output and is a separate change.
- **Stopping the worker on every new upload:** a stale run would end sooner, but the next image would always pay the 8 s.
