// The app's first result and background improver, reproduced step by step for benchmarks: the
// same settings, the same lettering flow (small lettering read from the AI-sharpened copy,
// rebuilt automatically at a match of 0.85+, offered from 0.5), the same alternatives and the
// same offer rule. Used by bench/assess.html?exp=improver and bench/real.html.
import type { Enhancer } from '../src/ai/enhancer'
import { findText, matchFonts } from '../src/fonts/identify'
import { placeLine, type PlacedWord } from '../src/fonts/lettering'
import { readFromSharpened } from '../src/fonts/sharpened'
import { scoreAgainstUpload } from '../src/quality/render'
import { DEFAULT_CLIENT, detailBoost, prepFor, traceParamsFor } from '../src/vectorize/client'
import { detectArt, type Detection } from '../src/vectorize/detect'
import { bitmapToImageData, type InputImage, type SourceImage } from '../src/vectorize/image'
import { alternatives, isImprovement, worthSharpening, type Scored } from '../src/vectorize/improve'
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

  // The first result: lettering rebuilt automatically when a font matches at 0.85+.
  let lettering: PlacedWord[] = []
  let font: string | null = null
  const tryLines: { font: string; words: PlacedWord[] }[] = []
  const plain = await traceOf(job({}))
  if (det.kind === 'flat') {
    try {
      const up = worthSharpening(det, source.width, source.height) ? await sharpened() : null
      const sharp = up ? await createImageBitmap(up) : null
      const report = await readFromSharpened(source.bitmap, sharp, (image) => findText(image, plain.palette?.map((p) => p.color) ?? []))
      for (const line of await matchFonts(report, [])) {
        const m = line.matches[0]
        if (!m || m.score < 0.5) continue
        const placed = await placeLine(report, line, m)
        if (!placed.words.length) continue
        if (m.score >= 0.85) {
          lettering = [...lettering, ...placed.words]
          font = font ? `${font}, ${m.label}` : m.label
        } else tryLines.push({ font: m.label, words: placed.words })
      }
    } catch {
      // No text found: nothing to rebuild.
    }
  }
  const t0 = performance.now()
  const first = lettering.length ? await traceOf(job({ lettering })) : plain
  const firstScore = await scoredOf(source, first)

  // The alternatives the app tries, judged by the app's rule.
  const options: SimOption[] = []
  const consider = async (label: string, res: TraceResult | null) => {
    if (!res?.paths) return
    const proxy = await scoredOf(source, res)
    options.push({ label, svg: res.svg, proxy, ok: isImprovement(firstScore, proxy) })
  }
  for (const alt of alternatives(det, source.width, source.height, client.detail)) {
    if (alt.kind === 'detail') await consider(alt.label, await traceOf(job({ detail: alt.detail, lettering })))
    else {
      const up = await sharpened()
      if (up) await consider(alt.label, await traceOf(job({ image: { url: '', width: up.width, height: up.height, bitmap: await createImageBitmap(up) }, lettering })))
    }
  }
  for (const l of tryLines) await consider(`lettering rebuilt from ${l.font}, the closest font match`, await traceOf(job({ lettering: [...lettering, ...l.words] })))
  const offered = options.filter((o) => o.ok).sort((a, b) => a.proxy.score - b.proxy.score)[0] ?? null
  return {
    det,
    first: { svg: first.svg, proxy: firstScore, colours: first.palette?.length ?? 0, paths: first.paths, font, result: first },
    plates: async () => (await traceOf(job({ lettering, knockout: true }))).svg,
    options,
    offered,
    ms: Math.round(performance.now() - t0),
  }
}
