import type { ReactNode } from 'react'
import type { AiProgress, UpscaleSetting } from '../ai/enhancer'
import type { ArtKind } from '../vectorize/detect'
import { KIND_LABEL, type Style } from '../vectorize/client'

interface Props {
  detected: ArtKind
  style: Style
  onStyle: (s: Style) => void
  maxColors: number | null
  onMaxColors: (n: number | null) => void
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
    <details className="more">
      <summary>More options</summary>
      <div className="more-body">
        <div className="field">
          <label htmlFor="style">Artwork type</label>
          <select id="style" value={p.style} onChange={(e) => p.onStyle(e.target.value as Style)}>
            <option value="auto">Automatic ({KIND_LABEL[p.detected]})</option>
            {(Object.keys(KIND_LABEL) as ArtKind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </div>

        {p.showColors && (
          <div className="field">
            <label htmlFor="maxColors">Maximum colors</label>
            <select id="maxColors" value={p.maxColors ?? 'auto'} onChange={(e) => p.onMaxColors(e.target.value === 'auto' ? null : Number(e.target.value))}>
              <option value="auto">Automatic</option>
              {[1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 24].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="field">
          <span className="field-label" id="upscale-label">
            Sharpen small images (AI)
          </span>
          <div className="mini-seg" role="group" aria-labelledby="upscale-label">
            {(
              [
                ['off', 'Off'],
                ['2x', '2×'],
                ['4x', '4× + de-JPEG'],
              ] as [UpscaleSetting, string][]
            ).map(([v, l]) => (
              <button key={v} aria-pressed={p.upscale === v} onClick={() => p.onUpscale(v)}>
                {l}
              </button>
            ))}
          </div>
          {p.upscaleProgress ? (
            <div className="ai-progress">
              <span>{p.upscaleProgress.phase === 'download' ? 'Downloading the sharpening model' : 'Sharpening'}</span>
              <div className="bar">
                <div style={{ width: `${Math.round(p.upscaleProgress.progress * 100)}%` }} />
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
