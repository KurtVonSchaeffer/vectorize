import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Enhancer, type AiProgress, type UpscaleSetting } from './ai/enhancer'
import { Compare } from './components/Compare'
import { BrandPanel, type MatchMode } from './components/BrandPanel'
import { FontPanel } from './components/FontPanel'
import type { LineLettering, PlacedWord } from './fonts/lettering'
import { placeSuggestion } from './fonts/suggest'
import { SMALL_TEXT_PX } from './fonts/textsize'
import { InkPanel } from './components/InkPanel'
import { MoreOptions } from './components/MoreOptions'
import { ResultCard, type Chip, type ColorMode } from './components/ResultCard'
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
import { alternatives, worthSharpening } from './vectorize/improve'
import { exampleImage } from './vectorize/example'
import { FlatTracer } from './vectorize/flat-tracer'
import { bitmapToImageData, hasVisiblePixels, imageDataToInput, loadImage, type InputImage, type SourceImage } from './vectorize/image'
import { buildTraceJob, inkNames, runTraceJob, type TraceJob, type TraceResult } from './vectorize/pipeline'
import { CancelledError, TimeoutError, Tracer } from './vectorize/tracer'

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
  // The shortest text line the lettering reader found (source pixels), for the image with this id.
  const [textSize, setTextSize] = useState<{ id: string; px: number | null } | null>(null)
  // The image whose color mode was set to Custom (its limits are then chosen under Fine-tune).
  const [customPicked, setCustomPicked] = useState<string | null>(null)
  // Close font matches suggested by name (never applied until the customer tries them), for the image with this id.
  const [fontSuggestion, setFontSuggestion] = useState<{ id: string; lines: { line: number; text: string; font: string; score: number; placed: LineLettering }[] } | null>(null)
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
        // Every upload starts in full color: print inks (one ink, library matching) are a choice
        // per image, never carried over silently from the previous one.
        setInks((s) => (s.enabled ? { ...s, enabled: false } : s))
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
  // One colour: Maximum colors = 1 on flat art. The gap is cut only into print plates and cut files.
  const oneOn = maxColors === 1 && kind === 'flat' && !inks.enabled
  const { ink: oneInk, gapMm, outputWidthMm, previewGaps } = client.oneColour
  const gapsShown = oneOn && plates && previewGaps && gapMm > 0
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
        oneColour: oneOn ? { ink: oneInk, gapMm, outputWidthMm } : undefined,
      })
  }, [input, source, detection, kind, detail, corners, maxColors, keepBlends, exactShapes, gradients, inks, palette, removed, transparent, brand, letteringWords, oneOn, oneInk, gapMm, outputWidthMm])
  // The preview is the master, unless the client asked to see the production file's gaps.
  const job = useMemo(() => buildJob?.(gapsShown) ?? null, [buildJob, gapsShown])

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
      // One colour: the master keeps each former colour as its own shape, which a cutter would cut apart.
      cutSvgFromPlates: oneOn,
    })
  }, [result, source, client.purpose, names, inks.enabled, chips, plates, buildJob, oneOn])

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
  const counted = colorCount ? `${colorCount} ${colorCount === 1 ? 'color' : 'colors'}` : `${(result?.paths ?? 0).toLocaleString()} shapes`
  const smallText = !!source && textSize?.id === source.id && textSize.px !== null && textSize.px < SMALL_TEXT_PX
  // Only claim "ready" when nothing we know of says otherwise. Cut files aren't checked for
  // cuttability, so they're never called ready; photos and tiny lettering get a plain warning.
  const warnings = [
    kind === 'photo' &&
      (client.purpose === 'cut'
        ? 'Photos become thousands of tiny shapes, which a cutting machine can’t cut cleanly. Use a logo or line drawing for cutting.'
        : 'Photos become thousands of small shapes: fine for large prints and posters, but not clean, editable artwork.'),
    smallText && 'Some lettering is too small to trace cleanly and may be hard to read. Upload a larger copy if you have one.',
  ].filter(Boolean)
  const summary = status === 'working' && !result
    ? 'Finding colors and tracing edges…'
    : warnings.length
      ? `${counted}. ${warnings.join(' ')}`
      : inks.enabled && inks.maxInks === 1
        ? 'One ink: every color prints in this ink, and white areas stay as paper. Choose the ink under Brand colors.'
        : flattened
          ? `${counted}. Some shading in your image became flat color, so zoom in and check it before you ${{ print: 'print', web: 'publish', cut: 'cut' }[client.purpose]} it.`
          : client.purpose === 'cut'
            ? `${counted}${colorCount ? ', clean edges' : ''}. Check small details at your cut size before cutting.`
            : `${colorCount ? `${counted}, clean edges` : counted}, ready for ${client.purpose === 'print' ? 'print' : 'the web'}.`
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
  // The color mode, shown on the result: full color unless the customer chose otherwise.
  // One color is the one-colour engine (oneOn). The legacy silhouette (one print ink, white as paper)
  // is a Custom choice, kept while the two are compared.
  const legacySilhouette = inks.enabled && inks.maxInks === 1
  const colorMode: ColorMode = oneOn ? 'one' : inks.enabled || client.maxColors !== null || customPicked === source?.id ? 'custom' : 'full'
  const openFineTune = (id: string) => {
    document.querySelectorAll('details').forEach((d) => (d.open = true))
    requestAnimationFrame(() => document.getElementById(id)?.focus())
  }
  const setColorMode = (m: ColorMode) => {
    setRemoved([])
    setCustomPicked(m === 'custom' ? (source?.id ?? null) : null)
    if (m === 'full') {
      setInks((s) => ({ ...s, enabled: false }))
      setClient((c) => ({ ...c, maxColors: null }))
    } else if (m === 'one') {
      setInks((s) => ({ ...s, enabled: false }))
      setClient((c) => ({ ...c, maxColors: 1 }))
      setBrand({ ...brand, mode: 'off' })
      openFineTune('one-ink')
    } else {
      // Custom: the limits live under Fine-tune → More options (maximum colors, print inks, or the legacy silhouette).
      setInks((s) => ({ ...s, enabled: false }))
      setClient((c) => ({ ...c, maxColors: c.maxColors === 1 ? null : c.maxColors }))
      openFineTune('maxColors')
    }
  }
  const setLegacySilhouette = (on: boolean) => {
    setRemoved([])
    setCustomPicked(source?.id ?? null)
    setClient((c) => ({ ...c, maxColors: null }))
    setInks((s) => (on ? { ...s, enabled: true, maxInks: 1, whiteIsPaper: true } : { ...s, enabled: false }))
    if (on) setBrand({ ...brand, mode: 'off' })
  }
  const inkNote = inks.enabled
    ? {
        text: legacySilhouette
          ? 'Legacy silhouette: the whole artwork in one print ink as a single shape, without inner shapes or separation gaps. For one ink that keeps inner shapes, choose Color mode → One color.'
          : `Colors are matched to at most ${inks.maxInks} print inks${importedPalette ? ' from your library' : ' (demo inks)'}.`,
        undoLabel: 'Back to full color',
        onUndo: () => {
          setRemoved([])
          setInks((s) => ({ ...s, enabled: false }))
        },
      }
    : null
  const letteringNote = (() => {
    const lines = Object.values(lettering)
    if (matchingLettering && result) return { text: 'Reading the lettering and looking for matching fonts…' }
    // Lines found but not rebuilt (no font close enough, and none chosen since).
    const unmatched = (unmatchedLettering && unmatchedLettering.id === source?.id ? unmatchedLettering.lines : []).filter((u) => !lettering[u.line])
    const suggested = (fontSuggestion && fontSuggestion.id === source?.id ? fontSuggestion.lines : []).filter((s) => !lettering[s.line])
    const howTo = 'If you know the font, choose it under More options → Fonts in this artwork → Use a font you know.'
    const quote = (texts: string[]) => `“${texts[0]}”${texts.length > 1 ? ` and ${texts.length === 2 ? '1 other line' : `${texts.length - 1} other lines`}` : ''}`
    if (lines.length && result) {
      const words = lines.reduce((n, l) => n + l.words.length, 0)
      const skipped = lines.reduce((n, l) => n + l.skipped, 0)
      const fonts = [...new Set(lines.flatMap((l) => l.words.map((w) => w.font)))]
      return {
        text: `Showing ${words === 1 ? '1 word' : `${words} words`} rebuilt in ${fonts.join(' and ')} instead of the traced letters. Compare with your image before you keep it.${skipped ? ` ${skipped === 1 ? '1 word' : `${skipped} words`} didn't line up and ${skipped === 1 ? 'stays' : 'stay'} as traced.` : ''}`,
        undoLabel: 'Back to traced letters',
        onUndo: () => setLettering({}),
      }
    }
    if (!result) return null
    if (suggested.length) {
      const font = suggested[0].font
      return {
        text: `Kept the lettering as traced. ${quote(suggested.map((s) => s.text))} looks like ${font} (${Math.round(suggested[0].score * 100)}% font match). You can try that typeface as an alternative: rebuilt letters are clean, but can sit or space slightly differently from your image, so compare before you keep it.`,
        undoLabel: `Try ${font}`,
        onUndo: () => setLettering((l) => ({ ...l, ...Object.fromEntries(suggested.map((s) => [s.line, s.placed])) })),
      }
    }
    if (unmatched.length) {
      const closest = unmatched[0].closest
      return { text: `Kept the lettering as traced: ${quote(unmatched.map((u) => u.text))} ${unmatched.length > 1 ? "weren't" : "wasn't"} replaced with a font${closest ? ` (closest: ${closest.label}, ${Math.round(closest.score * 100)}%)` : ''}. ${howTo}` }
    }
    return null
  })()
  // ---------- Cleaner version, found in the background ----------
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
  const fixNotes = [inkNote, improver.note, letteringNote, gradientNote, brandNote, blendNote, shapeNote].filter((n): n is NonNullable<typeof n> => !!n)

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
            <Compare
              originalUrl={source.url}
              svg={result?.svg ?? null}
              width={source.width}
              height={source.height}
              busy={busyLabel}
              vectorLabel={gapsShown ? `Print / cut file · ${(widenedGap(result?.oneColour ?? null, gapMm) ?? gapMm).toFixed(1)} mm gaps` : oneOn ? 'Master · one colour, no gaps' : undefined}
              marks={
                gapsShown && result?.oneColour?.flags.length
                  ? { points: result.oneColour.flags, size: { width: result.width, height: result.height }, legend: `Red rings: ${result.oneColour.flags.length} places to check, where a gap was left out (to keep detail or keep the file cuttable) or took in a hairline sliver.` }
                  : undefined
              }
            />
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
            colorMode={kind === 'flat' ? { mode: colorMode, onMode: setColorMode } : null}
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
                oneColour={client.oneColour}
                onOneColour={(oneColour) => setClient((c) => ({ ...c, oneColour: { ...c.oneColour, ...oneColour } }))}
                oneColourGaps={plates}
                oneColourNote={oneOn ? oneColourNote(result?.oneColour ?? null, gapsShown, gapMm) : null}
                oneColourInk={oneOn ? (result?.oneColour?.ink ?? null) : null}
                legacySilhouette={kind === 'flat' && !oneOn && (!inks.enabled || legacySilhouette) ? { on: legacySilhouette, onChange: setLegacySilhouette } : null}
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
                    onTextSize={(px) => setTextSize({ id: source.id, px })}
                    onSuggestFont={async (report, index, match) => {
                      // Suggested by name only (see fonts/suggest.ts), applied only on request.
                      const { placeLine } = await import('./fonts/lettering')
                      const item = await placeSuggestion(report, index, match, placeLine)
                      if (!item) return
                      setFontSuggestion((s) => (s && s.id === source.id ? { id: s.id, lines: [...s.lines.filter((l) => l.line !== index), item] } : { id: source.id, lines: [item] }))
                    }}
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

