// Checks that a download is a usable file (used by bench/real.html and bench/compare.html).

/** 'ok', or what's wrong with the file: SVG parses and renders; PDF is complete with fills; DXF has outlines; PNG is a PNG. */
export async function validate(label: string, blob: Blob): Promise<string> {
  if (!blob.size) return 'empty'
  const text = label === 'PNG' ? '' : await blob.text()
  if (label === 'SVG') {
    if (new DOMParser().parseFromString(text, 'image/svg+xml').querySelector('parsererror')) return 'does not parse'
    const url = URL.createObjectURL(blob)
    try {
      const img = new Image()
      img.src = url
      await img.decode()
    } catch {
      return 'does not render'
    } finally {
      URL.revokeObjectURL(url)
    }
  }
  if (label === 'PDF' && (!text.startsWith('%PDF-') || !text.trim().endsWith('%%EOF') || !/f\*/.test(text))) return 'incomplete'
  if (label === 'DXF' && (!text.includes('AC1009') || !/\nPOLYLINE\n/.test(text))) return 'no outlines'
  if (label === 'PNG') {
    const b = new Uint8Array(await blob.slice(0, 8).arrayBuffer())
    if (b[1] !== 0x50 || b[2] !== 0x4e || b[3] !== 0x47) return 'bad signature'
  }
  return 'ok'
}
