import { useState } from 'react'
import { ASSET_TYPES, cleanLinks, REVIEW_REASONS, reviewProblem, type AssetType, type Confidence, type Outcome, type RunRecord } from '../admin/runs'
import type { Complexity } from '../admin/complexity'
import { btnPrimary, cx, note, seg, segBtn, select } from './ui'

export interface ReviewDraft {
  outcome: Outcome
  reasonCode: string | null
  comment: string
  minutesSaved: number
  /** The type of artwork, as the artist confirmed or corrected the suggestion. */
  assetType: AssetType
  /** How sure the artist is; null when not given. */
  confidence: Confidence | null
  /** The order this logo belongs to, so the run can be found from the case or sales order. */
  links: RunRecord['links']
}

interface Props {
  complexity: Complexity | null
  /** The type the engine's detection suggests; the artist can change it. */
  suggestedType: AssetType
  /** Saving, saved, or what went wrong; null before the first save. */
  state: { status: 'saving' | 'saved' } | { status: 'error'; message: string } | null
  onSave: (r: ReviewDraft) => void
}

const OUTCOMES: { id: Outcome; label: string }[] = [
  { id: 'usable', label: 'Usable as is' },
  { id: 'touch-up', label: 'Needs touch-up' },
  { id: 'rejected', label: 'Rejected' },
]

const BAND = { simple: 'Simple', medium: 'Medium', complex: 'Complex' } as const

/**
 * The Layout team's verdict on the vector shown (admin panel only). It feeds the success rate per
 * complexity band and the learned settings, so a reason is asked for whenever it wasn't usable.
 */
export function ReviewPanel({ complexity, suggestedType, state, onSave }: Props) {
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [assetType, setAssetType] = useState<AssetType>(suggestedType)
  const [confidence, setConfidence] = useState<Confidence | null>(null)
  const [reasonCode, setReasonCode] = useState('')
  const [comment, setComment] = useState('')
  const [minutes, setMinutes] = useState('')
  const [order, setOrder] = useState({ logoId: '', caseNo: '', salesOrder: '' })
  const [shown, setShown] = useState<string | null>(null)

  const save = () => {
    if (!outcome) return setShown('Choose usable, touch-up or rejected.')
    const draft = { outcome, reasonCode: reasonCode || null, comment: comment.trim(), minutesSaved: minutes.trim() === '' ? 0 : Number(minutes), assetType, confidence, links: cleanLinks(order) }
    const problem = reviewProblem(draft)
    setShown(problem)
    if (!problem) onSave(draft)
  }

  return (
    <section className="grid gap-3 rounded-2xl border border-line bg-card p-4" aria-label="Review this vector">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-display text-base font-bold">Review this vector</h2>
        {complexity && (
          <span className={note}>
            Complexity {complexity.score} · {BAND[complexity.band]}
          </span>
        )}
      </div>
      <div className={seg} role="group" aria-label="Outcome">
        {OUTCOMES.map((o) => (
          <button key={o.id} type="button" className={segBtn} aria-pressed={outcome === o.id} onClick={() => setOutcome(o.id)}>
            {o.label}
          </button>
        ))}
      </div>
      {outcome && (
        <div className="grid gap-1 text-sm font-medium">
          <span id="confidence-label">
            How sure are you? <small className={note}>Optional</small>
          </span>
          <div className={seg} role="group" aria-labelledby="confidence-label">
            {(['low', 'medium', 'high'] as const).map((c) => (
              <button key={c} type="button" className={segBtn} aria-pressed={confidence === c} onClick={() => setConfidence(confidence === c ? null : c)}>
                {c === 'low' ? 'Borderline' : c === 'medium' ? 'Fairly sure' : 'Certain'}
              </button>
            ))}
          </div>
        </div>
      )}
      <label className="grid gap-1 text-sm font-medium">
        Type of artwork <small className={note}>Suggested from the image; change it if it's wrong.</small>
        <select className={select} value={assetType} onChange={(e) => setAssetType(e.target.value as AssetType)}>
          {ASSET_TYPES.map((t) => (
            <option key={t.code} value={t.code}>
              {t.label}
            </option>
          ))}
        </select>
      </label>
      {outcome && outcome !== 'usable' && (
        <label className="grid gap-1 text-sm font-medium">
          Reason
          <select className={select} value={reasonCode} onChange={(e) => setReasonCode(e.target.value)}>
            <option value="">Choose a reason…</option>
            {REVIEW_REASONS.map((r) => (
              <option key={r.code} value={r.code}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="grid gap-2 min-[520px]:grid-cols-3">
        {(
          [
            ['logoId', 'Logo ID', 'BLN…'],
            ['caseNo', 'Case', 'CAS-…'],
            ['salesOrder', 'Sales order', 'BAR-SO…'],
          ] as const
        ).map(([key, label, hint]) => (
          <label key={key} className="grid gap-1 text-sm font-medium">
            {label} <small className={note}>Optional</small>
            <input className={select} value={order[key]} placeholder={hint} onChange={(e) => setOrder((o) => ({ ...o, [key]: e.target.value }))} />
          </label>
        ))}
      </div>
      <label className="grid gap-1 text-sm font-medium">
        Minutes saved <small className={note}>Against doing it by hand; negative if it cost time.</small>
        <input className={select} inputMode="numeric" value={minutes} onChange={(e) => setMinutes(e.target.value)} placeholder="0" />
      </label>
      <label className="grid gap-1 text-sm font-medium">
        Comment <small className={note}>Optional</small>
        <textarea className={cx(select, 'min-h-16')} value={comment} onChange={(e) => setComment(e.target.value)} />
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className={btnPrimary} onClick={save} disabled={state?.status === 'saving'}>
          {state?.status === 'saving' ? 'Saving…' : 'Save review'}
        </button>
        <span className={note} role="status">
          {shown ?? (state?.status === 'saved' ? 'Saved. Thank you.' : state?.status === 'error' ? state.message : '')}
        </span>
      </div>
    </section>
  )
}
