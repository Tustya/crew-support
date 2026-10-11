import { describe, expect, it } from 'vitest'
import { defaultSettings } from '../../domain/templates'
import { selectGroups } from '../../domain/view'
import { loadScenario } from '../../fixtures/scenarios'
import { matchesOverviewCard } from './overviewCards'

describe('карточки обзора', () => {
  it('«Ещё не в письме» оставляет только группы с изменениями', () => {
    const groups = selectGroups(loadScenario('calm', defaultSettings(), 'specialist'))
    const filtered = groups.filter((group) => matchesOverviewCard(group, 'events'))
    expect(filtered.map((group) => group.key)).toEqual(['hotel-angel|SVX|2026-10-09'])
    expect(groups.length).toBeGreaterThan(filtered.length)
  })

  it('без выбранной карточки группа проходит', () => {
    const [group] = selectGroups(loadScenario('calm', defaultSettings(), 'specialist'))
    expect(group && matchesOverviewCard(group, null)).toBe(true)
  })
})
