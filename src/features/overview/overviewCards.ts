import type { GroupView, QueueStatus } from '../../domain/types'

export type OverviewCard = 'review' | 'events' | 'waiting' | 'decision'

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

export function matchesOverviewCard(group: GroupView, card: OverviewCard | null): boolean {
  if (card === null) return true
  if (card === 'events') return group.changes.length > 0
  return CARD_STATUSES[card].includes(group.status)
}

export function overviewCardCount(groups: GroupView[], card: OverviewCard): number {
  if (card === 'events') return groups.reduce((sum, group) => sum + group.changes.length, 0)
  return groups.filter((group) => matchesOverviewCard(group, card)).length
}
