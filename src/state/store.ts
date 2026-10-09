import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { emptyData } from '../domain/flow'
import { defaultSettings } from '../domain/templates'
import type { Booking, DemoData, Hotel, MailTemplate, Role, ScenarioId, Settings, TemplateId } from '../domain/types'
import {
  advance,
  applySettings,
  armSourceOutage,
  beginSend,
  checkNow,
  confirmExternal,
  establishBaseline,
  finishSend,
  handoffDraft,
  importDemoSample,
  injectDelay,
  openScenario,
  prepareNow,
  regenerateDraft,
  resolveException,
  reviewDraft,
  saveDraft,
  saveHotel,
  saveTemplate,
  type DraftEdits,
} from './ops'

interface Toast {
  id: string
  text: string
  tone: 'ok' | 'info' | 'error'
}

interface DemoStore {
  data: DemoData
  pendingPayload: Booking[] | null
  toasts: Toast[]
  persistenceError: string | null
  secrets: { aviabitToken: string; mailToken: string }
  scenarioOpen: boolean
  setScenarioOpen: (open: boolean) => void
  setSecret: (key: 'aviabitToken' | 'mailToken', value: string) => void
  pushToast: (text: string, tone: Toast['tone']) => void
  dismissToast: (id: string) => void
  startCalm: () => void
  chooseScenario: (scenarioId: ScenarioId) => void
  resetAll: () => void
  setRole: (role: Role) => void
  setPaused: (paused: boolean) => void
  advanceMinutes: (minutes: number) => void
  tickSecond: () => void
  runCheck: () => void
  armOutage: () => void
  addChange: () => void
  importSample: () => void
  setBaseline: () => void
  prepareGroup: (groupKey: string) => void
  rebuildDraft: (groupKey: string) => void
  saveLetter: (draftId: string, edits: DraftEdits) => void
  reviewLetter: (draftId: string) => void
  sendLetter: (draftId: string) => void
  handoffLetter: (draftId: string) => void
  confirmOutside: (notificationId: string) => void
  saveSettings: (settings: Settings) => void
  saveMailTemplate: (templateId: TemplateId, template: MailTemplate) => boolean
  saveDirectoryHotel: (hotel: Hotel) => void
  closeException: (exceptionId: string, comment: string) => void
  recoverSource: () => void
  disableSource: () => void
}

