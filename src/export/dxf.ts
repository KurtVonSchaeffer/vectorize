import { flatten, type ColorShape } from './path'

export interface DxfLayer {
  shape: ColorShape
  name: string
}

export interface DxfOptions {
  width: number
  height: number
  /** Output width in millimetres; height follows the aspect ratio. */
  widthMm?: number
}

/**
 * Writes an AutoCAD R12 DXF (the most widely accepted version for cutters, plotters and laser
 * software): one layer per color, every subpath as a closed POLYLINE in millimetres, y up.
 */
export function buildDxf(layers: DxfLayer[], opts: DxfOptions): string {
  const mm = (opts.widthMm ?? 200) / opts.width
  const n = (v: number) => (Math.round(v * 10000) / 10000).toString()
  const names = uniqueNames(layers.map((l) => l.name))
  const lines: string[] = []
  const g = (code: number, value: string | number) => lines.push(String(code), String(value))

  g(0, 'SECTION'); g(2, 'HEADER')
  g(9, '$ACADVER'); g(1, 'AC1009')
  g(9, '$INSUNITS'); g(70, 4)
  g(9, '$EXTMIN'); g(10, 0); g(20, 0)
  g(9, '$EXTMAX'); g(10, n(opts.width * mm)); g(20, n(opts.height * mm))
  g(0, 'ENDSEC')

  g(0, 'SECTION'); g(2, 'TABLES')
  g(0, 'TABLE'); g(2, 'LAYER'); g(70, names.length)
  names.forEach((name, i) => {
    g(0, 'LAYER'); g(2, name); g(70, 0); g(62, (i % 6) + 1); g(6, 'CONTINUOUS')
  })
  g(0, 'ENDTAB')
  g(0, 'ENDSEC')

  g(0, 'SECTION'); g(2, 'ENTITIES')
  layers.forEach((layer, li) => {
    for (const sp of layer.shape.subpaths) {
      const pts = flatten(sp, 0.05 / mm) // ≤ 0.05 mm chord error
      if (pts.length < 2) continue
      g(0, 'POLYLINE'); g(8, names[li]); g(66, 1); g(10, 0); g(20, 0); g(30, 0); g(70, sp.closed ? 1 : 0)
      for (const [x, y] of pts) {
        g(0, 'VERTEX'); g(8, names[li]); g(10, n(x * mm)); g(20, n((opts.height - y) * mm)); g(30, 0)
      }
      g(0, 'SEQEND'); g(8, names[li])
    }
  })
  g(0, 'ENDSEC')
  g(0, 'EOF')
  return lines.join('\n') + '\n'
}

/** DXF layer names: letters, digits, - and _ only, and unique. */
function uniqueNames(names: string[]): string[] {
  const seen = new Set<string>()
  return names.map((raw, i) => {
    let base = raw.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase() || `COLOR_${i + 1}`
    let name = base
    for (let k = 2; seen.has(name); k++) name = `${base}_${k}`
    seen.add(name)
    return name
  })
}
