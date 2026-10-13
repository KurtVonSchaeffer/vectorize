import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Enhancer, type AiProgress, type UpscaleSetting } from './ai/enhancer'
import { Compare } from './components/Compare'
import { BrandPanel, type MatchMode } from './components/BrandPanel'
import { FontPanel } from './components/FontPanel'
import { InkPanel } from './components/InkPanel'
import { MoreOptions } from './components/MoreOptions'
import { ResultCard, type Chip } from './components/ResultCard'
import { Upload } from './components/Upload'
import { downloadsFor, saveBlob, type Download } from './export/files'
import { DEMO_PALETTE } from './palette/demo'
import { colorNames } from './palette/names'
import { parsePaletteFile, type Palette } from './palette/parse'
import { DEFAULT_INKS, type InkSettings } from './palette/quantize'
import type { BrandSettings } from './palette/brand'
import { loadSavedBrand, loadSavedPalette, saveBrand, savePalette } from './palette/storage'
import { DEFAULT_CLIENT, prepFor, purposeAffectsTrace, traceParamsFor, type ClientSettings, type Purpose } from './vectorize/client'
import { detectArt, type Detection } from './vectorize/detect'
import { exampleImage } from './vectorize/example'
import { FlatTracer } from './vectorize/flat-tracer'
import { bitmapToImageData, hasVisiblePixels, imageDataToInput, loadImage, type InputImage, type SourceImage } from './vectorize/image'
import { buildTraceJob, inkNames, runTraceJob, type TraceJob, type TraceResult } from './vectorize/pipeline'
import { CancelledError, Tracer } from './vectorize/tracer'

const DEBOUNCE_MS = 180

