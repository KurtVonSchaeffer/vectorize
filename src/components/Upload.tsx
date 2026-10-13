import { useRef, useState } from 'react'

interface Props {
  onFile: (file: Blob, name: string) => void
  onExample: () => void
  loading: boolean
}

export function Upload({ onFile, onExample, loading }: Props) {
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)

  return (
    <div className="upload">
      <div
        className={`drop ${over ? 'over' : ''}`}
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
        <svg className="drop-icon" viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M24 31V11m0 0l-8 8m8-8l8 8" />
          <path d="M9 29v6a4 4 0 0 0 4 4h22a4 4 0 0 0 4-4v-6" />
        </svg>
        <h1>Turn any image into a clean vector</h1>
        <p>Drop a logo, sketch or graphic here. JPG, PNG, WebP, GIF or SVG.</p>
        <div className="drop-actions">
          <button className="btn-primary" onClick={() => input.current?.click()} disabled={loading}>
            {loading ? 'Opening…' : 'Choose image'}
          </button>
          <button className="btn-quiet" onClick={onExample} disabled={loading}>
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

      <section className="how" aria-label="How it works">
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
