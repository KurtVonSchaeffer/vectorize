import { useEffect, useState, type ReactNode } from 'react'
import type { Purpose } from '../vectorize/client'
import type { Download } from '../export/files'
import { onePlate, type Plate } from '../export/plates'
import type { EnclosedArea, WhiteInk } from '../vectorize/paper'
import type { AutoCheck } from '../quality/readiness'
import { btnQuiet, chip, cx, link, range, seg, segBtn, spinnerSmall, swatch } from './ui'

export type ColorMode = 'full' | 'one' | 'custom'

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
  /** Full color (the default), one ink, or custom limits; null when colors don't apply. */
  colorMode: { mode: ColorMode; onMode: (m: ColorMode) => void } | null
  transparent: boolean
  transparentHint: string
  transparentLocked: boolean
  onTransparent: (v: boolean) => void
  downloads: [Download, Download] | null
  /** Lettering rebuilt from a font, as editable text: offered only when there is some. */
  editableText?: Download | null
  onDownload: (d: Download) => void
  detail: number
  corners: number
  onDetail: (v: number) => void
  onCorners: (v: number) => void
  more: ReactNode
  /**
   * Quality reporting (behind a flag): generated, automatically checked and reviewed by a person
   * are shown as separate facts. None of them is a production approval. Absent, the card reads as before.
   */
  quality?: { autoCheck: AutoCheck; reviewed: boolean; findings: string[]; onReview: () => void; onUnreview: () => void }
  /**
   * Print files (behind a flag), for an opaque upload on paper: how much of the white prints as
   * white ink. `enclosed`: the artwork encloses white that may be intentional or paper. Absent,
   * nothing is shown.
   */
  whiteInk?: WhiteInkProps
  /** Print files (behind a flag): the print plates, shown before downloading. Absent, nothing is shown. */
  platePreview?: PlatePreviewProps
}

export interface WhiteInkProps {
  mode: WhiteInk
  onMode: (m: WhiteInk) => void
  enclosed: boolean
  /** White artwork only: the lettering is still being read (letter counters not known yet). */
  readingText: boolean
  /** White artwork only: the enclosed white areas and what became of them; null while the plates are made. */
  areas: EnclosedArea[] | null
}

export interface PlatePreviewProps {
  open: boolean
  onOpen: (open: boolean) => void
  /** The print SVG once made; null while it's being made. */
  svg: string | null
  failed: boolean
  plates: Plate[]
  /** Gradient shapes: printed in full colour, not on a plate. */
  gradients: number
  /** White artwork only: enclosed white areas, marked on the preview, each with a choice. */
  areas: EnclosedArea[]
  onChoose: (area: EnclosedArea, white: boolean) => void
  onChooseAll: (areas: EnclosedArea[], white: boolean) => void
  width: number
  height: number
}

export type { WhiteInk }

export const WHITE_INK: { mode: WhiteInk; label: string; hint: string }[] = [
  { mode: 'none', label: 'No white ink', hint: 'For white garments: nothing prints in white. The garment shows through the background and every white area.' },
  { mode: 'artwork', label: 'Print white artwork only', hint: 'For coloured garments: white inside the artwork prints in white ink; the background is left out.' },
  { mode: 'all', label: 'Print white background too', hint: 'The white background prints in white ink as well, as a white box.' },
]

/** Garment colours for the plate preview. */
const GARMENTS = [
  { label: 'White garment', color: '#ffffff' },
  { label: 'Coloured garment', color: '#1f3b5c' },
]

