import { addMinutes } from './time.ts'

export interface QuietTimer {
  quietStartedAt: string
  lastChangeAt: string
  dueAt: string
}

export function nextQuietTimer(current: QuietTimer | undefined, changedAt: string, quietMinutes: number): QuietTimer {
  return {
    quietStartedAt: current?.quietStartedAt ?? changedAt,
    lastChangeAt: changedAt,
    dueAt: addMinutes(changedAt, quietMinutes),
  }
}
