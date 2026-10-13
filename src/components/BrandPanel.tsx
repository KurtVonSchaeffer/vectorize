import { useId, type ReactNode } from 'react'
import type { BrandColor, BrandMode, BrandSettings } from '../palette/brand'
import type { Palette } from '../palette/parse'

export type MatchMode = BrandMode | 'library'

interface Props {
  brand: BrandSettings
  /** 'library' means matching to the nearest swatch of an imported library (Pantone etc.). */
  mode: MatchMode
  onMode: (m: MatchMode) => void
  onColors: (colors: BrandColor[]) => void
  /** Colors found in the current artwork, offered as one-tap additions. */
  artwork: { color: number; name: string }[]
  /** Imported swatch library, used to look up exact colors by name. */
  library: Palette | null
  /** The library-matching controls, shown in 'library' mode. */
  libraryPanel: ReactNode
}

const TOLERANCES: [number, string][] = [
  [4, 'Very close'],
  [8, 'Close'],
  [15, 'Loose'],
  [25, 'Very loose'],
]

const hex = (c: number) => '#' + c.toString(16).padStart(6, '0')
const rgbInt = (r: number, g: number, b: number) => (r << 16) | (g << 8) | b

export function BrandPanel({ brand, mode, onMode, onColors, artwork, library, libraryPanel }: Props) {
  const listId = useId()
  const update = (i: number, patch: Partial<BrandColor>) => onColors(brand.colors.map((c, j) => (j === i ? { ...c, ...patch } : c)))
  const remove = (i: number) => onColors(brand.colors.filter((_, j) => j !== i))
  const add = (c: Partial<BrandColor>) =>
    onColors([...brand.colors, { name: c.name ?? `Brand color ${brand.colors.length + 1}`, color: c.color ?? 0x000000, tolerance: c.tolerance ?? 8 }])
  const notYetAdded = artwork.filter((a) => !brand.colors.some((b) => b.color === a.color))

  return (
    <div className="field brand">
      <span className="field-label" id="brand-label">
        Brand colors
      </span>
      <div className="mini-seg" role="group" aria-labelledby="brand-label">
        {(
          [
            ['off', 'Off'],
            ['snap', 'Snap close'],
            ['only', 'Only brand'],
            ['library', 'Library'],
          ] as [MatchMode, string][]
        ).map(([v, l]) => (
          <button key={v} aria-pressed={mode === v} onClick={() => onMode(v)}>
            {l}
          </button>
        ))}
      </div>
      <small>
        {mode === 'off' && 'Colors are taken from the artwork as they are.'}
        {mode === 'snap' && 'Colors close to a brand color become that exact color. Others stay as they are.'}
        {mode === 'only' && 'Every color becomes the nearest brand color, so nothing off-brand appears.'}
        {mode === 'library' && 'Each color is matched to the nearest swatch in an imported library, such as Pantone.'}
      </small>

      {mode === 'library' ? (
        libraryPanel
      ) : (
        <>
          {library && (
            <datalist id={listId}>
              {library.swatches.map((s) => (
                <option key={s.name} value={s.name} />
              ))}
            </datalist>
          )}
          <div className="brand-list">
            {brand.colors.map((c, i) => (
              <div className="brand-row" key={i}>
                <input
                  type="color"
                  value={hex(c.color)}
                  aria-label={`${c.name} color`}
                  onChange={(e) => update(i, { color: parseInt(e.target.value.slice(1), 16) })}
                />
                <input
                  className="brand-name"
                  value={c.name}
                  list={library ? listId : undefined}
                  aria-label="Brand color name"
                  title={library ? 'Type a swatch name to use its exact color' : undefined}
                  onChange={(e) => {
                    const name = e.target.value
                    const swatch = library?.swatches.find((s) => s.name === name)
                    update(i, swatch ? { name, color: rgbInt(...swatch.rgb) } : { name })
                  }}
                />
                <select value={c.tolerance} aria-label={`How close a color must be to become ${c.name}`} onChange={(e) => update(i, { tolerance: Number(e.target.value) })}>
                  {TOLERANCES.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
                <button className="icon-btn" onClick={() => remove(i)} aria-label={`Remove ${c.name}`}>
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                    <path d="M4.5 4.5l7 7m0-7l-7 7" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
          <div className="brand-actions">
            <button className="btn small" onClick={() => add({})}>
              + Add color
            </button>
          </div>
          {notYetAdded.length > 0 && (
            <div className="from-art">
              <small>Add from your artwork:</small>
              <div className="chips">
                {notYetAdded.map((a) => (
                  <button key={a.color} className="chip small" onClick={() => add({ name: a.name, color: a.color })} title={`Add ${a.name} as a brand color`}>
                    <i style={{ background: hex(a.color) }} />
                    {a.name}
                  </button>
                ))}
              </div>
            </div>
          )}
          {(mode === 'snap' || mode === 'only') && !brand.colors.length && <small className="note">Add at least one brand color to use this.</small>}
        </>
      )}
    </div>
  )
}
