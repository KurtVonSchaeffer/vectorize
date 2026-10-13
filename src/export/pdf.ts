import type { GradientFill } from '../palette/gradients'
import type { ColorShape } from './path'

export interface PdfInk {
  shape: ColorShape
  /** Spot color name (e.g. a Pantone name); omitted inks are written as plain RGB. */
  spotName?: string
}

export interface PdfOptions {
  /** Artwork size in the shapes' coordinate units (source pixels). */
  width: number
  height: number
  /** Longest page side in points (72 pt = 1 inch). */
  pageSize?: number
  title?: string
}

/**
 * Writes a single-page PDF. Each ink with a spot name becomes a Separation color space, so a
 * printer's RIP produces one plate per ink with that name; its RGB value is only the on-screen
 * preview. Shapes are filled with the even-odd rule, matching the SVG.
 */
export function buildPdf(inks: PdfInk[], opts: PdfOptions): Uint8Array {
  const longest = opts.pageSize ?? 720
  const s = longest / Math.max(opts.width, opts.height)
  const W = opts.width * s
  const H = opts.height * s
  const f = (v: number) => (Math.round(v * 1000) / 1000).toString()
  const rgb = (c: number) => [(c >> 16) & 255, (c >> 8) & 255, c & 255].map((v) => f(v / 255)).join(' ')

  const spots = inks.map((ink, i) => (ink.spotName && !ink.shape.gradient ? { key: `CS${i}`, name: pdfName(ink.spotName), color: ink.shape.color } : null))
  // Gradients become shading patterns (full color; a gradient can't be one spot ink).
  const patterns = inks.map((ink, i) => (ink.shape.gradient ? { key: `P${i}`, body: shadingPattern(ink.shape.gradient, `[${f(s)} 0 0 ${f(-s)} 0 ${f(H)}]`, rgb, f) } : null))

  // Content stream: flip y (PDF origin is bottom-left), scale to points, fill each ink.
  let content = `q\n${f(s)} 0 0 ${f(-s)} 0 ${f(H)} cm\n`
  inks.forEach((ink, i) => {
    const spot = spots[i]
    const pattern = patterns[i]
    content += pattern ? `/Pattern cs /${pattern.key} scn\n` : spot ? `/${spot.key} cs 1 scn\n` : `${rgb(ink.shape.color)} rg\n`
    for (const sp of ink.shape.subpaths) {
      content += `${f(sp.start[0])} ${f(sp.start[1])} m\n`
      for (const g of sp.segs) {
        content += g.t === 'L' ? `${f(g.p[0])} ${f(g.p[1])} l\n` : `${f(g.c1[0])} ${f(g.c1[1])} ${f(g.c2[0])} ${f(g.c2[1])} ${f(g.p[0])} ${f(g.p[1])} c\n`
      }
      content += 'h\n'
    }
    content += 'f*\n'
  })
  content += 'Q\n'

  const objects: string[] = []
  const add = (body: string) => objects.push(body) // object number = index + 1
  add('<< /Type /Catalog /Pages 2 0 R >>')
  add('<< /Type /Pages /Kids [3 0 R] /Count 1 >>')
  const csEntries = spots.map((sp, i) => (sp ? `/${sp.key} ${6 + i} 0 R` : '')).filter(Boolean).join(' ')
  const patternBase = 6 + inks.length
  const patEntries = patterns.filter(Boolean).map((p, j) => `/${p!.key} ${patternBase + j} 0 R`).join(' ')
  add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${f(W)} ${f(H)}] /Contents 4 0 R /Resources << /ColorSpace << ${csEntries} >>${patEntries ? ` /Pattern << ${patEntries} >>` : ''} >> >>`)
  add(`<< /Length ${byteLength(content)} >>\nstream\n${content}endstream`)
  add(`<< /Title (${pdfString(opts.title ?? 'Vector artwork')}) /Producer (Vectorize) >>`)
  spots.forEach((sp) => {
    // Placeholder objects keep numbering aligned with ink indexes when some inks aren't spot.
    add(sp ? `[/Separation /${sp.name} /DeviceRGB << /FunctionType 2 /Domain [0 1] /C0 [1 1 1] /C1 [${rgb(sp.color)}] /N 1 >>]` : 'null')
  })

  for (const p of patterns) if (p) add(p.body)

  let out = '%PDF-1.4\n%âãÏÓ\n'
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(byteLength(out))
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = byteLength(out)
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const o of offsets) out += `${o.toString().padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return latin1(out)
}

/**
 * An axial or radial shading pattern for a gradient fill. Pattern space is the page's default
 * space, so `matrix` maps the artwork's pixels to points (as the content stream does). Stops
 * become a stitched function; the ends extend, as SVG's default "pad" does.
 */
function shadingPattern(g: GradientFill, matrix: string, rgb: (c: number) => string, f: (v: number) => string): string {
  const stops = [...g.stops]
  if (stops[0].offset > 0) stops.unshift({ offset: 0, color: stops[0].color })
  if (stops[stops.length - 1].offset < 1) stops.push({ offset: 1, color: stops[stops.length - 1].color })
  for (let i = 1; i < stops.length; i++) stops[i] = { ...stops[i], offset: Math.max(stops[i].offset, stops[i - 1].offset + 1e-4) }
  const pieces = stops.slice(1).map((st, i) => `<< /FunctionType 2 /Domain [0 1] /C0 [${rgb(stops[i].color)}] /C1 [${rgb(st.color)}] /N 1 >>`)
  const fn =
    pieces.length === 1
      ? pieces[0]
      : `<< /FunctionType 3 /Domain [0 1] /Functions [${pieces.join(' ')}] /Bounds [${stops.slice(1, -1).map((st) => f(Math.min(st.offset, 1 - 1e-4))).join(' ')}] /Encode [${pieces.map(() => '0 1').join(' ')}] >>`
  const shading =
    g.kind === 'linear'
      ? `<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [${f(g.x1)} ${f(g.y1)} ${f(g.x2)} ${f(g.y2)}] /Function ${fn} /Extend [true true] >>`
      : `<< /ShadingType 3 /ColorSpace /DeviceRGB /Coords [${f(g.cx)} ${f(g.cy)} 0 ${f(g.cx)} ${f(g.cy)} ${f(g.r)}] /Function ${fn} /Extend [true true] >>`
  return `<< /PatternType 2 /Shading ${shading} /Matrix ${matrix} >>`
}

/** PDF name object: printable ASCII except delimiters; everything else as #xx. */
function pdfName(name: string): string {
  return Array.from(new TextEncoder().encode(name))
    .map((b) => (b > 0x20 && b < 0x7f && !'#()<>[]{}/%'.includes(String.fromCharCode(b)) ? String.fromCharCode(b) : '#' + b.toString(16).padStart(2, '0')))
    .join('')
}

function pdfString(s: string): string {
  return s.replace(/[^\x20-\x7e]/g, '?').replace(/[\\()]/g, '\\$&')
}

// The file is written as Latin-1 bytes; content is ASCII apart from the binary-marker comment.
function byteLength(s: string): number {
  return s.length
}
function latin1(s: string): Uint8Array {
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff
  return out
}
