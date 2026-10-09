import { applyDetectedTimes, diffBookings, fingerprintBookings, linkCrossGroupMoves, replayDiffs } from './diff'
import { recipientKey } from './email'
import { mskDate, nextDate } from './time'
import type { Booking, ChangeEvent, DemoData, Draft, GroupException, GroupView, Hotel, QueueStatus, Snapshot } from './types'

export function latestSnapshot(data: DemoData): Snapshot | null {
  const series = data.snapshots.filter((snapshot) => snapshot.seriesId === data.seriesId)
  if (series.length === 0) return null
  return [...series].sort((left, right) => right.sequence - left.sequence)[0]
}

export function previousSnapshot(data: DemoData): Snapshot | null {
  const series = data.snapshots
    .filter((snapshot) => snapshot.seriesId === data.seriesId)
    .sort((left, right) => left.sequence - right.sequence)
  if (series.length < 2) return null
  return series[series.length - 2]
}

export function activeDraft(drafts: Draft[], groupKey: string): Draft | null {
  const open = drafts.filter(
    (draft) =>
      draft.groupKey === groupKey &&
      !draft.isTest &&
      (draft.status === 'active' || draft.status === 'reviewed' || draft.status === 'handed_off'),
  )
  if (open.length === 0) return null
  return [...open].sort((left, right) => right.revision - left.revision)[0]
}

function indexBookings(bookings: Booking[]): Map<string, Booking[]> {
  const grouped = new Map<string, Booking[]>()
  for (const booking of bookings) {
    const key = `${booking.hotelId}|${booking.airportCode}|${booking.localStayDate}`
    const list = grouped.get(key)
    if (list) list.push(booking)
    else grouped.set(key, [booking])
  }
  return grouped
}

function placeholderHotel(hotelId: string, airportCode: string): Hotel {
  return {
    id: hotelId,
    name: 'Неизвестная гостиница',
    city: '—',
    airportCode,
    airportName: airportCode,
    timezone: 'Europe/Moscow',
    utcOffset: '+03:00',
    recipients: [],
    cc: [],
    contractStatus: 'unknown',
    active: false,
    recipientSource: 'aviabit',
    comment: '',
    sourceRecipients: [],
    sourceCc: [],
  }
}

function inScope(stayDate: string, data: DemoData): boolean {
  if (data.settings.stayScope === 'both') return true
  const today = mskDate(data.clockIso)
  if (data.settings.stayScope === 'today') return stayDate === today
  return stayDate === nextDate(today)
}

