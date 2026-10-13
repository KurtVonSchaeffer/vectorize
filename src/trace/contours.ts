export type Point = [number, number]

/**
 * Marching squares: closed iso-contours of `field` at `level`, with sub-pixel positions from
 * linear interpolation. Sample (x, y) sits at the center of pixel (x, y), i.e. at coordinate
 * (x + 0.5, y + 0.5). The field is treated as 0 outside the image, so every contour closes.
 */
export function contours(field: Float32Array, w: number, h: number, level = 0.5): Point[][] {
  // Pad with a ring of zeros so contours touching the edge close around the image border.
  const W = w + 2
  const H = h + 2
  const f = new Float32Array(W * H)
  for (let y = 0; y < h; y++) f.set(field.subarray(y * w, y * w + w), (y + 1) * W + 1)

  // Edge ids: horizontal edge from sample (x,y) to (x+1,y) is 2*(y*W+x); vertical edge from
  // (x,y) to (x,y+1) is 2*(y*W+x)+1. Each crossed edge gets one interpolated point.
  const point = (edge: number): Point => {
    const cell = edge >> 1
    const x = cell % W
    const y = (cell / W) | 0
    const a = f[cell]
    const b = edge & 1 ? f[cell + W] : f[cell + 1]
    const t = (level - a) / (b - a)
    // -1 undoes the padding; +0.5 moves from sample index to pixel-center coordinates.
    return edge & 1 ? [x - 0.5, y + t - 0.5] : [x + t - 0.5, y - 0.5]
  }

  const next = new Map<number, number>()
  const link = (a: number, b: number) => {
    // Each edge point is shared by exactly two cells; store links in both directions.
    if (next.has(a)) next.set(-a - 1, b)
    else next.set(a, b)
    if (next.has(b)) next.set(-b - 1, a)
    else next.set(b, a)
  }

  for (let y = 0; y < H - 1; y++) {
    for (let x = 0; x < W - 1; x++) {
      const i = y * W + x
      const tl = f[i] >= level ? 8 : 0
      const tr = f[i + 1] >= level ? 4 : 0
      const br = f[i + W + 1] >= level ? 2 : 0
      const bl = f[i + W] >= level ? 1 : 0
      const c = tl | tr | br | bl
      if (c === 0 || c === 15) continue
      const top = 2 * i
      const bottom = 2 * (i + W)
      const left = 2 * i + 1
      const right = 2 * (i + 1) + 1
      switch (c) {
        case 1: case 14: link(left, bottom); break
        case 2: case 13: link(bottom, right); break
        case 3: case 12: link(left, right); break
        case 4: case 11: link(top, right); break
        case 6: case 9: link(top, bottom); break
        case 7: case 8: link(left, top); break
        case 5: case 10: {
          // Saddle: resolve by the cell-center average so the result is consistent.
          const center = (f[i] + f[i + 1] + f[i + W] + f[i + W + 1]) / 4 >= level
          if ((c === 5) === center) {
            link(left, top)
            link(bottom, right)
          } else {
            link(left, bottom)
            link(top, right)
          }
          break
        }
      }
    }
  }

  // Walk the links into closed loops.
  const visited = new Set<number>()
  const loops: Point[][] = []
  for (const start of next.keys()) {
    if (start < 0 || visited.has(start)) continue
    const loop: Point[] = []
    let prev = -1
    let cur = start
    while (!visited.has(cur)) {
      visited.add(cur)
      loop.push(point(cur))
      const a = next.get(cur)!
      const b = next.get(-cur - 1)
      const nxt = a !== prev ? a : b
      if (nxt === undefined) break
      prev = cur
      cur = nxt
    }
    if (loop.length >= 3) loops.push(loop)
  }
  return loops
}

/** Signed polygon area (shoelace). */
export function area(loop: Point[]): number {
  let s = 0
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) s += (loop[j][0] + loop[i][0]) * (loop[j][1] - loop[i][1])
  return s / 2
}
