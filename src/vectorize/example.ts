const star = (cx: number, cy: number, r: number, n: number, inner = 0.45) =>
  Array.from({ length: n * 2 }, (_, i) => {
    const a = (Math.PI * i) / n - Math.PI / 2
    const rr = i % 2 ? r * inner : r
    return `${(cx + rr * Math.cos(a)).toFixed(1)},${(cy + rr * Math.sin(a)).toFixed(1)}`
  }).join(' ')

const BADGE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 400">
  <rect width="600" height="400" fill="#fff8e7"/>
  <polygon points="${star(300, 200, 170, 16)}" fill="#f08c00"/>
  <circle cx="300" cy="200" r="120" fill="#2b2d42"/>
  <circle cx="300" cy="200" r="108" fill="none" stroke="#fff8e7" stroke-width="4"/>
  <text x="300" y="190" font-family="Arial Black, Arial, sans-serif" font-weight="900" font-size="52" text-anchor="middle" fill="#fff8e7">BREW</text>
  <text x="300" y="235" font-family="Arial, sans-serif" font-weight="700" font-size="22" text-anchor="middle" fill="#f08c00" letter-spacing="4">EST. 2026</text>
  ${[230, 300, 370].map((x, i) => `<polygon points="${star(x, i === 1 ? 280 : 270, 12, 5)}" fill="#f08c00"/>`).join('')}
</svg>`

/** A realistic upload: a small badge logo saved as a compressed JPEG. */
export async function exampleImage(): Promise<Blob> {
  const url = URL.createObjectURL(new Blob([BADGE], { type: 'image/svg+xml' }))
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    const c = new OffscreenCanvas(600, 400)
    c.getContext('2d')!.drawImage(img, 0, 0, 600, 400)
    return await c.convertToBlob({ type: 'image/jpeg', quality: 0.75 })
  } finally {
    URL.revokeObjectURL(url)
  }
}