export function selectGroups(data: DemoData, basis: 'baseline' | 'previous' = 'baseline'): GroupView[] {
  const latest = latestSnapshot(data)
  const previous = previousSnapshot(data)
  const latestByGroup = indexBookings(latest?.bookings ?? [])
  const history = replayDiffs(data.snapshots.filter((snapshot) => snapshot.seriesId === data.seriesId))
  const keys = new Set<string>([
    ...latestByGroup.keys(),
    ...Object.keys(data.baselines),
    ...data.drafts.filter((draft) => !draft.isTest).map((draft) => draft.groupKey),
    ...Object.keys(data.groupTimers),
    ...data.manualHolds.map((hold) => hold.groupKey),
  ])

  const previousEvents =
    basis === 'previous' && previous && latest
      ? diffBookings({
          before: previous.bookings,
          after: latest.bookings,
          detectedAt: latest.fetchedAt,
          fromSnapshotId: previous.id,
          toSnapshotId: latest.id,
        })
      : []

  const rawNet: ChangeEvent[] = []
  if (basis === 'baseline' && (data.baselineEstablished || Object.keys(data.baselines).length > 0)) {
    for (const key of keys) {
      const baselineBookings = data.baselineEstablished ? (data.baselines[key]?.bookings ?? []) : (data.baselines[key]?.bookings ?? null)
      if (!baselineBookings) continue
      rawNet.push(
        ...diffBookings({
          before: baselineBookings,
          after: latestByGroup.get(key) ?? [],
          detectedAt: latest?.fetchedAt ?? data.clockIso,
          fromSnapshotId: data.baselines[key]?.originatingSnapshotId ?? 'baseline',
          toSnapshotId: latest?.id ?? 'latest',
        }),
      )
    }
  }
  const netEvents = applyDetectedTimes(linkCrossGroupMoves(rawNet), history)
  const netByGroup = new Map<string, ChangeEvent[]>()
  for (const event of netEvents) {
    const list = netByGroup.get(event.groupKey)
    if (list) list.push(event)
    else netByGroup.set(event.groupKey, [event])
  }

  const groups: GroupView[] = []
  for (const key of keys) {
    const [hotelId, airportCode, localStayDate] = key.split('|')
    const knownHotel = data.hotels.find((hotel) => hotel.id === hotelId)
    const hotel = knownHotel ?? placeholderHotel(hotelId, airportCode)
    const latestGroup = latestByGroup.get(key) ?? []
    const baseline = data.baselineEstablished ? (data.baselines[key]?.bookings ?? []) : (data.baselines[key]?.bookings ?? null)
    const changes = basis === 'previous' ? previousEvents.filter((event) => event.groupKey === key) : (netByGroup.get(key) ?? [])
    const draft = activeDraft(data.drafts, key)
    const exceptions = exceptionsFor({
      data,
      key,
      hotel: knownHotel,
      unknown: !knownHotel && (latestGroup.length > 0 || changes.length > 0),
      stayDate: localStayDate,
      latestGroup,
      latest,
      draft,
      pending: changes.length > 0 || Boolean(draft),
    })
    const timer = data.groupTimers[key]
    const liveFingerprint = fingerprintBookings(latestGroup)
    const hotelRecipientKey = recipientKey(knownHotel ?? hotel)
    const status = resolveStatus({
      baselineEstablished: data.baselineEstablished,
      hasBaselineEntry: data.baselineEstablished || Boolean(data.baselines[key]),
      changeCount: changes.length,
      exceptions,
      draft,
      liveFingerprint,
      recipientKey: hotelRecipientKey,
      dueAt: timer?.dueAt ?? null,
      nowIso: data.clockIso,
      preparing: data.preparingGroupKey === key,
    })
    if (latestGroup.length === 0 && changes.length === 0 && !draft && !data.baselines[key]) continue
    groups.push({
      key,
      hotel,
      airportCode,
      localStayDate,
      changes,
      lastChangeAt: timer?.lastChangeAt ?? null,
      dueAt: timer?.dueAt ?? null,
      status,
      exceptions,
      draft,
      latestBookings: latestGroup,
      baselineBookings: baseline,
      liveFingerprint,
      recipientKey: hotelRecipientKey,
    })
  }
  return groups
}