export const useDemoStore = create<DemoStore>()(
  persist(
    (set, get) => ({
      data: emptyData(),
      pendingPayload: null,
      toasts: [],
      persistenceError: null,
      secrets: { aviabitToken: '', mailToken: '' },
      scenarioOpen: false,
      setScenarioOpen: (scenarioOpen) => set({ scenarioOpen }),
      setSecret: (key, value) => set({ secrets: { ...get().secrets, [key]: value } }),
      pushToast: (text, tone) => {
        const id = `toast-${Date.now()}`
        set({ toasts: [...get().toasts, { id, text, tone }] })
        window.setTimeout(() => get().dismissToast(id), 4200)
      },
      dismissToast: (id) => set({ toasts: get().toasts.filter((toast) => toast.id !== id) }),
      startCalm: () => set({ data: openScenario(get().data, 'calm') }),
      chooseScenario: (scenarioId) => set({ data: openScenario(get().data, scenarioId), scenarioOpen: false }),
      resetAll: () => {
        localStorage.removeItem('crew-support-demo')
        set({ data: emptyData(), pendingPayload: null, secrets: { aviabitToken: '', mailToken: '' }, persistenceError: null })
      },
      setRole: (role) => set({ data: { ...get().data, role } }),
      setPaused: (clockPaused) => set({ data: { ...get().data, clockPaused } }),
      advanceMinutes: (minutes) => set({ data: advance(get().data, minutes * 60_000) }),
      tickSecond: () => {
        const data = get().data
        if (data.phase !== 'running' || data.clockPaused) return
        set({ data: advance(data, 1000) })
      },
      runCheck: () => {
        const data = get().data
        if (data.checking || data.phase !== 'running') return
        const checkOperationId = `check-${Date.now()}`
        set({ data: { ...data, checking: true, checkOperationId } })
        window.setTimeout(() => {
          const current = get().data
          if (current.checkOperationId !== checkOperationId) return
          const next = checkNow(current)
          const same = next.activities[0]?.description.includes('не дублировались')
          set({ data: next })
          get().pushToast(next.sourceStatus === 'error' ? 'Источник недоступен, очередь сохранена' : same ? 'Новых изменений нет' : 'Проверка завершена', next.sourceStatus === 'error' ? 'error' : 'info')
        }, 1200)
      },
      armOutage: () => set({ data: armSourceOutage(get().data) }),
      addChange: () => set({ data: injectDelay(get().data) }),
      importSample: () => set({ data: importDemoSample(get().data) }),
      setBaseline: () => set({ data: establishBaseline(get().data) }),
      prepareGroup: (groupKey) => set({ data: prepareNow(get().data, groupKey) }),
      rebuildDraft: (groupKey) => set({ data: regenerateDraft(get().data, groupKey) }),
      saveLetter: (draftId, edits) => {
        const next = saveDraft(get().data, draftId, edits)
        if (next === get().data) {
          get().pushToast('Адрес должен быть на @example.com', 'error')
          return
        }
        set({ data: next })
      },
      reviewLetter: (draftId) => set({ data: reviewDraft(get().data, draftId) }),
      sendLetter: (draftId) => {
        const started = beginSend(get().data, draftId)
        if (!started.payload) {
          get().pushToast(started.reason ?? 'Отправка недоступна', 'error')
          return
        }
        set({ data: { ...started.data, sendingDraftId: draftId }, pendingPayload: started.payload })
        window.setTimeout(() => {
          const state = get()
          if (state.data.sendingDraftId !== draftId) return
          const next = finishSend(state.data, state.pendingPayload)
          set({ data: next, pendingPayload: null })
          get().pushToast(next.activities[0]?.result === 'error' ? 'Демо-почта отклонила письмо' : 'Демо-отправка записана в историю', next.activities[0]?.result === 'error' ? 'error' : 'ok')
        }, 1200)
      },
      handoffLetter: (draftId) => {
        const next = handoffDraft(get().data, draftId)
        set({ data: next })
        get().pushToast('Передано в почту · демо. Отправка не подтверждена', 'info')
      },
      confirmOutside: (notificationId) => set({ data: confirmExternal(get().data, notificationId) }),
      saveSettings: (settings) => set({ data: applySettings(get().data, settings) }),
      saveMailTemplate: (templateId, template) => {
        const next = saveTemplate(get().data, templateId, template)
        if (!next) {
          get().pushToast('Шаблон не сохранён: проверьте переменные и метки', 'error')
          return false
        }
        set({ data: next })
        get().pushToast('Шаблон сохранён для новых писем', 'ok')
        return true
      },
      saveDirectoryHotel: (hotel) => set({ data: saveHotel(get().data, hotel) }),
      closeException: (exceptionId, comment) => set({ data: resolveException(get().data, exceptionId, comment) }),
      recoverSource: () => {
        const data = { ...get().data, sourceOutage: false, sourceStatus: 'ok' as const }
        set({ data: checkNow(data) })
        get().pushToast('Источник снова доступен', 'ok')
      },
      disableSource: () => set({ data: { ...get().data, sourceStatus: 'disabled', sourceOutage: false, nextCheckAt: null } }),
    }),
    {
      name: 'crew-support-demo',
      version: 1,
      partialize: (state) => ({ data: state.data }),
      merge: (persisted, current) => {
        const saved = persisted as { data?: DemoData }
        if (!saved.data || saved.data.schemaVersion !== 1) return current
        return {
          ...current,
          data: {
            ...saved.data,
            settings: { ...defaultSettings(), ...saved.data.settings, requireHumanReview: true },
            clockPaused: true,
            checking: false,
            sendingDraftId: null,
            preparingGroupKey: null,
            checkOperationId: null,
          },
        }
      },
      storage: createJSONStorage(() => ({
        getItem: (name) => localStorage.getItem(name),
        setItem: (name, value) => {
          try {
            localStorage.setItem(name, value)
          } catch {
            useDemoStore.setState({ persistenceError: 'Память браузера заполнена. Смена работает до обновления страницы.' })
          }
        },
        removeItem: (name) => localStorage.removeItem(name),
      })),
    },
  ),
)
