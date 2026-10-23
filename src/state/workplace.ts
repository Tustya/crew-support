import { create } from 'zustand'
import { toDirectoryHotel, toJournalEntry, toLetter, toNotice, toSnapshotItem, toTemplate, toWorkGroup } from '../api/adapters'
import { api, ApiError } from '../api/client'
import type {
  AuditDto,
  DirectoryHotel,
  DraftDto,
  GroupDto,
  HotelDto,
  IntegrationDto,
  JournalEntry,
  Letter,
  Notice,
  NotificationDto,
  OverviewDto,
  SettingsDto,
  SnapshotDto,
  SnapshotItem,
  SourceDto,
  TemplateDto,
  WorkGroup,
} from '../api/types'
import { sourceProblemText } from '../domain/labels'
import { defaultTemplate } from '../domain/templates'
import type { MailTemplate, TemplateId } from '../domain/types'

type Templates = Record<TemplateId, MailTemplate>

export interface LetterEdits {
  subject: string
  intro: string
  closing: string
  signature: string
  recipients: string[]
}

interface Toast {
  id: number
  text: string
}

interface WorkplaceState {
  loaded: boolean
  generation: number | null
  nowIso: string
  groups: WorkGroup[]
  letters: Record<string, Letter>
  hotels: DirectoryHotel[]
  notices: Notice[]
  journal: JournalEntry[]
  snapshots: SnapshotItem[]
  settings: SettingsDto | null
  templates: Templates
  source: SourceDto | null
  integrations: IntegrationDto[]
  busy: string | null
  toasts: Toast[]
  refresh: () => Promise<void>
  tick: () => void
  clear: () => void
  pushToast: (text: string) => void
  dismissToast: (id: number) => void
  fetchCorrections: (basis: 'baseline' | 'previous') => Promise<WorkGroup[]>
  loadLetter: (groupKey: string) => Promise<void>
  openNotice: (noticeId: string) => Promise<void>
  importWorkbook: (file: File) => Promise<boolean>
  prepareGroup: (groupKey: string) => Promise<void>
  saveLetter: (letter: Letter, edits: LetterEdits) => Promise<void>
  reviewLetter: (letter: Letter) => Promise<void>
  handoffLetter: (letter: Letter) => Promise<void>
  sendLetter: (letter: Letter) => Promise<void>
  rebuildLetter: (letter: Letter) => Promise<void>
  confirmOutside: (noticeId: string, basis: string) => Promise<void>
  saveSettings: (patch: Partial<SettingsDto>) => Promise<void>
  publishTemplate: (id: TemplateId, template: MailTemplate) => Promise<void>
  saveHotel: (hotel: DirectoryHotel) => Promise<boolean>
}

const TEMPLATE_IDS: TemplateId[] = ['adjustment', 'new_booking', 'cancellation']

function defaultTemplates(): Templates {
  return { adjustment: defaultTemplate('adjustment'), new_booking: defaultTemplate('new_booking'), cancellation: defaultTemplate('cancellation') }
}

const EMPTY = {
  loaded: false,
  generation: null as number | null,
  groups: [],
  letters: {},
  hotels: [],
  notices: [],
  journal: [],
  snapshots: [],
  settings: null,
  templates: defaultTemplates(),
  source: null,
  integrations: [],
  busy: null,
}

let toastSeq = 0
let refreshQueue: Promise<void> = Promise.resolve()
let loadedScreen = ''

function screenOf(pathname: string): string {
  if (pathname.startsWith('/corrections')) return 'corrections'
  if (pathname.startsWith('/mail')) return 'mail'
  if (pathname.startsWith('/history')) return 'history'
  if (pathname.startsWith('/settings')) return 'settings'
  return 'overview'
}

