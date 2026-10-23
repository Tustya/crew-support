import { describe, expect, it } from 'vitest'
import { defaultSettings } from '../../domain/templates'
import { selectGroups } from '../../domain/view'
import { loadScenario } from '../../fixtures/scenarios'
import { matchesOverviewCard, passesQueueFilter, type QueueFilterGroup } from './overviewCards'

describe('карточки обзора', () => {
  it('«Ещё не в письме» оставляет только группы с изменениями', () => {
    const groups = selectGroups(loadScenario('calm', defaultSettings(), 'specialist'))
    const filtered = groups.filter((group) => matchesOverviewCard(group, 'events'))
    expect(filtered.map((group) => group.key)).toEqual(['hotel-angel|SVX|2026-10-09'])
    expect(groups.length).toBeGreaterThan(filtered.length)
  })

  it('очередь сужается по дате, аэропорту и поиску и оставляет обработанные', () => {
    const groups: QueueFilterGroup[] = [
      queueGroup('waiting', '2026-10-23', 'SVX', 'Ангел'),
      queueGroup('handed_off', '2026-10-23', 'AER', 'Север'),
      queueGroup('waiting', '2026-10-24', 'AER', 'Юг'),
      queueGroup('needs_review', '2026-10-09', 'SVX', 'Старая'),
      queueGroup('handed_off', '2026-10-09', 'SVX', 'Берег'),
    ]
    const base = { dates: 'both' as const, today: '2026-10-23', tomorrow: '2026-10-24', airport: 'all', query: '', card: null }
    expect(groups.filter((group) => passesQueueFilter(group, base)).map((group) => group.hotelName)).toEqual(['Ангел', 'Север', 'Юг'])
    expect(groups.filter((group) => passesQueueFilter(group, { ...base, dates: 'all' })).map((group) => group.hotelName)).toEqual(['Ангел', 'Север', 'Юг', 'Старая', 'Берег'])
    expect(groups.filter((group) => passesQueueFilter(group, { ...base, dates: 'today' })).map((group) => group.hotelName)).toEqual(['Ангел', 'Север'])
    expect(groups.filter((group) => passesQueueFilter(group, { ...base, dates: 'tomorrow' })).map((group) => group.hotelName)).toEqual(['Юг'])
    expect(groups.filter((group) => passesQueueFilter(group, { ...base, airport: 'AER' })).map((group) => group.hotelName)).toEqual(['Север', 'Юг'])
    expect(groups.filter((group) => passesQueueFilter(group, { ...base, query: 'юг' })).map((group) => group.hotelName)).toEqual(['Юг'])
  })

  it('без выбранной карточки группа проходит', () => {
    const [group] = selectGroups(loadScenario('calm', defaultSettings(), 'specialist'))
    expect(group && matchesOverviewCard(group, null)).toBe(true)
  })
})

function queueGroup(status: QueueFilterGroup['status'], localStayDate: string, airportCode: string, hotelName: string): QueueFilterGroup {
  return { status, localStayDate, airportCode, hotelName, city: 'Город', crewNames: [hotelName], changes: [] }
}
