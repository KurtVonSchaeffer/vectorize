import { describe, expect, it } from 'vitest'
import { adminModeOn } from '../../quality/flags'

describe('adminModeOn', () => {
  it('is on for an admin build, off for customers whatever the address says', () => {
    expect(adminModeOn('', { value: 'on', dev: false })).toBe(true)
    expect(adminModeOn('?admin=on', { value: undefined, dev: false })).toBe(false)
  })
  it('a preview build or the dev server can switch it on for one visit', () => {
    expect(adminModeOn('?admin=on', { value: 'preview', dev: false })).toBe(true)
    expect(adminModeOn('?admin=on', { value: undefined, dev: true })).toBe(true)
    expect(adminModeOn('', { value: 'preview', dev: false })).toBe(false)
  })
})
