import { describe, expect, it } from 'vitest'
import { STATUS_LABEL, summarizeKindCounts } from './labels'

describe('status labels', () => {
  it('names a missing baseline in plain language', () => {
    expect(STATUS_LABEL.needs_baseline).toBe('Исходная не выбрана')
    expect(STATUS_LABEL.needs_baseline.toLowerCase()).not.toContain('база')
  })

  it('counts repeated change kinds instead of listing each one', () => {
    expect(summarizeKindCounts(['arrival', 'arrival', 'arrival', 'departure', 'departure'])).toBe('Изменение прилёта · 3, Изменение вылета · 2')
  })
})
