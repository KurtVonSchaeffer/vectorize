import { useEffect, useMemo, useRef, useState } from 'react'

interface Props {
  originalUrl: string
  svg: string | null
  width: number
  height: number
  /** Shown over the artwork while work is in progress. */
  busy: string | null
}

const ZOOMS = [1, 2, 4]

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
    <div className="preview">
      <div className="viewport">
        <div
          ref={art}
          className="art"
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
          <img className="layer" src={originalUrl} alt="Your image" draggable={false} />
          {svgUrl && <img className="layer vector" src={svgUrl} alt="Vector result" draggable={false} style={{ clipPath: `inset(0 0 0 ${split}%)` }} />}
          <div className="handle" style={{ left: `${split}%` }}>
            <span>
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="M7 5l-4 5 4 5M13 5l4 5-4 5" />
              </svg>
            </span>
          </div>
          <span className="label l">Your image</span>
          <span className="label r">Vector</span>
        </div>
        {busy && (
          <div className="busy" role="status">
            <span className="spinner" aria-hidden="true" />
            {busy}
          </div>
        )}
      </div>
      <div className="zoomrow">
        <span>Drag the handle to compare. Zoom in to check edges.</span>
        <span className="zooms" role="group" aria-label="Zoom">
          {ZOOMS.map((z) => (
            <button key={z} aria-pressed={zoom === z} onClick={() => setZoom(z)}>
              {z === 1 ? 'Fit' : `${z}×`}
            </button>
          ))}
        </span>
      </div>
    </div>
  )
}
