import { createHash } from 'node:crypto'

export function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
    return Object.fromEntries(entries.map(([key, item]) => [key, sortValue(item)]))
  }
  return value
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value))
}
