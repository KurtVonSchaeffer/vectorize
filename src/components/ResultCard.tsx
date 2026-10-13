import type { ReactNode } from 'react'
import type { Purpose } from '../vectorize/client'
import type { Download } from '../export/files'
import { btnQuiet, chip, cx, link, range, spinnerSmall, swatch } from './ui'

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
  /** What was fixed, with a way back. A note without `onUndo` is work in progress. */
  fixNotes: { text: string; undoLabel?: string; onUndo?: () => void }[]
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

const BADGE = 'inline-flex w-fit items-center gap-1.5 rounded-full px-2.5 py-1 text-[13px] font-semibold [&_svg]:size-3.5'

const hex = (c: number) => '#' + c.toString(16).padStart(6, '0')

export function ResultCard(p: Props) {
  return (
    <aside className="grid grid-cols-[minmax(0,1fr)] gap-[22px] rounded-card border border-line bg-card p-[22px] min-[941px]:sticky min-[941px]:top-4 min-[941px]:max-h-[calc(100vh-32px)] min-[941px]:overflow-y-auto" aria-live="polite">
      <div className="grid gap-1.5">
        {p.status === 'ready' && (
          <span className={cx(BADGE, 'bg-good-soft text-good')}>
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
              <path d="M3 8.5l3 3 7-7" />
            </svg>
            Ready
          </span>
        )}
        {p.status === 'working' && (
          <span className={cx(BADGE, 'bg-accent-soft text-accent')}>
            <span className={spinnerSmall} aria-hidden="true" />
            Working
          </span>
        )}
        {p.status === 'error' && <span className={cx(BADGE, 'bg-bad-soft text-bad')}>Something went wrong</span>}
        <h1 className="font-display text-[27px]/[1.12] font-extrabold tracking-[-0.025em] text-balance">{p.status === 'error' ? 'We couldn’t vectorize this image' : p.headline}</h1>
        {p.status === 'error' ? (
          <div className="grid justify-items-start gap-2.5">
            <p>{p.error}</p>
            <button className={btnQuiet} onClick={p.onRetry}>
              Try again
            </button>
          </div>
        ) : (
          <p className="text-ink-2">{p.summary}</p>
        )}
      </div>

      <div className="grid gap-2.5">
        <h2 className="text-[13px] font-semibold text-ink-2">What will you use it for?</h2>
        <div className="grid grid-cols-3 gap-2" role="group" aria-label="Purpose">
          {USES.map((u) => (
            <button key={u.id} className="group grid justify-items-center gap-1 rounded-xl border-[1.5px] border-line bg-card px-1.5 pt-3.5 pb-3 text-sm font-semibold hover:border-ink-2 aria-pressed:border-accent aria-pressed:bg-accent-soft [&_small]:text-xs [&_small]:font-normal [&_svg]:size-7 [&_svg]:text-ink-2 aria-pressed:[&_svg]:text-accent" aria-pressed={p.purpose === u.id} onClick={() => p.onPurpose(u.id)}>
              {u.icon}
              {u.label}
              <small>{u.note}</small>
            </button>
          ))}
        </div>
      </div>

      {p.chips && p.chips.length > 0 && (
        <div className="grid gap-2.5">
          <h2 className="text-[13px] font-semibold text-ink-2">
            {p.purpose === 'print' ? `Colors · ${p.chips.length} ${p.chips.length === 1 ? 'ink' : 'inks'} to print` : `Colors · ${p.chips.length}`}
          </h2>
          <div className="flex flex-wrap gap-2">
            {p.chips.map((c) => (
              <button
                key={c.color}
                className={chip}
                onClick={() => p.onRemoveColor(c.color)}
                disabled={p.chips!.length < 2}
                title={p.chips!.length < 2 ? 'At least one color is needed' : `Remove ${c.name}`}
                aria-label={`Remove ${c.name}`}
              >
                <i className={cx(swatch, 'size-6')} style={{ background: hex(c.color) }} />
                {c.name}
                {p.chips!.length > 1 && (
                  <svg className="size-4 text-ink-2" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                    <path d="M4.5 4.5l7 7m0-7l-7 7" />
                  </svg>
                )}
              </button>
            ))}
          </div>
          {p.fixNotes.map((note) => (
            <div className="flex items-start gap-2.5 rounded-[10px] bg-bg px-3 py-2.5 text-[13px] text-ink-2" key={note.text} role={note.onUndo ? undefined : 'status'}>
              {note.onUndo ? (
                <svg className="mt-px size-[18px] flex-none text-good" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <circle cx="9" cy="9" r="7.5" />
                  <path d="M5.5 9.2l2.3 2.3 4.7-4.7" />
                </svg>
              ) : (
                <span className={cx(spinnerSmall, 'mt-0.5')} aria-hidden="true" />
              )}
              <span>
                {note.text} {note.onUndo && <button className={link} onClick={note.onUndo}>{note.undoLabel}</button>}
              </span>
            </div>
          ))}
        </div>
      )}

      <label className={cx('flex items-center justify-between gap-3 font-medium', !p.transparentLocked && 'cursor-pointer')} htmlFor="transparent">
        <span>
          Transparent background
          <small className="block text-[13px] font-normal">{p.transparentHint}</small>
        </span>
        <input
          id="transparent"
          type="checkbox"
          className="relative m-0 h-[26px] w-11 flex-none cursor-pointer appearance-none rounded-full bg-line transition-colors after:absolute after:top-[3px] after:left-[3px] after:size-5 after:rounded-full after:bg-card after:shadow-[0_1px_3px_rgb(0_0_0/0.3)] after:transition-transform after:content-[''] checked:bg-accent checked:after:translate-x-[18px] disabled:cursor-default disabled:opacity-55" checked={p.transparent} disabled={p.transparentLocked} onChange={(e) => p.onTransparent(e.target.checked)} />
      </label>

      <div className="grid gap-2">
        <button className="flex items-center justify-center gap-2.5 rounded-xl bg-accent px-[18px] py-[15px] text-base font-bold text-accent-ink enabled:hover:brightness-106" disabled={!p.downloads || p.status !== 'ready'} onClick={() => p.downloads && p.onDownload(p.downloads[0])}>
          <svg className="size-5" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M10 3v10m0 0l-4-4m4 4l4-4M4 16h12" />
          </svg>
          Download {p.downloads?.[0].label ?? ''}
        </button>
        {p.downloads && (
          <div className="text-center text-[13px] text-balance text-ink-2">
            {p.downloads[0].detail}.{' '}
            <button className={link} disabled={p.status !== 'ready'} onClick={() => p.onDownload(p.downloads![1])}>
              Also get {p.downloads[1].label}
            </button>
          </div>
        )}
      </div>

      <details className="group border-t border-line pt-3.5">
        <summary className="flex items-center gap-1.5 text-sm font-semibold text-ink-2">
          <svg className="size-4 transition-transform group-open:rotate-90" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M6 3l5 5-5 5" />
          </svg>
          Not quite right? Fine-tune
        </summary>
        <div className="mt-3.5 grid grid-cols-[minmax(0,1fr)] gap-4">
          <div className="grid gap-1">
            <label className="text-sm font-medium" htmlFor="detail">Detail</label>
            <input id="detail" className={range} type="range" min={0} max={100} value={Math.round(p.detail * 100)} onChange={(e) => p.onDetail(Number(e.target.value) / 100)} />
            <div className="flex justify-between text-xs text-ink-2">
              <span>Simpler shapes</span>
              <span>More detail</span>
            </div>
          </div>
          <div className="grid gap-1">
            <label className="text-sm font-medium" htmlFor="corners">Corners</label>
            <input id="corners" className={range} type="range" min={0} max={100} value={Math.round(p.corners * 100)} onChange={(e) => p.onCorners(Number(e.target.value) / 100)} />
            <div className="flex justify-between text-xs text-ink-2">
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
