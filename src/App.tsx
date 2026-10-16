import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Enhancer, type AiProgress, type UpscaleSetting } from './ai/enhancer'
import { Compare } from './components/Compare'
import { BrandPanel, type MatchMode } from './components/BrandPanel'
import { FontPanel } from './components/FontPanel'
import type { LineLettering, PlacedWord } from './fonts/lettering'
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
import { lostShading, shadingLossOf } from './quality/shading'
import { useImprover, type Candidate } from './useImprover'
import { DEFAULT_CLIENT, detailBoost, prepFor, purposeAffectsTrace, traceParamsFor, type ClientSettings, type Purpose } from './vectorize/client'
import { detectArt, type Detection } from './vectorize/detect'
import { alternatives, LETTERING_RATIO, worthSharpening } from './vectorize/improve'
import { exampleImage } from './vectorize/example'
import { FlatTracer } from './vectorize/flat-tracer'
import { bitmapToImageData, hasVisiblePixels, imageDataToInput, loadImage, type InputImage, type SourceImage } from './vectorize/image'
import { buildTraceJob, inkNames, runTraceJob, type TraceJob, type TraceResult } from './vectorize/pipeline'
import { CancelledError, Tracer } from './vectorize/tracer'

const DEBOUNCE_MS = 180

/** "1898" (8 could be 9), for a warning about a reading the image doesn't clearly support. */
function describeDoubt(w: PlacedWord): string {
  const parts = (w.doubts ?? []).map((d) => (d.at < 0 ? `also read as "${d.rival}"` : `"${d.char}" could be "${d.rival}"`))
  return `"${w.text}" (${[...new Set(parts)].join(', ')})`
}

