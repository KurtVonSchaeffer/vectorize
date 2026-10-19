import type { ReactNode } from 'react'
import type { AiProgress, UpscaleSetting } from '../ai/enhancer'
import type { ArtKind } from '../vectorize/detect'
import { COLOR_LIMITS, KIND_LABEL, type Style } from '../vectorize/client'
import { bar, barFill, field, fieldLabel, link, note, progress, seg, segBtn, select } from './ui'

interface Props {
  detected: ArtKind
  style: Style
  onStyle: (s: Style) => void
  maxColors: number | null
  onMaxColors: (n: number | null) => void
  /** Switches to print inks with a single ink (white is paper): the one-colour route. */
  onOneInk?: () => void
  showColors: boolean
  upscale: UpscaleSetting
  onUpscale: (u: UpscaleSetting) => void
  upscaleProgress: AiProgress | null
  upscaleNote: string | null
  brandColors: ReactNode
  fonts: ReactNode
}

export function MoreOptions(p: Props) {
  return (
    <details className="group rounded-xl border border-line">
      <summary className="px-3.5 py-2.5 text-sm font-semibold group-open:border-b group-open:border-line">More options</summary>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-1">
        <div className={field}>
          <label className={fieldLabel} htmlFor="style">Artwork type</label>
          <select className={select} id="style" value={p.style} onChange={(e) => p.onStyle(e.target.value as Style)}>
            <option value="auto">Automatic ({KIND_LABEL[p.detected]})</option>
            {(Object.keys(KIND_LABEL) as ArtKind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </div>

        {p.showColors && (
          <div className={field}>
            <label className={fieldLabel} htmlFor="maxColors">Maximum colors</label>
            <select className={select} id="maxColors" value={p.maxColors ?? 'auto'} onChange={(e) => p.onMaxColors(e.target.value === 'auto' ? null : Number(e.target.value))}>
              <option value="auto">Automatic</option>
              {COLOR_LIMITS.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            {p.onOneInk && (
              <small className={note}>
                One color for screen printing or vinyl?{' '}
                <button type="button" className={link} onClick={p.onOneInk}>
                  Print in one ink
                </button>{' '}
                (white areas stay as paper).
              </small>
            )}
          </div>
        )}

        <div className={field}>
          <span className={fieldLabel} id="upscale-label">
            Sharpen small images (AI)
          </span>
          <div className={seg} role="group" aria-labelledby="upscale-label">
            {(
              [
                ['off', 'Off'],
                ['2x', '2×'],
                ['4x', '4× + de-JPEG'],
              ] as [UpscaleSetting, string][]
            ).map(([v, l]) => (
              <button key={v} className={segBtn} aria-pressed={p.upscale === v} onClick={() => p.onUpscale(v)}>
                {l}
              </button>
            ))}
          </div>
          {p.upscaleProgress ? (
            <div className={progress}>
              <span>{p.upscaleProgress.phase === 'download' ? 'Downloading the sharpening model' : 'Sharpening'}</span>
              <div className={bar}>
                <div className={barFill} style={{ width: `${Math.round(p.upscaleProgress.progress * 100)}%` }} />
              </div>
            </div>
          ) : (
            <small>{p.upscaleNote ?? 'Helps with tiny or blurry images. Runs on your computer; can take a minute.'}</small>
          )}
        </div>

        {p.brandColors}
        {p.fonts}
      </div>
    </details>
  )
}
