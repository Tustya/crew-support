let onUnauthenticated: (() => void) | null = null

export function setUnauthenticatedHandler(handler: () => void): void {
  onUnauthenticated = handler
}

export class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

export async function api<T>(path: string, options: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
  const headers = new Headers(options.headers)
  headers.set('x-crew-request', '1')
  let body: BodyInit | undefined
  if (options.body instanceof ArrayBuffer) {
    headers.set('content-type', 'application/octet-stream')
    body = options.body
  } else if (options.body !== undefined) {
    headers.set('content-type', 'application/json')
    body = JSON.stringify(options.body)
  }
  const response = await fetch(path, { method: options.method ?? 'GET', headers, body, credentials: 'include' })
  if (response.status === 204) return undefined as T
  const text = await response.text()
  const payload = text ? (JSON.parse(text) as { error?: { code?: string; message?: string } }) : {}
  if (!response.ok) {
    if (response.status === 401 && path !== '/api/v1/session') onUnauthenticated?.()
    throw new ApiError(response.status, payload.error?.code ?? 'INTERNAL', payload.error?.message ?? 'Ошибка запроса')
  }
  return payload as T
}