async function loadScreen(set: (partial: Partial<WorkplaceState>) => void, get: () => WorkplaceState): Promise<void> {
  try {
    const revision = await api<{ generation: number }>('/api/v1/revision')
    const screen = screenOf(window.location.pathname)
    if (revision.generation === get().generation && get().loaded && loadedScreen === screen) return
    if (screen === 'overview') await loadOverview(set, get)
    else if (screen === 'corrections') await loadCorrections(set)
    else if (screen === 'mail') await loadMail(set, get)
    else if (screen === 'history') await loadHistory(set)
    else await loadSettings(set)
    loadedScreen = screen
    set({ loaded: true, generation: revision.generation, nowIso: new Date().toISOString() })
  } catch (reason) {
    set({ loaded: true })
    if (reason instanceof ApiError && reason.status === 401) return
    get().pushToast(message(reason))
  }
}

async function loadOverview(set: (partial: Partial<WorkplaceState>) => void, get: () => WorkplaceState): Promise<void> {
  const [overview, groupPage] = await Promise.all([
    api<OverviewDto>('/api/v1/overview'),
    api<{ items: GroupDto[] }>('/api/v1/groups?limit=100'),
  ])
  const hotels = get().hotels
  set({
    source: overview.source,
    groups: groupPage.items.map((group) => toWorkGroup(group, hotels)),
    journal: overview.recentEvents.map((item) => toJournalEntry(item, hotels)),
  })
}

async function loadCorrections(set: (partial: Partial<WorkplaceState>) => void): Promise<void> {
  const [groupPage, snapshotPage] = await Promise.all([
    api<{ items: GroupDto[] }>('/api/v1/groups?limit=100'),
    api<{ items: SnapshotDto[] }>('/api/v1/snapshots'),
  ])
  set({
    groups: groupPage.items.map((group) => toWorkGroup(group, [])),
    snapshots: snapshotPage.items.map(toSnapshotItem),
  })
}

async function loadMail(set: (partial: Partial<WorkplaceState>) => void, get: () => WorkplaceState): Promise<void> {
  const [groupPage, hotelPage, noticePage] = await Promise.all([
    api<{ items: GroupDto[] }>('/api/v1/groups?limit=100'),
    api<{ items: HotelDto[] }>('/api/v1/hotels'),
    api<{ items: NotificationDto[] }>('/api/v1/notifications'),
  ])
  const hotels = hotelPage.items.map(toDirectoryHotel)
  const groups = groupPage.items.map((group) => toWorkGroup(group, hotels))
  const selectedKey = new URLSearchParams(window.location.search).get('group')
  const selected = groups.find((group) => group.key === selectedKey && group.draftId) ?? null
  const letter = selected?.draftId ? toLetter(await api<DraftDto>(`/api/v1/drafts/${selected.draftId}`), selected.key) : null
  set({
    hotels,
    groups,
    notices: noticePage.items.map((item) => toNotice(item, hotels)),
    letters: letter ? { ...get().letters, [letter.groupKey]: letter } : get().letters,
  })
}

async function loadHistory(set: (partial: Partial<WorkplaceState>) => void): Promise<void> {
  const [groupPage, hotelPage, noticePage, auditPage, snapshotPage] = await Promise.all([
    api<{ items: GroupDto[] }>('/api/v1/groups?limit=100'),
    api<{ items: HotelDto[] }>('/api/v1/hotels'),
    api<{ items: NotificationDto[] }>('/api/v1/notifications'),
    api<{ items: AuditDto[] }>('/api/v1/audit/events?limit=100'),
    api<{ items: SnapshotDto[] }>('/api/v1/snapshots'),
  ])
  const hotels = hotelPage.items.map(toDirectoryHotel)
  set({
    hotels,
    groups: groupPage.items.map((group) => toWorkGroup(group, hotels)),
    notices: noticePage.items.map((item) => toNotice(item, hotels)),
    journal: auditPage.items.map((item) => toJournalEntry(item, hotels)),
    snapshots: snapshotPage.items.map(toSnapshotItem),
  })
}

