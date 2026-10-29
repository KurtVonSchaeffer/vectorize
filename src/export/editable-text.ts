/**
 * Editable lettering: words that were rebuilt from a font (and only those) written as SVG text, so
 * they can be retyped in Illustrator, Inkscape or CorelDRAW. Each letter keeps its own position
 * (x per letter, one baseline, the fitted size), so the text lands on the artwork's letters when
 * the font is installed; without it, the program substitutes another font. Traced lettering, and
 * any word whose layout isn't complete, stays as outlines.
 */

export interface EditableText {
  svg: string
  /** Words written as text. */
  words: number
  /** Fonts the text needs, as named in the file (most specific name of each word). */
  fonts: string[]
}

const GROUP = /<g id="(Text_[^"]*)"([^>]*\sdata-font-size="[^"]*"[^>]*)>[\s\S]*?<\/g>/g

const attr = (attrs: string, name: string) => attrs.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1]
const unescapeAttr = (s: string) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
const escapeText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escapeAttr = (s: string) => escapeText(s).replace(/"/g, '&quot;')

/** The SVG with every rebuilt word that has a complete layout written as text. */
export function withEditableText(svg: string): EditableText {
  let words = 0
  const fonts = new Set<string>()
  const out = svg.replace(GROUP, (whole, id: string, attrs: string) => {
    const families = unescapeAttr(attr(attrs, 'data-font-family') ?? '').split('|').filter(Boolean)
    const chars = unescapeAttr(attr(attrs, 'data-chars') ?? '').split('|')
    const xs = (attr(attrs, 'data-x') ?? '').split(' ').filter(Boolean).map(Number)
    const size = Number(attr(attrs, 'data-font-size'))
    const baseline = Number(attr(attrs, 'data-baseline'))
    const color = attr(attrs, 'data-color')
    if (!families.length || !color || xs.length !== chars.length || !xs.length || !(size > 0) || ![...xs, baseline].every(Number.isFinite)) return whole
    words++
    fonts.add(families[0])
    const family = families.map((f) => `'${f.replace(/'/g, '')}'`).join(', ')
    const text =
      `<text x="${xs.join(' ')}" y="${baseline}" font-family="${escapeAttr(family)}" font-weight="${attr(attrs, 'data-font-weight') ?? 400}"` +
      ` font-style="${attr(attrs, 'data-font-style') ?? 'normal'}" font-size="${size}" fill="${color}" xml:space="preserve">${escapeText(chars.join(''))}</text>`
    return `<g id="${id}"${attrs}>\n${text}\n</g>`
  })
  return { svg: out, words, fonts: [...fonts] }
}
