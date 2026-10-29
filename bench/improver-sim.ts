// The app's first result and background improver, reproduced step by step for benchmarks: the
// same settings, the same lettering flow (small lettering read from the AI-sharpened copy, never
// rebuilt automatically, close matches suggested by name), the same alternatives and the same
// offer rule. The rules themselves are the app's (fonts/suggest.ts, vectorize/improve.ts), not
// copies. Used by bench/assess.html?exp=improver, bench/parity.html and bench/real.html.
import type { Enhancer } from '../src/ai/enhancer'
import { findText, matchFonts } from '../src/fonts/identify'
import { placeLine, type PlacedWord } from '../src/fonts/lettering'
import { readFromSharpened } from '../src/fonts/sharpened'
import { SMALL_TEXT_PX, smallestTextLine } from '../src/fonts/textsize'
import { placeSuggestion, worthSuggesting, type FontSuggestion } from '../src/fonts/suggest'
import { scoreAgainstUpload } from '../src/quality/render'
import { DEFAULT_CLIENT, detailBoost, prepFor, traceParamsFor } from '../src/vectorize/client'
import { detectArt, type Detection } from '../src/vectorize/detect'
import { bitmapToImageData, type InputImage, type SourceImage } from '../src/vectorize/image'
import { alternatives, betterOffer, isImprovement, worthSharpening, type Scored } from '../src/vectorize/improve'
import { buildTraceJob, runTraceJob, type TraceResult } from '../src/vectorize/pipeline'
import type { Tracer } from '../src/vectorize/tracer'

export interface SimOption {
  label: string
  svg: string
  /** Scored against the upload, as the app does. */
  proxy: Scored
  /** Whether the app's rule would offer it. */
  ok: boolean
}

export interface SimResult {
  det: Detection
  first: { svg: string; proxy: Scored; colours: number; paths: number; font: string | null; result: TraceResult }
  /** The first result's print/cut version (shapes that don't overlap), as the app makes for downloads. */
  plates: () => Promise<string>
  options: SimOption[]
  /** What the app would offer (the best passing option), if anything. */
  offered: SimOption | null
  /**
   * Typefaces the app would suggest by name ("Try …", fonts/suggest.ts), and the result of trying
   * them all, as that button does. Never offered as a cleaner version.
   */
  suggestions: { fonts: string[]; svg: string } | null
  /** Background time after the first result (excluding the lettering match). */
  ms: number
}

const scoredOf = async (source: SourceImage, res: TraceResult): Promise<Scored> => {
  const { score, edgeF1 } = await scoreAgainstUpload(source.bitmap, res.svg)
  return { score, edgeF1, segments: (res.svg.match(/[CLQ]/g) ?? []).length, colours: res.palette?.length ?? 0 }
}

/** Null for artwork the improver doesn't handle (photos, pixel art). */
export async function simulateImprover(source: SourceImage, enhancer: Enhancer, tracer: Tracer): Promise<SimResult | null> {
  const det = detectArt(bitmapToImageData(source.bitmap))
  if (det.kind !== 'flat' && det.kind !== 'lineart') return null
  // As the app opens an image: default settings, no saved brand colours, no print inks. Purpose
  // only changes the downloads (the preview is always stacked), not the trace.
  const client = DEFAULT_CLIENT
  const job = (o: { detail?: number; image?: InputImage; lettering?: PlacedWord[]; knockout?: boolean }) =>
    buildTraceJob(o.image ?? source, source.width, {
      trace: traceParamsFor(det.kind, { ...client, detail: o.detail ?? client.detail }, detailBoost(det, source.width, source.height)),
      prep: prepFor(det.kind, client),
      spot: null,
      removeColors: [],
      // As the app sets it when an image is opened.
      transparent: det.hasAlpha || det.kind === 'lineart',
      knockout: o.knockout ?? false,
      exactShapes: true,
      gradients: true,
      lettering: o.lettering,
    })
  const traceOf = (j: ReturnType<typeof job>) => runTraceJob({ vtracer: tracer, flat: null }, j, source, false)
  const sharpened = async (): Promise<ImageData | null> => enhancer.upscale(`${source.id}`, bitmapToImageData(source.bitmap), '2x').catch(() => null)

  // The first result keeps the traced lettering. Close font matches are only suggested by name,
  // with the app's own rule (fonts/suggest.ts); they are never improver candidates.
  const suggestions: FontSuggestion[] = []
  const plain = await traceOf(job({}))
  // As the app: lettering measured too small to trace cleanly (the warning) makes AI sharpening an
  // alternative whatever the image size (improve.ts worthSharpening).
  let smallText = false
  if (det.kind === 'flat') {
    try {
      const up = worthSharpening(det, source.width, source.height) ? await sharpened() : null
      const sharp = up ? await createImageBitmap(up) : null
      const report = await readFromSharpened(source.bitmap, sharp, (image) => findText(image, plain.palette?.map((p) => p.color) ?? [], undefined, sharp ? source.bitmap : undefined))
      const px = smallestTextLine(report)
      smallText = px !== null && px < SMALL_TEXT_PX
      const lines = await matchFonts(report, [])
      for (let i = 0; i < lines.length; i++) {
        const best = lines[i].matches[0]
        if (!worthSuggesting(best)) continue
        const s = await placeSuggestion(report, i, best, placeLine)
        if (s) suggestions.push(s)
      }
    } catch {
      // No text found: nothing to suggest.
    }
  }
  const t0 = performance.now()
  const first = plain
  const firstScore = await scoredOf(source, first)

  // The alternatives the app tries, judged by the app's rule.
  const options: SimOption[] = []
  let offered: SimOption | null = null
  const consider = async (label: string, res: TraceResult | null) => {
    if (!res?.paths) return
    const proxy = await scoredOf(source, res)
    const option = { label, svg: res.svg, proxy, ok: isImprovement(firstScore, proxy) }
    options.push(option)
    // In the order the app checks them, keeping the best so far (as useImprover does).
    if (betterOffer(firstScore, proxy, offered?.proxy.score)) offered = option
  }
  for (const alt of alternatives(det, source.width, source.height, client.detail, smallText)) {
    if (alt.kind === 'detail') await consider(alt.label, await traceOf(job({ detail: alt.detail })))
    else {
      const up = await sharpened()
      if (up) await consider(alt.label, await traceOf(job({ image: { url: '', width: up.width, height: up.height, bitmap: await createImageBitmap(up) } })))
    }
  }
  const ms = Math.round(performance.now() - t0)
  const tried = suggestions.length ? await traceOf(job({ lettering: suggestions.flatMap((s) => s.placed.words) })) : null
  return {
    det,
    first: { svg: first.svg, proxy: firstScore, colours: first.palette?.length ?? 0, paths: first.paths, font: null, result: first },
    plates: async () => (await traceOf(job({ knockout: true }))).svg,
    options,
    offered,
    suggestions: tried && { fonts: [...new Set(suggestions.map((s) => s.font))], svg: tried.svg },
    ms,
  }
}
