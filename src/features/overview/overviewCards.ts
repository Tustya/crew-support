import type { QueueStatus } from '../../domain/types'

type CardGroup = { changes: unknown[]; status: QueueStatus }

export type OverviewCard = 'review' | 'events' | 'waiting' | 'decision'

export type QueueDateFilter = 'both' | 'today' | 'tomorrow' | 'all'

export type QueueFilterGroup = {
  status: QueueStatus
  localStayDate: string
  airportCode: string
  hotelName: string
  city: string
  crewNames: string[]
  changes: unknown[]
}

export type QueueFilter = {
  dates: QueueDateFilter
  today: string
  tomorrow: string
  airport: string
  query: string
  card: OverviewCard | null
}

const CARD_STATUSES: Record<Exclude<OverviewCard, 'events'>, QueueStatus[]> = {
  review: ['needs_review'],
  waiting: ['waiting', 'preparing'],
  decision: ['needs_decision', 'stale'],
}

type UnitForms = [one: string, few: string, many: string]

const GROUP_UNIT: UnitForms = ['группа', 'группы', 'групп']

export const OVERVIEW_CARDS: { id: OverviewCard; title: string; unit: UnitForms }[] = [
  { id: 'review', title: 'Проверить письма', unit: GROUP_UNIT },
  { id: 'events', title: 'Ещё не в письме', unit: ['изменение', 'изменения', 'изменений'] },
  { id: 'waiting', title: 'Ждут паузу', unit: GROUP_UNIT },
  { id: 'decision', title: 'Разобрать вручную', unit: GROUP_UNIT },
]

export function passesQueueFilter(group: QueueFilterGroup, filter: QueueFilter): boolean {
  if (filter.dates === 'today' && group.localStayDate !== filter.today) return false
  if (filter.dates === 'tomorrow' && group.localStayDate !== filter.tomorrow) return false
  if (filter.dates === 'both' && group.localStayDate !== filter.today && group.localStayDate !== filter.tomorrow) return false
  if (filter.airport !== 'all' && group.airportCode !== filter.airport) return false
  if (!matchesOverviewCard(group, filter.card)) return false
  const query = filter.query.trim().toLowerCase()
  if (!query) return true
  const haystack = `${group.hotelName} ${group.city} ${group.airportCode} ${group.crewNames.join(' ')}`.toLowerCase()
  return haystack.includes(query)
}

export function matchesOverviewCard(group: CardGroup, card: OverviewCard | null): boolean {
  if (card === null) return true
  if (card === 'events') return group.changes.length > 0
  return CARD_STATUSES[card].includes(group.status)
}

export function overviewCardCount(groups: CardGroup[], card: OverviewCard): number {
  if (card === 'events') return groups.reduce((sum, group) => sum + group.changes.length, 0)
  return groups.filter((group) => matchesOverviewCard(group, card)).length
}
