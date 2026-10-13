import { useEffect, useRef, useState } from 'react'
import { canListInstalledFonts, installedFonts, weightOf } from '../fonts/candidates'
import { loadIndex } from '../fonts/catalog'
import type { FontProgress, FontReport, TextLine } from '../fonts/identify'
import type { LineLettering } from '../fonts/lettering'
import type { FontCandidate } from '../fonts/match'
import { identifyOnline, onlineAvailable, type OnlineFont } from '../fonts/online'

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
  /** `quiet`: chosen automatically, so a font that doesn't line up is skipped silently. */
  onUseFont: (report: FontReport, line: number, match: FontCandidate, quiet?: boolean) => Promise<void>
  onClearFont: (line: number) => void
  /** Find the fonts and rebuild confident matches as soon as the artwork is traced. */
  auto: boolean
  /** Reports whether the automatic lettering match is running. */
  onAutoBusy?: (busy: boolean) => void
}

/** Automatically rebuilt only when the best free match is at least this close. */
const AUTO_MIN_SCORE = 0.8

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

export function FontPanel({ imageId, bitmap, colors, lettering, canRebuild, onUseFont, onClearFont, auto, onAutoBusy }: Props) {
  const [state, setState] = useState<State>({ kind: 'idle' })
  /** The font being placed right now ("line|label"). */
  const [placing, setPlacing] = useState<string | null>(null)
  const useFont = async (report: FontReport, i: number, m: FontCandidate) => {
    setPlacing(`${i}|${m.label}`)
    try {
      await onUseFont(report, i, m)
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
      const report = await findText(bitmap, colors, onProgress)
      const lines = await matchFonts(report, includeInstalled ? (installed.current ?? []) : [], onProgress)
      if (live()) {
        setOnline({})
        setState({ kind: 'done', report, lines, withInstalled: includeInstalled })
      }
      if (autoApply && canRebuild)
        for (let i = 0; i < lines.length && live(); i++) {
          const best = lines[i].matches[0]
          if (best && best.score >= AUTO_MIN_SCORE) await onUseFont(report, i, best, true)
        }
    } catch (err) {
      if (!live() || autoApply) return
      const denied = err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'SecurityError')
      setState({ kind: 'error', message: denied ? 'Permission to see your installed fonts was not given.' : `Couldn't check the fonts: ${err instanceof Error ? err.message : String(err)}` })
    }
  }

  const canInstalled = canListInstalledFonts()

  return (
    <div className="field fonts">
      <span className="field-label">Fonts in this artwork</span>
      {state.kind === 'busy' ? (
        <div className="ai-progress" role="status">
          <span>{STEP[state.progress.step]}</span>
          <div className="bar">
            <div style={{ width: `${Math.round(state.progress.progress * 100)}%` }} />
          </div>
        </div>
      ) : (
        <>
          {state.kind === 'idle' && <small>Finds the text and suggests the closest fonts. The image stays on your computer.</small>}
          {state.kind === 'error' && <small className="note">{state.message}</small>}
          {state.kind === 'done' && !state.lines.length && <small className="note">No text found in this artwork.</small>}
          {state.kind === 'done' &&
            state.lines.map((line, i) => (
              <div className="font-line" key={i}>
                <div className="font-text">“{line.text}”</div>
                <ol className="font-matches">
                  {line.matches.slice(0, 5).map((m) => (
                    <li key={`${m.label}|${m.source}`}>
                      <span className="font-sample" style={{ fontFamily: `"${m.family}"`, fontWeight: m.weight, fontStyle: m.style }}>
                        {line.text}
                      </span>
                      <span className="font-name">
                        {m.label}
                        <em className={`font-src ${m.source}`}>{SOURCE_LABEL[m.source]}</em>
                      </span>
                      <span className="font-score">{Math.round(m.score * 100)}%</span>
                      {canRebuild &&
                        (lettering[i]?.font === m.label ? (
                          <button className="btn small font-use active" onClick={() => onClearFont(i)} title="Put the traced letters back">
                            ✓ Lettering rebuilt · Undo
                          </button>
                        ) : (
                          <button
                            className="btn small font-use"
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
          <div className="brand-actions">
            {state.kind !== 'done' && (
              <button className="btn small" onClick={() => start(false)}>
                Find fonts
              </button>
            )}
            {canInstalled && !(state.kind === 'done' && state.withInstalled) && (
              <button className="btn small" onClick={() => start(true)} title="Also compares the fonts installed on this computer, including commercial fonts you own">
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
      <div className="font-online">
        {result?.status === 'error' && <small className="note">{result.message}</small>}
        <button className="btn small" onClick={onSearch}>
          {result ? 'Try the online search again' : 'Search 1 million fonts online, including commercial'}
        </button>
        <small>Sends a black-and-white image of just “{line.text}” to WhatFontIs.com. Nothing else leaves your computer.</small>
      </div>
    )
  if (result.status === 'busy')
    return (
      <div className="font-online ai-progress" role="status">
        <span>Searching online…</span>
        <div className="bar indeterminate">
          <div />
        </div>
      </div>
    )
  return (
    <div className="font-online">
      <div className="font-text">Online matches</div>
      {result.fonts.length ? (
        <ol className="font-matches">
          {result.fonts.slice(0, 8).map((f, k) => (
            <li key={k}>
              {f.sample && (
                <span className="font-sample">
                  <img src={f.sample} alt={`${f.name} sample`} />
                </span>
              )}
              <span className="font-name">
                {f.page ? (
                  <a href={f.page} target="_blank" rel="noopener noreferrer">
                    {f.name}
                  </a>
                ) : (
                  f.name
                )}
                <em className={`font-src ${f.type}`}>{f.type === 'commercial' ? 'Commercial' : f.type === 'free' ? 'Free' : 'Online'}</em>
              </span>
              {canRebuild && usable.has(f.name) && (
                <button className={`btn small font-use${inUse === f.name ? ' active' : ''}`} disabled={placing !== null || inUse === f.name} onClick={() => onUse(usable.get(f.name)!)}>
                  {inUse === f.name ? '✓ Lettering rebuilt' : placing?.endsWith(`|${f.name}`) ? 'Rebuilding…' : 'Use for lettering'}
                </button>
              )}
            </li>
          ))}
        </ol>
      ) : (
        <small className="note">No matches found online.</small>
      )}
      <small>
        Online results by{' '}
        <a href="https://www.whatfontis.com" target="_blank" rel="noopener noreferrer">
          WhatFontIs.com
        </a>
        . Open a font to preview it or see where to buy it.
      </small>
    </div>
  )
}