async function loadSettings(set: (partial: Partial<WorkplaceState>) => void): Promise<void> {
  const [settings, templatePage, hotelPage, integrationPage, snapshotPage, source, groupPage] = await Promise.all([
    api<SettingsDto>('/api/v1/settings'),
    api<{ items: TemplateDto[] }>('/api/v1/templates'),
    api<{ items: HotelDto[] }>('/api/v1/hotels'),
    api<{ items: IntegrationDto[] }>('/api/v1/integrations/status'),
    api<{ items: SnapshotDto[] }>('/api/v1/snapshots'),
    api<SourceDto>('/api/v1/source/status'),
    api<{ items: GroupDto[] }>('/api/v1/groups?limit=100'),
  ])
  const hotels = hotelPage.items.map(toDirectoryHotel)
  const templates = Object.fromEntries(TEMPLATE_IDS.map((id) => [id, toTemplate(templatePage.items.find((item) => item.template_key === id), id)])) as Templates
  set({
    settings,
    templates,
    hotels,
    integrations: integrationPage.items,
    snapshots: snapshotPage.items.map(toSnapshotItem),
    source,
    groups: groupPage.items.map((group) => toWorkGroup(group, hotels)),
  })
}

function message(reason: unknown): string {
  if (!(reason instanceof ApiError)) return 'Нет связи с сервером'
  if (reason.code.startsWith('SOURCE_') && reason.code !== 'SOURCE_SCHEMA_UNVERIFIED') return `${sourceProblemText(reason.code)}. Загрузите свежий Excel и повторите`
  return reason.message
}

function hotelBody(hotel: DirectoryHotel): Record<string, unknown> {
  return {
    sourceHotelId: hotel.sourceHotelId || null,
    name: hotel.name,
    city: hotel.city,
    airportCode: hotel.airportCode,
    timezone: hotel.timezone,
    recipients: hotel.recipients,
    cc: hotel.cc,
    contractStatus: hotel.contractStatus,
    active: hotel.active,
    comment: hotel.comment,
  }
}

