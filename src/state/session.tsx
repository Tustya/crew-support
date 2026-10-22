import { useEffect, useState, type ReactNode } from 'react'
import { api, ApiError, currentSubject, setSubject } from '../api/client'
import type { Me } from '../api/types'
import { SessionContext, type Session } from './useSession'
import { useWorkplace } from './workplace'

export function SessionProvider({ children }: { children: ReactNode }) {
  const [subject, setCurrent] = useState(currentSubject)
  const [me, setMe] = useState<Me | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loadedSubject, setLoadedSubject] = useState<string | null>(null)
  useEffect(() => {
    if (!subject) return
    let active = true
    api<Me>('/api/v1/me')
      .then((profile) => {
        if (!active) return
        setMe(profile)
        setError(null)
        void useWorkplace.getState().refresh()
      })
      .catch((reason: unknown) => {
        if (!active) return
        setSubject(null)
        setCurrent(null)
        setMe(null)
        setError(reason instanceof ApiError ? reason.message : 'Нет связи с сервером')
      })
      .finally(() => {
        if (active) setLoadedSubject(subject)
      })
    return () => {
      active = false
    }
  }, [subject])
  const value: Session = {
    me: subject ? me : null,
    ready: !subject || loadedSubject === subject,
    error,
    choose: (next) => {
      setSubject(next)
      setCurrent(next)
    },
    leave: () => {
      setSubject(null)
      setCurrent(null)
      setMe(null)
      useWorkplace.getState().clear()
    },
  }
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}
