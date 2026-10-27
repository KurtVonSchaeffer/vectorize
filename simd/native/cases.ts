// Native SIMD shootout (simd/native/README.md): the input images, and the file format the recorded
// blur calls are kept in. Every engine reads the same files.
import { existsSync, readFileSync } from 'node:fs'
import sharp from 'sharp'
import { circle, installImageData, paint, rect, regularStar, type RGB, type Shape } from '../../src/vectorize/__tests__/fidelity/harness'

export const DATA = new URL('./data/', import.meta.url)

/** One blur() call as the tracer made it: the arguments the kernel gets, plus sigma and box for blur() itself. */
export interface Call {
  sigma: number
  r: number
  x0: number
  x1: number
  y0: number
  y1: number
  by0: number
  by1: number
  /** blur()'s box argument, rebuilt so that blur() picks the same x0..x1, y0..y1. */
  box: [number, number, number, number]
  k: Float32Array
  src: Float32Array
}

export interface Recording {
  w: number
  h: number
  calls: Call[]
}

const local = (file: string) => new URL(`../../public/_tmp-check/${file}`, import.meta.url)

async function decode(file: string, scale = 1): Promise<ImageData> {
  installImageData()
  const bytes = readFileSync(local(file))
  let img = sharp(bytes).ensureAlpha()
  if (scale !== 1) {
    const meta = await sharp(bytes).metadata()
    img = img.resize(Math.round(meta.width! * scale), Math.round(meta.height! * scale), { kernel: 'lanczos3' })
  }
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true })
  return new ImageData(new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), info.width, info.height)
}

const NAVY: RGB = [31, 42, 92]
const PAPER: RGB = [255, 255, 255]

/** Concentric 1–2 px rings and hairline bars: thin outlines the fine-detail rule handles. */
function fineOutlines(): ImageData {
  const shapes: Shape[] = []
  for (const [r, sw] of [[180, 1], [150, 1.5], [120, 2], [90, 1], [60, 1.5]]) shapes.push({ rings: [circle(300, 220, r), circle(300, 220, r - sw, true)], color: NAVY })
  for (let i = 0; i < 12; i++) shapes.push({ rings: [rect(520 + i * 8, 60, 520 + i * 8 + 0.75 + (i % 3) * 0.5, 380)], color: [200, 30, 40] })
  return paint(680, 440, PAPER, shapes, 3)
}

/** A star over a band of eight close steps from orange to red (a stand-in for a gradient). */
function gradients(): ImageData {
  const shapes: Shape[] = []
  for (let i = 0; i < 24; i++) {
    const t = i / 23
    shapes.push({ rings: [rect(i * 30, 0, i * 30 + 30, 400)], color: [240, Math.round(140 - 110 * t), Math.round(20 * t)] })
  }
  shapes.push({ rings: [regularStar(360, 200, 150, 5)], color: NAVY })
  return paint(720, 400, null, shapes, 2)
}

/** Shapes in colours a few units apart, as in tone-on-tone logos. */
function similarColours(): ImageData {
  return paint(640, 400, [236, 238, 242], [
    { rings: [circle(200, 200, 150)], color: [222, 226, 234] },
    { rings: [regularStar(200, 200, 120, 6)], color: [210, 216, 228] },
    { rings: [rect(380, 60, 600, 340)], color: NAVY },
    { rings: [circle(490, 200, 90)], color: [38, 50, 104] },
    { rings: [regularStar(490, 200, 70, 8, 0.6)], color: [46, 58, 112] },
  ], 3)
}

const cover = (x: number, y: number, cx: number, cy: number, r: number) => Math.max(0, Math.min(1, r + 0.5 - Math.hypot(x + 0.5 - cx, y + 0.5 - cy)))

/** A JPEG-like three-colour badge with a thin ring and small strokes (as bench/profile.test.ts). */
function badge(w: number, h: number): ImageData {
  installImageData()
  const d = new Uint8ClampedArray(w * h * 4)
  let s = 7
  const noise = () => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5) * 10
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const a = cover(x, y, w / 2, h / 2, h * 0.3)
      const b = cover(x, y, w / 2, h / 2, h * 0.12)
      let c = [255, 248, 231].map((v, i) => v * (1 - a) + [43, 45, 66][i] * a)
      c = c.map((v, i) => v * (1 - b) + [240, 140, 0][i] * b)
      if (Math.abs(Math.hypot(x - w / 2, y - h / 2) - h * 0.25) < 0.6) c = [255, 248, 231]
      if (x % 23 < 2 && y > h * 0.8 && y < h * 0.9) c = [31, 42, 92]
      d.set([...c.map((v) => v + noise()), 255], (y * w + x) * 4)
    }
  return new ImageData(d, w, h)
}

/** Many small shapes, as text-heavy logos have (as bench/profile.test.ts). */
function lettering(w: number, h: number): ImageData {
  installImageData()
  const d = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const on = (x % 14 < 3 || y % 18 < 2) && x % 140 < 120 && y % 36 < 26
      d.set(on ? [31, 42, 92, 255] : [255, 255, 255, 255], (y * w + x) * 4)
    }
  return new ImageData(d, w, h)
}

/**
 * The shootout's inputs. Cases with a `file` use local logos (public/_tmp-check, not in the repo:
 * third-party artwork) and are skipped where it is missing, as on CI; the synthetic cases always run.
 */
