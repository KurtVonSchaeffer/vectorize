import { useEffect, useRef, useState } from 'react'
import { canListInstalledFonts, installedFonts, weightOf } from '../fonts/candidates'
import { loadIndex } from '../fonts/catalog'
import { readFromSharpened } from '../fonts/sharpened'
import { smallestTextLine } from '../fonts/textsize'
import type { FontProgress, FontReport, TextLine } from '../fonts/identify'
import type { LineLettering } from '../fonts/lettering'
import type { FontCandidate, FontMatch } from '../fonts/match'
import { identifyOnline, onlineAvailable, type OnlineFont } from '../fonts/online'
import { bar, barFill, btnSmall, cx, field, fieldLabel, note, progress } from './ui'

interface Props {
  /** Identifies the image, so results reset when a new one is opened. */
  imageId: string
  bitmap: ImageBitmap
  /** The artwork's colors; each is read as its own black-on-white picture. */
  colors: number[]
  /** Lines whose lettering is rebuilt from a font, by line index. */
  lettering: Record<number, LineLettering>
  /** Whether lettering can be rebuilt for this kind of artwork. */
  canRebuild: boolean
  /**
   * `quiet`: chosen automatically, so a font that doesn't line up is skipped silently. `words`:
   * only these words of the line (indices), e.g. a bold word and a light word in one line.
   * `named`: the client named this font, so a looser fit is accepted.
   */
  onUseFont: (report: FontReport, line: number, match: FontCandidate, quiet?: boolean, words?: number[], named?: boolean) => Promise<boolean>
  onClearFont: (line: number) => void
  /** Find the fonts and rebuild confident matches as soon as the artwork is traced. */
  auto: boolean
  /** Reports whether the automatic lettering match is running. */
  onAutoBusy?: (busy: boolean) => void
  /** The automatic match found lettering but no font close enough to rebuild it: per such line, its text and closest match. */
  /** The shortest text line found, in source pixels (null when there's no text). */
  onTextSize?: (px: number | null) => void
  onAutoUnmatched?: (lines: { line: number; text: string; closest: FontCandidate & { score: number } | null }[]) => void
  /** A line's best match is worth trying, if it scores better (offered in the background). */
  onTryFont?: (report: FontReport, line: number, match: FontCandidate) => void
  /** A line's best match is close enough to suggest by name; the customer decides. */
  onSuggestFont?: (report: FontReport, line: number, match: FontCandidate & { score: number }) => void
  /** Every line handed to onTryFont, together, when there are several (one piece of lettering split into lines). */
  onTryLines?: (report: FontReport, tries: { line: number; match: FontCandidate }[]) => void
  /**
   * A sharpened (AI 2×) copy of the image, for small lettering: fonts at 6–12 px are identified
   * far more reliably from it (docs/v7-results.md). Null when it isn't worth making.
   */
  sharpen?: () => Promise<ImageBitmap | null>
}

const MATCH = 'grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-2 gap-y-0.5 rounded-lg border border-line px-2 py-1.5 [&>*]:min-w-0'
const SAMPLE = 'col-start-1 row-start-1 truncate text-xl/[1.15]'
const NAME = 'col-start-1 row-start-2 flex flex-wrap items-baseline gap-1.5 text-xs'
const SRC = 'text-[11px] not-italic text-ink-2'
const SRC_STRONG = 'font-semibold text-accent'
const TEXT = 'text-xs font-semibold text-ink-2'
const USE = 'col-span-full mt-1 justify-self-start'

/**
 * Lettering is never replaced with a font automatically: even a close match (REM Medium at 85%+
 * for a bold geometric sans) can change letter shapes and weight. Matches at least this close are
 * only offered, after a quality check (onTryFont); the traced letters stay until the customer
 * accepts the offer or picks a font.
 */
const TRY_MIN_SCORE = 0.5
/** At least this close, a match is suggested to the customer by name (onSuggestFont), still never applied by itself. */
const SUGGEST_MIN_SCORE = 0.85

const STEP: Record<FontProgress['step'], string> = {
  reading: 'Reading the text',
  loading: 'Loading fonts to compare',
  comparing: 'Comparing letter shapes',
}

const SOURCE_LABEL: Record<FontCandidate['source'], string> = {
  google: 'Free font',
  system: 'On this computer',
  installed: 'Installed',
}

