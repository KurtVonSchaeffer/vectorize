import { DEFAULT_BRAND, type BrandSettings } from './brand'
import type { Palette } from './parse'

const KEY = 'vectorizer.palette.v1'

// Per-browser convenience only; the app works the same if storage is unavailable.
export function loadSavedPalette(): Palette | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const p = JSON.parse(raw) as Palette
    return Array.isArray(p?.swatches) && p.swatches.length ? p : null
  } catch {
    return null
  }
}

export function savePalette(p: Palette | null) {
  try {
    if (p) localStorage.setItem(KEY, JSON.stringify(p))
    else localStorage.removeItem(KEY)
  } catch {
    // Storage full or blocked: the palette just won't persist.
  }
}

const BRAND_KEY = 'vectorizer.brand.v1'

export function loadSavedBrand(): BrandSettings {
  try {
    const raw = localStorage.getItem(BRAND_KEY)
    if (!raw) return DEFAULT_BRAND
    const b = JSON.parse(raw) as BrandSettings
    return Array.isArray(b?.colors) ? { mode: b.mode ?? 'off', colors: b.colors } : DEFAULT_BRAND
  } catch {
    return DEFAULT_BRAND
  }
}

export function saveBrand(b: BrandSettings) {
  try {
    localStorage.setItem(BRAND_KEY, JSON.stringify(b))
  } catch {
    // Storage full or blocked: brand colors just won't persist.
  }
}
