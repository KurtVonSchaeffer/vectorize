import type { ReactNode } from 'react'
import type { Purpose } from '../vectorize/client'
import type { Download } from '../export/files'

export interface Chip {
  color: number
  name: string
}

interface Props {
  status: 'working' | 'ready' | 'error'
  headline: string
  summary: string
  error: string | null
  onRetry: () => void
  purpose: Purpose
  onPurpose: (p: Purpose) => void
  /** Null when colors don't apply (photos, pixel art). */
  chips: Chip[] | null
  onRemoveColor: (color: number) => void
  /** Automatic fixes, each with a way to undo it. */
  fixNotes: { text: string; undoLabel: string; onUndo: () => void }[]
  transparent: boolean
  transparentHint: string
  transparentLocked: boolean
  onTransparent: (v: boolean) => void
  downloads: [Download, Download] | null
  onDownload: (d: Download) => void
  detail: number
  corners: number
  onDetail: (v: number) => void
  onCorners: (v: number) => void
  more: ReactNode
}

const USES: { id: Purpose; label: string; note: string; icon: ReactNode }[] = [
  {
    id: 'print',
    label: 'Print',
    note: 'T-shirts, signs',
    icon: (
      <svg viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true">
        <path d="M9 3h7l4 4v4H9z" />
        <path d="M5 11h18v9H5z" />
        <path d="M9 17h10v8H9z" />
      </svg>
    ),
  },
  {
    id: 'web',
    label: 'Website',
    note: 'Site, social',
    icon: (
      <svg viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
        <rect x="3" y="5" width="22" height="16" rx="2" />
        <path d="M3 9h22M10 25h8M14 21v4" />
      </svg>
    ),
  },
  {
    id: 'cut',
    label: 'Cutting',
    note: 'Vinyl, Cricut',
    icon: (
      <svg viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
        <circle cx="7" cy="20" r="3.5" />
        <circle cx="17" cy="21" r="3.5" />
        <path d="M9.5 17.5L23 4M14.5 18.5L9 6" />
      </svg>
    ),
  },
]

const hex = (c: number) => '#' + c.toString(16).padStart(6, '0')

export function ResultCard(p: Props) {
  return (
    <aside className="card" aria-live="polite">
      <div className="ready">
        {p.status === 'ready' && (
          <span className="badge ok">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
              <path d="M3 8.5l3 3 7-7" />
            </svg>
            Ready
          </span>
        )}
        {p.status === 'working' && (
          <span className="badge working">
            <span className="spinner small" aria-hidden="true" />
            Working
          </span>
        )}
        {p.status === 'error' && <span className="badge bad">Something went wrong</span>}
        <h1>{p.status === 'error' ? 'We couldn’t vectorize this image' : p.headline}</h1>
        {p.status === 'error' ? (
          <div className="error-box">
            <p>{p.error}</p>
            <button className="btn-quiet" onClick={p.onRetry}>
              Try again
            </button>
          </div>
        ) : (
          <p>{p.summary}</p>
        )}
      </div>

      <div className="q">
        <h2>What will you use it for?</h2>
        <div className="uses" role="group" aria-label="Purpose">
          {USES.map((u) => (
            <button key={u.id} className="use" aria-pressed={p.purpose === u.id} onClick={() => p.onPurpose(u.id)}>
              {u.icon}
              {u.label}
              <small>{u.note}</small>
            </button>
          ))}
        </div>
      </div>

      {p.chips && p.chips.length > 0 && (
        <div className="q">
          <h2>
            {p.purpose === 'print' ? `Colors · ${p.chips.length} ${p.chips.length === 1 ? 'ink' : 'inks'} to print` : `Colors · ${p.chips.length}`}
          </h2>
          <div className="chips">
            {p.chips.map((c) => (
              <button
                key={c.color}
                className="chip"
                onClick={() => p.onRemoveColor(c.color)}
                disabled={p.chips!.length < 2}
                title={p.chips!.length < 2 ? 'At least one color is needed' : `Remove ${c.name}`}
                aria-label={`Remove ${c.name}`}
              >
                <i style={{ background: hex(c.color) }} />
                {c.name}
                {p.chips!.length > 1 && (
                  <svg className="x" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                    <path d="M4.5 4.5l7 7m0-7l-7 7" />
                  </svg>
                )}
              </button>
            ))}
          </div>
          {p.fixNotes.map((note) => (
            <div className="fixed" key={note.text}>
              <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <circle cx="9" cy="9" r="7.5" />
                <path d="M5.5 9.2l2.3 2.3 4.7-4.7" />
              </svg>
              <span>
                {note.text} <button onClick={note.onUndo}>{note.undoLabel}</button>
              </span>
            </div>
          ))}
        </div>
      )}

      <label className={`switch ${p.transparentLocked ? 'locked' : ''}`} htmlFor="transparent">
        <span>
          Transparent background
          <small>{p.transparentHint}</small>
        </span>
        <input id="transparent" type="checkbox" checked={p.transparent} disabled={p.transparentLocked} onChange={(e) => p.onTransparent(e.target.checked)} />
      </label>

      <div className="download">
        <button className="dl" disabled={!p.downloads || p.status !== 'ready'} onClick={() => p.downloads && p.onDownload(p.downloads[0])}>
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M10 3v10m0 0l-4-4m4 4l4-4M4 16h12" />
          </svg>
          Download {p.downloads?.[0].label ?? ''}
        </button>
        {p.downloads && (
          <div className="dl-sub">
            {p.downloads[0].detail}.{' '}
            <button className="link" disabled={p.status !== 'ready'} onClick={() => p.onDownload(p.downloads![1])}>
              Also get {p.downloads[1].label}
            </button>
          </div>
        )}
      </div>

      <details className="tune">
        <summary>
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M6 3l5 5-5 5" />
          </svg>
          Not quite right? Fine-tune
        </summary>
        <div className="tune-body">
          <div className="range">
            <label htmlFor="detail">Detail</label>
            <input id="detail" type="range" min={0} max={100} value={Math.round(p.detail * 100)} onChange={(e) => p.onDetail(Number(e.target.value) / 100)} />
            <div className="ends">
              <span>Simpler shapes</span>
              <span>More detail</span>
            </div>
          </div>
          <div className="range">
            <label htmlFor="corners">Corners</label>
            <input id="corners" type="range" min={0} max={100} value={Math.round(p.corners * 100)} onChange={(e) => p.onCorners(Number(e.target.value) / 100)} />
            <div className="ends">
              <span>Rounded</span>
              <span>Sharp</span>
            </div>
          </div>
          {p.more}
        </div>
      </details>
    </aside>
  )
}
