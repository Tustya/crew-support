export function demoDelay(ms = 1200): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

export interface SnapshotSource {
  pull(outage: boolean): Promise<{ ok: boolean; reason: string }>
}

export interface MailTransport {
  deliver(failOnce: boolean): Promise<{ ok: boolean; reason: string }>
}

export const demoSnapshotSource: SnapshotSource = {
  async pull(outage) {
    await demoDelay()
    return outage ? { ok: false, reason: 'Демо-API не ответил' } : { ok: true, reason: 'Демо-отчёт доступен' }
  },
}

export const demoMailTransport: MailTransport = {
  async deliver(failOnce) {
    await demoDelay()
    return failOnce ? { ok: false, reason: 'Демо-почта отклонила отправку' } : { ok: true, reason: 'Демо-отправка принята' }
  },
}
