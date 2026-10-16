import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { scoreAgainstUpload } from './quality/render'
import { isImprovement, type Scored } from './vectorize/improve'
import type { SourceImage } from './vectorize/image'
import { runTraceJob, type TraceJob, type TraceResult } from './vectorize/pipeline'
import type { FlatTracer } from './vectorize/flat-tracer'
import type { Tracer } from './vectorize/tracer'

/** A result's quality against the upload, with what the compression guard needs. */
async function scored(source: SourceImage, res: TraceResult): Promise<Scored> {
  const { score, edgeF1 } = await scoreAgainstUpload(source.bitmap, res.svg)
  return { score, edgeF1, segments: (res.svg.match(/[CLQ]/g) ?? []).length, colours: res.palette?.length ?? 0 }
}

/** An alternative way to trace the current image, offered only if it scores clearly better. */
export interface Candidate {
  /** What's different, completing "A cleaner version is ready: …". */
  label: string
  /** The trace job, or null when it can't be made (e.g. sharpening unavailable). */
  job: () => Promise<TraceJob | null>
  /** How much better it must score (see isImprovement); lettering rebuilds use LETTERING_RATIO. */
  ratio?: number
  /** Switches the app to this version; returns how to switch back. */
  apply: () => () => void
}

type State =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'found'; candidate: Candidate }
  | { kind: 'applied'; candidate: Candidate; revert: () => void }

interface Options {
  source: SourceImage | null
  /** The first result shown for the image. */
  result: TraceResult | null
  /** Identifies the current settings; the check is dropped if they change before an offer is used. */
  jobKey: string
  /** True once the first result is final (traced, lettering matched, nothing in progress). */
  ready: boolean
  /** Alternatives to try, built from the current settings. */
  candidates: () => Candidate[]
  tracers: RefObject<{ vtracer: Tracer; improve: FlatTracer } | null>
}

/**
 * After the first result is shown, traces alternatives in the background (its own worker, so the
 * preview is never held up), scores each against the upload, and offers the best one that is
 * clearly better (see isImprovement). Runs once per image; settings the client chooses are never
 * second-guessed. More candidates (rebuilt lettering) can arrive later through `consider`.
 */
export function useImprover({ source, result, jobKey, ready, candidates, tracers }: Options) {
  const [state, setState] = useState<State>({ kind: 'idle' })
  const checked = useRef<string | null>(null)
  const run = useRef(0)
  const base = useRef<{ key: string; first: Promise<Scored> } | null>(null)
  const best = useRef<number>(Infinity)
  const pending = useRef<Candidate[]>([])

  // One at a time: the worker cancels a job when it's given the next one.
  const queue = useRef<Promise<void>>(Promise.resolve())
  const evaluate = useCallback(
    (c: Candidate, id: number) => (queue.current = queue.current.then(() => evaluateNow(c, id))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [source, tracers],
  )
  const evaluateNow = useCallback(
    async (c: Candidate, id: number) => {
      const t = tracers.current
      if (!source || !t || !base.current) return
      try {
        const first = await base.current.first
        if (id !== run.current) return
        const job = await c.job()
        if (!job || id !== run.current) return
        const res = await runTraceJob({ vtracer: t.vtracer, flat: t.improve }, job, source, false)
        if (id !== run.current || !res.paths) return
        const alt = await scored(source, res)
        if (id !== run.current) return
        if (isImprovement(first, alt, c.ratio) && alt.score < best.current) {
          best.current = alt.score
          setState((s) => (s.kind === 'applied' ? s : { kind: 'found', candidate: c }))
        }
      } catch {
        // An alternative that fails (e.g. sharpening unavailable offline) is simply not offered.
      }
    },
    [source, tracers],
  )

  // A new image: stop any background work and forget everything about the previous one.
  useEffect(() => {
    run.current++
    tracers.current?.improve.dispose()
    checked.current = null
    base.current = null
    best.current = Infinity
    pending.current = []
    setState({ kind: 'idle' })
  }, [source])

  // Once the first result is final, check the alternatives (once per image).
  useEffect(() => {
    if (!ready || !source || !result || checked.current === source.id) return
    checked.current = source.id
    const id = ++run.current
    base.current = { key: jobKey, first: scored(source, result) }
    setState({ kind: 'checking' })
    void (async () => {
      for (const c of [...candidates(), ...pending.current.splice(0)]) await evaluate(c, id)
      if (id === run.current) setState((s) => (s.kind === 'checking' ? { kind: 'idle' } : s))
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, source, result])

  // Settings changed by the client before an offer was used: the offer no longer applies.
  useEffect(() => {
    if (!base.current || base.current.key === jobKey) return
    if (state.kind === 'checking' || state.kind === 'found') {
      run.current++
      tracers.current?.improve.dispose()
      setState({ kind: 'idle' })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobKey])

  /** A candidate found later (e.g. lettering rebuilt from a lower-scoring font). */
  const consider = useCallback(
    (c: Candidate) => {
      if (!base.current) {
        pending.current.push(c)
        return
      }
      if (base.current.key !== jobKey) return
      void evaluate(c, run.current)
    },
    [evaluate, jobKey],
  )

  const use = () => {
    if (state.kind !== 'found') return
    const revert = state.candidate.apply()
    setState({ kind: 'applied', candidate: state.candidate, revert })
  }
  const back = () => {
    if (state.kind !== 'applied') return
    state.revert()
    setState({ kind: 'found', candidate: state.candidate })
  }

  const note =
    state.kind === 'checking'
      ? { text: 'Looking for a cleaner version in the background…' }
      : state.kind === 'found'
        ? { text: `A cleaner version is ready: ${state.candidate.label}.`, undoLabel: 'Use it', onUndo: use }
        : state.kind === 'applied'
          ? { text: `Using the cleaner version: ${state.candidate.label}.`, undoLabel: 'Go back', onUndo: back }
          : null
  return { note, consider }
}