type Online = { status: 'busy' } | { status: 'done'; fonts: OnlineFont[] } | { status: 'error'; message: string }

type State = { kind: 'idle' } | { kind: 'busy'; progress: FontProgress } | { kind: 'done'; report: FontReport; lines: TextLine[]; withInstalled: boolean } | { kind: 'error'; message: string }

export function FontPanel({ imageId, bitmap, colors, lettering, canRebuild, onUseFont, onClearFont, auto, onAutoBusy, onAutoUnmatched, onTextSize, onTryFont, onSuggestFont, onTryLines, sharpen }: Props) {
  const [state, setState] = useState<State>({ kind: 'idle' })
  /** The font being placed right now ("line|label"). */
  const [placing, setPlacing] = useState<string | null>(null)
  const useFont = async (report: FontReport, i: number, m: FontCandidate, words?: number[], named?: boolean) => {
    setPlacing(`${i}|${m.label}`)
    try {
      await onUseFont(report, i, m, false, words, named)
    } finally {
      setPlacing(null)
    }
  }
  const installed = useRef<FontCandidate[] | null>(null)
  const run = useRef(0)
  /** Online results per line index. */
  const [online, setOnline] = useState<Record<number, Online>>({})
  const [canOnline, setCanOnline] = useState(false)

  useEffect(() => {
    run.current++
    setState({ kind: 'idle' })
    setOnline({})
  }, [imageId])

  useEffect(() => {
    onlineAvailable().then(setCanOnline)
  }, [])

  const searchOnline = async (report: FontReport, line: TextLine, i: number) => {
    const id = run.current
    setOnline((o) => ({ ...o, [i]: { status: 'busy' } }))
    let next: Online
    try {
      next = { status: 'done', fonts: await identifyOnline(report, line) }
    } catch (err) {
      next = { status: 'error', message: err instanceof Error ? err.message : String(err) }
    }
    if (id === run.current) setOnline((o) => ({ ...o, [i]: next }))
  }

  const autoRan = useRef<string | null>(null)
  useEffect(() => {
    if (!auto || !colors.length || state.kind !== 'idle' || autoRan.current === imageId) return
    autoRan.current = imageId
    onAutoBusy?.(true)
    void start(false, true).finally(() => onAutoBusy?.(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, colors.length, imageId, state.kind])

  const start = async (includeInstalled: boolean, autoApply = false) => {
    const id = ++run.current
    const live = () => id === run.current
    setState({ kind: 'busy', progress: { step: 'reading', progress: 0 } })
    try {
      // Asked first, while the click still counts as a user gesture.
      if (includeInstalled && !installed.current) installed.current = await installedFonts()
      // OCR is loaded only when someone asks for fonts.
      const { findText, matchFonts } = await import('../fonts/identify')
      const onProgress = (progress: FontProgress) => live() && setState({ kind: 'busy', progress })
      // Small lettering is read from a sharpened copy when there is one; letters are still
      // placed in the original image's pixels (the report's scale accounts for the 2×).
      const sharp = sharpen ? await sharpen().catch(() => null) : null
      // The original is read too: a reading that changes between the two is uncertain text.
      const report = await readFromSharpened(bitmap, sharp, (image) => findText(image, colors, onProgress, sharp ? bitmap : undefined))
      // report.scale is already in the original's pixels.
      if (live()) onTextSize?.(smallestTextLine(report))
      const lines = await matchFonts(report, includeInstalled ? (installed.current ?? []) : [], onProgress)
      if (live()) {
        setOnline({})
        setState({ kind: 'done', report, lines, withInstalled: includeInstalled })
      }
      if (autoApply && canRebuild) {
        const unmatched: { line: number; text: string; closest: FontMatch | null }[] = []
        const tries: { line: number; match: FontCandidate }[] = []
        for (let i = 0; i < lines.length && live(); i++) {
          const best = lines[i].matches[0]
          unmatched.push({ line: i, text: lines[i].text, closest: best ?? null })
          if (best && best.score >= SUGGEST_MIN_SCORE) onSuggestFont?.(report, i, best)
          else if (best && best.score >= TRY_MIN_SCORE) {
            onTryFont?.(report, i, best)
            tries.push({ line: i, match: best })
          }
        }
        if (live() && tries.length >= 2) onTryLines?.(report, tries)
        if (live()) onAutoUnmatched?.(unmatched)
      }
    } catch (err) {
      if (!live() || autoApply) return
      const denied = err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'SecurityError')
      setState({ kind: 'error', message: denied ? 'Permission to see your installed fonts was not given.' : `Couldn't check the fonts: ${err instanceof Error ? err.message : String(err)}` })
    }
  }

  const canInstalled = canListInstalledFonts()

  return (
    <div className={cx(field, 'min-w-0')}>
      <span className={fieldLabel}>Fonts in this artwork</span>
      {state.kind === 'busy' ? (
        <div className={progress} role="status">
          <span>{STEP[state.progress.step]}</span>
          <div className={bar}>
            <div className={barFill} style={{ width: `${Math.round(state.progress.progress * 100)}%` }} />
          </div>
        </div>
      ) : (
        <>
          {state.kind === 'idle' && <small>Finds the text and suggests the closest fonts. The image stays on your computer.</small>}
          {state.kind === 'error' && <small className={note}>{state.message}</small>}
          {state.kind === 'done' && !state.lines.length && <small className={note}>No text found in this artwork.</small>}
          {state.kind === 'done' &&
            state.lines.map((line, i) => (
              <div className="grid min-w-0 gap-1.5" key={i}>
                <div className={TEXT}>“{line.text}”</div>
                <ol className="grid min-w-0 gap-1 justify-self-stretch">
                  {line.matches.slice(0, 5).map((m) => (
                    <li key={`${m.label}|${m.source}`} className={MATCH}>
                      <span className={SAMPLE} style={{ fontFamily: `"${m.family}"`, fontWeight: m.weight, fontStyle: m.style }}>
                        {line.text}
                      </span>
                      <span className={NAME}>
                        {m.label}
                        <em className={cx(SRC, m.source !== 'google' && SRC_STRONG)}>{SOURCE_LABEL[m.source]}</em>
                      </span>
                      <span className="col-start-2 row-span-2 row-start-1 self-center text-xs font-semibold tabular-nums">{Math.round(m.score * 100)}%</span>
                      {canRebuild &&
                        (lettering[i]?.font === m.label ? (
                          <button className={cx(btnSmall, USE, 'border-accent text-accent')} onClick={() => onClearFont(i)} title="Put the traced letters back">
                            ✓ Lettering rebuilt · Undo
                          </button>
                        ) : (
                          <button
                            className={cx(btnSmall, USE)}
                            disabled={placing !== null}
                            onClick={() => useFont(state.report, i, m)}
                            title={`Replace the traced letters with ${m.label}, so they're perfectly clean`}
                          >
                            {placing === `${i}|${m.label}` ? 'Rebuilding…' : 'Use for lettering'}
                          </button>
                        ))}
                    </li>
                  ))}
                </ol>
                {canRebuild && (
                  <NamedFont line={line} placing={placing} onUse={(m, words) => useFont(state.report, i, m, words, true)} />
                )}
                {canOnline && (
                  <OnlineResults
                    line={line}
                    result={online[i]}
                    onSearch={() => searchOnline(state.report, line, i)}
                    canRebuild={canRebuild}
                    inUse={lettering[i]?.font}
                    placing={placing}
                    onUse={(m) => useFont(state.report, i, m)}
                  />
                )}
              </div>
            ))}
          <div className="flex gap-1.5">
            {state.kind !== 'done' && (
              <button className={btnSmall} onClick={() => start(false)}>
                Find fonts
              </button>
            )}
            {canInstalled && !(state.kind === 'done' && state.withInstalled) && (
              <button className={btnSmall} onClick={() => start(true)} title="Also compares the fonts installed on this computer, including commercial fonts you own">
                {state.kind === 'done' ? 'Also check my installed fonts' : 'Include my installed fonts'}
              </button>
            )}
          </div>
          <small>
            {canInstalled
              ? 'Compares over 2,000 free font families and the common fonts that come with this computer (such as Arial, Helvetica and Futura). Your other installed fonts can be added too; the browser asks first.'
              : 'Compares over 2,000 free font families and the common fonts that come with this computer (such as Arial, Helvetica and Futura).'}
          </small>
        </>
      )}
    </div>
  )
}

/** Free online matches that are in the open catalog, as candidates whose files can be loaded. */
function useCatalogMatch(fonts: OnlineFont[] | null): Map<string, FontCandidate> {
  const [found, setFound] = useState(new Map<string, FontCandidate>())
  useEffect(() => {
    if (!fonts?.some((f) => f.type === 'free')) return
    let live = true
    loadIndex('').then(({ meta }) => {
      const byId = new Map<string, number[]>()
      for (const [id, , weight] of meta.fonts) byId.set(id, [...(byId.get(id) ?? []), weight])
      const out = new Map<string, FontCandidate>()
      for (const f of fonts) {
        if (f.type !== 'free') continue
        // "Archivo Black Regular" → archivo-black-regular, archivo-black, archivo …
        const words = f.name.replace(/\s*\(.*?\)/g, '').split(/\s+/)
        for (let k = words.length; k > 0; k--) {
          const id = words.slice(0, k).join('-').toLowerCase().replace(/[^a-z0-9-]/g, '')
          const weights = byId.get(id)
          if (!weights) continue
          const want = weightOf(words.slice(k).join(' ') || 'Regular')
          const weight = weights.reduce((b, w) => (Math.abs(w - want) < Math.abs(b - want) ? w : b), weights[0])
          out.set(f.name, { family: '', label: f.name, ref: id, weight, style: 'normal', source: 'google' })
          break
        }
      }
      if (live) setFound(out)
    }).catch(() => {})
    return () => {
      live = false
    }
  }, [fonts])
  return found
}

function OnlineResults({
  line,
  result,
  onSearch,
  canRebuild,
  inUse,
  placing,
  onUse,
}: {
  line: TextLine
  result: Online | undefined
  onSearch: () => void
  canRebuild: boolean
  inUse: string | undefined
  placing: string | null
  onUse: (m: FontCandidate) => void
}) {
  const usable = useCatalogMatch(result?.status === 'done' ? result.fonts : null)
  if (!result || result.status === 'error')
    return (
      <div className="grid justify-items-start gap-1.5">
        {result?.status === 'error' && <small className={note}>{result.message}</small>}
        <button className={btnSmall} onClick={onSearch}>
          {result ? 'Try the online search again' : 'Search 1 million fonts online, including commercial'}
        </button>
        <small>Sends a black-and-white image of just “{line.text}” to WhatFontIs.com. Nothing else leaves your computer.</small>
      </div>
    )
  if (result.status === 'busy')
    return (
      <div className={cx(progress, 'justify-items-start')} role="status">
        <span>Searching online…</span>
        <div className={cx(bar, 'justify-self-stretch')}>
          <div className="h-full w-[35%] animate-bar-slide bg-accent motion-reduce:w-full motion-reduce:animate-none motion-reduce:opacity-50" />
        </div>
      </div>
    )
  return (
    <div className="grid justify-items-start gap-1.5">
      <div className={TEXT}>Online matches</div>
      {result.fonts.length ? (
        <ol className="grid min-w-0 gap-1 justify-self-stretch">
          {result.fonts.slice(0, 8).map((f, k) => (
            <li key={k} className={MATCH}>
              {f.sample && (
                <span className={SAMPLE}>
                  <img className="block h-7 max-w-full object-contain object-left" src={f.sample} alt={`${f.name} sample`} />
                </span>
              )}
              <span className={cx(NAME, !f.sample && 'row-start-1')}>
                {f.page ? (
                  <a className="text-inherit" href={f.page} target="_blank" rel="noopener noreferrer">
                    {f.name}
                  </a>
                ) : (
                  f.name
                )}
                <em className={cx(SRC, f.type === 'commercial' && SRC_STRONG)}>{f.type === 'commercial' ? 'Commercial' : f.type === 'free' ? 'Free' : 'Online'}</em>
              </span>
              {canRebuild && usable.has(f.name) && (
                <button className={cx(btnSmall, USE, inUse === f.name && 'border-accent text-accent')} disabled={placing !== null || inUse === f.name} onClick={() => onUse(usable.get(f.name)!)}>
                  {inUse === f.name ? '✓ Lettering rebuilt' : placing?.endsWith(`|${f.name}`) ? 'Rebuilding…' : 'Use for lettering'}
                </button>
              )}
            </li>
          ))}
        </ol>
      ) : (
        <small className={note}>No matches found online.</small>
      )}
      <small>
        Online results by{' '}
        <a className="text-accent" href="https://www.whatfontis.com" target="_blank" rel="noopener noreferrer">
          WhatFontIs.com
        </a>
        . Open a font to preview it or see where to buy it.
      </small>
    </div>
  )
}

const WEIGHTS: [number, string][] = [
  [100, 'Thin'],
  [200, 'ExtraLight'],
  [300, 'Light'],
  [400, 'Regular'],
  [500, 'Medium'],
  [600, 'SemiBold'],
  [700, 'Bold'],
  [800, 'ExtraBold'],
  [900, 'Black'],
]

/** Free font family names (and their Fontsource ids) from the catalog, for suggestions. */
function useFamilies(): Map<string, string> {
  const [families, setFamilies] = useState(new Map<string, string>())
  useEffect(() => {
    let live = true
    loadIndex('')
      .then(({ meta }) => live && setFamilies(new Map(meta.fonts.map(([id, family]) => [family.toLowerCase(), id]))))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])
  return families
}

/**
 * The client names the font (the brand font is often known): any free family at any weight,
 * for the whole line or one word, so a bold word and a light word can each get their weight.
 * The real letter outlines then replace the traced letters, placed as for a matched font.
 */
function NamedFont({ line, placing, onUse }: { line: TextLine; placing: string | null; onUse: (m: FontCandidate, words?: number[]) => void }) {
  const families = useFamilies()
  const [family, setFamily] = useState('')
  const [weight, setWeight] = useState(400)
  const [word, setWord] = useState(-1)
  const words = line.shapes.map((s) => s.text)
  const listId = `families-${line.box.x0}-${line.box.y0}`
  const name = family.trim()
  // Only fonts in the free catalog can be loaded; if the catalog didn't load, the font file itself is the check.
  const known = families.size === 0 || families.has(name.toLowerCase())
  const id = families.get(name.toLowerCase()) ?? name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const label = `${name} ${WEIGHTS.find(([w]) => w === weight)![1]}`
  const busy = placing !== null
  return (
    <details className="grid gap-1.5">
      <summary className="cursor-pointer text-xs font-semibold text-accent">Use a font you know</summary>
      <div className="mt-1.5 grid gap-1.5">
        <input
          className="min-w-0 rounded-lg border border-line bg-transparent px-2 py-1 text-sm"
          list={listId}
          placeholder="Font name, e.g. Montserrat"
          value={family}
          onChange={(e) => setFamily(e.target.value)}
          aria-label="Font name"
        />
        <datalist id={listId}>
          {name.length >= 2 &&
            [...families.keys()]
              .filter((f) => f.startsWith(name.toLowerCase()))
              .slice(0, 20)
              .map((f) => <option key={f} value={f.replace(/\b\w/g, (c) => c.toUpperCase())} />)}
        </datalist>
        <div className="flex flex-wrap gap-1.5">
          <select className="rounded-lg border border-line bg-transparent px-2 py-1 text-sm" value={weight} onChange={(e) => setWeight(Number(e.target.value))} aria-label="Weight">
            {WEIGHTS.map(([w, n]) => (
              <option key={w} value={w}>
                {n}
              </option>
            ))}
          </select>
          {words.length > 1 && (
            <select className="min-w-0 rounded-lg border border-line bg-transparent px-2 py-1 text-sm" value={word} onChange={(e) => setWord(Number(e.target.value))} aria-label="Which words">
              <option value={-1}>All words</option>
              {words.map((w, k) => (
                <option key={k} value={k}>
                  Only “{w}”
                </option>
              ))}
            </select>
          )}
          <button
            className={btnSmall}
            disabled={!id || !known || busy}
            onClick={() => onUse({ family: `named-${id}-${weight}`, label, ref: id, weight, style: 'normal', source: 'google' }, word >= 0 ? [word] : undefined)}
          >
            {placing?.endsWith(`|${label}`) ? 'Rebuilding…' : 'Rebuild with this font'}
          </button>
        </div>
        {name.length >= 2 && !known ? (
          <small className={note}>“{name}” isn't in the free font catalog. Check the spelling, or for a commercial font you own, use “Include my installed fonts”.</small>
        ) : (
          <small>Any free Google font, at any weight. For a commercial font you own, use “Include my installed fonts”.</small>
        )}
      </div>
    </details>
  )
}
