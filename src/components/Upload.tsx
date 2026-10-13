import { useRef, useState } from 'react'
import { btnPrimary, btnQuiet, cx } from './ui'

interface Props {
  onFile: (file: Blob, name: string) => void
  onExample: () => void
  loading: boolean
}

export function Upload({ onFile, onExample, loading }: Props) {
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)

  return (
    <div className="grid gap-4">
      <div
        className={cx(
          'grid justify-items-center gap-2.5 rounded-[20px] border-2 border-dashed px-5 py-[clamp(32px,8vw,72px)] text-center transition-colors',
          over ? 'border-accent bg-accent-soft' : 'border-line bg-card',
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
        <svg className="size-12 text-accent" viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M24 31V11m0 0l-8 8m8-8l8 8" />
          <path d="M9 29v6a4 4 0 0 0 4 4h22a4 4 0 0 0 4-4v-6" />
        </svg>
        <h1 className="mt-1.5 font-display text-[clamp(26px,4vw,38px)]/[1.1] font-extrabold tracking-[-0.03em] text-balance">Turn any image into a clean vector</h1>
        <p className="max-w-[46ch] text-ink-2">Drop a logo, sketch or graphic here. JPG, PNG, WebP, GIF or SVG.</p>
        <div className="mt-2.5 mb-1 flex flex-wrap justify-center gap-2.5">
          <button className={btnPrimary} onClick={() => input.current?.click()} disabled={loading}>
            {loading ? 'Opening…' : 'Choose image'}
          </button>
          <button className={btnQuiet} onClick={onExample} disabled={loading}>
            Try an example
          </button>
        </div>
        <small>You can also paste an image. Your file stays on your computer.</small>
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
      </div>

      <section className="grid gap-3 min-[941px]:grid-cols-3 [&>div]:grid [&>div]:gap-0.5 [&>div]:rounded-card [&>div]:border [&>div]:border-line [&>div]:bg-card [&>div]:px-[18px] [&>div]:py-4 [&_b]:font-display [&_b]:font-semibold [&_span]:text-sm [&_span]:text-ink-2" aria-label="How it works">
        <div>
          <b>Drop any image</b>
          <span>A photo of a sketch, a blurry JPEG, a screenshot of a logo.</span>
        </div>
        <div>
          <b>We clean it up</b>
          <span>Compression smudges, stray specks and fuzzy edges are fixed automatically.</span>
        </div>
        <div>
          <b>Download the right file</b>
          <span>Pick print, website or cutting machine. We choose the format.</span>
        </div>
      </section>
    </div>
  )
}
