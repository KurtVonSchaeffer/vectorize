// Ground-truth test artwork for quality benchmarking. Each is a real SVG, so the vectorizer's
// output can be compared against the exact original.

const star = (cx: number, cy: number, r: number, points = 5) =>
  Array.from({ length: points * 2 }, (_, i) => {
    const a = (Math.PI * i) / points - Math.PI / 2
    const rr = i % 2 ? r * 0.45 : r
    return `${(cx + rr * Math.cos(a)).toFixed(1)},${(cy + rr * Math.sin(a)).toFixed(1)}`
  }).join(' ')

export const ARTWORK: Record<string, string> = {
  logo: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 400">
    <rect width="600" height="400" fill="#ffffff"/>
    <circle cx="300" cy="200" r="150" fill="#1c7ed6"/>
    <circle cx="300" cy="200" r="70" fill="#ffffff"/>
    <circle cx="300" cy="200" r="35" fill="#e8402f"/>
  </svg>`,

  badge: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 400">
    <rect width="600" height="400" fill="#fff8e7"/>
    <polygon points="${star(300, 200, 170, 16)}" fill="#f08c00"/>
    <circle cx="300" cy="200" r="120" fill="#2b2d42"/>
    <circle cx="300" cy="200" r="108" fill="none" stroke="#fff8e7" stroke-width="4"/>
    <text x="300" y="190" font-family="Arial Black, Arial, sans-serif" font-weight="900" font-size="52" text-anchor="middle" fill="#fff8e7">BREW</text>
    <text x="300" y="235" font-family="Arial, sans-serif" font-weight="700" font-size="22" text-anchor="middle" fill="#f08c00" letter-spacing="4">EST. 2026</text>
    <polygon points="${star(230, 270, 12)}" fill="#f08c00"/>
    <polygon points="${star(300, 280, 12)}" fill="#f08c00"/>
    <polygon points="${star(370, 270, 12)}" fill="#f08c00"/>
  </svg>`,

  scene: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 400">
    <rect width="600" height="400" fill="#a5d8ff"/>
    <circle cx="470" cy="90" r="45" fill="#ffd43b"/>
    ${Array.from({ length: 12 }, (_, i) => {
      const a = (i / 12) * Math.PI * 2
      return `<line x1="${470 + 58 * Math.cos(a)}" y1="${90 + 58 * Math.sin(a)}" x2="${470 + 78 * Math.cos(a)}" y2="${90 + 78 * Math.sin(a)}" stroke="#ffd43b" stroke-width="5" stroke-linecap="round"/>`
    }).join('')}
    <path d="M0 260 L120 150 L210 230 L330 120 L470 250 L600 190 L600 400 L0 400 Z" fill="#7048e8"/>
    <path d="M330 120 L370 158 L345 150 L330 170 L312 152 L290 160 Z" fill="#ffffff"/>
    <path d="M0 320 Q150 270 300 315 T600 300 L600 400 L0 400 Z" fill="#37b24d"/>
    ${[60, 140, 420, 520].map((x, i) => `<rect x="${x - 5}" y="${300 + (i % 2) * 10}" width="10" height="35" fill="#5c3d2e"/><polygon points="${x},${230 + (i % 2) * 10} ${x - 28},${310 + (i % 2) * 10} ${x + 28},${310 + (i % 2) * 10}" fill="#2b8a3e"/>`).join('')}
    <path d="M40 60 q20 -20 40 0 q20 -20 40 0" fill="none" stroke="#343a40" stroke-width="3"/>
    <path d="M200 90 q12 -12 24 0 q12 -12 24 0" fill="none" stroke="#343a40" stroke-width="3"/>
    <rect x="250" y="330" width="100" height="50" rx="8" fill="#e03131"/>
    <text x="300" y="363" font-family="Arial, sans-serif" font-weight="700" font-size="20" text-anchor="middle" fill="#ffffff">CAMP</text>
  </svg>`,

  ink: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 400">
    <rect width="600" height="400" fill="#f4f1ea"/>
    <path d="M80 300 C120 120 220 80 300 200 S470 330 520 120" fill="none" stroke="#1a1a1a" stroke-width="9" stroke-linecap="round"/>
    <path d="M90 340 C200 310 380 370 510 330" fill="none" stroke="#1a1a1a" stroke-width="3" stroke-linecap="round"/>
    <circle cx="160" cy="130" r="40" fill="none" stroke="#1a1a1a" stroke-width="5"/>
    <path d="M400 70 l20 40 l-40 0 z" fill="#1a1a1a"/>
    <text x="300" y="60" font-family="Georgia, serif" font-style="italic" font-size="34" text-anchor="middle" fill="#1a1a1a">Sketchbook</text>
  </svg>`,
}

/** Renders an SVG string to ImageData at the given size. */
export async function rasterize(svg: string, width: number, height: number): Promise<ImageData> {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    const c = new OffscreenCanvas(width, height)
    const g = c.getContext('2d', { willReadFrequently: true })!
    g.fillStyle = '#ffffff'
    g.fillRect(0, 0, width, height)
    g.drawImage(img, 0, 0, width, height)
    return g.getImageData(0, 0, width, height)
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** Simulates a typical upload: downscaled and JPEG-compressed. */
export async function degrade(svg: string, width: number, height: number, quality = 0.75): Promise<Blob> {
  const data = await rasterize(svg, width, height)
  const c = new OffscreenCanvas(width, height)
  c.getContext('2d')!.putImageData(data, 0, 0)
  return c.convertToBlob({ type: 'image/jpeg', quality })
}

export interface Score {
  /** Mean per-pixel RGB error against the ground truth (0–255 scale). */
  meanError: number
  /** Share of pixels that are clearly wrong (error > 48). */
  wrongPixels: number
  paths: number
  /** Total curve/line segments: a proxy for how clean (simple) the geometry is. */
  segments: number
  kb: number
}

export async function score(outputSvg: string, truthSvg: string, width = 1200, height = 800): Promise<Score> {
  const [a, b] = await Promise.all([rasterize(outputSvg, width, height), rasterize(truthSvg, width, height)])
  let sum = 0
  let wrong = 0
  for (let i = 0; i < a.data.length; i += 4) {
    const e = (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2])) / 3
    sum += e
    if (e > 48) wrong++
  }
  const n = a.data.length / 4
  return {
    meanError: +(sum / n).toFixed(2),
    wrongPixels: +((wrong / n) * 100).toFixed(2),
    paths: (outputSvg.match(/<path\b/g) ?? []).length,
    segments: (outputSvg.match(/[CLQ]/g) ?? []).length,
    kb: +(new Blob([outputSvg]).size / 1024).toFixed(1),
  }
}
