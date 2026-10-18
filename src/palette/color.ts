// Color conversions and CIEDE2000. Lab values are D50, matching how Pantone and Adobe swatch
// libraries specify spot colors; sRGB (D65) is chromatically adapted with Bradford.

export type RGB = [number, number, number]
export type Lab = [number, number, number]

export function hexToRgb(hex: string): RGB | null {
  const m = hex.trim().replace(/^#/, '')
  const full = m.length === 3 ? m.replace(/./g, '$&$&') : m
  if (!/^[0-9a-f]{6}$/i.test(full)) return null
  const n = parseInt(full, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

export function rgbToHex([r, g, b]: RGB): string {
  return '#' + [r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('').toUpperCase()
}

const toLinear = (c: number) => {
  c /= 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}
const fromLinear = (c: number) => 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)

// sRGB linear → XYZ D50 (sRGB matrix with Bradford D65→D50 adaptation folded in), and inverse.
const M = [
  [0.4360747, 0.3850649, 0.1430804],
  [0.2225045, 0.7168786, 0.0606169],
  [0.0139322, 0.0971045, 0.7141733],
]
const MI = [
  [3.1338561, -1.6168667, -0.4906146],
  [-0.9787684, 1.9161415, 0.033454],
  [0.0719453, -0.2289914, 1.4052427],
]
const WHITE = [0.96422, 1, 0.82521] // D50

const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116)
const fi = (t: number) => (t ** 3 > 216 / 24389 ? t ** 3 : (116 * t - 16) / (24389 / 27))

export function rgbToLab([r, g, b]: RGB): Lab {
  const lr = toLinear(r)
  const lg = toLinear(g)
  const lb = toLinear(b)
  const x = (M[0][0] * lr + M[0][1] * lg + M[0][2] * lb) / WHITE[0]
  const y = (M[1][0] * lr + M[1][1] * lg + M[1][2] * lb) / WHITE[1]
  const z = (M[2][0] * lr + M[2][1] * lg + M[2][2] * lb) / WHITE[2]
  const fx = f(x)
  const fy = f(y)
  const fz = f(z)
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}

export function labToRgb([L, a, b]: Lab): RGB {
  const fy = (L + 16) / 116
  const x = fi(fy + a / 500) * WHITE[0]
  const y = fi(fy) * WHITE[1]
  const z = fi(fy - b / 200) * WHITE[2]
  const rgb = MI.map((row) => fromLinear(row[0] * x + row[1] * y + row[2] * z))
  return rgb.map((v) => Math.round(Math.min(255, Math.max(0, v)))) as RGB
}

/** Naive CMYK → sRGB. Real conversion needs an ICC profile; good enough for matching. */
/** At most this CIEDE2000 from white counts as white: #FAFAFA (1.0) does, #F5F5F5 (2.0) doesn't. */
export const NEAR_WHITE_DE = 1.5
const WHITE_LAB = rgbToLab([255, 255, 255])

/**
 * Near-white (0xRRGGBB) becomes exact white: a white background or white lettering in a JPEG
 * averages to an off-white like #FBFCFC, which would print as a faint tint (or an extra plate)
 * instead of bare paper. Light greys and creams are further from white and stay.
 */
export function snapNearWhite(c: number): number {
  return deltaE2000(rgbToLab([(c >> 16) & 255, (c >> 8) & 255, c & 255]), WHITE_LAB) <= NEAR_WHITE_DE ? 0xffffff : c
}

export function cmykToRgb(c: number, m: number, y: number, k: number): RGB {
  return [255 * (1 - c) * (1 - k), 255 * (1 - m) * (1 - k), 255 * (1 - y) * (1 - k)]
}

const rad = Math.PI / 180

/** CIEDE2000 color difference. ~1 is barely noticeable; >5 is clearly different. */
export function deltaE2000(l1: Lab, l2: Lab): number {
  const [L1, a1, b1] = l1
  const [L2, a2, b2] = l2
  const C1 = Math.hypot(a1, b1)
  const C2 = Math.hypot(a2, b2)
  const Cb = (C1 + C2) / 2
  const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)))
  const a1p = (1 + G) * a1
  const a2p = (1 + G) * a2
  const C1p = Math.hypot(a1p, b1)
  const C2p = Math.hypot(a2p, b2)
  const h = (b: number, ap: number) => {
    if (b === 0 && ap === 0) return 0
    const v = Math.atan2(b, ap) / rad
    return v < 0 ? v + 360 : v
  }
  const h1p = h(b1, a1p)
  const h2p = h(b2, a2p)
  const dLp = L2 - L1
  const dCp = C2p - C1p
  let dhp = 0
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p
    if (dhp > 180) dhp -= 360
    else if (dhp < -180) dhp += 360
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * rad)
  const Lbp = (L1 + L2) / 2
  const Cbp = (C1p + C2p) / 2
  let hbp = h1p + h2p
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) > 180) hbp += h1p + h2p < 360 ? 360 : -360
    hbp /= 2
  }
  const T = 1 - 0.17 * Math.cos((hbp - 30) * rad) + 0.24 * Math.cos(2 * hbp * rad) + 0.32 * Math.cos((3 * hbp + 6) * rad) - 0.2 * Math.cos((4 * hbp - 63) * rad)
  const dTheta = 30 * Math.exp(-(((hbp - 275) / 25) ** 2))
  const Rc = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7))
  const Sl = 1 + (0.015 * (Lbp - 50) ** 2) / Math.sqrt(20 + (Lbp - 50) ** 2)
  const Sc = 1 + 0.045 * Cbp
  const Sh = 1 + 0.015 * Cbp * T
  const Rt = -Math.sin(2 * dTheta * rad) * Rc
  return Math.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh))
}
