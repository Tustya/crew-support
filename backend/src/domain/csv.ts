const FORMULA_PREFIX = /^[=+\-@\t\r]/

export function neutralizeCell(value: string): string {
  const safe = FORMULA_PREFIX.test(value) ? `'${value}` : value
  if (/[",\n\r]/.test(safe)) return `"${safe.replaceAll('"', '""')}"`
  return safe
}

export function buildCsv(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const lines = [headers, ...rows].map((row) => row.map((cell) => neutralizeCell(cell)).join(','))
  return `\uFEFF${lines.join('\r\n')}\r\n`
}
