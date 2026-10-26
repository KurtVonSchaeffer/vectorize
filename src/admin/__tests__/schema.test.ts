import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ASSET_TYPES, CONFIDENCE, RENDER_MODES, REVIEW_REASONS } from '../runs'

// The database schema is SQL the app never runs, so these checks keep it in step with what the app sends.
const sql = readFileSync(new URL('../../../db/migrations/001_vectoriser_init.sql', import.meta.url), 'utf8')

describe('the results database schema', () => {
  it('seeds every review reason the app offers', () => {
    for (const r of REVIEW_REASONS) expect(sql).toContain(`'${r.code}'`)
  })
  it('allows every outcome, band, kind and verdict the app records', () => {
    for (const v of ["'usable', 'touch-up', 'rejected'", "'simple', 'medium', 'complex'", "'flat', 'lineart', 'pixel', 'photo'", "'ready', 'check', 'not-suitable'"]) expect(sql).toContain(v)
  })
  it('allows every type of artwork the review panel offers, and stores texture and illustration per run', () => {
    expect(sql).toContain(`asset_type IN (${ASSET_TYPES.map((t) => `'${t.code}'`).join(', ')})`)
    for (const c of ['texture_share', 'is_illustration', 'v.asset_type']) expect(sql).toContain(c)
  })
  it('allows every confidence and render mode, and keeps the reviewed path count', () => {
    const list = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(', ')
    expect(sql).toContain(`confidence IN (${list(CONFIDENCE)})`)
    expect(sql).toContain(`final_mode IN (${list(RENDER_MODES)})`)
    for (const c of ['v.confidence', 'v.final_paths', 'v.final_mode']) expect(sql).toContain(c)
  })
  it('keeps the order links and the minutes range the review panel uses', () => {
    for (const c of ['logo_id', 'case_no', 'sales_order']) expect(sql).toContain(c)
    expect(sql).toContain('minutes_saved BETWEEN -240 AND 240')
  })
})