export const useWorkplace = create<WorkplaceState>()((set, get) => {
  const run = async (busy: string, action: () => Promise<unknown>, success: string): Promise<boolean> => {
    if (get().busy) return false
    set({ busy })
    try {
      await action()
      get().pushToast(success)
      return true
    } catch (reason) {
      get().pushToast(message(reason))
      return false
    } finally {
      set({ busy: null })
      await get().refresh()
    }
  }

  return {
    ...EMPTY,
    nowIso: new Date().toISOString(),
    toasts: [],
    refresh: () => {
      const job = refreshQueue.then(() => loadScreen(set, get))
      refreshQueue = job.catch(() => undefined)
      return job
    },
    tick: () => set({ nowIso: new Date().toISOString() }),
    clear: () => {
      loadedScreen = ''
      set({ ...EMPTY, templates: defaultTemplates(), toasts: [] })
    },
    pushToast: (text) => {
      const id = ++toastSeq
      set((state) => ({ toasts: [...state.toasts.slice(-2), { id, text }] }))
      window.setTimeout(() => get().dismissToast(id), 5000)
    },
    dismissToast: (id) => set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })),
    fetchCorrections: async (basis) => {
      const page = await api<{ items: GroupDto[] }>(`/api/v1/corrections?basis=${basis}&limit=100`)
      return page.items.map((group) => toWorkGroup(group, get().hotels))
    },
    loadLetter: async (groupKey) => {
      const group = get().groups.find((item) => item.key === groupKey)
      if (!group?.draftId) return
      const letter = toLetter(await api<DraftDto>(`/api/v1/drafts/${group.draftId}`), group.key)
      set((state) => ({ letters: { ...state.letters, [group.key]: letter } }))
    },
    openNotice: async (noticeId) => {
      const row = await api<{ archived_payload?: { letter?: DraftDto | null } }>(`/api/v1/notifications/${noticeId}`)
      const letter = row.archived_payload?.letter ?? null
      set((state) => ({ notices: state.notices.map((item) => (item.id === noticeId ? { ...item, letter } : item)) }))
    },
    importWorkbook: (file) =>
      run(
        'import',
        async () => api('/api/v1/imports', { method: 'POST', body: await file.arrayBuffer(), headers: { 'x-filename': encodeURIComponent(file.name) } }),
        `Файл ${file.name} загружен`,
      ),
    prepareGroup: async (groupKey) => {
      const group = get().groups.find((item) => item.key === groupKey)
      const bypassQuiet = Boolean(group?.dueAt && group.dueAt > new Date().toISOString())
      await run('prepare', () => api(`/api/v1/groups/${groupKey}/prepare`, { method: 'POST', body: { bypassQuiet, reason: bypassQuiet ? 'Подготовлено вручную' : null } }), 'Черновик собран')
    },
    saveLetter: async (letter, edits) => {
      await run(
        `letter:${letter.id}`,
        () => api(`/api/v1/drafts/${letter.id}`, { method: 'PATCH', body: { expectedRevision: letter.revision, ...edits, cc: letter.cc, overrides: [] } }),
        'Черновик сохранён',
      )
    },
    reviewLetter: async (letter) => {
      await run(`letter:${letter.id}`, () => api(`/api/v1/drafts/${letter.id}/review`, { method: 'POST', body: { revision: letter.revision, fingerprint: letter.fingerprint, confirmed: true } }), 'Письмо проверено')
    },
    handoffLetter: async (letter) => {
      await run(
        `letter:${letter.id}`,
        () => api(`/api/v1/drafts/${letter.id}/handoff`, { method: 'POST', headers: { 'idempotency-key': crypto.randomUUID() }, body: { revision: letter.revision } }),
        'Передано в почту. Подтвердите отправку во вкладке «Отправленные»',
      )
    },
    sendLetter: async (letter) => {
      await run(
        `letter:${letter.id}`,
        () => api(`/api/v1/drafts/${letter.id}/send`, { method: 'POST', headers: { 'idempotency-key': crypto.randomUUID() }, body: { revision: letter.revision, confirmed: true } }),
        'Письмо передано на отправку',
      )
    },
    rebuildLetter: async (letter) => {
      await run(`letter:${letter.id}`, () => api(`/api/v1/drafts/${letter.id}/rebuild`, { method: 'POST', body: {} }), 'Черновик пересобран')
    },
    confirmOutside: async (noticeId, basis) => {
      await run(
        `notice:${noticeId}`,
        () => api(`/api/v1/notifications/${noticeId}/confirm-external`, { method: 'POST', body: { confirmed: true, basis, sentAt: new Date().toISOString() } }),
        'Отправка подтверждена, база обновлена',
      )
    },
    saveSettings: async (patch) => {
      const version = get().settings?.version
      if (version === undefined) return
      await run('settings', () => api('/api/v1/settings', { method: 'PATCH', body: patch, headers: { 'if-match': String(version) } }), 'Настройки сохранены')
    },
    publishTemplate: async (id, template) => {
      await run(
        'template',
        () =>
          api(`/api/v1/templates/${id}/versions`, {
            method: 'POST',
            body: { blocks: template.blocks.map((block) => ({ kind: block.kind, text: block.text })), columns: template.columns, newLabel: template.newLabel, cancelLabel: template.cancelLabel },
          }),
        'Шаблон опубликован',
      )
    },
    saveHotel: (hotel) => {
      const known = get().hotels.some((item) => item.id === hotel.id)
      return run(
        'hotel',
        () =>
          known
            ? api(`/api/v1/hotels/${hotel.id}`, { method: 'PATCH', body: hotelBody(hotel), headers: { 'if-match': String(hotel.version) } })
            : api('/api/v1/hotels', { method: 'POST', body: hotelBody(hotel) }),
        'Гостиница сохранена',
      )
    },
  }
})