/**
 * A gap the print / cut file got that is wider than the one asked for (it is at least 1.5 traced px);
 * null when it isn't wider, or when no gap was cut at all.
 */
const widenedGap = (r: TraceResult['oneColour'], askedMm: number) => (r && r.gaps > 0 && r.gapMm != null && r.gapMm > askedMm + 0.05 ? r.gapMm : null)

/** What one colour did, in plain words: negative space kept, and gaps moved or skipped to keep detail. */
function oneColourNote(r: TraceResult['oneColour'], gapsShown: boolean, askedMm: number): string | null {
  if (!r) return null
  const parts = [`${r.inkRegions} ${r.inkRegions === 1 ? 'colour' : 'colours'} drawn in the ink`]
  if (r.paperRegions) parts.push(`${r.paperRegions} light ${r.paperRegions === 1 ? 'colour' : 'colours'} left open as negative space`)
  if (gapsShown) {
    parts.push(`gaps cut at ${r.gaps} ${r.gaps === 1 ? 'boundary' : 'boundaries'}`)
    const wide = widenedGap(r, askedMm)
    if (wide) parts.push(`gaps are ${wide.toFixed(1)} mm, not the ${askedMm.toFixed(1)} mm you chose: at this image size a narrower gap wouldn't cut the pieces apart (a larger upload allows a narrower gap)`)
    const thin = r.flags.filter((f) => f.reason === 'gap-skipped').length
    const cut = r.flags.filter((f) => f.reason === 'cut-limit').length
    const sliver = r.flags.filter((f) => f.reason === 'gap-sliver').length
    if (thin) parts.push(`${thin} left joined where a gap would cut into thin detail`)
    if (cut) parts.push(`${cut} left joined where a gap would leave a piece too thin or small to cut`)
    if (sliver) parts.push(`${sliver} hairline ${sliver === 1 ? 'sliver' : 'slivers'} of another colour along a gap became part of it`)
    if (thin || cut || sliver) parts.push('ringed in red on the preview')
  }
  return parts.join(' · ') + '.'
}

function friendlyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/memory|allocation|bad_alloc/i.test(msg)) return 'This image is too large to process here. Try a smaller copy (under about 4000 pixels wide).'
  if (err instanceof TimeoutError) return 'This image is taking too long to process. Try a smaller copy, or fewer colours under Fine-tune.'
  if (/unreachable|panic/i.test(msg)) return 'The tracer hit a problem with this image. Try a different artwork type under Fine-tune → More options.'
  return `Something went wrong while tracing (${msg}).`
}
