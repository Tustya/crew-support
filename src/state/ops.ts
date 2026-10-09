import { applyOverrides, isDemoEmail, normalizeEmails, templateProblems } from '../domain/email'
import {
  applyClock,
  archiveNotification,
  baselinePayload,
  baselinesFrom,
  makeActivity,
  makeDraft,
  patchLatest,
  prepareDueGroups,
  writeBaseline,
} from '../domain/flow'
import { fingerprintBookings } from '../domain/diff'
import { actorLabel } from '../domain/labels'
import { addMinutes } from '../domain/time'
import type { Booking, ColumnKey, DemoData, Draft, Hotel, MailTemplate, ScenarioId, Settings, TemplateId } from '../domain/types'
import { canReview, canSend, latestSnapshot, selectGroups } from '../domain/view'
import { loadScenario } from '../fixtures/scenarios'

export interface DraftEdits {
  subject: string
  greeting: string
  intro: string
  closing: string
  signature: string
  recipients: string[]
  cc: string[]
  overrides: { bookingId: string; field: ColumnKey; value: string; note: string }[]
}

export interface SendStart {
  data: DemoData
  payload: Booking[] | null
  reason: string | null
}

export function openScenario(data: DemoData, scenarioId: ScenarioId): DemoData {
  return { ...loadScenario(scenarioId, data.settings, data.role), clockPaused: true, phase: 'running' }
}

export function advance(data: DemoData, deltaMs: number): DemoData {
  const clockIso = new Date(Date.parse(data.clockIso) + deltaMs).toISOString()
  return applyClock(data, clockIso, true)
}

export function checkNow(data: DemoData): DemoData {
  if (data.sourceOutage) {
    return record(
      {
        ...data,
        checking: false,
        checkOperationId: null,
        sourceStatus: 'error',
        lastErrorAt: data.clockIso,
        nextCheckAt: addMinutes(data.clockIso, data.settings.pollMinutes),
      },
      'Проверка источника',
      'Проверка Aviabit завершилась ошибкой; последний снимок сохранён.',
      'error',
    )
  }
  return record(
    {
      ...data,
      checking: false,
      checkOperationId: null,
      sourceStatus: 'ok',
      lastSuccessAt: data.clockIso,
      nextCheckAt: addMinutes(data.clockIso, data.settings.pollMinutes),
    },
    'Проверка успешна',
    'Повторная проверка тех же данных. Таймеры и черновики не дублировались.',
    'ok',
  )
}

export function armSourceOutage(data: DemoData): DemoData {
  return { ...data, sourceOutage: true }
}

