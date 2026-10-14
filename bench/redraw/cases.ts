// Test set for the redraw proof of concept: geometric logos with exact originals (made for this
// test, not customer artwork). Each is damaged into a realistic upload by the page (shrunk,
// blurred, saved as JPEG), so the redraw can be scored against the design it should recover.

export interface RedrawCase {
  name: string
  /** What the case exercises. */
  tests: string
  svg: string
}

const svg = (body: string, w = 600, h = 600) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="#FFFFFF"/>${body}</svg>`

/** Lens where two circles of radius r, centres (x1,y) and (x2,y), overlap. */
function lens(x1: number, x2: number, y: number, r: number): string {
  const d = x2 - x1
  const hx = x1 + d / 2
  const hy = Math.sqrt(r * r - (d / 2) ** 2)
  return `M${hx} ${y - hy}A${r} ${r} 0 0 1 ${hx} ${y + hy}A${r} ${r} 0 0 1 ${hx} ${y - hy}Z`
}

export const REDRAW_CASES: RedrawCase[] = [
  { name: 'ring-and-bar', tests: 'concentric circles, a straight bar crossing them', svg: svg('<path d="M300 120a180 180 0 1 0 0.01 0zM300 190a110 110 0 1 1 -0.01 0z" fill="#1B3A8C" fill-rule="evenodd"/><rect x="80" y="270" width="440" height="60" fill="#E2231A"/>') },
  { name: 'star-badge', tests: 'rounded square, regular star, symmetry', svg: svg('<rect x="90" y="90" width="420" height="420" rx="70" fill="#0F8A7E"/><path d="M300 150L335.3 251.4L442.7 253.6L357.1 318.6L388.2 421.4L300 360L211.8 421.4L242.9 318.6L157.3 253.6L264.7 251.4Z" fill="#FFFFFF"/>') },
  { name: 'chevrons', tests: 'straight edges at 45°, mirror symmetry, equal shapes', svg: svg('<path d="M120 150L300 330L480 150L480 250L300 430L120 250Z" fill="#6B2BB5"/><path d="M120 330L300 510L480 330L480 400L300 580L120 400Z" fill="#F29F05"/>') },
  { name: 'shield', tests: 'lines meeting arcs, a centre stripe, symmetry', svg: svg('<path d="M140 100H460V300A160 200 0 0 1 300 520A160 200 0 0 1 140 300Z" fill="#B3122E"/><rect x="270" y="100" width="60" height="420" fill="#F5C518"/>') },
  { name: 'target', tests: 'three concentric rings, equal widths', svg: svg('<circle cx="300" cy="300" r="240" fill="#222222"/><circle cx="300" cy="300" r="170" fill="#FFFFFF"/><circle cx="300" cy="300" r="100" fill="#E63946"/><circle cx="300" cy="300" r="40" fill="#FFFFFF"/>') },
  { name: 'hexagon', tests: 'regular hexagon, inner triangle, 60° and 120° corners', svg: svg('<path d="M300 70L499.2 185V415L300 530L100.8 415V185Z" fill="#2A9D8F"/><path d="M300 190L400 363.2H200Z" fill="#FFFFFF"/>') },
  { name: 'arc-mark', tests: 'thick 270° arc with square ends, a separate dot', svg: svg('<path d="M300 110A190 190 0 1 1 110 300H180A120 120 0 1 0 300 180Z" fill="#0077B6"/><circle cx="160" cy="160" r="45" fill="#F77F00"/>') },
  { name: 'venn', tests: 'two overlapping circles with a third colour where they overlap', svg: svg(`<circle cx="230" cy="300" r="160" fill="#3A86FF"/><circle cx="370" cy="300" r="160" fill="#FFBE0B"/><path d="${lens(230, 370, 300, 160)}" fill="#2D6A4F"/>`) },
  { name: 'leaf', tests: 'two equal arcs meeting at points, a straight stem', svg: svg('<path d="M300 80A260 260 0 0 1 300 460A260 260 0 0 1 300 80Z" fill="#38B000"/><rect x="290" y="440" width="20" height="100" fill="#5C3D2E"/>') },
  { name: 'speech-bubble', tests: 'rounded rectangle joined by a straight-edged tail', svg: svg('<path d="M150 120H450A50 50 0 0 1 500 170V350A50 50 0 0 1 450 400H260L170 480L190 400H150A50 50 0 0 1 100 350V170A50 50 0 0 1 150 120Z" fill="#7209B7"/><rect x="170" y="200" width="260" height="30" fill="#FFFFFF"/><rect x="170" y="280" width="180" height="30" fill="#FFFFFF"/>') },
]
