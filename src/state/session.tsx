import { useEffect, useState, type ReactNode } from 'react'
import { api, ApiError, setUnauthenticatedHandler } from '../api/client'
import type { Me } from '../api/types'
import { SessionContext, type Session } from './useSession'
import { useWorkplace } from './workplace'

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  useEffect(() => {
    setUnauthenticatedHandler(() => {
      setMe(null)
      setError(null)
      useWorkplace.getState().clear()
    })
  }, [])
  useEffect(() => {
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
        setMe(null)
        setError(reason instanceof ApiError && reason.status === 401 ? null : reason instanceof ApiError ? reason.message : 'Нет связи с сервером')
      })
      .finally(() => {
        if (active) setReady(true)
      })
    return () => {
      active = false
    }
  }, [])
  const value: Session = {
    me,
    ready,
    error,
    signIn: async (email, password) => {
      try {
        const profile = await api<Me>('/api/v1/session', { method: 'POST', body: { email, password } })
        setMe(profile)
        setError(null)
        await useWorkplace.getState().refresh()
      } catch (reason: unknown) {
        setMe(null)
        setError(reason instanceof ApiError ? reason.message : 'Нет связи с сервером')
      }
    },
    leave: () => {
      void api('/api/v1/session/logout', { method: 'POST' }).catch(() => undefined)
      setMe(null)
      setError(null)
      useWorkplace.getState().clear()
    },
  }
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}
