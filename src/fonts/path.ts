/** Scales every coordinate of an absolute path (as opentype.js writes them). */
export function scalePath(d: string, k: number): string {
  return d.replace(/-?\d*\.?\d+(?:e-?\d+)?/g, (n) => String(+(Number(n) * k).toFixed(2)))
}
