import { cmykToRgb, hexToRgb, labToRgb, rgbToLab, type Lab, type RGB } from './color'

export interface Swatch {
  name: string
  rgb: RGB
  lab: Lab
}

export interface Palette {
  name: string
  swatches: Swatch[]
}

function swatch(name: string, rgb: RGB, lab?: Lab): Swatch {
  const r = rgb.map((v) => Math.round(Math.min(255, Math.max(0, v)))) as RGB
  return { name: name.trim(), rgb: r, lab: lab ?? rgbToLab(r) }
}

function fromLab(name: string, lab: Lab): Swatch {
  return swatch(name, labToRgb(lab), lab)
}

export async function parsePaletteFile(file: File): Promise<Palette> {
  const name = file.name.replace(/\.[^.]+$/, '')
  const ext = file.name.split('.').pop()?.toLowerCase()
  let swatches: Swatch[]
  if (ext === 'ase') swatches = parseAse(await file.arrayBuffer())
  else if (ext === 'json') swatches = parseJson(await file.text())
  else swatches = parseCsv(await file.text())

  // Drop duplicates by name; libraries sometimes repeat swatches across groups.
  const seen = new Set<string>()
  swatches = swatches.filter((s) => s.name && !seen.has(s.name) && seen.add(s.name))
  if (!swatches.length) throw new Error(`No colors found in "${file.name}".`)
  return { name, swatches }
}

/**
 * Adobe Swatch Exchange (binary, big-endian). Handles RGB, LAB, CMYK and Gray entries; group
 * markers are skipped. Lab L is stored as 0–1.
 */
export function parseAse(buf: ArrayBuffer): Swatch[] {
  const v = new DataView(buf)
  if (v.byteLength < 12 || String.fromCharCode(v.getUint8(0), v.getUint8(1), v.getUint8(2), v.getUint8(3)) !== 'ASEF') {
    throw new Error('Not an Adobe Swatch Exchange (.ase) file.')
  }
  const blocks = v.getUint32(8)
  const out: Swatch[] = []
  let p = 12
  for (let i = 0; i < blocks && p + 6 <= v.byteLength; i++) {
    const type = v.getUint16(p)
    const len = v.getUint32(p + 2)
    const start = p + 6
    p = start + len
    if (type !== 0x0001) continue
    let q = start
    const nameLen = v.getUint16(q)
    q += 2
    let name = ''
    for (let c = 0; c < nameLen; c++, q += 2) {
      const code = v.getUint16(q)
      if (code) name += String.fromCharCode(code)
    }
    const model = String.fromCharCode(v.getUint8(q), v.getUint8(q + 1), v.getUint8(q + 2), v.getUint8(q + 3))
    q += 4
    const f = (k: number) => v.getFloat32(q + k * 4)
    if (model === 'RGB ') out.push(swatch(name, [f(0) * 255, f(1) * 255, f(2) * 255]))
    else if (model === 'LAB ') out.push(fromLab(name, [f(0) * 100, f(1), f(2)]))
    else if (model === 'CMYK') out.push(swatch(name, cmykToRgb(f(0), f(1), f(2), f(3))))
    else if (model === 'Gray') out.push(swatch(name, [f(0) * 255, f(0) * 255, f(0) * 255]))
  }
  return out
}

/**
 * JSON: an array of { name, hex } / { name, rgb: [r,g,b] } / { name, lab: [L,a,b] },
 * or an object mapping names to hex strings.
 */
export function parseJson(text: string): Swatch[] {
  const data = JSON.parse(text)
  const entries: unknown[] = Array.isArray(data) ? data : Object.entries(data).map(([name, hex]) => ({ name, hex }))
  const out: Swatch[] = []
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue
    const o = e as Record<string, unknown>
    const name = String(o.name ?? o.title ?? '')
    if (Array.isArray(o.lab)) out.push(fromLab(name, o.lab.map(Number) as Lab))
    else if (Array.isArray(o.rgb)) out.push(swatch(name, o.rgb.map(Number) as RGB))
    else if (typeof o.hex === 'string' || typeof o.color === 'string') {
      const rgb = hexToRgb(String(o.hex ?? o.color))
      if (rgb) out.push(swatch(name, rgb))
    }
  }
  return out
}

/**
 * CSV / TSV / plain text. One swatch per line: a name plus either a hex color or three numbers.
 * Three numbers are read as Lab when the header says so (L, a, b) or a value is negative,
 * otherwise as RGB 0–255.
 */
export function parseCsv(text: string): Swatch[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim())
  if (!lines.length) return []
  const split = (l: string) => l.split(/[,;\t]/).map((c) => c.trim().replace(/^"(.*)"$/, '$1'))
  const header = split(lines[0]).map((c) => c.toLowerCase())
  const hasHeader = header.some((c) => ['name', 'hex', 'l', 'r', 'lab', 'rgb', 'color'].includes(c))
  const labHeader = hasHeader && header.includes('l') && header.includes('a') && header.includes('b')
  const out: Swatch[] = []
  for (const line of hasHeader ? lines.slice(1) : lines) {
    const cols = split(line)
    const hex = cols.find((c) => /^#?[0-9a-f]{6}$/i.test(c) || /^#[0-9a-f]{3}$/i.test(c))
    const nums = cols.filter((c) => c !== '' && !isNaN(Number(c))).map(Number)
    const name = cols.find((c) => c !== hex && isNaN(Number(c))) ?? cols[0]
    if (hex) {
      out.push(swatch(name, hexToRgb(hex)!))
    } else if (nums.length >= 3) {
      const [x, y, z] = nums.slice(-3)
      if (labHeader || y < 0 || z < 0) out.push(fromLab(name, [x, y, z]))
      else out.push(swatch(name, [x, y, z]))
    }
  }
  return out
}
