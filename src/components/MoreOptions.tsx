import type { ReactNode } from 'react'
import type { AiProgress, UpscaleSetting } from '../ai/enhancer'
import type { ArtKind } from '../vectorize/detect'
import { KIND_LABEL, type OneColourSettings, type Style } from '../vectorize/client'
import { bar, barFill, field, fieldLabel, progress, seg, segBtn, select } from './ui'

interface Props {
  detected: ArtKind
  style: Style
  onStyle: (s: Style) => void
  maxColors: number | null
  onMaxColors: (n: number | null) => void
  showColors: boolean
  oneColour: OneColourSettings
  onOneColour: (s: Partial<OneColourSettings>) => void
  /** Whether this purpose makes print plates or cut files (where a separation gap applies). */
  oneColourGaps: boolean
  oneColourNote: string | null
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
              {[1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 24].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            {p.maxColors === 1 && <OneColour {...p} />}
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

const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`

/** One-colour choices: the ink, and the separation gap that print and cut files get. */
function OneColour(p: Props) {
  const o = p.oneColour
  return (
    <div className="mt-2 grid gap-2 rounded-lg border border-line p-2.5 text-sm">
      <label className="flex items-center gap-2">
        <span>Ink</span>
        <input type="color" value={hex(o.ink)} onChange={(e) => p.onOneColour({ ink: parseInt(e.target.value.slice(1), 16) })} aria-label="Ink colour" />
        <small>Light areas in the paper's colour stay open, so letter holes and white shapes survive.</small>
      </label>
      {p.oneColourGaps ? (
        <>
          <label className="grid gap-1">
            <span>
              Separation gap: <b>{o.gapMm.toFixed(1)} mm</b> at{' '}
              <input type="number" min={10} max={5000} step={10} value={o.outputWidthMm} onChange={(e) => p.onOneColour({ outputWidthMm: Math.max(10, Number(e.target.value) || 200) })} className="w-20 rounded border border-line px-1" aria-label="Output width in millimetres" /> mm wide
            </span>
            <input type="range" min={0} max={2} step={0.1} value={o.gapMm} onChange={(e) => p.onOneColour({ gapMm: Number(e.target.value) })} aria-label="Separation gap in millimetres" />
            <small>Keeps shapes that were different colours apart in the print and cut files. The SVG master keeps every shape whole.</small>
          </label>
          <div className="grid gap-1">
            <span id="one-preview">Preview shows</span>
            <div className={seg} role="group" aria-labelledby="one-preview">
              <button className={segBtn} aria-pressed={!o.previewGaps || o.gapMm === 0} onClick={() => p.onOneColour({ previewGaps: false })}>
                Master
              </button>
              <button className={segBtn} aria-pressed={o.previewGaps && o.gapMm > 0} disabled={o.gapMm === 0} onClick={() => p.onOneColour({ previewGaps: true })}>
                Print / cut file
              </button>
            </div>
            <small>The master (SVG) never has gaps. The print / cut file is what the PDF, DXF and cut SVG contain.</small>
          </div>
        </>
      ) : (
        <small>Separation gaps apply to print and cut files; the web version is the master, without gaps.</small>
      )}
      {p.oneColourNote && <small>{p.oneColourNote}</small>}
    </div>
  )
}
