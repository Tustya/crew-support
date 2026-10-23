import { formatMsk } from '../domain/time'
import type { GroupException, Hotel, MailTemplate, TemplateId } from '../domain/types'
import { defaultTemplate } from '../domain/templates'
import type {
  AuditDto,
  ChangeDto,
  ChangeView,
  DirectoryHotel,
  DraftDto,
  GroupDto,
  HotelDto,
  JournalEntry,
  Letter,
  Notice,
  NotificationDto,
  SnapshotDto,
  SnapshotItem,
  TemplateDto,
  WorkGroup,
} from './types'

const ACTION_LABEL: Record<string, string> = {
  'source.check_succeeded': 'Проверка источника',
  'source.check_duplicate': 'Проверка без изменений',
  'source.check_failed': 'Ошибка источника',
  'source.import_succeeded': 'Загрузка Excel',
  'source.import_duplicate': 'Повторный Excel',
  'import.accepted': 'Файл принят',
  'import.rejected': 'Файл отклонён',
  'baseline.established': 'База зафиксирована',
  'draft.prepared': 'Черновик собран',
  'draft.bypass_quiet': 'Черновик без паузы',
  'draft.revised': 'Черновик изменён',
  'draft.reviewed': 'Письмо проверено',
  'draft.handed_off': 'Передано в почту',
  'delivery.sent': 'Письмо отправлено',
  'delivery.rejected': 'Отправка отклонена',
  'delivery.unknown': 'Статус отправки неизвестен',
  'notification.external_confirmed': 'Подтверждено вне системы',
  'exception.held': 'Отложено вручную',
  'exception.resolved': 'Исключение снято',
  'hotel.created': 'Гостиница добавлена',
  'hotel.updated': 'Гостиница изменена',
  'settings.updated': 'Настройки изменены',
  'template.published': 'Шаблон опубликован',
  'integration.test': 'Проверка подключения',
  'auth.login': 'Вход',
  'auth.logout': 'Выход',
}

const DETAIL_LABEL: Record<string, string> = {
  rowCount: 'строк',
  filename: 'файл',
  reason: 'причина',
  quietMinutes: 'пауза, мин',
  version: 'версия',
  revision: 'версия',
  airport: 'аэропорт',
  code: 'код',
}

const REASON_LABEL: Record<string, string> = {
  bad_credentials: 'неверная почта или пароль',
  rate_limited: 'слишком много попыток',
}

export function utcOffsetOf(timezone: string): string {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'shortOffset' }).formatToParts(new Date()).find((item) => item.type === 'timeZoneName')
    const match = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(part?.value ?? '')
    if (!match) return '+00:00'
    return `${match[1]}${match[2]?.padStart(2, '0')}:${match[3] ?? '00'}`
  } catch {
    return ''
  }
}

export function toDirectoryHotel(dto: HotelDto): DirectoryHotel {
  return {
    id: dto.id,
    sourceHotelId: dto.source_hotel_id ?? '',
    version: Number(dto.row_version),
    name: dto.name,
    city: dto.city,
    airportCode: dto.airport_code,
    airportName: '',
    timezone: dto.timezone,
    utcOffset: utcOffsetOf(dto.timezone),
    recipients: dto.recipients,
    cc: dto.cc,
    contractStatus: dto.contract_status,
    active: dto.active,
    recipientSource: 'local',
    comment: dto.comment ?? '',
    sourceRecipients: [],
    sourceCc: [],
  }
}

function placeholderHotel(id: string, airportCode: string): Hotel {
  return {
    id,
    name: 'Гостиница не сопоставлена',
    city: '',
    airportCode,
    airportName: '',
    timezone: '',
    utcOffset: '',
    recipients: [],
    cc: [],
    contractStatus: 'unknown',
    active: false,
    recipientSource: 'local',
    comment: '',
    sourceRecipients: [],
    sourceCc: [],
  }
}

function toChange(change: ChangeDto, detectedAt: string | null): ChangeView {
  return {
    id: `${change.entityKey}|${change.kind}|${change.groupKey}`,
    fullName: change.fullName,
    groupKey: change.groupKey,
    linkedGroupKey: change.linkedGroupKey,
    replacement: change.replacement,
    kind: change.kind,
    fields: change.fields,
    detectedAt,
  }
}

