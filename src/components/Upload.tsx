import { useRef, useState } from 'react'
import { cx } from './ui'

/** Largest upload accepted, in MB (the drop zone states it; App enforces it for paste too). */
export const MAX_UPLOAD_MB = 20

interface Props {
  onFile: (file: Blob, name: string) => void
  onExample: () => void
  loading: boolean
}

const btn = 'min-h-12 rounded-lg font-display text-base font-bold'

const steps = [
  { title: 'Drop Any Image', text: 'A photo of a sketch, a blurry JPEG, a screenshot of a logo.', mark: 'bg-accent text-accent-ink' },
  { title: 'We Clean It Up', text: 'Compression smudges, stray specks and fuzzy edges are fixed automatically.', mark: 'bg-accent-2 text-accent-2-ink' },
  { title: 'Download the Right File', text: 'Pick print, website or cutting machine. We choose the format.', mark: 'bg-accent-3 text-accent-2-ink' },
]

export function Upload({ onFile, onExample, loading }: Props) {
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)

  return (
    <div className="grid gap-10 pt-[clamp(16px,5vw,38px)] pb-8">
      <div className="grid justify-items-center gap-3 text-center">
        <span className="text-sm font-semibold tracking-[0.02em] text-meta">Step 1 of 3 · Upload</span>
        <h1 className="font-display text-[clamp(32px,5vw,48px)]/[1.1] font-bold tracking-[-0.02em] text-balance text-accent">Turn Any Image Into a Clean Vector</h1>
        <p className="max-w-[560px] text-lg/normal text-ink-2">Drop a logo, sketch or graphic and we’ll trace it, tidy it up and hand you the right file for the job.</p>
      </div>

      <section
        aria-label="Upload an image"
        className={cx(
          'grid justify-items-center gap-5 rounded-3xl border-2 border-dashed px-6 py-[clamp(36px,7vw,56px)] text-center transition-colors',
          over ? 'border-accent bg-accent-soft' : 'border-line-strong bg-card',
        )}
        onDragOver={(e) => {
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setOver(false)
          const file = e.dataTransfer.files[0]
          if (file) onFile(file, file.name)
        }}
      >
        <div className="flex size-[72px] items-center justify-center rounded-full bg-drop-icon text-accent">
          <svg className="size-8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 15V3" />
            <path d="m7 8 5-5 5 5" />
            <path d="M20 15v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-4" />
          </svg>
        </div>
        <div className="grid gap-1.5">
          <p className="font-display text-[22px] font-bold">Drag and drop your image here</p>
          <p className="text-[15px] text-meta">JPG, PNG, WebP, GIF or SVG · <span className="whitespace-nowrap">up to {MAX_UPLOAD_MB} MB</span></p>
        </div>
        <div className="flex flex-wrap justify-center gap-3">
          <button className={cx(btn, 'bg-accent px-7 text-accent-ink enabled:hover:brightness-125')} onClick={() => input.current?.click()} disabled={loading}>
            {loading ? 'Opening…' : 'Choose Image'}
          </button>
          <button className={cx(btn, 'border border-line-strong bg-card px-6 text-accent enabled:hover:border-accent')} onClick={onExample} disabled={loading}>
            Try an Example
          </button>
        </div>
        <p className="flex items-center gap-2 text-sm text-ink-2">
          <svg className="size-4 flex-none text-accent" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="4" y="11" width="16" height="10" rx="2" />
            <path d="M8 11V7a4 4 0 0 1 8 0v4" />
          </svg>
          You can also paste with Ctrl + V. Your file never leaves your computer.
        </p>
        <input
          ref={input}
          type="file"
          accept="image/*,.svg"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) onFile(file, file.name)
            e.target.value = ''
          }}
        />
      </section>

      <section id="how" aria-labelledby="how-title" className="grid scroll-mt-6 gap-5">
        <h2 id="how-title" className="font-display text-2xl font-bold text-accent">How It Works</h2>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-4">
          {steps.map((s, i) => (
            <div key={s.title} className="grid content-start gap-3 rounded-xl border border-line bg-card p-6">
              <span className={cx('flex size-10 items-center justify-center rounded-full font-display text-base font-bold', s.mark)}>{i + 1}</span>
              <h3 className="font-display text-lg font-bold">{s.title}</h3>
              <p className="text-[15px]/normal text-ink-2">{s.text}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