export default function App() {
  const [source, setSource] = useState<SourceImage | null>(null)
  const [detection, setDetection] = useState<Detection | null>(null)
  const [opening, setOpening] = useState(false)
  const [client, setClient] = useState<ClientSettings>(DEFAULT_CLIENT)
  const [transparent, setTransparent] = useState(false)
  const [removed, setRemoved] = useState<number[]>([])
  const [result, setResult] = useState<TraceResult | null>(null)
  // The settings (jobKey) the shown result was traced with; during a re-trace it's the old one.
  const [resultKey, setResultKey] = useState('')
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
  // Lettering rebuilt from a matched font, per text line of the current image.
  const [lettering, setLettering] = useState<Record<number, LineLettering>>({})
  const [matchingLettering, setMatchingLettering] = useState(false)
  // The image whose automatic lettering match has finished (it runs once, after the first result).
  const [letteringSettled, setLetteringSettled] = useState<string | null>(null)
  // Lines the automatic match found but couldn't rebuild confidently, for the image with this id.
  const [unmatchedLettering, setUnmatchedLettering] = useState<{ id: string; lines: { line: number; text: string; closest: { label: string; score: number } | null }[] } | null>(null)
  const letteringWords = useMemo(() => Object.values(lettering).flatMap((l) => l.words), [lettering])
  const [importedPalette, setImportedPalette] = useState<Palette | null>(loadSavedPalette)
  const palette = importedPalette ?? DEMO_PALETTE

  const tracers = useRef<{ vtracer: Tracer; flat: FlatTracer; plates: FlatTracer; improve: FlatTracer }>(null)
  useEffect(() => {
    tracers.current = { vtracer: new Tracer(), flat: new FlatTracer(), plates: new FlatTracer(), improve: new FlatTracer() }
    return () => {
      tracers.current?.vtracer.dispose()
      tracers.current?.flat.dispose()
      tracers.current?.plates.dispose()
      tracers.current?.improve.dispose()
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
        setLettering({})
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
  // Print plates and cut files need shapes that don't overlap (knockout), but where two such shapes
  // meet, screens show a hairline seam. So the preview (and SVG) always stacks shapes, and the
  // knockout version is traced only when a print PDF or cut file is made.
  const plates = client.purpose !== 'web' && purposeAffectsTrace(kind, inks.enabled)
  const { detail, corners, maxColors, keepBlends, exactShapes, gradients } = client
  const buildJob = useMemo(() => {
    if (!input || !source) return null
    const c = { ...DEFAULT_CLIENT, detail, corners, maxColors, keepBlends, exactShapes, gradients }
    // `vary` makes an alternative of the current job (used by the background improver).
    return (knockout: boolean, vary: { detail?: number; input?: InputImage; lettering?: PlacedWord[] } = {}) =>
      buildTraceJob(vary.input ?? input, source.width, {
        trace: traceParamsFor(kind, { ...c, detail: vary.detail ?? detail }, detection ? detailBoost(detection, source.width, source.height) : undefined),
        prep: prepFor(kind, c),
        spot: { settings: inks, palette },
        removeColors: removed,
        transparent,
        knockout,
        keepBlends,
        exactShapes,
        gradients,
        brand,
        lettering: vary.lettering ?? letteringWords,
      })
  }, [input, source, detection, kind, detail, corners, maxColors, keepBlends, exactShapes, gradients, inks, palette, removed, transparent, brand, letteringWords])
  const job = useMemo(() => buildJob?.(false) ?? null, [buildJob])

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
      setResultKey(jobKey)
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
        setResultKey(jobKey)
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

  // Whether the result flattened visible shading (e.g. gradients the tracer couldn't keep), so the
  // summary doesn't call it ready for print. Line art is left out: it becomes solid ink on purpose.
  const [shadingLost, setShadingLost] = useState<{ svg: string; lost: boolean } | null>(null)
  useEffect(() => {
    const svg = result?.svg
    if (!svg || !source || kind !== 'flat') return
    let live = true
    shadingLossOf(source.bitmap, svg)
      .then((s) => live && setShadingLost({ svg, lost: lostShading(s) }))
      .catch(() => live && setShadingLost({ svg, lost: false }))
    return () => {
      live = false
    }
  }, [result?.svg, source, kind])
  const flattened = kind === 'flat' && !!result && shadingLost?.svg === result.svg && shadingLost.lost
  const chips: Chip[] | null = flatKind && palettes ? palettes.map((p) => ({ color: p.color, name: names.get(p.color) ?? '' })) : null

  const downloads = useMemo(() => {
    if (!result || !source) return null
    const baseName = source.name.replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '-') || 'vector'
    return downloadsFor(client.purpose, {
      svg: result.svg,
      plateSvg: plates && buildJob ? async () => {
            // Its own worker, so making a file never interrupts the preview.
            const t = tracers.current!
            return (await runTraceJob({ vtracer: t.vtracer, flat: t.plates }, buildJob(true), source, inks.enabled)).svg
          } : undefined,
      width: result.width,
      height: result.height,
      baseName,
      names,
      spotNames: inks.enabled ? new Map((result.inks ?? []).map((i) => [rgbInt(i.swatch.rgb), i.swatch.name])) : null,
      flat: !!chips && chips.length <= 16,
    })
  }, [result, source, client.purpose, names, inks.enabled, chips, plates, buildJob])

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
    : flattened
      ? `${colorCount ? `${colorCount} ${colorCount === 1 ? 'color' : 'colors'}` : `${(result?.paths ?? 0).toLocaleString()} shapes`}. Some shading in your image became flat color, so zoom in and check it before you ${{ print: 'print', web: 'publish', cut: 'cut' }[client.purpose]} it.`
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
    return {
      text: `Kept ${n} smooth, as editable gradient fills${client.purpose === 'print' ? ' (printed in full color)' : client.purpose === 'cut' ? ' (each cut as one shape)' : ''}.`,
      undoLabel: 'Undo',
      onUndo: () => setClient((c) => ({ ...c, gradients: false })),
    }
  })()
  const brandNote =
    result && result.named.length > 0 && brand.mode !== 'off'
      ? {
          text: `Matched ${result.named.length === 1 ? `1 color` : `${result.named.length} colors`} to your brand colors (${result.named.map(([, n]) => n).join(', ')}).`,
          undoLabel: 'Turn off',
          onUndo: () => setBrand({ ...brand, mode: 'off' }),
        }
      : null
  const letteringNote = (() => {
    const lines = Object.values(lettering)
    if (matchingLettering && result) return { text: 'Matching the lettering to fonts, to rebuild it cleanly…' }
    // Lines found but not rebuilt (no font close enough, and none chosen since).
    const unmatched = (unmatchedLettering && unmatchedLettering.id === source?.id ? unmatchedLettering.lines : []).filter((u) => !lettering[u.line])
    const howTo = 'If you know the font, choose it under More options → Fonts in this artwork → Use a font you know.'
    const kept = unmatched.length
      ? `“${unmatched[0].text}”${unmatched.length > 1 ? ` and ${unmatched.length === 2 ? '1 other line' : `${unmatched.length - 1} other lines`}` : ''} couldn't be rebuilt from a font automatically${unmatched[0].closest ? ` (closest: ${unmatched[0].closest.label}, ${Math.round(unmatched[0].closest.score * 100)}%)` : ''}`
      : ''
    if (!lines.length && result && kept) return { text: `Kept the lettering as traced: ${kept}. ${howTo}` }
    if (!lines.length || !result) return null
    const words = lines.reduce((n, l) => n + l.words.length, 0)
    const skipped = lines.reduce((n, l) => n + l.skipped, 0)
    const fonts = [...new Set(lines.flatMap((l) => l.words.map((w) => w.font)))]
    const fontsUsed = fonts.join(' and ')
    return {
      text: `Matched the lettering to ${fontsUsed} and rebuilt ${words === 1 ? '1 word' : `${words} words`} from ${fonts.length > 1 ? 'those fonts' : 'the font'}, so the letters are perfectly clean.${skipped ? ` ${skipped === 1 ? '1 word' : `${skipped} words`} didn't line up and ${skipped === 1 ? 'stays' : 'stay'} as traced.` : ''}${kept ? ` ${kept}, so it stays as traced. ${howTo}` : ''}`,
      undoLabel: 'Use traced letters',
      onUndo: () => setLettering({}),
    }
  })()
  // ---------- Cleaner version, found in the background ----------
  // Latest values for candidates created before the check starts (rebuilt lettering).
  const latest = useRef({ buildJob, letteringWords })
  latest.current = { buildJob, letteringWords }
  const improver = useImprover({
    source,
    result,
    jobKey,
    // Only once the shown result is final: traced with the current settings, after the automatic
    // lettering match (which can rebuild letters and so change the result) has finished.
    ready:
      status === 'ready' &&
      resultKey === jobKey &&
      !matchingLettering &&
      (letteringSettled === source?.id || !(kind === 'flat' && !inks.enabled)) &&
      upscale === 'off' &&
      job?.kind === 'flat',
    tracers,
    candidates: () => {
      if (!buildJob || !source || !detection) return []
      const d0 = client.detail
      return alternatives(detection, source.width, source.height, d0).map((alt): Candidate =>
        alt.kind === 'detail'
          ? {
              label: alt.label,
              job: async () => buildJob(false, { detail: alt.detail }),
              apply: () => {
                setClient((c) => ({ ...c, detail: alt.detail }))
                return () => setClient((c) => ({ ...c, detail: d0 }))
              },
            }
          : {
              label: alt.label,
              job: async () => {
                const up = await (enhancer.current ??= new Enhancer()).upscale(source.id, bitmapToImageData(source.bitmap), '2x')
                if (!up) return null
                const sharp = await imageDataToInput(up)
                // The job holds its own pixel copy; the temporary bitmap and URL can go.
                const j = buildJob(false, { input: sharp })
                URL.revokeObjectURL(sharp.url)
                sharp.bitmap.close()
                return j
              },
              apply: () => {
                setUpscale('2x')
                return () => setUpscale('off')
              },
            },
      )
    },
  })
  const fixNotes = [improver.note, letteringNote, gradientNote, brandNote, blendNote, shapeNote].filter((n): n is NonNullable<typeof n> => !!n)

  const busyLabel = aiProgress
    ? aiProgress.phase === 'download'
      ? `Downloading sharpening model · ${Math.round(aiProgress.progress * 100)}%`
      : `Sharpening · ${Math.round(aiProgress.progress * 100)}%`
    : busy || (!result && !traceError)
      ? 'Vectorizing…'
      : null

  // ---------- Render ----------
  return (
    <div className="mx-auto grid max-w-[1200px] gap-5 px-5 pt-[18px] pb-12">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <button className="flex items-center gap-2.5 py-1 font-display text-[19px]/none font-extrabold tracking-[-0.02em]" onClick={reset} aria-label="Vectorize, start over">
          <svg className="size-[26px]" viewBox="0 0 26 26" aria-hidden="true">
            <path d="M4 20C7 6 19 6 22 20" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
            <rect x="2" y="18" width="4.5" height="4.5" rx="1" fill="var(--color-accent)" />
            <rect x="19.5" y="18" width="4.5" height="4.5" rx="1" fill="var(--color-accent)" />
          </svg>
          Vectorize
        </button>
        {source && (
          <button className="rounded-full border border-line bg-card px-4 py-2 font-semibold hover:border-ink-2" onClick={reset}>
            Upload another image
          </button>
        )}
      </header>

      {!source || !detection ? (
        <Upload onFile={openBlob} onExample={async () => openBlob(await exampleImage(), 'example-badge.jpg')} loading={opening} />
      ) : (
        <section className="grid items-start gap-5 min-[941px]:grid-cols-[minmax(0,1fr)_370px]">
          <div className="grid min-w-0 gap-2">
            <Compare originalUrl={source.url} svg={result?.svg ?? null} width={source.width} height={source.height} busy={busyLabel} />
            <div className="pl-1 text-[13px] wrap-anywhere text-ink-2">
              <b className="font-semibold text-ink">{source.name}</b> · {source.width}×{source.height}
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
                fonts={
                  <FontPanel
                    imageId={source.id}
                    bitmap={source.bitmap}
                    colors={palettes?.map((p) => p.color) ?? []}
                    lettering={lettering}
                    canRebuild={kind === 'flat' && !inks.enabled}
                    auto={kind === 'flat' && !inks.enabled}
                    onAutoBusy={(busy) => {
                      setMatchingLettering(busy)
                      if (!busy) setLetteringSettled(source.id)
                    }}
                    onAutoUnmatched={(lines) => setUnmatchedLettering({ id: source.id, lines })}
                    onUseFont={async (report, index, match, quiet, only, named) => {
                      const line = report.lines[index]
                      // Only some words (e.g. the bold word of a bold + light wordmark), by position in the line.
                      const picked = only ?? line.shapes.map((_, k) => k)
                      const part = only ? { ...line, shapes: picked.map((k) => line.shapes[k]) } : line
                      let placed: LineLettering
                      try {
                        const { placeLine } = await import('./fonts/lettering')
                        placed = await placeLine(report, part, match, { named })
                      } catch (err) {
                        if (!quiet) showToast(`Couldn't rebuild the lettering: ${err instanceof Error ? err.message : String(err)}`)
                        return false
                      }
                      if (!placed.words.length) {
                        if (!quiet) showToast(`${match.label} doesn't line up with this lettering closely enough, so it stays as traced.`)
                        return false
                      }
                      // Text the image doesn't clearly support (a look-alike fits as well, or the OCR
                      // readings disagree) is never rebuilt automatically: those words stay traced.
                      // When the client picks the font themselves, it's rebuilt, with a warning.
                      const doubtful = placed.words.filter((w) => w.doubts?.length)
                      if (quiet && doubtful.length) {
                        placed = { ...placed, words: placed.words.filter((w) => !w.doubts?.length), skipped: placed.skipped + doubtful.length }
                        if (!placed.words.length) return false
                      } else if (doubtful.length) showToast(`Check the wording: ${doubtful.map(describeDoubt).join('; ')}.`)
                      // Positions within the part → positions within the line.
                      const words = placed.words.map((w) => ({ ...w, index: picked[w.index ?? 0] }))
                      setLettering((l) => {
                        const prev = l[index]
                        if (!only || !prev) return { ...l, [index]: { ...placed, words, tried: picked } }
                        // Keep the line's other words as they were rebuilt; replace the chosen ones.
                        const all = [...prev.words.filter((w) => !picked.includes(w.index ?? -1)), ...words].sort((a, b) => a.box.x0 - b.box.x0)
                        const tried = [...new Set([...(prev.tried ?? line.shapes.map((_, k) => k)), ...picked])]
                        const skipped = tried.filter((k) => !all.some((w) => w.index === k)).length
                        return { ...l, [index]: { font: [...new Set(all.map((w) => w.font))].join(' + '), words: all, skipped, tried } }
                      })
                      return true
                    }}
                    onClearFont={(index) => setLettering(({ [index]: _, ...rest }) => rest)}
                    sharpen={
                      detection && worthSharpening(detection, source.width, source.height)
                        ? async () => {
                            // Shared with the background improver: computed once, then cached.
                            const up = await (enhancer.current ??= new Enhancer()).upscale(source.id, bitmapToImageData(source.bitmap), '2x')
                            return up ? createImageBitmap(up) : null
                          }
                        : undefined
                    }
                    onTryFont={async (report, index, match) => {
                      // Below the automatic threshold: offered only if it scores clearly better, and
                      // only words whose text the image supports (never an unverified reading).
                      const { placeLine } = await import('./fonts/lettering')
                      const found = await placeLine(report, report.lines[index], match).catch(() => null)
                      const placed = found && { ...found, words: found.words.filter((w) => !w.doubts?.length) }
                      if (!placed?.words.length) return
                      improver.consider({
                        label: `lettering rebuilt from ${match.label}, the closest font match`,
                        ratio: LETTERING_RATIO,
                        job: async () => latest.current.buildJob?.(false, { lettering: [...latest.current.letteringWords, ...placed.words] }) ?? null,
                        apply: () => {
                          setLettering((l) => ({ ...l, [index]: placed }))
                          return () => setLettering(({ [index]: _, ...rest }) => rest)
                        },
                      })
                    }}
                    onTryLines={async (report, tries) => {
                      // Lines of one piece of lettering (a tagline split into lines by OCR) rebuilt
                      // together: each line alone may change too little to be offered.
                      const { placeLine } = await import('./fonts/lettering')
                      const placed = (
                        await Promise.all(tries.map(async ({ line, match }) => ({ line, found: await placeLine(report, report.lines[line], match).catch(() => null) })))
                      ).flatMap(({ line, found }) => {
                        const words = found?.words.filter((w) => !w.doubts?.length) ?? []
                        return found && words.length ? [{ line, lettering: { ...found, words } }] : []
                      })
                      if (placed.length < 2) return
                      const fonts = [...new Set(placed.map((p) => p.lettering.font))]
                      improver.consider({
                        label: `lettering in ${placed.length} lines rebuilt from the closest font matches (${fonts.join(', ')})`,
                        ratio: LETTERING_RATIO,
                        job: async () => latest.current.buildJob?.(false, { lettering: [...latest.current.letteringWords, ...placed.flatMap((p) => p.lettering.words)] }) ?? null,
                        apply: () => {
                          setLettering((l) => ({ ...l, ...Object.fromEntries(placed.map((p) => [p.line, p.lettering])) }))
                          return () => setLettering((l) => Object.fromEntries(Object.entries(l).filter(([k]) => !placed.some((p) => p.line === Number(k)))))
                        },
                      })
                    }}
                  />
                }
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
        <div className="fixed bottom-[calc(24px+env(safe-area-inset-bottom,0px))] left-1/2 z-10 flex max-w-[calc(100%-32px)] -translate-x-1/2 items-center gap-3.5 rounded-[10px] bg-ink px-4 py-[11px] text-sm text-card shadow-[0_10px_30px_rgb(0_0_0/0.25)]" role="status">
          <span>{toast.text}</span>
          {toast.undo && (
            <button
              className="font-bold text-accent"
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
      ? {
          ...job.options,
          quantize: { ...job.options.quantize, palette: job.options.quantize.palette ? `${job.options.quantize.palette.name}:${job.options.quantize.palette.swatches.length}` : null },
          // The coverage map follows from the words; keep the key small.
          text: job.options.text?.words.map((w) => `${w.font}:${w.text}:${w.box.map(Math.round).join(',')}`) ?? null,
        }
      : job.params
  return `${sourceId}|${upscale}|${job.kind}|${job.image.width}x${job.image.height}|${annotate}|${JSON.stringify(opts)}`
}

function friendlyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/memory|allocation|bad_alloc/i.test(msg)) return 'This image is too large to process here. Try a smaller copy (under about 4000 pixels wide).'
  if (/unreachable|panic/i.test(msg)) return 'The tracer hit a problem with this image. Try a different artwork type under Fine-tune → More options.'
  return `Something went wrong while tracing (${msg}).`
}
