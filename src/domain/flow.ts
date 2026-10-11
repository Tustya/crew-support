import { diffBookings, fingerprintBookings, groupKeyOf } from './diff'
import { applyTokens, blockText, letterRows, pickTemplateId, roomPairsOf } from './email'
import { actorLabel } from './labels'
import { addMinutes } from './time'
import { defaultSettings } from './templates'
import type { Activity, Baseline, Booking, DemoData, Draft, GroupView, NotificationRecord, ScenarioId, Snapshot } from './types'
import { latestSnapshot, selectGroups } from './view'

let sequence = 1

function nid(prefix: string): string {
  sequence += 1
  return `${prefix}-${Date.now().toString(36)}-${sequence}`
}

export function emptyData(): DemoData {
  return {
    schemaVersion: 1,
    phase: 'welcome',
    scenarioId: 'calm',
    role: 'specialist',
    clockIso: '2026-10-09T11:00:00.000Z',
    clockPaused: true,
    settings: defaultSettings(),
    hotels: [],
    snapshots: [],
    baselines: {},
    baselineEstablished: false,
    drafts: [],
    notifications: [],
    activities: [],
    groupTimers: {},
    sourceStatus: 'unknown',
    sourceOutage: false,
    lastSuccessAt: null,
    lastErrorAt: null,
    nextCheckAt: null,
    checking: false,
    checkOperationId: null,
    sendingDraftId: null,
    preparingGroupKey: null,
    mailFailOnce: false,
    uploadedFile: null,
    historicalCompare: null,
    resolvedExceptionIds: [],
    manualHolds: [],
    changeCursor: 0,
    seriesId: 'series-welcome',
  }
}

export function makeActivity(data: DemoData, input: Omit<Activity, 'id' | 'actor'> & { actor?: string }): Activity {
  return {
    ...input,
    id: nid('act'),
    actor: input.actor ?? (input.action.startsWith('Проверка') || input.action.startsWith('Черновик') ? 'Система' : actorLabel(data.role)),
  }
}

export function baselinesFrom(snapshot: Snapshot, establishedBy: Baseline['establishedBy'], notifiedAt: string): Record<string, Baseline> {
  const grouped = new Map<string, Booking[]>()
  for (const booking of snapshot.bookings) {
    const key = groupKeyOf(booking)
    const list = grouped.get(key)
    if (list) list.push(booking)
    else grouped.set(key, [booking])
  }
  const baselines: Record<string, Baseline> = {}
  for (const [key, bookings] of grouped) {
    baselines[key] = {
      groupKey: key,
      bookings,
      originatingSnapshotId: snapshot.id,
      establishedBy,
      notificationId: null,
      notifiedAt,
    }
  }
  return baselines
}

export function makeDraft(data: DemoData, group: GroupView, isTest = false): Draft {
  const templateId = pickTemplateId(group.changes.map((change) => change.kind))
  const template = data.settings.templates[templateId]
  const variables = {
    hotel_name: group.hotel.name,
    airport_name: group.hotel.airportName,
    airport_code: group.airportCode,
    stay_date: group.localStayDate.split('-').reverse().join('.'),
    local_timezone: `${group.hotel.timezone} ${group.hotel.utcOffset}`,
    change_count: String(group.changes.length),
    sender_name: data.settings.senderName,
  }
  const revision = data.drafts.filter((draft) => draft.groupKey === group.key).reduce((max, draft) => Math.max(max, draft.revision), 0) + 1
  return {
    id: nid('draft'),
    groupKey: group.key,
    revision,
    sourceSnapshotId: latestSnapshot(data)?.id ?? '',
    templateId,
    templateVersion: data.settings.templateVersion,
    dataFingerprint: group.liveFingerprint,
    recipientKey: group.recipientKey,
    recipients: [...group.hotel.recipients],
    cc: [...group.hotel.cc],
    subject: applyTokens(blockText(template, 'subject'), variables),
    greeting: applyTokens(blockText(template, 'greeting'), variables),
    intro: applyTokens(blockText(template, 'intro'), variables),
    closing: applyTokens(blockText(template, 'closing'), variables),
    signature: applyTokens(blockText(template, 'signature'), variables),
    rows: letterRows({
      latest: group.latestBookings,
      baseline: group.baselineBookings,
      columns: template.columns,
      keptPairs: data.baselines[group.key]?.roomPairs ?? (group.draft ? roomPairsOf(group.draft.rows) : []),
    }),
    columns: template.columns.map((column) => ({ ...column })),
    newLabel: template.newLabel,
    cancelLabel: template.cancelLabel,
    overrides: [],
    manualEdits: false,
    saved: true,
    status: 'active',
    reviewedRevision: null,
    reviewedAt: null,
    reviewedBy: null,
    createdAt: data.clockIso,
    isTest,
    hotelName: group.hotel.name,
    city: group.hotel.city,
    airportCode: group.airportCode,
    localStayDate: group.localStayDate,
    timezoneLabel: group.hotel.utcOffset,
  }
}

