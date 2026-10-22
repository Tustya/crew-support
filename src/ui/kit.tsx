import { useEffect, useRef, type ReactNode } from 'react'

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

export function Button({
  children,
  tone = 'primary',
  disabled,
  onClick,
  type = 'button',
  title,
}: {
  children: ReactNode
  tone?: 'primary' | 'accent' | 'ghost' | 'soft'
  disabled?: boolean
  onClick?: () => void
  type?: 'button' | 'submit'
  title?: string
}) {
  const tones = {
    primary: 'bg-brand-strong text-white hover:bg-[#006a9c]',
    accent: 'bg-accent text-white hover:bg-[#d10068]',
    ghost: 'bg-white text-ink border border-line hover:bg-muted',
    soft: 'bg-brand-soft text-ink hover:bg-[#c9ebf8]',
  }
  return (
    <button
      type={type}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cx('inline-flex h-11 items-center justify-center gap-2 rounded-[14px] px-4 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50', tones[tone])}
    >
      {children}
    </button>
  )
}

const BADGE: Record<string, string> = {
  needs_review: 'bg-brand-soft text-ink',
  reviewed: 'bg-[#e5f6ee] text-ok',
  waiting: 'bg-[#fff6df] text-warn',
  preparing: 'bg-[#fff6df] text-warn',
  stale: 'bg-[#fff6df] text-warn',
  needs_decision: 'bg-[#fdecea] text-danger',
  needs_baseline: 'bg-muted text-ink-soft',
  handed_off: 'bg-muted text-ink',
  sent: 'bg-[#e5f6ee] text-ok',
  unchanged: 'bg-muted text-ink-soft',
  error: 'bg-[#fdecea] text-danger',
  ok: 'bg-[#e5f6ee] text-ok',
  info: 'bg-brand-soft text-ink',
}

export function Badge({ tone, children }: { tone: string; children: ReactNode }) {
  return <span className={cx('inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold', BADGE[tone] ?? BADGE.info)}>{children}</span>
}

function useOverlayFocus(open: boolean, onClose: () => void) {
  const closeRef = useRef<HTMLButtonElement>(null)
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])
  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    closeRef.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCloseRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      previous?.focus()
    }
  }, [open])
  return closeRef
}

export function Dialog({
  open,
  title,
  onClose,
  children,
  footer,
}: {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
}) {
  const closeRef = useOverlayFocus(open, onClose)
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4" onMouseDown={onClose}>
      <div role="dialog" aria-modal="true" aria-label={title} className="max-h-[90vh] w-full max-w-xl overflow-auto rounded-3xl bg-white p-6 shadow-card" onMouseDown={(event) => event.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between gap-4">
          <h2 className="text-lg font-bold leading-6">{title}</h2>
          <button ref={closeRef} type="button" aria-label="Закрыть" className="min-h-11 rounded-xl px-2 py-1 text-ink-soft" onClick={onClose}>
            Закрыть
          </button>
        </div>
        {children}
        {footer ? <div className="mt-5 flex flex-wrap justify-end gap-2">{footer}</div> : null}
      </div>
    </div>
  )
}

export function Drawer({
  open,
  title,
  onClose,
  children,
  width = 520,
}: {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
  width?: number
}) {
  const closeRef = useOverlayFocus(open, onClose)
  if (!open) return null
  return (
    <div className="fixed inset-0 z-40 bg-ink/30" onMouseDown={onClose}>
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{ width: `min(${width}px, 90vw)` }}
        className="absolute bottom-0 right-0 top-0 flex flex-col bg-white shadow-card"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2 className="text-lg font-bold">{title}</h2>
          <button ref={closeRef} type="button" aria-label="Закрыть" className="min-h-11 rounded-xl px-2 py-1" onClick={onClose}>
            Закрыть
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-5 py-4">{children}</div>
      </aside>
    </div>
  )
}

export function EmptyState({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-3xl bg-white px-6 py-10 shadow-card">
      <p className="text-base font-semibold">{title}</p>
      {action}
    </div>
  )
}

export function Banner({ tone, children }: { tone: 'error' | 'warn' | 'info'; children: ReactNode }) {
  const styles = {
    error: 'bg-[#fdecea] text-danger',
    warn: 'bg-[#fff6df] text-warn',
    info: 'bg-brand-soft text-ink',
  }
  return <div className={cx('rounded-2xl px-4 py-3 text-sm', styles[tone])}>{children}</div>
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5 text-sm font-semibold">
      {label}
      {children}
    </label>
  )
}

export const inputClass = 'h-11 rounded-xl border border-transparent bg-muted px-3 text-sm font-normal text-ink outline-none'
export const cardClass = 'rounded-3xl bg-white p-5 shadow-card'
