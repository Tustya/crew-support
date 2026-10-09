export function isIata(value: string): boolean {
  return /^[A-Z]{3}$/.test(value)
}
