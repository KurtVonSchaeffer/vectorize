// Ground-truth diagnostic cases shared by the diagnose and assess pages: each isolates one kind of
// detail and is drawn from an exact SVG, so outputs can be measured against the original.
import { inkChange, type ColourFidelity, type RasterComparison } from '../src/quality/compare'
import { rasterizeSvg } from '../src/quality/render'
import { ARTWORK } from './artwork'

export interface Case {
  group: string
  name: string
  svg: string
  /** Input raster size (the truth SVG is drawn to fill it). */
  w: number
  h: number
  /** Transparent artwork: JPEG can't hold it, so only PNG input is meaningful. */
  pngOnly?: boolean
}

export const NAVY = '#1f2a5c'
export const svg = (w: number, h: number, body: string, bg: string | null = '#ffffff') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${bg ? `<rect width="${w}" height="${h}" fill="${bg}"/>` : ''}${body}</svg>`

export const CASES: Case[] = [
  // Text at a range of cap heights (Arial cap height ≈ 0.716 em, Georgia ≈ 0.692 em).
  ...[6, 8, 10, 12, 16, 24].map((cap) => ({
    group: 'text',
    name: `sans ${cap}px caps`,
    svg: svg(420, 4 * cap + 20, `<text x="10" y="${cap * 2 + 10}" font-family="Arial" font-weight="700" font-size="${(cap / 0.716).toFixed(2)}" fill="${NAVY}">Brand Studio 2026</text>`),
    w: 420,
    h: 4 * cap + 20,
  })),
  ...[8, 12, 16].map((cap) => ({
    group: 'text',
    name: `serif ${cap}px caps`,
    svg: svg(420, 4 * cap + 20, `<text x="10" y="${cap * 2 + 10}" font-family="Georgia" font-size="${(cap / 0.692).toFixed(2)}" fill="${NAVY}">Brand Studio 2026</text>`),
    w: 420,
    h: 4 * cap + 20,
  })),
  // Thin strokes: straight, diagonal and curved.
  ...[0.75, 1, 1.5, 2, 3].map((sw) => ({
    group: 'lines',
    name: `${sw}px strokes`,
    svg: svg(300, 150, `<g fill="none" stroke="${NAVY}" stroke-width="${sw}"><path d="M20 30H280"/><path d="M20 130L140 50"/><path d="M160 130Q220 20 280 130"/></g>`),
    w: 300,
    h: 150,
  })),
  // Dots of decreasing size.
  {
    group: 'dots',
    name: 'dots r 1–5px',
    svg: svg(300, 80, [1, 1.5, 2, 3, 5].map((r, i) => `<circle cx="${30 + i * 60}" cy="40" r="${r}" fill="${NAVY}"/>`).join('')),
    w: 300,
    h: 80,
  },
  // Corners: sharp star points, an acute triangle, a square, rounded rectangles.
  {
    group: 'corners',
    name: 'sharp and rounded corners',
    svg: svg(
      460,
      120,
      `<g fill="${NAVY}"><polygon points="60,10 71,45 108,45 78,67 89,102 60,80 31,102 42,67 12,45 49,45"/><polygon points="130,105 190,105 160,15"/><rect x="215" y="25" width="70" height="70"/><rect x="305" y="25" width="60" height="70" rx="12"/><rect x="385" y="25" width="60" height="70" rx="3"/></g>`,
    ),
    w: 460,
    h: 120,
  },
  // Adjacent colours of decreasing difference, plus a small accent.
  {
    group: 'colours',
    name: 'similar colours side by side',
    svg: svg(
      400,
      120,
      `<rect x="20" y="20" width="80" height="80" fill="#1c7ed6"/><rect x="100" y="20" width="80" height="80" fill="#2a86d9"/><rect x="200" y="20" width="80" height="80" fill="#e8402f"/><rect x="280" y="20" width="80" height="80" fill="#f0603f"/><rect x="370" y="55" width="6" height="6" fill="#f59f00"/>`,
    ),
    w: 400,
    h: 120,
  },
  // Gradients with detail on top.
  {
    group: 'gradients',
    name: 'gradient pill with text',
    svg: svg(
      420,
      160,
      `<defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#ec4899"/><stop offset="1" stop-color="#581c87"/></linearGradient></defs><rect x="20" y="30" width="380" height="100" rx="50" fill="url(#g)"/><text x="210" y="92" text-anchor="middle" font-family="Arial" font-weight="700" font-size="28" fill="#ffffff">GRADIENT</text>`,
    ),
    w: 420,
    h: 160,
  },
  {
    group: 'gradients',
    name: 'radial disc with thin ring',
    svg: svg(
      240,
      240,
      `<defs><radialGradient id="r"><stop offset="0" stop-color="#ffd43b"/><stop offset="1" stop-color="#e8590c"/></radialGradient></defs><circle cx="120" cy="120" r="100" fill="url(#r)"/><circle cx="120" cy="120" r="70" fill="none" stroke="#ffffff" stroke-width="2"/>`,
    ),
    w: 240,
    h: 240,
  },
  // The same logo with and without a background: tests transparent-PNG edges.
  ...([['on white', '#ffffff'], ['transparent', null]] as const).map(([label, bg]) => ({
    group: 'transparent',
    name: `logo ${label}`,
    svg: svg(300, 300, `<circle cx="150" cy="150" r="110" fill="#1c7ed6"/><circle cx="150" cy="150" r="60" fill="#ffffff"/><path d="M150 40L180 150L150 260L120 150Z" fill="#e8402f"/>`, bg),
    w: 300,
    h: 300,
    pngOnly: bg === null,
  })),
  // Low resolution: the badge at shrinking sizes.
  ...[120, 200, 300, 600].map((w) => ({ group: 'lowres', name: `badge ${w}px wide`, svg: ARTWORK.badge, w, h: Math.round((w * 2) / 3) })),
  { group: 'complex', name: 'scene', svg: ARTWORK.scene, w: 600, h: 400 },
]

