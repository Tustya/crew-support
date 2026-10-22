export type Role = 'specialist' | 'lead'
export type RoomType = 'SGL' | 'DBL'
export type Gender = 'F' | 'M'
export type ContractStatus = 'confirmed' | 'none' | 'unknown'
export type RecipientSource = 'aviabit' | 'local'
export type RecordStatus = 'active' | 'cancelled'
export type SourceMode = 'demo_api' | 'manual_samples'
export type MailMode = 'in_app' | 'handoff'
export type StayScope = 'today' | 'tomorrow' | 'both'
export type SourceStatus = 'unknown' | 'ok' | 'error' | 'disabled'
export type ScenarioId =
  | 'calm'
  | 'delays'
  | 'errors'
  | 'stale'
  | 'replacement'
  | 'send_error'
  | 'reverted'
  | 'unknown_base'

export type ChangeKind =
  | 'added'
  | 'cancelled'
  | 'arrival'
  | 'departure'
  | 'flight'
  | 'room'
  | 'hotel_change'
  | 'date_change'

export type QueueStatus =
  | 'unchanged'
  | 'needs_baseline'
  | 'waiting'
  | 'preparing'
  | 'needs_review'
  | 'reviewed'
  | 'handed_off'
  | 'sent'
  | 'stale'
  | 'needs_decision'

export type DraftStatus = 'active' | 'reviewed' | 'handed_off' | 'sent' | 'archived'
export type TemplateId = 'adjustment' | 'new_booking' | 'cancellation'
export type ColumnKey =
  | 'fullName'
  | 'arrivalFlight'
  | 'arrivalDate'
  | 'arrivalTime'
  | 'departureFlight'
  | 'departureDate'
  | 'departureTime'
  | 'roomType'

export interface Hotel {
  id: string
  name: string
  city: string
  airportCode: string
  airportName: string
  timezone: string
  utcOffset: string
  recipients: string[]
  cc: string[]
  contractStatus: ContractStatus
  active: boolean
  recipientSource: RecipientSource
  comment: string
  sourceRecipients: string[]
  sourceCc: string[]
}

export interface Booking {
  id: string
  crewId: string
  fullName: string
  hotelId: string
  airportCode: string
  localStayDate: string
  arrivalFlight: string
  arrivalLocalDate: string
  arrivalLocalTime: string
  departureFlight: string
  departureLocalDate: string
  departureLocalTime: string
  roomType: RoomType
  gender: Gender
  recordStatus: RecordStatus
  replacementOf?: string
}

export interface FieldDelta {
  field: string
  label: string
  before: string
  after: string
}

export interface ChangeEvent {
  id: string
  bookingId: string
  crewId: string
  fullName: string
  groupKey: string
  linkedGroupKey?: string
  replacementId?: string
  kind: ChangeKind
  fields: FieldDelta[]
  beforeBooking: Booking | null
  afterBooking: Booking | null
  detectedAt: string
  fromSnapshotId: string
  toSnapshotId: string
}

export interface ValidationIssue {
  bookingId: string
  field: string
  message: string
}

export interface Snapshot {
  id: string
  source: 'demo_api' | 'demo_file'
  fetchedAt: string
  label: string
  windowFrom: string
  windowTo: string
  bookings: Booking[]
  validationIssues: ValidationIssue[]
  scenarioId: ScenarioId | 'sample'
  seriesId: string
  sequence: number
}

export interface GroupTimer {
  quietStartedAt: string
  lastChangeAt: string
  dueAt: string
}

export interface Baseline {
  groupKey: string
  bookings: Booking[]
  originatingSnapshotId: string
  establishedBy: 'scenario' | 'send' | 'external_confirm' | 'manual_base'
  notificationId: string | null
  notifiedAt: string
  roomPairs?: string[][]
}

export interface ColumnSetting {
  key: ColumnKey
  title: string
  visible: boolean
}

export interface TemplateBlock {
  id: string
  kind: 'subject' | 'greeting' | 'intro' | 'header' | 'table' | 'closing' | 'signature'
  title: string
  hint: string
  text: string
  required: boolean
}

export interface MailTemplate {
  id: TemplateId
  name: string
  blocks: TemplateBlock[]
  columns: ColumnSetting[]
  newLabel: string
  cancelLabel: string
}