export const CASES: { name: string; kind: string; file?: string; image: () => Promise<ImageData> }[] = [
  { name: 'tiny-text', kind: 'Barron logo at 50%: small lettering', file: 'barron-logo.png', image: () => decode('barron-logo.png', 0.5) },
  { name: 'fine-outlines', kind: 'Hairline rings and bars, 0.75–2 px', image: async () => fineOutlines() },
  { name: 'gradients', kind: 'Star over a 24-step orange-to-red band', image: async () => gradients() },
  { name: 'similar-colours', kind: 'Tone-on-tone shapes a few units apart', image: async () => similarColours() },
  { name: 'logo-small', kind: 'Amrod logo, 843×284', file: 'amrod-logo.png', image: () => decode('amrod-logo.png') },
  { name: 'illustration', kind: 'Gorilla illustration, 1200×750', file: 'gorilla.png', image: () => decode('gorilla.png') },
  { name: 'logo-large', kind: 'Barron logo, 2260×740', file: 'barron-logo.png', image: () => decode('barron-logo.png') },
  { name: 'very-large', kind: 'Barron logo at 200%, 4520×1480', file: 'barron-logo.png', image: () => decode('barron-logo.png', 2) },
  { name: 'badge-large', kind: 'Synthetic JPEG-like badge, 2000×1333', image: async () => badge(2000, 1333) },
  { name: 'lettering-large', kind: 'Synthetic lettering, 2260×740', image: async () => lettering(2260, 740) },
  { name: 'lettering-very-large', kind: 'Synthetic lettering, 4520×1480', image: async () => lettering(4520, 1480) },
]

/** The cases whose images are here. */
export const AVAILABLE = CASES.filter((c) => !c.file || existsSync(local(c.file)))

/*
 * File format (little-endian), data/<case>.bin:
 *   "BLR1", w i32, h i32, calls i32
 *   per call: sigma f64, r, x0, x1, y0, y1, by0, by1, bx0', bx1' (i32), k (2r+1 f32),
 *             src rows by0..by1 × columns bx0'..bx1' (f32); src is 0 everywhere else.
 * data/<case>.ref: the TypeScript blur's output per call, rows y0..y1 × columns x0..x1 (f32),
 * concatenated in call order; out is 0 everywhere else. Engines write their own outputs in the
 * same layout to out/<engine>/<case>.out.
 */
export function writeRecording(rec: Recording): Buffer {
  const parts: Buffer[] = []
  const head = Buffer.alloc(16)
  head.write('BLR1', 0, 'latin1')
  head.writeInt32LE(rec.w, 4)
  head.writeInt32LE(rec.h, 8)
  head.writeInt32LE(rec.calls.length, 12)
  parts.push(head)
  for (const c of rec.calls) {
    const b = Buffer.alloc(8 + 9 * 4)
    b.writeDoubleLE(c.sigma, 0)
    ;[c.r, c.x0, c.x1, c.y0, c.y1, c.by0, c.by1, c.box[0], c.box[2]].forEach((v, i) => b.writeInt32LE(v, 8 + i * 4))
    parts.push(b, Buffer.from(c.k.buffer, c.k.byteOffset, c.k.byteLength))
    const region = new Float32Array((c.by1 - c.by0 + 1) * (c.box[2] - c.box[0] + 1))
    let i = 0
    for (let y = c.by0; y <= c.by1; y++) for (let x = c.box[0]; x <= c.box[2]; x++) region[i++] = c.src[y * rec.w + x]
    parts.push(Buffer.from(region.buffer))
  }
  return Buffer.concat(parts)
}

export function readRecording(buf: Buffer): Recording {
  if (buf.toString('latin1', 0, 4) !== 'BLR1') throw new Error('not a BLR1 recording')
  const w = buf.readInt32LE(4), h = buf.readInt32LE(8), n = buf.readInt32LE(12)
  let o = 16
  const calls: Call[] = []
  for (let c = 0; c < n; c++) {
    const sigma = buf.readDoubleLE(o)
    const [r, x0, x1, y0, y1, by0, by1, bx0, bx1] = Array.from({ length: 9 }, (_, i) => buf.readInt32LE(o + 8 + i * 4))
    o += 44
    const k = new Float32Array(buf.buffer.slice(buf.byteOffset + o, buf.byteOffset + o + (2 * r + 1) * 4))
    o += k.byteLength
    const src = new Float32Array(w * h)
    const region = new Float32Array(buf.buffer.slice(buf.byteOffset + o, buf.byteOffset + o + (by1 - by0 + 1) * (bx1 - bx0 + 1) * 4))
    o += region.byteLength
    let i = 0
    for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) src[y * w + x] = region[i++]
    calls.push({ sigma, r, x0, x1, y0, y1, by0, by1, box: [bx0, by0, bx1, by1], k, src })
  }
  return { w, h, calls }
}

/** One output per call, from the out/ref layout (only the computed region is stored). */
export function readOutputs(buf: Buffer, rec: Recording): Float32Array[] {
  const all = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
  let o = 0
  return rec.calls.map((c) => {
    const out = new Float32Array(rec.w * rec.h)
    for (let y = c.y0; y <= c.y1; y++) {
      out.set(all.subarray(o, o + c.x1 - c.x0 + 1), y * rec.w + c.x0)
      o += c.x1 - c.x0 + 1
    }
    return out
  })
}

export function writeOutputs(outs: Float32Array[], rec: Recording): Buffer {
  const parts: Buffer[] = []
  rec.calls.forEach((c, i) => {
    for (let y = c.y0; y <= c.y1; y++) parts.push(Buffer.from(outs[i].slice(y * rec.w + c.x0, y * rec.w + c.x1 + 1).buffer))
  })
  return Buffer.concat(parts)
}