export default function App() {
  const [source, setSource] = useState<SourceImage | null>(null)
  const [detection, setDetection] = useState<Detection | null>(null)
  const [opening, setOpening] = useState(false)
  const [client, setClient] = useState<ClientSettings>(DEFAULT_CLIENT)
  const [transparent, setTransparent] = useState(false)
  const [removed, setRemoved] = useState<number[]>([])
  const [result, setResult] = useState<TraceResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [traceError, setTraceError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const [toast, setToast] = useState<{ text: string; undo?: () => void } | null>(null)

  // Advanced
  const [upscale, setUpscale] = useState<UpscaleSetting>('off')
  const [upscaled, setUpscaled] = useState<(InputImage & { key: string }) | null>(null)
  const [aiProgress, setAiProgress] = useState<AiProgress | null>(null)
  const [upscaleNote, setUpscaleNote] = useState<string | null>(null)
  const [inks, setInks] = useState<InkSettings>(DEFAULT_INKS)
  const [brand, setBrandState] = useState<BrandSettings>(loadSavedBrand)
  const setBrand = (b: BrandSettings) => {
    setBrandState(b)
    saveBrand(b)
    setRemoved([])
  }
  const matchMode: MatchMode = inks.enabled ? 'library' : brand.mode
  const [importedPalette, setImportedPalette] = useState<Palette | null>(loadSavedPalette)
  const palette = importedPalette ?? DEMO_PALETTE

  const tracers = useRef<{ vtracer: Tracer; flat: FlatTracer }>(null)
  useEffect(() => {
    tracers.current = { vtracer: new Tracer(), flat: new FlatTracer() }
    return () => {
      tracers.current?.vtracer.dispose()
      tracers.current?.flat.dispose()
    }
  }, [])
  const enhancer = useRef<Enhancer>(null)
  useEffect(() => () => enhancer.current?.dispose(), [])

  const showToast = useCallback((text: string, undo?: () => void) => setToast({ text, undo }), [])
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), toast.undo ? 5000 : 3500)
    return () => clearTimeout(t)
  }, [toast])

  // ---------- Opening an image ----------
  const openBlob = useCallback(
    async (blob: Blob, name: string) => {
      setOpening(true)
      try {
        const img = await loadImage(blob, name)
        const det = detectArt(bitmapToImageData(img.bitmap))
        setSource((prev) => {
          if (prev) {
            URL.revokeObjectURL(prev.url)
            prev.bitmap.close()
          }
          return img
        })
        setDetection(det)
        setTransparent(det.hasAlpha || det.kind === 'lineart')
        setRemoved([])
        setResult(null)
        setTraceError(null)
        setUpscaled(null)
        setClient((c) => ({ ...c, style: 'auto', maxColors: null, keepBlends: false }))
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err))
      } finally {
        setOpening(false)
      }
    },
    [showToast],
  )

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'))
      if (file) openBlob(file, file.name || 'pasted-image.png')
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [openBlob])

  const reset = () => {
    if (source) {
      URL.revokeObjectURL(source.url)
      source.bitmap.close()
    }
    setSource(null)
    setDetection(null)
    setResult(null)
  }

  // ---------- Optional AI upscale (cached per image) ----------
  const upscaleKey = source && upscale !== 'off' ? `${source.id}|${upscale}` : ''
  useEffect(() => {
    if (!source || upscale === 'off') {
      setAiProgress(null)
      setUpscaleNote(null)
      return
    }
    if (upscaled?.key === upscaleKey) return
    let stale = false
    ;(async () => {
      const up = await (enhancer.current ??= new Enhancer()).upscale(source.id, bitmapToImageData(source.bitmap), upscale, (p) => !stale && setAiProgress(p))
      if (stale) return
      setAiProgress(null)
      if (!up) {
        setUpscaleNote('Not needed: this image is already large enough.')
        setUpscaled({ ...source, key: upscaleKey })
        return
      }
      const input = await imageDataToInput(up)
      if (stale) return URL.revokeObjectURL(input.url)
      setUpscaleNote(null)
      setUpscaled((prev) => {
        if (prev && prev.url !== source.url) URL.revokeObjectURL(prev.url)
        return { ...input, key: upscaleKey }
      })
    })().catch((err) => {
      if (stale) return
      setAiProgress(null)
      setUpscale('off')
      showToast(`Sharpening failed, so we used the original image. (${err instanceof Error ? err.message : String(err)})`)
    })
    return () => {
      stale = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, upscaleKey])

  const input: InputImage | null = !source ? null : upscale === 'off' ? source : upscaled?.key === upscaleKey ? upscaled : null

  // ---------- Tracing ----------
  const kind = detection ? (client.style === 'auto' ? detection.kind : client.style) : 'flat'
  // Only flat art changes shape with the purpose; photos and pixel art trace the same for all.
  const knockout = client.purpose !== 'web' && purposeAffectsTrace(kind, inks.enabled)
  const { detail, corners, maxColors, keepBlends, exactShapes, gradients } = client
  const job = useMemo(() => {
    if (!input || !source) return null
    const c = { ...DEFAULT_CLIENT, detail, corners, maxColors, keepBlends, exactShapes, gradients }
    return buildTraceJob(input, source.width, {
      trace: traceParamsFor(kind, c),
      prep: prepFor(kind, c),
      spot: { settings: inks, palette },
      removeColors: removed,
      transparent,
      knockout,
      keepBlends,
      exactShapes,
      gradients,
      brand,
    })
  }, [input, source, kind, detail, corners, maxColors, keepBlends, exactShapes, gradients, inks, palette, removed, transparent, knockout, brand])

  // Recent results, so going back to a previous setting (e.g. Print → Website → Print) is instant.
  const cache = useRef(new Map<string, TraceResult>())
  const jobKey = job && source ? cacheKey(source.id, upscale, job, inks.enabled) : ''

  useEffect(() => {
    if (!source || !job) return
    if (!hasVisiblePixels(job.image)) {
      setResult(null)
      setTraceError('This image is completely transparent, so there is nothing to trace.')
      return
    }
    const cached = cache.current.get(jobKey)
    if (cached) {
      setResult(cached)
      setTraceError(null)
      setBusy(false)
      return
    }
    setBusy(true)
    const timer = setTimeout(async () => {
      try {
        const res = await runTraceJob(tracers.current!, job, source, inks.enabled)
        if (res.paths > 0) {
          cache.current.set(jobKey, res)
          if (cache.current.size > 8) cache.current.delete(cache.current.keys().next().value!)
        }
        if (res.paths === 0) {
          setTraceError(inks.enabled && inks.whiteIsPaper ? 'Every color was treated as paper. Turn off “White is paper” under Brand colors.' : 'No shapes were found. Try more detail under Fine-tune.')
        } else setTraceError(null)
        setResult(res)
        setBusy(false)
      } catch (err) {
        if (err instanceof CancelledError) return
        setTraceError(friendlyError(err))
        setBusy(false)
      }
    }, DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [source, job, inks.enabled, inks.whiteIsPaper, retry])

  // ---------- Derived view data ----------
  const palettes = result?.palette ?? null
  // Same naming as the exported file, so chips and file always agree.
  const names = useMemo(
    () => (palettes ? inkNames({ palette: palettes, inks: result?.inks ?? [], named: result?.named }) : new Map<number, string>()),
    [palettes, result?.inks, result?.named],
  )

  const flatKind = kind === 'flat' || kind === 'lineart' || inks.enabled
  const chips: Chip[] | null = flatKind && palettes ? palettes.map((p) => ({ color: p.color, name: names.get(p.color) ?? '' })) : null

  const downloads = useMemo(() => {
    if (!result || !source) return null
    const baseName = source.name.replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '-') || 'vector'
    return downloadsFor(client.purpose, {
      svg: result.svg,
      width: result.width,
      height: result.height,
      baseName,
      names,
      spotNames: inks.enabled ? new Map((result.inks ?? []).map((i) => [rgbInt(i.swatch.rgb), i.swatch.name])) : null,
      flat: !!chips && chips.length <= 16,
    })
  }, [result, source, client.purpose, names, inks.enabled, chips])

  const download = async (d: Download) => {
    try {
      saveBlob(await d.make(), d.filename)
      showToast(`Saved ${d.filename}`)
    } catch (err) {
      showToast(`Couldn’t create the ${d.label}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const removeColor = (color: number) => {
    const name = names.get(color) ?? 'that color'
    setRemoved((r) => [...r, color])
    showToast(`Removed ${name}. Those areas now use the nearest color.`, () => setRemoved((r) => r.filter((c) => c !== color)))
  }

  const bgName = result?.background != null ? (names.get(result.background) ?? colorNames([result.background])[0]).toLowerCase() : null
  const transparentLocked = !!detection?.hasAlpha || (!bgName && !transparent)
  const transparentHint = detection?.hasAlpha
    ? 'Your image is already transparent'
    : kind === 'lineart'
      ? transparent
        ? 'The paper is left out; only the ink remains'
        : 'Keeps a white sheet behind the drawing'
      : bgName
        ? `Removes the ${bgName} behind your artwork`
        : 'No plain background found to remove'

  const status: 'working' | 'ready' | 'error' = traceError ? 'error' : busy || !result || aiProgress ? 'working' : 'ready'
  const colorCount = chips?.length ?? null
  const summary = status === 'working' && !result
    ? 'Finding colors and tracing edges…'
    : `${colorCount ? `${colorCount} ${colorCount === 1 ? 'color' : 'colors'}, clean edges` : `${(result?.paths ?? 0).toLocaleString()} shapes`}, ready for ${{ print: 'print', web: 'the web', cut: 'cutting' }[client.purpose]}.`
  const headline = {
    flat: 'Your artwork is now a sharp vector',
    photo: 'Your image is now a vector',
    lineart: 'Your drawing is now clean line art',
    pixel: 'Your pixel art is now a vector',
  }[kind]

  const blendNote = result && flatKind
    ? client.keepBlends
      ? { text: 'Edge smudges are kept as extra colors.', undoLabel: 'Clean them up', onUndo: () => setClient((c) => ({ ...c, keepBlends: false })) }
      : result.blendsRemoved > 0
        ? {
            text: 'We cleaned up fuzzy edges and compression smudges, so only your real colors remain.',
            undoLabel: 'Undo',
            onUndo: () => setClient((c) => ({ ...c, keepBlends: true })),
          }
        : null
    : null

  const shapeNote = (() => {
    if (!result || !flatKind) return null
    if (!client.exactShapes) return { text: 'Circles and stars are traced as drawn.', undoLabel: 'Make them exact', onUndo: () => setClient((c) => ({ ...c, exactShapes: true })) }
    const s = result.shapes
    if (!s) return null
    const parts = [
      plural(s.circle + s.ellipse, s.ellipse ? 'circle or oval' : 'circle', s.ellipse ? 'circles and ovals' : 'circles'),
      plural(s.star, 'star', 'stars'),
      plural(s.polygon, 'straight-edged shape', 'straight-edged shapes'),
    ].filter(Boolean)
    if (!parts.length) return null
    const split = s.overlaps > 0 ? ` Overlapping shapes are kept separate (like a star behind a circle), so each is easy to edit.` : ''
    return { text: `Made ${listJoin(parts as string[])} geometrically exact.${split}`, undoLabel: 'Undo', onUndo: () => setClient((c) => ({ ...c, exactShapes: false })) }
  })()
  const gradientNote = (() => {
    const g = result?.gradients
    if (!result || !flatKind || !g?.found) return null
    const n = g.found === 1 ? '1 gradient' : `${g.found} gradients`
    if (!client.gradients) return { text: `${n} traced as solid color bands.`, undoLabel: 'Keep them smooth', onUndo: () => setClient((c) => ({ ...c, gradients: true })) }
    if (!g.kept) {
      // Print plates and cut files need solid colors.
      return {
        text: `This artwork has ${n}. ${client.purpose === 'cut' ? 'Cutting' : 'Print'} files use solid colors, so ${g.found === 1 ? 'it is' : 'they are'} split into bands.`,
        undoLabel: 'Keep smooth for website',
        onUndo: () => setClient((c) => ({ ...c, purpose: 'web' })),
      }
    }
    return { text: `Kept ${n} smooth, as editable gradient fills.`, undoLabel: 'Undo', onUndo: () => setClient((c) => ({ ...c, gradients: false })) }
  })()
  const brandNote =
    result && result.named.length > 0 && brand.mode !== 'off'
      ? {
          text: `Matched ${result.named.length === 1 ? `1 color` : `${result.named.length} colors`} to your brand colors (${result.named.map(([, n]) => n).join(', ')}).`,
          undoLabel: 'Turn off',
          onUndo: () => setBrand({ ...brand, mode: 'off' }),
        }
      : null
  const fixNotes = [gradientNote, brandNote, blendNote, shapeNote].filter((n): n is NonNullable<typeof n> => !!n)

  const busyLabel = aiProgress
    ? aiProgress.phase === 'download'
      ? `Downloading sharpening model · ${Math.round(aiProgress.progress * 100)}%`
      : `Sharpening · ${Math.round(aiProgress.progress * 100)}%`
    : busy || (!result && !traceError)
      ? 'Vectorizing…'
      : null

  // ---------- Render ----------
  return (
    <div className="page">
      <header className="top">
        <button className="brand" onClick={reset} aria-label="Vectorize, start over">
          <svg viewBox="0 0 26 26" aria-hidden="true">
            <path d="M4 20C7 6 19 6 22 20" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
            <rect x="2" y="18" width="4.5" height="4.5" rx="1" fill="var(--accent)" />
            <rect x="19.5" y="18" width="4.5" height="4.5" rx="1" fill="var(--accent)" />
          </svg>
          Vectorize
        </button>
        {source && (
          <button className="new" onClick={reset}>
            Upload another image
          </button>
        )}
      </header>

      {!source || !detection ? (
        <Upload onFile={openBlob} onExample={async () => openBlob(await exampleImage(), 'example-badge.jpg')} loading={opening} />
      ) : (
        <section className="work">
          <div className="work-main">
            <Compare originalUrl={source.url} svg={result?.svg ?? null} width={source.width} height={source.height} busy={busyLabel} />
            <div className="filerow">
              <b>{source.name}</b> · {source.width}×{source.height}
            </div>
          </div>
          <ResultCard
            status={status}
            headline={headline}
            summary={summary}
            error={traceError}
            onRetry={() => {
              setTraceError(null)
              setRetry((n) => n + 1)
            }}
            purpose={client.purpose}
            onPurpose={(purpose: Purpose) => setClient((c) => ({ ...c, purpose }))}
            chips={chips}
            onRemoveColor={removeColor}
            fixNotes={fixNotes}
            transparent={transparent}
            transparentHint={transparentHint}
            transparentLocked={transparentLocked}
            onTransparent={setTransparent}
            downloads={downloads}
            onDownload={download}
            detail={client.detail}
            corners={client.corners}
            onDetail={(detail) => setClient((c) => ({ ...c, detail }))}
            onCorners={(corners) => setClient((c) => ({ ...c, corners }))}
            more={
              <MoreOptions
                detected={detection.kind}
                style={client.style}
                onStyle={(style) => {
                  setRemoved([])
                  setClient((c) => ({ ...c, style }))
                }}
                maxColors={client.maxColors}
                onMaxColors={(maxColors) => setClient((c) => ({ ...c, maxColors }))}
                showColors={kind === 'flat' && !inks.enabled}
                upscale={upscale}
                onUpscale={setUpscale}
                upscaleProgress={aiProgress}
                upscaleNote={upscaleNote}
                fonts={<FontPanel imageId={source.id} bitmap={source.bitmap} colors={palettes?.map((p) => p.color) ?? []} />}
                brandColors={
                  <BrandPanel
                    brand={brand}
                    mode={matchMode}
                    onMode={(m) => {
                      setInks((s) => ({ ...s, enabled: m === 'library' }))
                      setBrand({ ...brand, mode: m === 'library' ? 'off' : m })
                    }}
                    onColors={(colors) => setBrand({ ...brand, colors })}
                    artwork={chips ?? []}
                    library={importedPalette}
                    libraryPanel={
                  <InkPanel
                    embedded
                    settings={inks}
                    palette={palette}
                    isDemo={!importedPalette}
                    inks={inks.enabled ? (result?.inks ?? null) : null}
                    onChange={(patch) => {
                      setRemoved([])
                      setInks((s) => ({ ...s, ...patch }))
                    }}
                    onImport={async (file) => {
                      try {
                        const p = await parsePaletteFile(file)
                        setImportedPalette(p)
                        savePalette(p)
                        setInks((s) => ({ ...s, overrides: {} }))
                        showToast(`Loaded ${p.swatches.length} colors from ${file.name}`)
                      } catch (err) {
                        showToast(err instanceof Error ? err.message : String(err))
                      }
                    }}
                    onUseDemo={() => {
                      setImportedPalette(null)
                      savePalette(null)
                      setInks((s) => ({ ...s, overrides: {} }))
                    }}
                  />
                    }
                  />
                }
              />
            }
          />
        </section>
      )}

      {toast && (
        <div className="toast" role="status">
          <span>{toast.text}</span>
          {toast.undo && (
            <button
              onClick={() => {
                toast.undo!()
                setToast(null)
              }}
            >
              Undo
            </button>
          )}
        </div>
      )}
    </div>
  )
}

const rgbInt = ([r, g, b]: [number, number, number]) => (r << 16) | (g << 8) | b

const plural = (n: number, one: string, many: string) => (n === 0 ? '' : n === 1 ? `1 ${one}` : `${n} ${many}`)
const listJoin = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`)

/** Identifies a trace by everything that affects its output. */
function cacheKey(sourceId: string, upscale: string, job: TraceJob, annotate: boolean): string {
  const opts =
    job.kind === 'flat'
      ? { ...job.options, quantize: { ...job.options.quantize, palette: job.options.quantize.palette ? `${job.options.quantize.palette.name}:${job.options.quantize.palette.swatches.length}` : null } }
      : job.params
  return `${sourceId}|${upscale}|${job.kind}|${job.image.width}x${job.image.height}|${annotate}|${JSON.stringify(opts)}`
}

function friendlyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/memory|allocation|bad_alloc/i.test(msg)) return 'This image is too large to process here. Try a smaller copy (under about 4000 pixels wide).'
  if (/unreachable|panic/i.test(msg)) return 'The tracer hit a problem with this image. Try a different artwork type under Fine-tune → More options.'
  return `Something went wrong while tracing (${msg}).`
}
