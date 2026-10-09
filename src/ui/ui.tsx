import { useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { create } from 'zustand'

type ToastTone = 'info' | 'ok' | 'error'

interface ToastItem {
  id: string
  text: string
  tone: ToastTone
}

interface UiState {
  mailDirty: boolean
  settingsDirty: boolean
  toasts: ToastItem[]
  setMailDirty: (value: boolean) => void
  setSettingsDirty: (value: boolean) => void
  pushToast: (text: string, tone?: ToastTone) => void
  dismissToast: (id: string) => void
}

export const useUi = create<UiState>((set) => ({
  mailDirty: false,
  settingsDirty: false,
  toasts: [],
  setMailDirty: (mailDirty) => set({ mailDirty }),
  setSettingsDirty: (settingsDirty) => set({ settingsDirty }),
  pushToast: (text, tone = 'info') => {
    const id = `toast-${Date.now()}`
    set((state) => ({ toasts: [...state.toasts, { id, text, tone }] }))
    window.setTimeout(() => {
      set((state) => ({ toasts: state.toasts.filter((item) => item.id !== id) }))
    }, 4200)
  },
  dismissToast: (id) => set((state) => ({ toasts: state.toasts.filter((item) => item.id !== id) })),
}))

export function Button({
  tone = 'secondary',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: 'primary' | 'accent' | 'secondary' | 'ghost' | 'danger' }) {
  const tones = {
    primary: 'bg-brand-strong text-white hover:brightness-110',
    accent: 'bg-accent text-white hover:brightness-110',
    secondary: 'bg-surface text-ink border border-line hover:bg-muted',
    ghost: 'bg-transparent text-brand-strong hover:bg-brand-soft',
    danger: 'bg-surface text-danger border border-line hover:bg-muted',
  }
  return (
    <button
      {...props}
      className={`inline-flex h-11 items-center justify-center gap-2 rounded-[14px] px-4 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${tones[tone]} ${props.className ?? ''}`}
    />
  )
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'info' | 'ok' | 'warn' | 'danger' }) {
  const tones = {
    neutral: 'bg-muted text-ink-soft',
    info: 'bg-brand-soft text-brand-strong',
    ok: 'bg-[#e5f6ee] text-ok',
    warn: 'bg-[#fff4df] text-warn',
    danger: 'bg-[#fdeceb] text-danger',
  }
  return <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ${tones[tone]}`}>{children}</span>
}

export function Banner({ tone = 'warn', children, action }: { tone?: 'warn' | 'danger' | 'info'; children: ReactNode; action?: ReactNode }) {
  const tones = { warn: 'bg-[#fff4df] text-warn', danger: 'bg-[#fdeceb] text-danger', info: 'bg-brand-soft text-ink' }
  return (
    <div className={`flex flex-wrap items-center justify-between gap-3 rounded-2xl px-4 py-3 text-sm ${tones[tone]}`}>
      <div>{children}</div>
      {action}
    </div>
  )
}

export function EmptyState({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-4 rounded-3xl bg-surface px-6 py-10 shadow-card">
      <div className="grid h-12 w-12 place-items-center rounded-2xl bg-muted text-xl text-brand-strong" aria-hidden>
        ○
      </div>
      <p className="text-lg font-bold">{title}</p>
      {action}
    </div>
  )
}

export function Field({ label, children, error }: { label: string; children: ReactNode; error?: string }) {
  return (
    <label className="grid gap-1.5 text-sm">
      <span className="font-semibold">{label}</span>
      {children}
      {error ? <span className="text-danger">{error}</span> : null}
    </label>
  )
}

export const fieldClass = 'h-11 rounded-xl border border-line bg-muted px-3 text-ink outline-none'

export function Dialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const titleId = useId()
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    dialog.showModal()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    dialog.addEventListener('keydown', onKey)
    return () => dialog.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <dialog ref={ref} aria-labelledby={titleId} className="w-[min(560px,calc(100%-32px))] rounded-3xl border-0 bg-surface p-0 text-ink shadow-card backdrop:bg-[#003478]/40">
      <div className="grid gap-4 p-6">
        <h2 id={titleId} className="text-lg font-bold">
          {title}
        </h2>
        {children}
      </div>
    </dialog>
  )
}

export function Drawer({ title, children, onClose, width = 520 }: { title: string; children: ReactNode; onClose: () => void; width?: number }) {
  const titleId = useId()
  const closeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    closeRef.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-[#003478]/30">
      <button type="button" className="h-full flex-1 cursor-default" aria-label="Закрыть" onClick={onClose} />
      <aside role="dialog" aria-labelledby={titleId} className="flex h-full max-w-[90vw] flex-col bg-surface shadow-card" style={{ width }}>
        <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-4">
          <h2 id={titleId} className="text-lg font-bold">
            {title}
          </h2>
          <button ref={closeRef} type="button" className="h-10 rounded-xl px-3 text-sm font-semibold text-brand-strong" onClick={onClose}>
            Закрыть
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-5 py-4">{children}</div>
      </aside>
    </div>
  )
}

export function Toasts() {
  const toasts = useUi((state) => state.toasts)
  const dismiss = useUi((state) => state.dismissToast)
  return (
    <div className="fixed bottom-4 right-4 z-50 grid gap-2">
      {toasts.map((toast) => (
        <button key={toast.id} type="button" onClick={() => dismiss(toast.id)} className="max-w-sm rounded-2xl bg-ink px-4 py-3 text-left text-sm text-white shadow-card">
          {toast.text}
        </button>
      ))}
    </div>
  )
}
