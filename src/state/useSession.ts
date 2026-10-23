import { createContext, useContext } from 'react'
import type { Me } from '../api/types'

export interface Session {
  me: Me | null
  ready: boolean
  error: string | null
  signIn: (email: string, password: string) => Promise<void>
  leave: () => void
}

export const SessionContext = createContext<Session | null>(null)

export function useSession(): Session {
  const value = useContext(SessionContext)
  if (!value) throw new Error('session missing')
  return value
}
