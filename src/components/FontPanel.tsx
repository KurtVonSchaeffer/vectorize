import { useEffect, useRef, useState } from 'react'
import { canListInstalledFonts, installedFonts } from '../fonts/candidates'
import type { FontProgress, FontReport, TextLine } from '../fonts/identify'
import type { FontCandidate } from '../fonts/match'
import { identifyOnline, onlineAvailable, type OnlineFont } from '../fonts/online'

interface Props {
  /** Identifies the image, so results reset when a new one is opened. */
  imageId: string
  bitmap: ImageBitmap
  /** The artwork's colors; each is read as its own black-on-white picture. */
  colors: number[]
}

const STEP: Record<FontProgress['step'], string> = {
  reading: 'Reading the text',
  loading: 'Loading fonts to compare',
  comparing: 'Comparing letter shapes',
}

type Online = { status: 'busy' } | { status: 'done'; fonts: OnlineFont[] } | { status: 'error'; message: string }

type State = { kind: 'idle' } | { kind: 'busy'; progress: FontProgress } | { kind: 'done'; report: FontReport; lines: TextLine[]; withInstalled: boolean } | { kind: 'error'; message: string }

export function FontPanel({ imageId, bitmap, colors }: Props) {
  const [state, setState] = useState<State>({ kind: 'idle' })
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

  const start = async (includeInstalled: boolean) => {
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
    } catch (err) {
      if (!live()) return
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
                        <em className={`font-src ${m.source}`}>{m.source === 'installed' ? 'Installed' : 'Free · Google Fonts'}</em>
                      </span>
                      <span className="font-score">{Math.round(m.score * 100)}%</span>
                    </li>
                  ))}
                </ol>
                {canOnline && <OnlineResults line={line} result={online[i]} onSearch={() => searchOnline(state.report, line, i)} />}
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
              ? 'Compares about 130 free font families. Installed fonts cover commercial fonts you own, such as Helvetica or Futura; the browser asks first.'
              : 'Compares about 130 free font families. To include commercial fonts installed on this computer, open Vectorize in Chrome or Edge.'}
          </small>
        </>
      )}
    </div>
  )
}

function OnlineResults({ line, result, onSearch }: { line: TextLine; result: Online | undefined; onSearch: () => void }) {
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
