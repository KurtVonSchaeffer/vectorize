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
import { ResultCard, type Chip, type ColorMode, type WhiteInk } from './components/ResultCard'
import { MAX_UPLOAD_MB, Upload } from './components/Upload'
import barronLogo from './assets/barron-logo.svg'
import { downloadsFor, printWidthMm, saveBlob, type Download } from './export/files'
import { platesOf } from './export/plates'
import { DEMO_PALETTE } from './palette/demo'
import { oneColourPlateName } from './vectorize/one-colour-ink'
import { colorNames } from './palette/names'
import { parsePaletteFile, type Palette } from './palette/parse'
import { DEFAULT_INKS, type InkSettings } from './palette/quantize'
import type { BrandSettings } from './palette/brand'
import { loadSavedBrand, loadSavedPalette, saveBrand, savePalette } from './palette/storage'
import { FidelityChecker } from './quality/check'
import { ADMIN_MODE, CLEAN_GEOMETRY, FINE_DETAIL, PRINT_FILES, QUALITY_REPORTING, STRAIGHT_EDGES, EXACT_ARCS } from './quality/flags'
import { profileFor } from './admin/complexity'
import { applyDefaults, buildRun, defaultRunsApi, renderModeOf, suggestedAssetType, type LearnedDefaults, type RunRecord } from './admin/runs'
import { ReviewPanel, type ReviewDraft } from './components/ReviewPanel'
import { isReviewed, readiness, type CheckOutcome, type Review } from './quality/readiness'
import { lostShading, shadingLossOf } from './quality/shading'
import { useImprover, type Candidate } from './useImprover'
import { DEFAULT_CLIENT, detailBoost, prepFor, purposeAffectsTrace, traceParamsFor, type ClientSettings, type Purpose } from './vectorize/client'
import { detectArt, type Detection } from './vectorize/detect'
import { ADMIN_SHARPEN_BELOW, alternatives, compressionRipple, SHARPEN_BELOW, worthSharpening } from './vectorize/improve'
import { exampleImage } from './vectorize/example'
import { FlatTracer } from './vectorize/flat-tracer'
import { bitmapToImageData, hasVisiblePixels, imageDataToInput, loadImage, type InputImage, type SourceImage } from './vectorize/image'
import { buildTraceJob, inkNames, runTraceJob, type TraceJob, type TraceResult } from './vectorize/pipeline'
import { isPaperColour, paperOutFor, type EnclosedArea, type WhiteChoice } from './vectorize/paper'
import { CancelledError, TimeoutError, Tracer } from './vectorize/tracer'

const DEBOUNCE_MS = 180
/**
 * The shading layer of an illustration: full colour, traced at twice the size (up to 2400 px) so
 * pen strokes 1–2 px wide are 2–4 px and keep their shape, with Detail raised a quarter of the way
 * to the maximum. Halfway kept specks of 2 px (at 2×): on the Gorilla Glue logo, a quarter (3 px)
 * has 45% fewer paths in the shading and looks 96% the same (SSIM of the texture).
 */
function shadingFor(c: ClientSettings) {
  const fine = { ...c, detail: c.detail + (1 - c.detail) / 4 }
  return { trace: traceParamsFor('photo', fine), prep: { maxSize: 2400, upscaleSmall: false, scale: 2 } }
}

