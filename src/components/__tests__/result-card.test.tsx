/**
 * With quality reporting off (no `quality` prop), the result card renders exactly as on main
 * @ 03b4148: hashes of its markup in each status were recorded by running this file there.
 */
import { createHash } from 'crypto'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ResultCard } from '../ResultCard'

const props = (status: 'working' | 'ready' | 'error') => ({
  status,
  headline: 'Your artwork is now a sharp vector',
  summary: '4 colors, clean edges, ready for print.',
  error: status === 'error' ? 'It failed' : null,
  onRetry: () => {},
  purpose: 'print' as const,
  onPurpose: () => {},
  chips: [{ color: 0x229e45, name: 'Green' }],
  onRemoveColor: () => {},
  fixNotes: [{ text: 'We cleaned up fuzzy edges.', undoLabel: 'Undo', onUndo: () => {} }],
  colorMode: null,
  transparent: false,
  transparentHint: 'No plain background found to remove',
  transparentLocked: true,
  onTransparent: () => {},
  downloads: null,
  onDownload: () => {},
  detail: 0.5,
  corners: 0.75,
  onDetail: () => {},
  onCorners: () => {},
  more: null,
})
const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16)

const MAIN: Record<string, string> = { working: '5419117f86a1fa29', ready: '2ae275f1e872669a', error: '9822bc4ea4955935' }

describe('result card without quality reporting matches main', () => {
  for (const status of ['working', 'ready', 'error'] as const)
    it(status, () => {
      const got = sha(renderToStaticMarkup(<ResultCard {...props(status)} />))
      if (process.env.PRINT_GOLDEN) console.log(`CARD ${status} ${got}`)
      expect(got).toBe(MAIN[status])
    })
})

describe('result card with quality reporting', () => {
  const quality = (autoCheck: 'no-known-problems' | 'problems-found', reviewed: boolean) => ({ autoCheck, reviewed, findings: autoCheck === 'problems-found' ? ['12 small details are missing.'] : [], onReview: () => {}, onUnreview: () => {} })
  it('shows the vector as created, the check and the review separately, never "Ready"', () => {
    const html = renderToStaticMarkup(<ResultCard {...props('ready')} summary="4 colors. Automatic checks found problems." quality={quality('problems-found', false)} />)
    expect(html).toContain('Vector created')
    expect(html).not.toMatch(/>Ready</)
    expect(html).toContain('Automatic check: problems found')
    expect(html).toContain('12 small details are missing.')
    expect(html).toContain('Artwork not reviewed yet')
    expect(html).toContain('Mark as reviewed')
  })
  it('says reviewed only when a person marked it, and never claims production approval', () => {
    const before = renderToStaticMarkup(<ResultCard {...props('ready')} quality={quality('no-known-problems', false)} />)
    const after = renderToStaticMarkup(<ResultCard {...props('ready')} quality={quality('no-known-problems', true)} />)
    expect(before).not.toContain('Artwork reviewed by you')
    expect(after).toContain('Artwork reviewed by you')
    for (const html of [before, after]) {
      expect(html).toContain('Not a production approval')
      expect(html).not.toMatch(/approved for production|production approved/i)
    }
  })
})
