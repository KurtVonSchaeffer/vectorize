import { useEffect, useMemo, useRef, useState } from 'react'
import { cx, spinner } from './ui'

interface Props {
  originalUrl: string
  svg: string | null
  width: number
  height: number
  /** Shown over the artwork while work is in progress. */
  busy: string | null
}

const ZOOMS = [1, 2, 4]
const LAYER = 'absolute inset-0 size-full max-w-none object-contain select-none [-webkit-user-drag:none]'
const LABEL = 'pointer-events-none absolute top-3 rounded-full bg-[rgb(18_20_24/0.72)] px-2.5 py-1 text-xs font-semibold text-white'

export function Compare({ originalUrl, svg, width, height, busy }: Props) {
  const [split, setSplit] = useState(50)
  const [zoom, setZoom] = useState(1)
  const art = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)

  const svgUrl = useMemo(() => (svg ? URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' })) : null), [svg])
  useEffect(() => () => {
    if (svgUrl) URL.revokeObjectURL(svgUrl)
  }, [svgUrl])

  const move = (clientX: number) => {
    const r = art.current!.getBoundingClientRect()
    setSplit(Math.min(100, Math.max(0, ((clientX - r.left) / r.width) * 100)))
  }

  return (
    <div className="grid gap-2.5 rounded-card border border-line bg-card p-3.5">
      <div className="relative grid max-h-[min(72vh,820px)] place-items-start justify-items-center overflow-auto rounded-[10px]">
        <div
          ref={art}
          className={cx('checkerboard relative flex-none cursor-ew-resize touch-none', zoom === 1 ? 'max-w-full min-w-0' : 'max-w-none min-w-full')}
          style={{ width: `${zoom * 100}%`, aspectRatio: `${width} / ${height}` }}
          role="slider"
          aria-label="Compare your image with the vector"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(split)}
          tabIndex={0}
          onPointerDown={(e) => {
            dragging.current = true
            e.currentTarget.setPointerCapture(e.pointerId)
            move(e.clientX)
          }}
          onPointerMove={(e) => dragging.current && move(e.clientX)}
          onPointerUp={() => (dragging.current = false)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') setSplit((s) => Math.max(0, s - 5))
            if (e.key === 'ArrowRight') setSplit((s) => Math.min(100, s + 5))
          }}
        >
          <img className={LAYER} src={originalUrl} alt="Your image" draggable={false} />
          {svgUrl && <img className={cx(LAYER, 'checkerboard')} src={svgUrl} alt="Vector result" draggable={false} style={{ clipPath: `inset(0 0 0 ${split}%)` }} />}
          <div className="pointer-events-none absolute inset-y-0 -ml-[1.5px] w-[3px] bg-card shadow-[0_0_0_1px_rgb(0_0_0/0.18)]" style={{ left: `${split}%` }}>
            <span className="absolute top-1/2 left-1/2 grid size-10 -translate-1/2 place-items-center rounded-full bg-card text-ink shadow-[0_4px_14px_rgb(0_0_0/0.25)]">
              <svg className="size-5" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="M7 5l-4 5 4 5M13 5l4 5-4 5" />
              </svg>
            </span>
          </div>
          <span className={cx(LABEL, 'left-3')}>Your image</span>
          <span className={cx(LABEL, 'right-3')}>Vector</span>
        </div>
        {busy && (
          <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-2.5 whitespace-nowrap rounded-full border border-line bg-card px-4 py-2 text-sm font-semibold shadow-[0_6px_20px_rgb(0_0_0/0.15)]" role="status">
            <span className={spinner} aria-hidden="true" />
            {busy}
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2.5 text-[13px] text-ink-2">
        <span>Drag the handle to compare. Zoom in to check edges.</span>
        <span className="inline-flex rounded-lg border border-line p-0.5" role="group" aria-label="Zoom">
          {ZOOMS.map((z) => (
            <button key={z} className="rounded-md px-2.5 py-1 text-[13px] font-semibold text-ink-2 aria-pressed:bg-ink aria-pressed:text-card" aria-pressed={zoom === z} onClick={() => setZoom(z)}>
              {z === 1 ? 'Fit' : `${z}×`}
            </button>
          ))}
        </span>
      </div>
    </div>
  )
}