/** Where the admin panel records runs and reviews (docs/admin-panel.md); null outside it. */
const runsApi = ADMIN_MODE ? defaultRunsApi() : null
/** Uploads up to this size (longest side, px) are also tried with AI sharpening (see ADMIN_SHARPEN_BELOW). */
const sharpenBelow = ADMIN_MODE ? ADMIN_SHARPEN_BELOW : SHARPEN_BELOW

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
  // Print files (flag): for an opaque upload on paper, how much of the white prints as white ink.
  // None unless asked, per upload: white ink is a production decision.
  const [whiteInk, setWhiteInk] = useState<WhiteInk>('none')
  const [platesOpen, setPlatesOpen] = useState(false)
  const [paperWords, setPaperWords] = useState<{ id: string; boxes: [number, number, number, number][] } | null>(null)
  const [whiteChoices, setWhiteChoices] = useState<WhiteChoice[]>([])
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
  const checker = useRef<FidelityChecker>(null)
  useEffect(() => () => checker.current?.dispose(), [])

  // ---------- Admin panel: compression measured on upload, the run recorded, the artist's review ----------
  const [compression, setCompression] = useState(0)
  const [defaults, setDefaults] = useState<LearnedDefaults | null>(null)
  const [run, setRun] = useState<{ sourceId: string; record: RunRecord } | null>(null)
  const [reviewSave, setReviewSave] = useState<{ status: 'saving' | 'saved' } | { status: 'error'; message: string } | null>(null)
  const openedId = useRef<string | null>(null)

  const showToast = useCallback((text: string, undo?: () => void) => setToast({ text, undo }), [])
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), toast.undo ? 5000 : 3500)
    return () => clearTimeout(t)
  }, [toast])

  // ---------- Opening an image ----------
  const openBlob = useCallback(
    async (blob: Blob, name: string) => {
      if (blob.size > MAX_UPLOAD_MB * 1024 * 1024) {
        showToast(`That file is over ${MAX_UPLOAD_MB} MB. Try a smaller copy.`)
        return
      }
      setOpening(true)
      try {
        const img = await loadImage(blob, name)
        const pixels = bitmapToImageData(img.bitmap)
        const det = detectArt(pixels)
        openedId.current = img.id
        if (ADMIN_MODE) {
          const ripple = compressionRipple(pixels)
          setCompression(ripple)
          setRun(null)
          setReviewSave(null)
          setDefaults(null)
          // Learned defaults for this kind of logo, if a supervisor approved some; tracing starts with
          // the usual settings and moves to these when they arrive.
          runsApi
            ?.getDefaults(profileFor({ detection: det, compression: ripple, width: img.width, height: img.height }))
            .then((d) => {
              if (!d || openedId.current !== img.id) return
              setDefaults(d)
              setClient((c) => applyDefaults(c, d))
            })
        }
        setSource((prev) => {
          if (prev) {
            URL.revokeObjectURL(prev.url)
            prev.bitmap.close()
          }
          return img
        })
        setDetection(det)
        setTransparent(det.hasAlpha || det.kind === 'lineart')
        setWhiteInk('none')
        setPlatesOpen(false)
        setWhiteChoices([])
        setRemoved([])
        setLettering({})
        setResult(null)
        setTraceError(null)
        setUpscaled(null)
        setClient((c) => ({ ...c, style: 'auto', maxColors: null, keepBlends: false, simplified: false }))
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
  // Hatched or engraved illustrations (detectArt) get a full-colour shading layer where the texture
  // is, or (Simplified) the texture redrawn as a few solid shapes; the flat colours draw the rest
  // (lettering, outlines, banners) with clean edges.
  const illustration = kind === 'flat' && client.style === 'auto' && !!detection?.illustration
  const simplified = client.simplified
  const buildJob = useMemo(() => {
    if (!input || !source) return null
    const c = { ...DEFAULT_CLIENT, detail, corners, maxColors, keepBlends, exactShapes, gradients }
    // `vary` makes an alternative of the current job (used by the background improver), or sets
    // what only print and cut files get (`paperOut`), so the preview isn't traced again for it.
    return (knockout: boolean, vary: { detail?: number; input?: InputImage; lettering?: PlacedWord[]; paperOut?: 'border' | 'all'; paperWords?: [number, number, number, number][]; whiteChoices?: WhiteChoice[] } = {}) =>
      buildTraceJob(vary.input ?? input, source.width, {
        trace: traceParamsFor(kind, { ...c, detail: vary.detail ?? detail }, detection ? detailBoost(detection, source.width, source.height) : undefined),
        prep: prepFor(kind, c),
        spot: { settings: inks, palette },
        removeColors: removed,
        transparent,
        knockout,
        keepBlends,
        exactShapes,
        ...(illustration ? (simplified ? { simplified: true } : { shading: shadingFor(c) }) : {}),
        gradients,
        brand,
        ...(CLEAN_GEOMETRY ? { cleanGeometry: true } : {}),
        // Fine detail changes the master only; without print files the print and cut SVGs are the
        // master, so it needs them (print and cut files then stay exactly as before).
        ...(FINE_DETAIL && PRINT_FILES ? { fineDetail: true } : {}),
        ...(STRAIGHT_EDGES ? { straightEdges: true } : {}),
        ...(EXACT_ARCS ? { exactArcs: true } : {}),
        lettering: vary.lettering ?? letteringWords,
        oneColour: oneOn ? { ink: oneInk, gapMm, outputWidthMm } : undefined,
        ...(vary.paperOut ? { paperOut: vary.paperOut, paperWords: vary.paperWords, whiteChoices: vary.whiteChoices } : {}),
      })
  }, [input, source, detection, kind, illustration, simplified, detail, corners, maxColors, keepBlends, exactShapes, gradients, inks, palette, removed, transparent, brand, letteringWords, oneOn, oneInk, gapMm, outputWidthMm])
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

  // Quality reporting (behind a flag): the result measured against the upload, and a person's
  // review of that exact result. Neither is a production approval.
  const [check, setCheck] = useState<{ svg: string; outcome: CheckOutcome } | null>(null)
  const [review, setReview] = useState<Review | null>(null)
  // Results changed from the upload on purpose (one colour, spot inks, line and pixel art, colours
  // removed or matched to brand colours, a background removed) can't be compared with it. A white
  // or near-white background removed still can: the check composites both images over white.
  const paperRemoved = transparent && !detection?.hasAlpha && detection?.background != null && isPaperColour(detection.background)
  const changedOnPurpose = oneOn || inks.enabled || kind === 'lineart' || kind === 'pixel' || removed.length > 0 || (transparent && !detection?.hasAlpha && !paperRemoved) || (result?.named.length ?? 0) > 0
  useEffect(() => {
    const svg = result?.svg
    if (!QUALITY_REPORTING || !svg || !source) return
    if (changedOnPurpose) {
      setCheck({ svg, outcome: { state: 'not-checked', reason: 'unsupported' } })
      return
    }
    let live = true
    setCheck({ svg, outcome: { state: 'checking' } })
    ;(checker.current ??= new FidelityChecker())
      .check(source.bitmap, svg, undefined, paperRemoved)
      .then((outcome) => live && setCheck({ svg, outcome }))
    return () => {
      live = false
      // Measuring a result nobody will see is wasted work.
      checker.current?.cancel()
    }
  }, [result?.svg, source, changedOnPurpose, paperRemoved])
  const chips: Chip[] | null = flatKind && palettes ? palettes.map((p) => ({ color: p.color, name: names.get(p.color) ?? '' })) : null

  // Print files (flag), white artwork only: the words of text found (letter counters are paper, see
  // paper.ts), null while the lettering is still being read; and the person's choices for the rest.
  const textWords = useMemo(
    () => (!source ? null : paperWords?.id === source.id ? paperWords.boxes : letteringSettled === source.id || kind !== 'flat' || inks.enabled ? [] : null),
    [source, paperWords, letteringSettled, kind, inks.enabled],
  )
  const plateResult = useMemo(() => {
    if (!PRINT_FILES || !result || !source || !plates || !buildJob) return undefined
    const paperOut = paperOutFor(whiteInk)
    let made: Promise<TraceResult> | null = null
    // Made once, so the plates previewed are the plates downloaded.
    return () => (made ??= runTraceJob(
      { vtracer: tracers.current!.vtracer, flat: tracers.current!.plates },
      buildJob(true, paperOut ? { paperOut, paperWords: textWords ?? [], whiteChoices } : {}),
      source,
      inks.enabled,
    ).catch((e) => {
      made = null
      throw e
    }))
  }, [result, source, plates, buildJob, inks.enabled, whiteInk, textWords, whiteChoices])

  const plateSvg = useMemo(() => {
    if (!result || !source || !plates || !buildJob) return undefined
    if (plateResult) return async () => (await plateResult()).svg
    return async () => {
      // Its own worker, so making a file never interrupts the preview.
      const t = tracers.current!
      return (await runTraceJob({ vtracer: t.vtracer, flat: t.plates }, buildJob(true, {}), source, inks.enabled)).svg
    }
  }, [result, source, plates, buildJob, inks.enabled, plateResult])

  const spotNames = useMemo(
    () =>
      !result
        ? null
        : inks.enabled
          ? new Map((result.inks ?? []).map((i) => [rgbInt(i.swatch.rgb), i.swatch.name]))
          : oneOn && result.oneColour
            ? new Map([[result.oneColour.ink, oneColourPlateName(result.oneColour.ink, client.oneColour.ink !== null ? client.oneColour.inkName || null : null)]])
            : null,
    [result, inks.enabled, oneOn, client.oneColour.ink, client.oneColour.inkName],
  )

  const downloads = useMemo(() => {
    if (!result || !source) return null
    const baseName = source.name.replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '-') || 'vector'
    return downloadsFor(client.purpose, {
      svg: result.svg,
      plateSvg,
      width: result.width,
      height: result.height,
      baseName,
      names,
      spotNames,
      flat: !!chips && chips.length <= 16,
      // One colour: the master keeps each former colour as its own shape, which a cutter would cut apart.
      // Print files (flag): the print / cut SVG is the same artwork as the PDF and DXF, paper left out.
      cutSvgFromPlates: oneOn || PRINT_FILES,
      // One colour has a chosen output width: the print and cut files (SVG, PDF, DXF) are made at it.
      outputWidthMm: oneOn ? outputWidthMm : undefined,
      // Print files (flag): full-colour SVG and DXF match the PDF's size (long side 254 mm).
      printWidthMm: PRINT_FILES && !oneOn ? printWidthMm(result.width, result.height) : undefined,
    })
  }, [result, source, client.purpose, names, spotNames, chips, plateSvg, oneOn, outputWidthMm])

  // Print files (flag): the plates as they will print, made on request.
  const [preview, setPreview] = useState<{ of: () => Promise<TraceResult>; plates: TraceResult | null; failed: boolean } | null>(null)
  // Spot inks have their own white-is-paper setting.
  const whiteInkShown = PRINT_FILES && plates && !oneOn && !inks.enabled && !transparent && !!result?.paper
  // White artwork only: made straight away, to say which white areas need checking.
  const needPlates = platesOpen || (whiteInkShown && whiteInk === 'artwork')
  useEffect(() => {
    if (!needPlates || !plateResult) return
    let live = true
    setPreview({ of: plateResult, plates: null, failed: false })
    plateResult().then(
      (plates) => live && setPreview({ of: plateResult, plates, failed: false }),
      () => live && setPreview({ of: plateResult, plates: null, failed: true }),
    )
    return () => {
      live = false
    }
  }, [needPlates, plateResult])
  const shownPlates = preview && preview.of === plateResult ? preview : null
  // A choice per enclosed white area, kept in source pixels so it survives a re-trace at another scale.
  const chooseWhite = (areas: EnclosedArea[], white: boolean) => {
    if (!source || !shownPlates?.plates) return
    const k = source.width / shownPlates.plates.width
    const covers = (c: WhiteChoice, a: EnclosedArea) => c.at[0] / k >= a.box[0] && c.at[0] / k <= a.box[2] && c.at[1] / k >= a.box[1] && c.at[1] / k <= a.box[3]
    setWhiteChoices((cs) => [...cs.filter((c) => !areas.some((a) => covers(c, a))), ...areas.map((a) => ({ at: [a.at[0] * k, a.at[1] * k] as [number, number], white }))])
  }
  const plateList = useMemo(() => (shownPlates?.plates ? platesOf(shownPlates.plates.svg, (c) => spotNames?.get(c) ?? names.get(c)) : { plates: [], gradients: 0 }), [shownPlates?.plates, spotNames, names])

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
  const checkNow: CheckOutcome | null = result && check?.svg === result.svg ? check.outcome : result ? { state: 'checking' } : null
  const quality = QUALITY_REPORTING
    ? readiness({
        // While a new version is traced, the current one stays described (as the old summary does).
        status: status === 'working' && result ? 'ready' : status,
        counted,
        purpose: client.purpose,
        warnings: [
          ...warnings.filter((w): w is string => typeof w === 'string'),
          // The check reports flattened shading itself; without it, keep the cheaper shading test's warning.
          ...(flattened && checkNow?.state !== 'checked' ? ['Some shading in your image became flat color.'] : []),
        ],
        oneInk: inks.enabled && inks.maxInks === 1,
        check: checkNow,
        reviewed: isReviewed(review, result?.svg, client.purpose),
      })
    : null

  // Admin panel: one run per upload, recorded once its first result has been checked, so the
  // success rate counts what the engine did on its own; the review then records where the artist
  // ended up (their final settings and the final result's check).
  const checkSummary = (c: CheckOutcome | null): RunRecord['autoCheck'] =>
    c?.state === 'checked' ? { verdict: c.report.verdict, edgeRecall: c.report.edgeRecall, wrongShare: c.report.wrongShare, fineLost: c.report.features.lost } : null
  useEffect(() => {
    if (!runsApi || !source || !detection || !result || status !== 'ready' || checkNow?.state === 'checking') return
    if (run?.sourceId === source.id) return
    const record = buildRun({
      name: source.name,
      type: source.name.split('.').pop()?.toLowerCase() ?? '',
      width: source.width,
      height: source.height,
      detection,
      colours: result.palette?.length ?? 0,
      compression,
      settings: client,
      defaultsId: defaults?.id ?? null,
      paths: result.paths,
      ms: result.ms,
      autoCheck: checkSummary(checkNow),
      engineVersion: import.meta.env.VITE_ENGINE_VERSION || 'dev',
    })
    setRun({ sourceId: source.id, record })
    const svg = result.svg
    fetch(source.url)
      .then((r) => r.blob())
      .then((original) => runsApi.postRun(record, { original, svg }))
      .catch((err) => setReviewSave({ status: 'error', message: `The run wasn't saved: ${err instanceof Error ? err.message : String(err)}` }))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- recorded once per upload, from its first checked result
  }, [source, detection, result, status, checkNow?.state, run?.sourceId])

  const saveReview = (draft: ReviewDraft) => {
    if (!runsApi || !run || !result) return
    setReviewSave({ status: 'saving' })
    runsApi
      .postReview(run.record.runId, { ...draft, finalSettings: client, finalAutoVerdict: checkSummary(checkNow)?.verdict ?? null, final: { paths: result.paths, mode: renderModeOf(kind, illustration, simplified) }, reviewedAt: new Date().toISOString() })
      .then(() => {
        setReviewSave({ status: 'saved' })
        // A person has looked at this exact vector, whatever they decided.
        setReview({ svg: result.svg, purpose: client.purpose })
      })
      .catch((err) => setReviewSave({ status: 'error', message: err instanceof Error ? err.message : String(err) }))
  }

  const headline = (
    QUALITY_REPORTING
      ? // Says what was made, not how good it is: that is the check's and the reviewer's to say.
        { flat: 'Your artwork is now a vector', photo: 'Your image is now a vector', lineart: 'Your drawing is now line art', pixel: 'Your pixel art is now a vector' }
      : {
          flat: 'Your artwork is now a sharp vector',
          photo: 'Your image is now a vector',
          lineart: 'Your drawing is now clean line art',
          pixel: 'Your pixel art is now a vector',
        }
  )[kind]

  const blendNote = result && flatKind
    ? client.keepBlends
      ? { text: 'Edge smudges are kept as extra colors.', undoLabel: 'Clean them up', onUndo: () => setClient((c) => ({ ...c, keepBlends: false })) }
      : result.blendsRemoved > 0
        ? {
            text: QUALITY_REPORTING ? 'We cleaned up fuzzy edges and compression smudges.' : 'We cleaned up fuzzy edges and compression smudges, so only your real colors remain.',
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
  // A one-colour ink chosen from the previous library isn't in the new one: keep its colour, drop the
  // name (the library stays open with nothing chosen), so the plate never carries a stale ink name.
  const forgetLibraryInk = () => setClient((c) => (c.oneColour.inkName ? { ...c, oneColour: { ...c.oneColour, inkName: '' } } : c))
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
      return alternatives(detection, source.width, source.height, d0, sharpenBelow).map((alt): Candidate =>
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
    <>
      <header className="border-b border-line bg-card">
        <div className="mx-auto flex max-w-[1200px] flex-wrap items-center justify-between gap-x-4 gap-y-1 px-5 py-4">
          {ADMIN_MODE ? (
            <button className="flex items-center gap-3.5" onClick={reset} aria-label="Barron Vectoriser, start over">
              <img src={barronLogo} alt="" className="h-8 w-auto" />
              <span className="h-6 w-px bg-line" />
              <span className="font-display text-xl/none font-bold tracking-[-0.01em] text-accent">Vectoriser</span>
              <span className="rounded-full bg-accent-3 px-2.5 py-1 text-xs font-semibold text-accent-2-ink">Layout team</span>
            </button>
          ) : (
            <button className="flex items-center gap-2.5 py-1 font-display text-[19px]/none font-extrabold tracking-[-0.02em]" onClick={reset} aria-label="Vectorize, start over">
              <svg className="size-[26px]" viewBox="0 0 26 26" aria-hidden="true">
                <path d="M4 20C7 6 19 6 22 20" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
                <rect x="2" y="18" width="4.5" height="4.5" rx="1" fill="var(--color-accent)" />
                <rect x="19.5" y="18" width="4.5" height="4.5" rx="1" fill="var(--color-accent)" />
              </svg>
              Vectorize
            </button>
          )}
          {source ? (
            <button className="rounded-full border border-line bg-card px-4 py-2 font-semibold hover:border-ink-2" onClick={reset}>
              Upload another image
            </button>
          ) : (
            <a className="p-3 text-sm font-medium text-accent hover:underline" href="#how">
              How it works
            </a>
          )}
        </div>
      </header>
    <div className="mx-auto grid max-w-[1200px] gap-5 px-5 pt-[18px] pb-12">

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
                  ? { points: result.oneColour.flags, size: { width: result.width, height: result.height }, legend: `Red rings: ${result.oneColour.flags.length} places to check, where a gap was left out (to keep detail, keep the file cuttable, or because the edge is unclear) or took in a hairline sliver.` }
                  : undefined
              }
            />
            <div className="pl-1 text-[13px] wrap-anywhere text-ink-2">
              <b className="font-semibold text-ink">{source.name}</b> · {source.width}×{source.height}
            </div>
            {runsApi && result && run?.sourceId === source.id && <ReviewPanel key={run.record.runId} complexity={run.record.complexity} suggestedType={suggestedAssetType(run.record.detection)} state={reviewSave} onSave={saveReview} />}
            {ADMIN_MODE && !runsApi && <p className="pl-1 text-[13px] text-ink-2">Reviews can't be saved: this browser blocks storage and no results service is set up.</p>}
          </div>
          <ResultCard
            status={status}
            headline={headline}
            summary={quality?.summary ?? summary}
            quality={
              quality && result
                ? {
                    autoCheck: quality.autoCheck,
                    reviewed: quality.reviewed,
                    findings: quality.findings,
                    onReview: () => setReview({ svg: result.svg, purpose: client.purpose }),
                    onUnreview: () => setReview(null),
                  }
                : undefined
            }
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
            whiteInk={
              whiteInkShown && result
                ? {
                    mode: whiteInk,
                    onMode: setWhiteInk,
                    enclosed: result.enclosedPaper,
                    readingText: whiteInk === 'artwork' && textWords === null,
                    areas: whiteInk === 'artwork' ? (shownPlates?.plates?.enclosed ?? null) : null,
                  }
                : undefined
            }
            platePreview={
              PRINT_FILES && plateSvg && result && source
                ? {
                    open: platesOpen,
                    onOpen: setPlatesOpen,
                    svg: shownPlates?.plates?.svg ?? null,
                    failed: !!shownPlates?.failed,
                    plates: plateList.plates,
                    gradients: plateList.gradients,
                    width: shownPlates?.plates?.width ?? result.width,
                    height: shownPlates?.plates?.height ?? result.height,
                    areas: whiteInkShown && whiteInk === 'artwork' ? (shownPlates?.plates?.enclosed ?? []) : [],
                    onChoose: (area, white) => chooseWhite([area], white),
                    onChooseAll: chooseWhite,
                  }
                : undefined
            }
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
                illustration={illustration ? { simplified, onChange: (s) => setClient((c) => ({ ...c, simplified: s })) } : null}
                maxColors={client.maxColors}
                onMaxColors={(maxColors) => setClient((c) => ({ ...c, maxColors }))}
                oneColour={client.oneColour}
                onOneColour={(oneColour) => setClient((c) => ({ ...c, oneColour: { ...c.oneColour, ...oneColour } }))}
                oneColourGaps={plates}
                oneColourNote={oneOn ? oneColourNote(result?.oneColour ?? null, gapsShown, gapMm) : null}
                oneColourInk={oneOn ? (result?.oneColour?.ink ?? null) : null}
                inkLibrary={{ name: palette.name, swatches: palette.swatches, isDemo: !importedPalette }}
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
                    onWords={(boxes) => setPaperWords({ id: source.id, boxes })}
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
                      let used = match
                      try {
                        const { placeLineInFamily } = await import('./fonts/lettering')
                        ;({ placed, used } = await placeLineInFamily(report, part, match, { named }))
                      } catch (err) {
                        if (!quiet) showToast(`Couldn't rebuild the lettering: ${err instanceof Error ? err.message : String(err)}`)
                        return false
                      }
                      if (!placed.words.length) {
                        if (!quiet) showToast(`${match.label} doesn't line up with this lettering closely enough, in any of its weights, so it stays as traced.`)
                        return false
                      }
                      if (used !== match && !quiet) showToast(`Used ${used.label}: ${match.label} didn't line up, and the lettering in this image fits ${used.label} better.`)
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
                      detection && worthSharpening(detection, source.width, source.height, sharpenBelow)
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
                        forgetLibraryInk()
                        showToast(`Loaded ${p.swatches.length} colors from ${file.name}`)
                      } catch (err) {
                        showToast(err instanceof Error ? err.message : String(err))
                      }
                    }}
                    onUseDemo={() => {
                      setImportedPalette(null)
                      savePalette(null)
                      setInks((s) => ({ ...s, overrides: {} }))
                      forgetLibraryInk()
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
              className="font-bold text-accent-on-ink"
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
    </>
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
    const unsure = r.flags.filter((f) => f.reason === 'gap-unsure').length
    if (thin) parts.push(`${thin} left joined where a gap would cut into thin detail`)
    if (cut) parts.push(`${cut} left joined where a gap would leave a piece too thin or small to cut`)
    if (unsure) parts.push(`${unsure} left joined where it isn't clear the colours meet at a real edge rather than in shading`)
    if (sliver) parts.push(`${sliver} hairline ${sliver === 1 ? 'sliver' : 'slivers'} of another colour along a gap became part of it`)
    if (thin || cut || unsure || sliver) parts.push('ringed in red on the preview')
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
