import { beforeAll, describe, expect, it } from 'vitest'
import { flattenOnWhite } from '../check'
import { assessFidelity } from '../fidelity'
import { circle, installImageData, paint, rect, renderSvg, vectorize } from '../../vectorize/__tests__/fidelity/harness'

beforeAll(installImageData)

const NAVY: [number, number, number] = [25, 29, 99]

describe('checking a vector whose white background was removed', () => {
  // A navy mark with white counters on white paper: removing the background also opens the
  // counters (same colour), which looks the same on white but not to a check that sees alpha.
  const upload = paint(160, 120, [255, 255, 255], [
    { rings: [rect(20, 20, 140, 100)], color: NAVY },
    { rings: [circle(55, 60, 14)], color: [255, 255, 255] },
    { rings: [circle(105, 60, 14)], color: [255, 255, 255] },
    { rings: [rect(30, 30, 36, 90)], color: [255, 255, 255] },
  ])
  const { svg } = vectorize(upload, (o) => ({ ...o, transparent: true }))

  it('as drawn (transparent), white areas count as lost detail', () => {
    const report = assessFidelity(upload, renderSvg(svg, upload.width, upload.height), svg)
    expect(report.features.lost).toBeGreaterThan(0)
  }, 60_000)

  it('flattened on white, as it prints on paper, nothing is lost', () => {
    const vector = renderSvg(svg, upload.width, upload.height)
    flattenOnWhite(vector)
    const report = assessFidelity(upload, vector, svg)
    expect(report.features.lost).toBe(0)
    expect(report.issues.map((i) => i.id)).not.toContain('lost-detail')
  }, 60_000)
})