function exceptionsFor(input: {
  data: DemoData
  key: string
  hotel: Hotel | undefined
  unknown: boolean
  stayDate: string
  latestGroup: Booking[]
  latest: Snapshot | null
  draft: Draft | null
  pending: boolean
}): GroupException[] {
  const exceptions: GroupException[] = []
  if (input.unknown) {
    exceptions.push({ id: `unknown:${input.key}`, kind: 'unknown_hotel', blocking: true, message: 'Гостиница не сопоставлена. Похожий объект не выбирается автоматически.' })
  }
  if (input.hotel && !input.hotel.active) {
    exceptions.push({ id: `inactive:${input.key}`, kind: 'inactive', blocking: true, message: 'Гостиница отключена. Необработанные изменения ждут решения.' })
  }
  if (input.hotel && input.hotel.recipients.length === 0 && !input.unknown) {
    exceptions.push({ id: `address:${input.key}`, kind: 'no_address', blocking: true, message: 'Нет адреса получателя. Письмо нельзя отправить.' })
  }
  if (input.hotel && input.hotel.contractStatus !== 'confirmed' && !input.unknown) {
    exceptions.push({
      id: `contract:${input.key}`,
      kind: 'no_contract',
      blocking: true,
      message: input.hotel.contractStatus === 'none' ? 'Договора нет. Адрес получателя это не закрывает.' : 'Состояние договора неизвестно. Отправка заблокирована.',
    })
  }
  if (!input.data.resolvedExceptionIds.includes(`ambiguous:${input.key}`)) {
    const seen = new Set<string>()
    let ambiguous = false
    for (const booking of input.latestGroup) {
      if (seen.has(booking.crewId)) ambiguous = true
      seen.add(booking.crewId)
    }
    if (ambiguous) {
      exceptions.push({ id: `ambiguous:${input.key}`, kind: 'ambiguous', blocking: true, message: 'Неоднозначное сопоставление: два идентификатора одного человека.' })
    }
  }
  const issue = input.latest?.validationIssues.find((item) => input.latestGroup.some((booking) => booking.id === item.bookingId))
  if (issue) {
    exceptions.push({ id: `norm:${input.key}`, kind: 'normalization', blocking: true, message: issue.message })
  }
  if (input.pending && !inScope(input.stayDate, input.data)) {
    exceptions.push({ id: `scope:${input.key}`, kind: 'outside_period', blocking: true, message: 'Вне выбранного периода. Группа сохранена и не рассылается.' })
  }
  const hold = input.data.manualHolds.find((item) => item.groupKey === input.key)
  if (hold) exceptions.push({ id: `hold:${input.key}`, kind: 'manual', blocking: true, message: hold.comment })
  if (input.draft && /\{[a-z0-9_]+\}/.test(`${input.draft.subject}${input.draft.intro}${input.draft.closing}${input.draft.signature}`)) {
    exceptions.push({ id: `token:${input.key}`, kind: 'missing_token', blocking: true, message: 'В письме осталась нераскрытая переменная.' })
  }
  return exceptions.filter((item) => !input.data.resolvedExceptionIds.includes(item.id))
}

export function resolveStatus(input: {
  baselineEstablished: boolean
  hasBaselineEntry: boolean
  changeCount: number
  exceptions: GroupException[]
  draft: Draft | null
  liveFingerprint: string
  recipientKey: string
  dueAt: string | null
  nowIso: string
  preparing: boolean
}): QueueStatus {
  if (input.preparing) return 'preparing'
  if (input.exceptions.some((item) => item.blocking)) return 'needs_decision'
  if (!input.baselineEstablished && !input.hasBaselineEntry) return 'needs_baseline'
  const draft = input.draft
  const drifted = Boolean(draft && (draft.dataFingerprint !== input.liveFingerprint || draft.recipientKey !== input.recipientKey))
  if (input.changeCount === 0) {
    if (draft?.status === 'handed_off') return 'handed_off'
    if (draft?.status === 'sent') return 'sent'
    return 'unchanged'
  }
  if (draft && drifted) return 'stale'
  if (draft?.status === 'reviewed') return 'reviewed'
  if (draft?.status === 'handed_off') return 'handed_off'
  if (draft?.status === 'active') return 'needs_review'
  return 'waiting'
}

export function sourceIsStale(data: DemoData): boolean {
  if (!data.lastSuccessAt || data.sourceStatus !== 'ok') return false
  const ageMinutes = (new Date(data.clockIso).getTime() - new Date(data.lastSuccessAt).getTime()) / 60_000
  return ageMinutes > data.settings.staleAfterMinutes
}

export function canReview(group: GroupView): boolean {
  const draft = group.draft
  if (!draft || !draft.saved || draft.isTest) return false
  if (draft.dataFingerprint !== group.liveFingerprint || draft.recipientKey !== group.recipientKey) return false
  if (group.exceptions.some((item) => item.blocking)) return false
  if (group.status === 'stale' || group.status === 'needs_decision' || group.status === 'needs_baseline') return false
  return draft.recipients.length > 0 && draft.recipients.every((email) => email.endsWith('@example.com'))
}

export function canSend(data: DemoData, group: GroupView): boolean {
  const draft = group.draft
  if (!draft || data.sendingDraftId) return false
  if (data.sourceStatus === 'error' || data.sourceStatus === 'disabled' || sourceIsStale(data)) return false
  if (draft.status !== 'reviewed' || draft.reviewedRevision !== draft.revision) return false
  return canReview(group)
}