export function injectDelay(data: DemoData): DemoData {
  const latest = latestSnapshot(data)
  const target =
    latest?.bookings.find((booking) => booking.id === 'b-svx-1' && booking.recordStatus === 'active') ??
    latest?.bookings.find((booking) => booking.hotelId === 'hotel-angel' && booking.recordStatus === 'active')
  if (!target) return data
  const [hourText, minuteText] = target.arrivalLocalTime.split(':')
  const total = (Number(hourText) * 60 + Number(minuteText) + 30) % 1440
  const arrivalLocalTime = `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
  return patchLatest(data, target.id, { arrivalLocalTime })
}

export function importDemoSample(data: DemoData): DemoData {
  const latest = latestSnapshot(data)
  if (!latest) return data
  const snapshot = {
    ...latest,
    id: `sample-${data.clockIso}-${latest.sequence + 1}`,
    source: 'demo_file' as const,
    label: 'Демо-образец',
    fetchedAt: data.clockIso,
    sequence: latest.sequence + 1,
  }
  return record(
    {
      ...data,
      snapshots: [...data.snapshots, snapshot],
      drafts: data.drafts.map((draft) =>
        draft.status === 'reviewed'
          ? { ...draft, status: 'active', reviewedRevision: null, reviewedAt: null, reviewedBy: null }
          : draft,
      ),
    },
    'Снимок импортирован',
    'Демо-образец заменил источник. Проверка открытых писем снята.',
    'info',
  )
}

export function establishBaseline(data: DemoData): DemoData {
  const series = data.snapshots
    .filter((snapshot) => snapshot.seriesId === data.seriesId)
    .sort((left, right) => left.sequence - right.sequence)
  const source = series[0]
  if (!source) return data
  return prepareDueGroups(
    record(
      {
        ...data,
        baselines: baselinesFrom(source, 'manual_base', data.clockIso),
        baselineEstablished: true,
      },
      'База выбрана',
      'В этом сценарии исходная рассылка уже выполнена.',
      'ok',
    ),
  )
}

export function prepareNow(data: DemoData, groupKey: string): DemoData {
  const group = selectGroups(data).find((item) => item.key === groupKey)
  if (!group || group.changes.length === 0 || group.exceptions.some((item) => item.blocking)) return data
  if (group.draft && group.draft.status !== 'sent' && group.draft.status !== 'archived') return data
  const draft = makeDraft(data, group)
  return record(
    { ...data, drafts: [...data.drafts, draft], preparingGroupKey: null },
    'Черновик подготовлен',
    `Создан черновик v${draft.revision}, ${group.changes.length} изм.`,
    'ok',
    groupKey,
    draft.id,
    draft.revision,
  )
}

export function regenerateDraft(data: DemoData, groupKey: string): DemoData {
  const archived = data.drafts.map((draft) =>
    draft.groupKey === groupKey && draft.status !== 'sent' && draft.status !== 'archived'
      ? { ...draft, status: 'archived' as const }
      : draft,
  )
  const next = { ...data, drafts: archived }
  const group = selectGroups(next).find((item) => item.key === groupKey)
  if (!group) return data
  const draft = makeDraft(next, group)
  return record(
    { ...next, drafts: [...archived, draft] },
    'Черновик обновлён',
    'Предыдущая версия сохранена в архиве, собрана новая.',
    'ok',
    groupKey,
    draft.id,
    draft.revision,
  )
}

export function saveDraft(data: DemoData, draftId: string, edits: DraftEdits): DemoData {
  const draft = data.drafts.find((item) => item.id === draftId)
  if (!draft) return data
  const recipients = normalizeEmails(edits.recipients)
  const cc = normalizeEmails(edits.cc)
  if (recipients.some((email) => !isDemoEmail(email)) || cc.some((email) => !isDemoEmail(email))) return data
  const rows = applyOverrides(draft.rows, edits.overrides)
  const changed =
    draft.subject !== edits.subject ||
    draft.greeting !== edits.greeting ||
    draft.intro !== edits.intro ||
    draft.closing !== edits.closing ||
    draft.signature !== edits.signature ||
    draft.recipients.join() !== recipients.join() ||
    draft.cc.join() !== cc.join() ||
    edits.overrides.length > 0
  if (!changed) return { ...data, drafts: data.drafts.map((item) => (item.id === draftId ? { ...item, saved: true } : item)) }
  const updated: Draft = {
    ...draft,
    revision: draft.revision + 1,
    subject: edits.subject,
    greeting: edits.greeting,
    intro: edits.intro,
    closing: edits.closing,
    signature: edits.signature,
    recipients,
    cc,
    rows,
    overrides: edits.overrides,
    manualEdits: true,
    saved: true,
    status: 'active',
    reviewedRevision: null,
    reviewedAt: null,
    reviewedBy: null,
  }
  return record(
    { ...data, drafts: data.drafts.map((item) => (item.id === draftId ? updated : item)) },
    'Ручная правка',
    `Сохранена правка v${updated.revision}. Проверка снята.`,
    'info',
    draft.groupKey,
    draft.id,
    updated.revision,
  )
}

export function reviewDraft(data: DemoData, draftId: string): DemoData {
  const group = selectGroups(data).find((item) => item.draft?.id === draftId)
  if (!group || !canReview(group) || !group.draft) return data
  const reviewed: Draft = {
    ...group.draft,
    status: 'reviewed',
    reviewedRevision: group.draft.revision,
    reviewedAt: data.clockIso,
    reviewedBy: actorLabel(data.role),
    saved: true,
  }
  return record(
    { ...data, drafts: data.drafts.map((item) => (item.id === draftId ? reviewed : item)) },
    'Письмо проверено',
    `Проверена версия v${reviewed.revision}.`,
    'ok',
    group.key,
    draftId,
    reviewed.revision,
  )
}

export function beginSend(data: DemoData, draftId: string): SendStart {
  const group = selectGroups(data).find((item) => item.draft?.id === draftId)
  if (!group?.draft) return { data, payload: null, reason: 'Черновик не найден' }
  if (group.draft.templateVersion !== data.settings.templateVersion) {
    return { data, payload: null, reason: 'Есть новая версия шаблона' }
  }
  if (data.settings.mailMode === 'handoff') return { data, payload: null, reason: 'Включён режим передачи в почтовый клиент' }
  if (!canSend(data, group)) return { data, payload: null, reason: 'Отправка сейчас недоступна' }
  const payload = baselinePayload(data, group.draft).map((booking) => ({ ...booking }))
  return {
    data: record(data, 'Отправка начата', `Демо-отправка v${group.draft.revision}.`, 'info', group.key, draftId, group.draft.revision),
    payload,
    reason: null,
  }
}

export function finishSend(data: DemoData, payload: Booking[] | null): DemoData {
  const draft = data.drafts.find((item) => item.id === data.sendingDraftId)
  if (!draft || !payload) return { ...data, sendingDraftId: null }
  const duplicate = data.notifications.some(
    (item) => item.draftId === draft.id && item.revision === draft.revision && item.transport === 'sent',
  )
  if (duplicate) return { ...data, sendingDraftId: null }
  if (data.mailFailOnce && data.settings.mailMode === 'in_app') {
    return record(
      { ...data, mailFailOnce: false, sendingDraftId: null },
      'Ошибка отправки',
      'Демо-почта отклонила письмо. Уведомлённое состояние не изменено.',
      'error',
      draft.groupKey,
      draft.id,
      draft.revision,
    )
  }
  const notice = archiveNotification({ ...data, sendingDraftId: draft.id }, draft, 'sent')
  const baselines = writeBaseline(data.baselines, draft.groupKey, payload, draft.sourceSnapshotId, 'send', data.clockIso, notice.id)
  const timers = { ...data.groupTimers }
  const [hotelId, airportCode, stayDate] = draft.groupKey.split('|')
  const live = (latestSnapshot(data)?.bookings ?? []).filter(
    (booking) =>
      booking.hotelId === hotelId &&
      booking.airportCode === airportCode &&
      booking.localStayDate === stayDate &&
      booking.recordStatus !== 'cancelled',
  )
  if (fingerprintBookings(live) === fingerprintBookings(payload)) delete timers[draft.groupKey]
  return record(
    {
      ...data,
      baselines,
      groupTimers: timers,
      notifications: [notice, ...data.notifications],
      drafts: data.drafts.map((item) => (item.id === draft.id ? { ...item, status: 'sent' } : item)),
      sendingDraftId: null,
    },
    'Отправка успешна',
    `Архив v${draft.revision}. База обновлена только у этой гостиницы и даты.`,
    'ok',
    draft.groupKey,
    draft.id,
    draft.revision,
  )
}

export function handoffDraft(data: DemoData, draftId: string): DemoData {
  const draft = data.drafts.find((item) => item.id === draftId)
  const group = selectGroups(data).find((item) => item.draft?.id === draftId)
  if (!draft || !group || !canReview(group) || draft.reviewedRevision !== draft.revision) return data
  const notice = archiveNotification(data, draft, 'handed_off')
  return record(
    {
      ...data,
      notifications: [notice, ...data.notifications],
      drafts: data.drafts.map((item) => (item.id === draftId ? { ...item, status: 'handed_off' } : item)),
    },
    'Передача в почту',
    'Черновик передан. Отправка не подтверждена, база не обновлена.',
    'info',
    draft.groupKey,
    draft.id,
    draft.revision,
  )
}

export function confirmExternal(data: DemoData, notificationId: string): DemoData {
  const notice = data.notifications.find((item) => item.id === notificationId && item.transport === 'handed_off')
  if (!notice) return data
  const draft = data.drafts.find((item) => item.id === notice.draftId)
  const payload = draft ? baselinePayload(data, draft) : []
  const baselines = writeBaseline(data.baselines, notice.groupKey, payload, draft?.sourceSnapshotId ?? '', 'external_confirm', data.clockIso, notice.id)
  return record(
    {
      ...data,
      baselines,
      notifications: data.notifications.map((item) =>
        item.id === notificationId
          ? { ...item, transport: 'external_confirmed' as const, sentAt: data.clockIso }
          : item,
      ),
      drafts: data.drafts.filter((item) => item.id !== notice.draftId),
    },
    'Внешняя отправка',
    'Сотрудник подтвердил отправку вне системы. Это не ответ почтового сервера.',
    'ok',
    notice.groupKey,
    notice.draftId,
    notice.revision,
  )
}

export function applySettings(data: DemoData, nextSettings: Settings): DemoData {
  const templatesChanged = JSON.stringify(nextSettings.templates) !== JSON.stringify(data.settings.templates)
  const settings =
    data.role === 'lead'
      ? { ...nextSettings, templateVersion: templatesChanged ? data.settings.templateVersion + 1 : data.settings.templateVersion }
      : { ...data.settings, quietMinutes: nextSettings.quietMinutes, stayScope: nextSettings.stayScope, autoPrepare: nextSettings.autoPrepare }
  const timers = { ...data.groupTimers }
  if (settings.quietMinutes !== data.settings.quietMinutes) {
    for (const [key, timer] of Object.entries(timers)) {
      timers[key] = { ...timer, dueAt: addMinutes(timer.lastChangeAt, settings.quietMinutes) }
    }
  }
  const nextCheckAt =
    settings.pollMinutes !== data.settings.pollMinutes ? addMinutes(data.clockIso, settings.pollMinutes) : data.nextCheckAt
  return prepareDueGroups(
    record(
      {
        ...data,
        settings,
        groupTimers: timers,
        nextCheckAt: settings.autoCheck ? nextCheckAt : null,
      },
      'Настройки',
      settings.quietMinutes !== data.settings.quietMinutes
        ? `Интервал тишины изменён на ${settings.quietMinutes} мин.`
        : 'Изменены настройки демонстрации.',
      'ok',
    ),
  )
}

export function saveTemplate(data: DemoData, templateId: TemplateId, template: MailTemplate): DemoData | null {
  if (data.role !== 'lead') return null
  if (templateProblems(template).length > 0) return null
  const templateVersion = data.settings.templateVersion + 1
  return record(
    {
      ...data,
      settings: {
        ...data.settings,
        templateVersion,
        templates: { ...data.settings.templates, [templateId]: template },
      },
    },
    'Шаблон',
    `Сохранена версия шаблона v${templateVersion}. Уже подготовленные письма не переписаны.`,
    'ok',
  )
}

export function saveHotel(data: DemoData, hotel: Hotel): DemoData {
  if (data.role !== 'lead') return data
  const exists = data.hotels.some((item) => item.id === hotel.id)
  const hotels = exists ? data.hotels.map((item) => (item.id === hotel.id ? hotel : item)) : [...data.hotels, hotel]
  return record({ ...data, hotels }, 'Справочник', `Обновлена гостиница ${hotel.name}.`, 'ok')
}

export function resolveException(data: DemoData, exceptionId: string, comment: string): DemoData {
  if (!comment.trim()) return data
  if (exceptionId.startsWith('hold:')) {
    const groupKey = exceptionId.slice(5)
    return record(
      {
        ...data,
        manualHolds: [...data.manualHolds.filter((item) => item.groupKey !== groupKey), { groupKey, comment: comment.trim(), createdAt: data.clockIso }],
      },
      'Исключение',
      comment.trim(),
      'ok',
      groupKey,
    )
  }
  return record(
    { ...data, resolvedExceptionIds: [...data.resolvedExceptionIds, exceptionId] },
    'Исключение',
    comment.trim(),
    'ok',
  )
}

function record(
  data: DemoData,
  action: string,
  description: string,
  result: 'ok' | 'error' | 'info',
  groupKey: string | null = null,
  draftId: string | null = null,
  revision: number | null = null,
): DemoData {
  const [hotelId, airportCode, stayDate] = groupKey?.split('|') ?? []
  const hotelName = data.hotels.find((hotel) => hotel.id === hotelId)?.name ?? ''
  const withSend = action === 'Отправка начата' && draftId ? { ...data, sendingDraftId: draftId } : data
  return {
    ...withSend,
    activities: [
      makeActivity(withSend, {
        timestamp: withSend.clockIso,
        action,
        hotelName,
        airportCode: airportCode ?? '',
        localStayDate: stayDate ?? '',
        description,
        result,
        groupKey,
        draftId,
        revision,
      }),
      ...withSend.activities,
    ],
  }
}