export function toWorkGroup(dto: GroupDto, hotels: Hotel[]): WorkGroup {
  const directory = hotels.find((item) => item.id === dto.hotel?.id)
  const hotel = directory ?? (dto.hotel
    ? { ...placeholderHotel(dto.hotel.id, dto.airportCode), name: dto.hotel.name, city: dto.hotel.city, timezone: dto.hotel.timezone, utcOffset: utcOffsetOf(dto.hotel.timezone) }
    : placeholderHotel(`unmapped:${dto.id}`, dto.airportCode))
  return {
    key: dto.id,
    groupKey: dto.groupKey,
    hotel,
    airportCode: dto.airportCode,
    localStayDate: dto.stayDate,
    changes: dto.changes.map((change) => toChange(change, dto.lastMeaningfulChangeAt)),
    lastChangeAt: dto.lastMeaningfulChangeAt,
    dueAt: dto.dueAt,
    status: dto.status,
    exceptions: dto.exceptions as GroupException[],
    draftId: dto.draftId,
    revision: dto.revision,
    crewNames: dto.crewNames,
  }
}

export function toLetter(dto: DraftDto, groupId: string): Letter {
  return { ...dto, groupKey: groupId }
}

function groupParts(groupKey: string, hotels: Hotel[]): { hotel: Hotel | undefined; airportCode: string; localStayDate: string } {
  const [hotelId = '', airportCode = '', localStayDate = ''] = groupKey.split('|')
  return { hotel: hotels.find((item) => item.id === hotelId), airportCode, localStayDate }
}

export function toNotice(dto: NotificationDto, hotels: Hotel[]): Notice {
  const parts = groupParts(dto.group_key, hotels)
  return {
    id: dto.id,
    groupKey: dto.group_key,
    revision: Number(dto.revision),
    transport: dto.transport_status,
    subject: dto.subject ?? dto.letter?.subject ?? null,
    letter: dto.letter,
    hotelName: parts.hotel?.name ?? '—',
    airportCode: parts.airportCode,
    localStayDate: parts.localStayDate,
    timezoneLabel: parts.hotel?.utcOffset ?? '',
    createdAt: dto.created_at,
    sentAt: dto.sent_at ?? dto.external_confirmation_at,
  }
}

function detailsText(details: Record<string, unknown>): string {
  return Object.entries(details)
    .filter((entry): entry is [string, string | number] => entry[0] in DETAIL_LABEL && (typeof entry[1] === 'string' || typeof entry[1] === 'number'))
    .map(([key, value]) => `${DETAIL_LABEL[key]} ${detailValue(key, value)}`)
    .join(', ')
}

function detailValue(key: string, value: string | number): string {
  if (key !== 'reason' || typeof value !== 'string') return String(value)
  return REASON_LABEL[value] ?? value
}

export function toJournalEntry(dto: AuditDto, hotels: Hotel[]): JournalEntry {
  const parts = dto.group_key ? groupParts(dto.group_key, hotels) : null
  return {
    id: dto.id,
    timestamp: dto.occurred_at,
    actor: dto.display_name ?? (dto.service_actor ? 'Система' : '—'),
    action: ACTION_LABEL[dto.action] ?? dto.action,
    hotelName: parts?.hotel?.name ?? '',
    localStayDate: parts?.localStayDate ?? '',
    description: detailsText(dto.safe_details ?? {}) || (dto.result === 'ok' ? 'выполнено' : dto.result === 'denied' ? 'отказано' : 'ошибка'),
    result: dto.result === 'ok' ? 'ok' : 'error',
    groupKey: dto.group_key,
  }
}

export function toSnapshotItem(dto: SnapshotDto): SnapshotItem {
  const source = dto.source === 'workbook' ? 'Excel' : dto.source === 'sample' ? 'образец' : dto.source
  return {
    id: dto.id,
    label: `#${dto.seq} · ${formatMsk(dto.fetched_at)}`,
    source,
    fetchedAt: dto.fetched_at,
    windowFrom: dto.window_from,
    windowTo: dto.window_to,
    rowCount: Number(dto.row_count),
    issueCount: Number(dto.issue_count),
  }
}

export function toTemplate(dto: TemplateDto | undefined, id: TemplateId): MailTemplate {
  const base = defaultTemplate(id)
  if (!dto) return base
  return {
    ...base,
    blocks: base.blocks.map((block) => ({ ...block, text: dto.blocks.find((item) => item.kind === block.kind)?.text ?? block.text })),
    columns: dto.columns.length ? dto.columns : base.columns,
    newLabel: dto.new_label,
    cancelLabel: dto.cancel_label,
  }
}
