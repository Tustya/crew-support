import type { ChangeKind, ColumnSetting, ContractStatus, FieldDelta, GroupException, Hotel, LetterRow, QueueStatus, StayScope, TemplateBlock } from '../domain/types'

export interface Me {
  subject: string
  displayName: string
  role: 'specialist' | 'lead' | 'system'
  position: string | null
}

export interface BookingDto {
  id: string | null
  crewId: string | null
  hotelId: string | null
  airportCode: string
  stayDate: string | null
  fullName: string
  arrivalFlight: string
  arrivalLocalDate: string
  arrivalLocalTime: string
  departureFlight: string
  departureLocalDate: string
  departureLocalTime: string
  roomType: 'SGL' | 'DBL' | null
  recordStatus: 'active' | 'cancelled'
  replacementOf: string | null
}

export interface CompareEvent {
  entityKey: string
  groupKey: string
  kind: ChangeKind
  before: { fullName: string } | null
  after: { fullName: string } | null
}

export interface ChangeDto {
  entityKey: string
  groupKey: string
  kind: ChangeKind
  fullName: string
  linkedGroupKey: string | null
  replacement: boolean
  fields: FieldDelta[]
}

export interface GroupDto {
  id: string
  groupKey: string
  hotel: { id: string; name: string; city: string; timezone: string } | null
  airportCode: string
  stayDate: string
  status: QueueStatus
  changeCount: number
  changes: ChangeDto[]
  lastMeaningfulChangeAt: string | null
  dueAt: string | null
  draftId: string | null
  draftStatus: string | null
  revision: number | null
  exceptions: Array<{ id: string; kind: string; message: string; blocking: boolean }>
  crewNames: string[]
}

export interface SourceDto {
  adapter: string
  lastStatus: string | null
  lastSuccessAt: string | null
  lastErrorCode: string | null
  problem: string | null
  latestSnapshotId: string | null
  latestSource?: string | null
  windowFrom?: string | null
  windowTo?: string | null
  rowCount?: number
  mailConfigured?: boolean
}

export interface OverviewDto {
  counts: Record<string, number>
  source: SourceDto
  recentEvents: AuditDto[]
}

export interface DraftDto {
  id: string
  status: string
  revision: number
  groupKey: string
  subject: string
  greeting: string
  intro: string
  closing: string
  signature: string
  rows: LetterRow[]
  columns: ColumnSetting[]
  newLabel: string
  cancelLabel: string
  manualEdits: boolean
  recipients: string[]
  cc: string[]
  reviewedAt: string | null
  templateVersion: number
  createdAt: string
  fingerprint: string | null
}

export interface LetterDto {
  subject: string
  greeting: string
  intro: string
  closing: string
  signature: string
  rows: LetterRow[]
  columns: ColumnSetting[]
  newLabel: string
  cancelLabel: string
}

export interface NotificationDto {
  id: string
  group_key: string
  transport_status: 'sending' | 'sent' | 'send_failed' | 'delivery_unknown' | 'handed_off' | 'external_confirmed'
  sent_at: string | null
  external_confirmation_at: string | null
  created_at: string
  revision: number
  subject?: string | null
  letter: LetterDto | null
}

export interface AuditDto {
  id: string
  occurred_at: string
  action: string
  entity_type: string
  result: 'ok' | 'error' | 'denied'
  group_key: string | null
  service_actor: string | null
  display_name: string | null
  safe_details: Record<string, unknown>
}

export interface SnapshotDto {
  id: string
  seq: number
  source: string
  series_id: string
  fetched_at: string
  window_from: string | null
  window_to: string | null
  validation_status: string
  completeness: string
  issue_count: number
  row_count: number
}

export interface SettingsDto {
  pollMinutes: number
  quietMinutes: number
  autoCheck: boolean
  autoPrepare: boolean
  stayScope: StayScope
  staleAfterMinutes: number
  templateVersion: number
  version: number
  senderName: string
  requireHumanReview: boolean
}

export interface HotelDto {
  id: string
  source_hotel_id: string | null
  name: string
  city: string
  airport_code: string
  timezone: string
  recipients: string[]
  cc: string[]
  contract_status: ContractStatus
  active: boolean
  row_version: number
  comment: string | null
}

export interface TemplateDto {
  template_key: 'adjustment' | 'new_booking' | 'cancellation'
  version: number
  blocks: Array<Pick<TemplateBlock, 'kind' | 'text'>>
  columns: ColumnSetting[]
  new_label: string
  cancel_label: string
}

export interface IntegrationDto {
  adapter: 'source' | 'mail'
  mode: string
  configured: boolean
}

export interface DirectoryHotel extends Hotel {
  sourceHotelId: string
  version: number
}

export interface ChangeView {
  id: string
  fullName: string
  groupKey: string
  linkedGroupKey: string | null
  replacement: boolean
  kind: ChangeKind
  fields: FieldDelta[]
  detectedAt: string | null
}

export interface Letter {
  id: string
  groupKey: string
  revision: number
  status: string
  templateVersion: number
  recipients: string[]
  cc: string[]
  subject: string
  greeting: string
  intro: string
  closing: string
  signature: string
  rows: LetterRow[]
  columns: ColumnSetting[]
  newLabel: string
  cancelLabel: string
  manualEdits: boolean
  reviewedAt: string | null
  createdAt: string
  fingerprint: string | null
}

export interface WorkGroup {
  key: string
  groupKey: string
  hotel: Hotel
  airportCode: string
  localStayDate: string
  changes: ChangeView[]
  lastChangeAt: string | null
  dueAt: string | null
  status: QueueStatus
  exceptions: GroupException[]
  draftId: string | null
  revision: number | null
  crewNames: string[]
}

export interface Notice {
  id: string
  groupKey: string
  revision: number
  transport: NotificationDto['transport_status']
  subject: string | null
  letter: LetterDto | null
  hotelName: string
  airportCode: string
  localStayDate: string
  timezoneLabel: string
  createdAt: string
  sentAt: string | null
}

export interface JournalEntry {
  id: string
  timestamp: string
  actor: string
  action: string
  hotelName: string
  localStayDate: string
  description: string
  result: 'ok' | 'error' | 'info'
  groupKey: string | null
}

export interface SnapshotItem {
  id: string
  label: string
  source: string
  fetchedAt: string
  windowFrom: string | null
  windowTo: string | null
  rowCount: number
  issueCount: number
}
