import type { ChangeKind, QueueStatus } from './types'
import { plural } from './time'

export const KIND_LABEL: Record<ChangeKind, string> = {
  added: 'Добавление',
  cancelled: 'Отмена',
  arrival: 'Изменение прилёта',
  departure: 'Изменение вылета',
  flight: 'Рейс',
  room: 'Тип номера',
  hotel_change: 'Смена гостиницы',
  date_change: 'Смена даты',
}

export const STATUS_LABEL: Record<QueueStatus, string> = {
  unchanged: 'Без изменений',
  needs_baseline: 'Исходная не выбрана',
  waiting: 'Ожидание',
  preparing: 'Подготовка',
  needs_review: 'Требует проверки',
  reviewed: 'Проверено',
  handed_off: 'Передано',
  sent: 'Отправлено',
  stale: 'Устарело',
  needs_decision: 'Требует решения',
}

const STATUS_RANK: Record<QueueStatus, number> = {
  needs_decision: 0,
  needs_baseline: 1,
  stale: 2,
  needs_review: 3,
  reviewed: 4,
  preparing: 5,
  waiting: 6,
  handed_off: 7,
  sent: 8,
  unchanged: 9,
}

export function statusRank(status: QueueStatus): number {
  return STATUS_RANK[status]
}

export function summarizeChanges(kinds: ChangeKind[]): string {
  const buckets = new Map<string, number>()
  for (const kind of kinds) {
    const key =
      kind === 'arrival' || kind === 'departure' || kind === 'flight'
        ? 'delay'
        : kind === 'cancelled'
          ? 'cancel'
          : kind === 'added'
            ? 'add'
            : kind
    buckets.set(key, (buckets.get(key) ?? 0) + 1)
  }
  const parts: string[] = []
  const delay = buckets.get('delay') ?? 0
  const cancel = buckets.get('cancel') ?? 0
  const add = buckets.get('add') ?? 0
  if (delay) parts.push(plural(delay, 'задержка', 'задержки', 'задержек'))
  if (cancel) parts.push(plural(cancel, 'отмена', 'отмены', 'отмен'))
  if (add) parts.push(plural(add, 'новая заявка', 'новые заявки', 'новых заявок'))
  for (const [key, count] of buckets) {
    if (key === 'delay' || key === 'cancel' || key === 'add') continue
    parts.push(`${count} ${KIND_LABEL[key as ChangeKind].toLowerCase()}`)
  }
  return parts.join(', ')
}

export function summarizeKindCounts(kinds: ChangeKind[]): string {
  const counts = new Map<ChangeKind, number>()
  for (const kind of kinds) counts.set(kind, (counts.get(kind) ?? 0) + 1)
  return [...counts].map(([kind, count]) => (count === 1 ? KIND_LABEL[kind] : `${KIND_LABEL[kind]} · ${count}`)).join(', ')
}

const SOURCE_PROBLEM_LABEL: Record<string, string> = {
  SOURCE_UNAVAILABLE: 'Источник не ответил',
  SOURCE_NOT_READY: 'Данных ещё нет',
  SOURCE_STALE: 'Выгрузка устарела',
  SOURCE_NOT_TRUSTED: 'Последняя выгрузка не прошла проверку',
}

export function sourceProblemText(code: string): string {
  return SOURCE_PROBLEM_LABEL[code] ?? 'Источник недоступен'
}

export function actorLabel(role: 'specialist' | 'lead'): string {
  return role === 'lead' ? 'Руководитель' : 'Сменный специалист'
}