export interface Settings {
  sourceMode: SourceMode
  aviabitBaseUrl: string
  reportName: string
  sourceTimezone: string
  mailMode: MailMode
  connectionName: string
  senderName: string
  senderAddress: string
  replyTo: string
  serviceCc: string
  mailEndpoint: string
  draftFolder: string
  autoCheck: boolean
  pollMinutes: number
  quietMinutes: number
  stayScope: StayScope
  staleAfterMinutes: number
  autoPrepare: boolean
  requireHumanReview: true
  templateVersion: number
  templates: Record<TemplateId, MailTemplate>
}

export interface MailRow {
  bookingId: string
  fullName: string
  arrivalFlight: string
  arrivalDate: string
  arrivalTime: string
  departureFlight: string
  departureDate: string
  departureTime: string
  roomType: string
  gender: Gender
  roomKey: string
  roomLabel: string
  badge: 'new' | 'cancel' | null
  changedFields: ColumnKey[]
  manualFields: ColumnKey[]
}

export type LetterRow = Omit<MailRow, 'gender'>

export interface RowOverride {
  bookingId: string
  field: ColumnKey
  value: string
  note: string
}

export interface Draft {
  id: string
  groupKey: string
  revision: number
  sourceSnapshotId: string
  templateId: TemplateId
  templateVersion: number
  dataFingerprint: string
  recipientKey: string
  recipients: string[]
  cc: string[]
  subject: string
  greeting: string
  intro: string
  closing: string
  signature: string
  rows: MailRow[]
  columns: ColumnSetting[]
  newLabel: string
  cancelLabel: string
  overrides: RowOverride[]
  manualEdits: boolean
  saved: boolean
  status: DraftStatus
  reviewedRevision: number | null
  reviewedAt: string | null
  reviewedBy: string | null
  createdAt: string
  isTest: boolean
  hotelName: string
  city: string
  airportCode: string
  localStayDate: string
  timezoneLabel: string
}

export interface NotificationRecord {
  id: string
  draftId: string
  revision: number
  groupKey: string
  subject: string
  greeting: string
  intro: string
  closing: string
  signature: string
  rows: MailRow[]
  columns: ColumnSetting[]
  newLabel: string
  cancelLabel: string
  recipients: string[]
  cc: string[]
  hotelName: string
  airportCode: string
  localStayDate: string
  timezoneLabel: string
  transport: 'sent' | 'handed_off' | 'external_confirmed'
  actor: string
  reviewer: string
  reviewedAt: string | null
  createdAt: string
  sentAt: string | null
  handedOffAt: string | null
  templateVersion: number
}

export interface Activity {
  id: string
  timestamp: string
  actor: string
  action: string
  hotelName: string
  airportCode: string
  localStayDate: string
  description: string
  result: 'ok' | 'error' | 'info'
  groupKey: string | null
  draftId: string | null
  revision: number | null
}

export interface ManualHold {
  groupKey: string
  comment: string
  createdAt: string
}

export interface UploadedFileInfo {
  name: string
  sizeBytes: number
  addedAt: string
}

export interface DemoData {
  schemaVersion: 1
  phase: 'welcome' | 'running'
  scenarioId: ScenarioId
  role: Role
  clockIso: string
  clockPaused: boolean
  settings: Settings
  hotels: Hotel[]
  snapshots: Snapshot[]
  baselines: Record<string, Baseline>
  baselineEstablished: boolean
  drafts: Draft[]
  notifications: NotificationRecord[]
  activities: Activity[]
  groupTimers: Record<string, GroupTimer>
  sourceStatus: SourceStatus
  sourceOutage: boolean
  lastSuccessAt: string | null
  lastErrorAt: string | null
  nextCheckAt: string | null
  checking: boolean
  checkOperationId: string | null
  sendingDraftId: string | null
  preparingGroupKey: string | null
  mailFailOnce: boolean
  uploadedFile: UploadedFileInfo | null
  historicalCompare: { leftId: string; rightId: string } | null
  resolvedExceptionIds: string[]
  manualHolds: ManualHold[]
  changeCursor: number
  seriesId: string
}

export interface GroupException {
  id: string
  kind:
    | 'no_address'
    | 'no_contract'
    | 'ambiguous'
    | 'normalization'
    | 'outside_period'
    | 'unknown_hotel'
    | 'inactive'
    | 'manual'
    | 'missing_token'
  blocking: boolean
  message: string
}

export interface GroupView {
  key: string
  hotel: Hotel
  airportCode: string
  localStayDate: string
  changes: ChangeEvent[]
  lastChangeAt: string | null
  dueAt: string | null
  status: QueueStatus
  exceptions: GroupException[]
  draft: Draft | null
  latestBookings: Booking[]
  baselineBookings: Booking[] | null
  liveFingerprint: string
  recipientKey: string
}