const CHECK_LABEL: Record<AutoCheck, string> = {
  checking: 'Checking against your image…',
  'no-known-problems': 'Automatic check: no known problems',
  'problems-found': 'Automatic check: problems found',
  'not-checked': 'Not checked automatically',
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
            {p.quality ? 'Vector created' : 'Ready'}
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
        {p.status === 'ready' && p.quality && <QualityStatus {...p.quality} />}
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
          {p.colorMode && (
            <div className="grid gap-1.5">
              <span className="text-[13px] font-semibold text-ink-2" id="color-mode-label">
                Color mode
              </span>
              <div className={seg} role="group" aria-labelledby="color-mode-label">
                {(
                  [
                    ['full', 'Full color'],
                    ['one', 'One color'],
                    ['custom', 'Custom'],
                  ] as [ColorMode, string][]
                ).map(([m, label]) => (
                  <button key={m} className={segBtn} aria-pressed={p.colorMode!.mode === m} onClick={() => p.colorMode!.onMode(m)}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}
          <h2 className="text-[13px] font-semibold text-ink-2">
            {p.purpose === 'print' && p.colorMode && p.colorMode.mode !== 'full' ? `Colors · ${p.chips.length} ${p.chips.length === 1 ? 'ink' : 'inks'} to print` : `Colors · ${p.chips.length}`}
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

      {p.whiteInk && (
        <div className="grid gap-1.5">
          <span className="font-medium" id="white-ink-label">
            White ink in print files
          </span>
          <small className="text-[13px] text-ink-2">Changes the print separations and cut files only. Your master vector (the SVG shown here) keeps every colour.</small>
          <div className={seg} role="group" aria-labelledby="white-ink-label">
            {WHITE_INK.map((o) => (
              <button key={o.mode} className={segBtn} aria-pressed={p.whiteInk!.mode === o.mode} onClick={() => p.whiteInk!.onMode(o.mode)}>
                {o.label}
              </button>
            ))}
          </div>
          <small className="text-[13px] text-ink-2">{WHITE_INK.find((o) => o.mode === p.whiteInk!.mode)!.hint}</small>
          {p.whiteInk.enclosed && p.whiteInk.mode === 'none' && (
            <div className="rounded-[10px] bg-bg px-3 py-2.5 text-[13px] text-ink-2" role="note">
              <strong className="text-ink">Check the white areas inside your artwork.</strong> They are left out, so the garment shows through them. If any of them are meant to be white (lettering, highlights), choose “Print white artwork only”.
            </div>
          )}
          {p.whiteInk.mode === 'artwork' && <WhiteAreasNote {...p.whiteInk} />}
        </div>
      )}

      {p.platePreview && <PlatePreview {...p.platePreview} />}

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
        {p.editableText && (
          <div className="text-center text-[13px] text-balance text-ink-2">
            <button className={link} disabled={p.status !== 'ready'} onClick={() => p.onDownload(p.editableText!)}>
              Also get {p.editableText.label}
            </button>
            . {p.editableText.detail}.
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

/** The automatic check and a person's review, as two separate lines. */
function QualityStatus(q: NonNullable<Props['quality']>) {
  return (
    <div className="grid gap-2 rounded-[10px] border border-line px-3 py-2.5 text-[13px]" role="status">
      <div className="grid gap-1">
        <span className={cx('flex items-center gap-1.5 font-semibold', q.autoCheck === 'problems-found' ? 'text-warn' : 'text-ink-2')}>
          {q.autoCheck === 'checking' && <span className={spinnerSmall} aria-hidden="true" />}
          {CHECK_LABEL[q.autoCheck]}
        </span>
        {q.findings.length > 0 && (
          <ul className="grid list-disc gap-0.5 pl-4 text-ink-2">
            {q.findings.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-2">
        <span className={cx('font-semibold', q.reviewed ? 'text-good' : 'text-ink-2')}>{q.reviewed ? 'Artwork reviewed by you' : 'Artwork not reviewed yet'}</span>
        {q.reviewed ? (
          <button className={link} onClick={q.onUnreview}>
            Undo
          </button>
        ) : (
          <button className={link} onClick={q.onReview}>
            Mark as reviewed
          </button>
        )}
        <span className="basis-full text-xs text-ink-2">Covers the vector shown here. Not a production approval: that will also need the print method, size and colours.</span>
      </div>
    </div>
  )
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** White artwork only: what happened to the white areas inside the artwork, and what needs checking. */
function WhiteAreasNote(w: WhiteInkProps) {
  if (w.readingText || !w.areas)
    return (
      <div className="flex items-center gap-2 text-[13px] text-ink-2" role="status">
        <span className={spinnerSmall} aria-hidden="true" />
        {w.readingText ? 'Reading the lettering to find the insides of letters…' : 'Checking the white areas inside your artwork…'}
      </div>
    )
  // Slivers inside letters are paper too, but aren't counted as letters' insides.
  const counters = w.areas.filter((a) => a.kind === 'counter' && !a.thin).length
  // Thin slivers are one thing to check (see PlatePreview).
  const open = w.areas.filter((a) => !a.decided && !a.thin).length + (w.areas.some((a) => !a.decided && a.thin) ? 1 : 0)
  if (!counters && !w.areas.some((a) => a.kind !== 'counter')) return null
  return (
    <div className="grid gap-1.5 rounded-[10px] bg-bg px-3 py-2.5 text-[13px] text-ink-2" role="note">
      {counters > 0 && <span>{plural(counters, 'letter counter (the inside of a letter) is', 'letter counters (the insides of letters) are')} left out, so the garment shows through.</span>}
      {open > 0 ? (
        <span>
          <strong className="text-ink">{open === 1 ? 'One thing needs' : `${open} things need`} checking.</strong> White areas inside the artwork print in white ink, but the image can’t tell white artwork from background showing through. Preview the print plates and choose for each one.
        </span>
      ) : (
        w.areas.some((a) => a.kind !== 'counter') && <span>You chose for every white area inside the artwork.</span>
      )}
    </div>
  )
}

/** The print plates as they will print, on a white or coloured garment, all together or one at a time. */
function PlatePreview(v: PlatePreviewProps) {
  const [garment, setGarment] = useState(GARMENTS[0].color)
  const [only, setOnly] = useState<number | null>(null)
  const shown = v.svg && only !== null && v.plates.some((pl) => pl.color === only) ? onePlate(v.svg, only) : v.svg
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!shown) return setUrl(null)
    const u = URL.createObjectURL(new Blob([shown], { type: 'image/svg+xml' }))
    setUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [shown])
  // Every enclosed white area that isn't a letter counter, numbered as on the preview.
  const marked = v.areas.filter((a) => a.kind !== 'counter' && !a.thin).map((area, i) => ({ area, n: i + 1 }))
  // Thin slivers are checked together: usually where blended edge colours meet.
  const thin = v.areas.filter((a) => a.kind !== 'counter' && a.thin)
  const thinKind = thin.every((a) => a.kind === 'garment') ? 'garment' : thin.every((a) => a.kind === 'white') ? 'white' : null
  const ring = (a: EnclosedArea) => Math.max(3, Math.hypot(a.box[2] - a.box[0], a.box[3] - a.box[1]) / 2 + 1.5)
  if (!v.open)
    return (
      <button className={btnQuiet} onClick={() => v.onOpen(true)}>
        Preview print plates
      </button>
    )
  return (
    <div className="grid gap-2" role="region" aria-label="Print plates preview">
      <div className="flex items-center justify-between gap-3">
        <span className="font-medium">Print plates</span>
        <button className={link} onClick={() => v.onOpen(false)}>
          Hide
        </button>
      </div>
      <div className={seg} role="group" aria-label="Garment">
        {GARMENTS.map((g) => (
          <button key={g.color} className={segBtn} aria-pressed={garment === g.color} onClick={() => setGarment(g.color)}>
            {g.label}
          </button>
        ))}
      </div>
      <div className="grid place-items-center overflow-hidden rounded-[10px] border border-line p-3" style={{ background: garment }}>
        {url ? (
          <svg viewBox={`0 0 ${v.width} ${v.height}`} className="max-h-64 w-full" role="img" aria-label={only === null ? 'All print plates' : `The ${v.plates.find((pl) => pl.color === only)?.name} plate`}>
            <image href={url} width={v.width} height={v.height} />
            {thin.map((area, i) => (
              <circle key={`t${i}`} cx={area.at[0]} cy={area.at[1]} r={Math.max(2, v.width / 120)} fill="#e0218a" fillOpacity={0.55} aria-hidden="true" />
            ))}
            {marked.map(({ area, n }) => (
              <g key={n} aria-hidden="true">
                <circle cx={area.at[0]} cy={area.at[1]} r={ring(area)} fill="none" stroke="#e0218a" strokeWidth={Math.max(1, v.width / 160)} strokeDasharray={area.decided ? undefined : `${Math.max(1.5, v.width / 80)}`} />
                <text x={area.at[0] + (n % 2 ? 1 : -1) * ring(area)} y={area.at[1] - ring(area)} textAnchor={n % 2 ? 'start' : 'end'} fontSize={Math.max(6, v.width / 18)} fontWeight="700" fill="#e0218a" stroke="#fff" strokeWidth={Math.max(0.6, v.width / 300)} paintOrder="stroke">
                  {n}
                </text>
              </g>
            ))}
          </svg>
        ) : v.failed ? (
          <span className="text-[13px] text-bad">The plates couldn’t be made.</span>
        ) : (
          <span className={spinnerSmall} aria-label="Making the print plates" />
        )}
      </div>
      {v.svg && (
        <>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Plates">
            <button className={cx(chip, 'pl-3 aria-pressed:border-ink')} aria-pressed={only === null} onClick={() => setOnly(null)}>
              All plates
            </button>
            {v.plates.map((pl) => (
              <button key={pl.color} className={cx(chip, 'aria-pressed:border-ink')} aria-pressed={only === pl.color} onClick={() => setOnly(only === pl.color ? null : pl.color)}>
                <span className={cx(swatch, 'size-[18px]')} style={{ background: '#' + pl.color.toString(16).padStart(6, '0') }} aria-hidden="true" />
                {pl.name}
              </button>
            ))}
          </div>
          {(marked.length > 0 || thin.length > 0) && (
            <div className="grid gap-1.5" role="group" aria-label="White areas inside the artwork">
              <small className="text-[13px] text-ink-2">White areas inside the artwork (marked): white artwork, or background showing through?</small>
              {marked.map(({ area, n }) => (
                <div key={n} className="flex items-center justify-between gap-2 text-[13px]">
                  <span>
                    Area {n}
                    {!area.decided && <span className="text-ink-2"> · needs checking</span>}
                  </span>
                  <div className={cx(seg, 'w-56 flex-none')} role="group" aria-label={`Area ${n}`}>
                    <button className={segBtn} aria-pressed={area.kind === 'white'} onClick={() => v.onChoose(area, true)}>
                      White ink
                    </button>
                    <button className={segBtn} aria-pressed={area.kind === 'garment'} onClick={() => v.onChoose(area, false)}>
                      Garment
                    </button>
                  </div>
                </div>
              ))}
              {thin.length > 0 && (
                <div className="flex items-center justify-between gap-2 text-[13px]">
                  <span>
                    {plural(thin.length, 'thin white sliver', 'thin white slivers')} (under 1 mm, dots)
                    {thin.some((a) => !a.decided) && <span className="text-ink-2"> · needs checking</span>}
                  </span>
                  <div className={cx(seg, 'w-56 flex-none')} role="group" aria-label="Thin white slivers">
                    <button className={segBtn} aria-pressed={thinKind === 'white'} onClick={() => v.onChooseAll(thin, true)}>
                      White ink
                    </button>
                    <button className={segBtn} aria-pressed={thinKind === 'garment'} onClick={() => v.onChooseAll(thin, false)}>
                      Garment
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
          {v.gradients > 0 && (
            <small className="text-[13px] text-ink-2">
              {v.gradients === 1 ? 'One gradient prints' : `${v.gradients} gradients print`} in full colour, not on a separate plate. They show in “All plates”.
            </small>
          )}
          <small className="text-[13px] text-ink-2">Exactly what the print and cut files contain. Where nothing prints, the garment shows through; white ink on a white garment is hard to see.</small>
        </>
      )}
    </div>
  )
}
