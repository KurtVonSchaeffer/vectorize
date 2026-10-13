import { useId, useRef, useState } from 'react'
import type { Palette } from '../palette/parse'
import type { Ink, InkSettings } from '../palette/quantize'
import { btnGhost, btnSmall, check, cx, fieldLabel, link, note, range } from './ui'

interface Props {
  settings: InkSettings
  palette: Palette
  isDemo: boolean
  inks: Ink[] | null
  onChange: (patch: Partial<InkSettings>) => void
  onImport: (file: File) => void
  onUseDemo: () => void
  /** Shown inside the brand-color panel, which already provides the heading and on/off. */
  embedded?: boolean
}

const css = (rgb: [number, number, number]) => `rgb(${rgb.join(',')})`

function matchLabel(de: number): { label: string; cls: string } {
  if (de < 2) return { label: 'Exact', cls: 'text-good' }
  if (de < 5) return { label: 'Close', cls: 'text-warn' }
  return { label: 'Far', cls: 'text-bad' }
}

export function InkPanel({ settings, palette, isDemo, inks, onChange, onImport, onUseDemo, embedded }: Props) {
  const file = useRef<HTMLInputElement>(null)
  const listId = useId()

  return (
    <section className={cx('grid gap-3', !embedded && 'px-3.5 py-3')}>
      {!embedded && (
        <>
          <h3 className="text-sm font-medium">Brand colors</h3>
          <label className={check}>
            <input type="checkbox" checked={settings.enabled} onChange={(e) => onChange({ enabled: e.target.checked })} />
            <span>
              Match my brand colors
              <small>Uses exact colors from your swatch library (for example Pantone) and names each ink in the print file.</small>
            </span>
          </label>
        </>
      )}

      {settings.enabled && (
        <>
          <div className="flex items-center justify-between gap-2">
            <div>
              <div className={fieldLabel}>{palette.name}</div>
              <small>{palette.swatches.length.toLocaleString()} swatches</small>
            </div>
            <div className="flex gap-1">
              <button className={btnSmall} onClick={() => file.current?.click()}>
                Import…
              </button>
              {!isDemo && (
                <button className={btnGhost} onClick={onUseDemo}>
                  Demo
                </button>
              )}
            </div>
          </div>
          {isDemo && (
            <small className={note}>
              Demo inks only. Import your licensed library: export it from Illustrator or Pantone Connect as .ase, or use a .csv / .json of names and
              hex or Lab values.
            </small>
          )}
          <input
            ref={file}
            type="file"
            accept=".ase,.csv,.tsv,.txt,.json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) onImport(f)
              e.target.value = ''
            }}
          />

          <label className="grid gap-1 [&_small]:text-xs">
            <div className="flex justify-between text-sm font-medium">
              <span>Max inks</span>
              <output className="text-ink-2 tabular-nums">{settings.maxInks}</output>
            </div>
            <input className={range} type="range" min={1} max={12} value={settings.maxInks} onChange={(e) => onChange({ maxInks: Number(e.target.value) })} />
            <small>Each ink is a separate screen or plate.</small>
          </label>

          <label className={check}>
            <input type="checkbox" checked={settings.whiteIsPaper} onChange={(e) => onChange({ whiteIsPaper: e.target.checked })} />
            <span>
              White is paper
              <small>Near-white areas get no ink and are left transparent.</small>
            </span>
          </label>

          {inks && inks.length > 0 && (
            <div className="grid gap-1.5">
              <datalist id={listId}>
                {palette.swatches.map((s) => (
                  <option key={s.name} value={s.name} />
                ))}
              </datalist>
              {inks.map((ink) => (
                <InkRow
                  key={ink.auto.name + ink.swatch.name}
                  ink={ink}
                  listId={listId}
                  palette={palette}
                  onSwap={(name) => {
                    const overrides = { ...settings.overrides }
                    if (name === ink.auto.name) delete overrides[ink.auto.name]
                    else overrides[ink.auto.name] = name
                    onChange({ overrides })
                  }}
                />
              ))}
            </div>
          )}
        </>
      )}
    </section>
  )
}

function InkRow({ ink, listId, palette, onSwap }: { ink: Ink; listId: string; palette: Palette; onSwap: (name: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  const match = matchLabel(ink.deltaE)
  const overridden = ink.swatch.name !== ink.auto.name

  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-line bg-bg px-2 py-1.5">
      <span className="size-[26px] flex-none rounded-md shadow-[inset_0_0_0_1px_rgb(0_0_0/0.15)]" style={{ background: css(ink.swatch.rgb) }} />
      <div className="min-w-0 flex-1">
        <input
          className="-ml-[5px] w-full rounded-[5px] border border-transparent bg-transparent px-1 py-px font-semibold outline-none hover:border-line hover:bg-card focus:border-line focus:bg-card"
          list={listId}
          value={draft ?? ink.swatch.name}
          title="Type or pick a swatch to swap this ink"
          onFocus={(e) => e.target.select()}
          onChange={(e) => {
            const v = e.target.value
            setDraft(v)
            if (palette.swatches.some((s) => s.name === v)) {
              setDraft(null)
              onSwap(v)
            }
          }}
          onBlur={() => setDraft(null)}
        />
        <small>
          {(ink.coverage * 100).toFixed(ink.coverage < 0.01 ? 1 : 0)}% of artwork · <span className={match.cls}>{match.label}</span> (ΔE{' '}
          {ink.deltaE.toFixed(1)})
          {overridden && (
            <>
              {' · '}
              <button className={link} onClick={() => onSwap(ink.auto.name)}>
                reset
              </button>
            </>
          )}
        </small>
      </div>
    </div>
  )
}