export const pct = (v: number) => +(v * 100).toFixed(2)

/** Share of the truth's "ink" (pixels unlike its most common colour) lost or added. */
export function inkShare(truth: ImageData, r: RasterComparison) {
  const { missing, extra } = inkChange(truth.data, r)
  return { missingInk: pct(missing), extraInk: pct(extra) }
}

export const summary = (r: RasterComparison, truth: ImageData) => ({
  err: +r.meanError.toFixed(2),
  wrong: pct(r.tolerantWrongShare),
  edgeF1: +r.edgeF1.toFixed(3),
  ...inkShare(truth, r),
})

export const fidelity = (f: ColourFidelity) => ({ meanDE: +f.meanDeltaE.toFixed(2), maxDE: +f.maxDeltaE.toFixed(2), merged: f.merged, found: f.colours.length })

export async function input(c: Case, jpeg: number | null): Promise<Blob> {
  const truth = await rasterizeSvg(c.svg, c.w, c.h)
  const cv = new OffscreenCanvas(c.w, c.h)
  cv.getContext('2d')!.putImageData(truth, 0, 0)
  return cv.convertToBlob(jpeg !== null ? { type: 'image/jpeg', quality: jpeg } : { type: 'image/png' })
}

/** Extra cases for the improver (bench/assess.html?exp=improver) and the app parity check. */
export const VALIDATION: Case[] = [
  { group: 'validation', name: 'jpeg saved as png', svg: CASES.find((c) => c.name === 'badge 200px wide')!.svg, w: 200, h: 133 },
  {
    group: 'validation',
    name: 'small transparent logo with text',
    svg: svg(180, 120, `<circle cx="50" cy="60" r="36" fill="#0b7285"/><path d="M38 60l9 9 17-19" fill="none" stroke="#ffffff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/><text x="96" y="66" font-family="Arial" font-weight="700" font-size="17" fill="#0b7285">Check</text>`, null),
    w: 180,
    h: 120,
    pngOnly: true,
  },
  {
    group: 'validation',
    name: 'small gradient logo',
    svg: svg(220, 110, `<defs><linearGradient id="v" x1="0" x2="1"><stop offset="0" stop-color="#7048e8"/><stop offset="1" stop-color="#e64980"/></linearGradient></defs><rect x="10" y="20" width="70" height="70" rx="16" fill="url(#v)"/><text x="92" y="64" font-family="Arial" font-weight="700" font-size="20" fill="#343a40">Prism</text>`),
    w: 220,
    h: 110,
  },
  {
    group: 'validation',
    name: 'thin-line icon',
    svg: svg(96, 96, `<g fill="none" stroke="#212529" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="18" y="26" width="60" height="44" rx="6"/><path d="M18 36h60M30 52h16M30 60h24"/><circle cx="66" cy="56" r="6"/></g>`),
    w: 96,
    h: 96,
  },
  {
    group: 'validation',
    name: 'wordmark with tiny tagline',
    svg: svg(360, 120, `<text x="20" y="62" font-family="Georgia" font-size="40" fill="#1f2a5c">Harbour</text><text x="22" y="90" font-family="Arial" font-size="10" letter-spacing="1" fill="#495057">COFFEE · ROASTERS · EST 1998</text>`),
    w: 360,
    h: 120,
  },
]
