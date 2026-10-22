export interface IdentityMatch<T> {
  pairs: Array<{ before: T; after: T }>
  added: T[]
  removed: T[]
  ambiguous: boolean
}

function onlyUniqueIds(ids: Array<string | null>): ids is string[] {
  if (ids.some((id) => id === null || id === '')) return false
  return new Set(ids).size === ids.length
}

function buckets<T>(rows: readonly T[], contentOf: (row: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>()
  for (const row of rows) {
    const key = contentOf(row)
    const list = grouped.get(key)
    if (list) list.push(row)
    else grouped.set(key, [row])
  }
  return grouped
}

export function matchByIdentity<T>(
  before: readonly T[],
  after: readonly T[],
  identityOf: (row: T) => string | null,
  contentOf: (row: T) => string,
): IdentityMatch<T> {
  const beforeIds = before.map(identityOf)
  const afterIds = after.map(identityOf)
  if (onlyUniqueIds(beforeIds) && onlyUniqueIds(afterIds)) {
    const beforeById = new Map(before.map((row, index) => [beforeIds[index], row]))
    const afterById = new Map(after.map((row, index) => [afterIds[index], row]))
    const pairs: Array<{ before: T; after: T }> = []
    const added: T[] = []
    for (const [id, row] of afterById) {
      const previous = beforeById.get(id)
      if (previous) pairs.push({ before: previous, after: row })
      else added.push(row)
    }
    const removed: T[] = []
    for (const [id, row] of beforeById) {
      if (!afterById.has(id)) removed.push(row)
    }
    return { pairs, added, removed, ambiguous: false }
  }

  const beforeBuckets = buckets(before, contentOf)
  const afterBuckets = buckets(after, contentOf)
  const keys = new Set([...beforeBuckets.keys(), ...afterBuckets.keys()])
  const pairs: Array<{ before: T; after: T }> = []
  let ambiguous = false
  for (const key of keys) {
    const left = beforeBuckets.get(key) ?? []
    const right = afterBuckets.get(key) ?? []
    const shared = Math.min(left.length, right.length)
    for (let index = 0; index < shared; index += 1) pairs.push({ before: left[index] as T, after: right[index] as T })
    if (left.length !== right.length) ambiguous = true
  }
  return { pairs, added: [], removed: [], ambiguous }
}
