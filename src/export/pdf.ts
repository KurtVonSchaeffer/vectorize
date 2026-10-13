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

  const spots = inks.map((ink, i) => (ink.spotName ? { key: `CS${i}`, name: pdfName(ink.spotName), color: ink.shape.color } : null))

  // Content stream: flip y (PDF origin is bottom-left), scale to points, fill each ink.
  let content = `q\n${f(s)} 0 0 ${f(-s)} 0 ${f(H)} cm\n`
  inks.forEach((ink, i) => {
    const spot = spots[i]
    content += spot ? `/${spot.key} cs 1 scn\n` : `${rgb(ink.shape.color)} rg\n`
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
  add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${f(W)} ${f(H)}] /Contents 4 0 R /Resources << /ColorSpace << ${csEntries} >> >> >>`)
  add(`<< /Length ${byteLength(content)} >>\nstream\n${content}endstream`)
  add(`<< /Title (${pdfString(opts.title ?? 'Vector artwork')}) /Producer (Vectorize) >>`)
  spots.forEach((sp) => {
    // Placeholder objects keep numbering aligned with ink indexes when some inks aren't spot.
    add(sp ? `[/Separation /${sp.name} /DeviceRGB << /FunctionType 2 /Domain [0 1] /C0 [1 1 1] /C1 [${rgb(sp.color)}] /N 1 >>]` : 'null')
  })

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