export function prepareDueGroups(data: DemoData): DemoData {
  if (!data.settings.autoPrepare || data.phase !== 'running' || data.sourceStatus !== 'ok') return data
  const groups = selectGroups(data)
  let drafts = data.drafts
  let activities = data.activities
  let changed = false
  for (const group of groups) {
    if (group.changes.length === 0 || group.exceptions.some((item) => item.blocking)) continue
    if (!group.dueAt || group.dueAt > data.clockIso) continue
    if (group.draft && group.draft.status !== 'sent' && group.draft.status !== 'archived') continue
    const draft = makeDraft(data, group)
    drafts = [...drafts, draft]
    activities = [
      makeActivity(data, {
        timestamp: data.clockIso,
        actor: 'Система',
        action: 'Черновик подготовлен',
        hotelName: group.hotel.name,
        airportCode: group.airportCode,
        localStayDate: group.localStayDate,
        description: `Создан черновик v${draft.revision}, ${group.changes.length} изм.`,
        result: 'ok',
        groupKey: group.key,
        draftId: draft.id,
        revision: draft.revision,
      }),
      ...activities,
    ]
    changed = true
  }
  return changed ? { ...data, drafts, activities } : data
}

export function applyClock(data: DemoData, clockIso: string, runPoll: boolean): DemoData {
  let next: DemoData = { ...data, clockIso }
  if (runPoll && next.settings.autoCheck && next.sourceStatus === 'ok' && next.nextCheckAt && clockIso >= next.nextCheckAt && !next.checking) {
    next = {
      ...next,
      lastSuccessAt: clockIso,
      nextCheckAt: addMinutes(clockIso, next.settings.pollMinutes),
      activities: [
        makeActivity(next, {
          timestamp: clockIso,
          actor: 'Система',
          action: 'Проверка успешна',
          hotelName: '',
          airportCode: '',
          localStayDate: '',
          description: 'Проверка Aviabit завершена. Повтор тех же данных таймеры не сбрасывает.',
          result: 'ok',
          groupKey: null,
          draftId: null,
          revision: null,
        }),
        ...next.activities,
      ],
    }
  }
  return prepareDueGroups(next)
}

export function patchLatest(data: DemoData, bookingId: string, patch: Partial<Booking>): DemoData {
  const latest = latestSnapshot(data)
  if (!latest) return data
  const before = latest.bookings
  const bookings = before.map((booking) => (booking.id === bookingId ? { ...booking, ...patch } : booking))
  const snapshot: Snapshot = {
    ...latest,
    id: nid('snap'),
    fetchedAt: data.clockIso,
    label: 'Демо-изменение',
    bookings,
    sequence: latest.sequence + 1,
    validationIssues: [],
  }
  const hop = diffBookings({
    before,
    after: bookings,
    detectedAt: data.clockIso,
    fromSnapshotId: latest.id,
    toSnapshotId: snapshot.id,
  })
  const affected = [...new Set(hop.map((event) => event.groupKey))]
  const timers = { ...data.groupTimers }
  for (const key of affected) timers[key] = { lastChangeAt: data.clockIso, dueAt: addMinutes(data.clockIso, data.settings.quietMinutes) }
  const draftData: DemoData = { ...data, snapshots: [...data.snapshots, snapshot], groupTimers: timers }
  const netKeys = new Set(selectGroups(draftData).filter((group) => group.changes.length > 0).map((group) => group.key))
  for (const key of Object.keys(timers)) {
    if (!netKeys.has(key)) delete timers[key]
  }
  const drafts = data.drafts.map((draft) => {
    if (draft.isTest) return draft
    if (!netKeys.has(draft.groupKey) && (draft.status === 'active' || draft.status === 'reviewed')) return { ...draft, status: 'archived' as const }
    return draft
  })
  const named = affected
    .map((key) => draftData.hotels.find((hotel) => key.startsWith(`${hotel.id}|`))?.name)
    .filter((name): name is string => Boolean(name))
  return prepareDueGroups({
    ...draftData,
    drafts,
    groupTimers: timers,
    activities: [
      makeActivity(data, {
        timestamp: data.clockIso,
        actor: 'Система',
        action: 'Изменение обнаружено',
        hotelName: named[0] ?? '',
        airportCode: affected[0]?.split('|')[1] ?? '',
        localStayDate: affected[0]?.split('|')[2] ?? '',
        description: netKeys.size === 0 ? 'Итоговая корректировка исчезла. Ожидание снято, история сохранена.' : `Таймер обновлён: ${named.join(', ') || 'группа'}`,
        result: 'info',
        groupKey: affected[0] ?? null,
        draftId: null,
        revision: null,
      }),
      ...data.activities,
    ],
  })
}

export function writeBaseline(baselines: Record<string, Baseline>, groupKey: string, bookings: Booking[], snapshotId: string, establishedBy: Baseline['establishedBy'], notifiedAt: string, notificationId: string | null, roomPairs: string[][]): Record<string, Baseline> {
  return {
    ...baselines,
    [groupKey]: { groupKey, bookings, originatingSnapshotId: snapshotId, establishedBy, notificationId, notifiedAt, roomPairs },
  }
}

export function archiveNotification(data: DemoData, draft: Draft, transport: NotificationRecord['transport']): NotificationRecord {
  return {
    id: nid('notice'),
    draftId: draft.id,
    revision: draft.revision,
    groupKey: draft.groupKey,
    subject: draft.subject,
    greeting: draft.greeting,
    intro: draft.intro,
    closing: draft.closing,
    signature: draft.signature,
    rows: draft.rows.map((row) => ({ ...row, changedFields: [...row.changedFields], manualFields: [...row.manualFields] })),
    columns: draft.columns.map((column) => ({ ...column })),
    newLabel: draft.newLabel,
    cancelLabel: draft.cancelLabel,
    recipients: [...draft.recipients],
    cc: [...draft.cc],
    hotelName: draft.hotelName,
    airportCode: draft.airportCode,
    localStayDate: draft.localStayDate,
    timezoneLabel: draft.timezoneLabel,
    transport,
    actor: actorLabel(data.role),
    reviewer: draft.reviewedBy ?? actorLabel(data.role),
    reviewedAt: draft.reviewedAt,
    createdAt: data.clockIso,
    sentAt: transport === 'handed_off' ? null : data.clockIso,
    handedOffAt: transport === 'sent' ? null : data.clockIso,
    templateVersion: draft.templateVersion,
  }
}

export function sentBookings(draft: Draft): Booking[] {
  const group = draft.groupKey
  return draft.rows
    .filter((row) => row.badge !== 'cancel')
    .map((row) => ({
      id: row.bookingId,
      crewId: row.bookingId,
      fullName: row.fullName,
      hotelId: group.split('|')[0] ?? '',
      airportCode: draft.airportCode,
      localStayDate: draft.localStayDate,
      arrivalFlight: row.arrivalFlight,
      arrivalLocalDate: row.arrivalDate.split('.').reverse().join('-'),
      arrivalLocalTime: row.arrivalTime,
      departureFlight: row.departureFlight,
      departureLocalDate: row.departureDate.split('.').reverse().join('-'),
      departureLocalTime: row.departureTime,
      roomType: row.roomType === 'DBL' ? 'DBL' : 'SGL',
      recordStatus: 'active' as const,
    }))
}

export function baselinePayload(data: DemoData, draft: Draft): Booking[] {
  const latest = latestSnapshot(data)
  const [hotelId, airportCode, stayDate] = draft.groupKey.split('|')
  const current = (latest?.bookings ?? []).filter((booking) => booking.hotelId === hotelId && booking.airportCode === airportCode && booking.localStayDate === stayDate && booking.recordStatus !== 'cancelled')
  if (draft.manualEdits) return sentBookings(draft)
  return current
}

export function fingerprintMatches(draft: Draft, bookings: Booking[]): boolean {
  return draft.dataFingerprint === fingerprintBookings(bookings)
}

export const SCENARIO_ORDER: ScenarioId[] = ['calm', 'delays', 'errors', 'stale', 'replacement', 'send_error', 'reverted', 'unknown_base']
