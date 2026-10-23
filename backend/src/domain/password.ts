import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

const SCRYPT_N = 131072
const SCRYPT_R = 8
const SCRYPT_P = 1
const KEY_LENGTH = 32
const SALT_LENGTH = 16
const MAX_MEMORY = 256 * 1024 * 1024
const ACTIVE_LIMIT = 2
const WAIT_LIMIT = 16

export class AuthBusyError extends Error {
  constructor() {
    super('AUTH_BUSY')
    this.name = 'AuthBusyError'
  }
}

let activeChecks = 0
let waitingChecks = 0
let peakActiveChecks = 0
const waiters: Array<() => void> = []

export function resetPasswordCheckPeak(): void {
  peakActiveChecks = activeChecks
}

export function passwordCheckPeak(): number {
  return peakActiveChecks
}

export async function hashPassword(password: string, pepper: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH)
  const key = await deriveKey(password, pepper, salt)
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64url')}$${key.toString('base64url')}`
}

let cachedUnknownHash: { pepper: string; encoded: string } | null = null

export async function warmPasswordCheck(pepper: string): Promise<void> {
  await rejectUnknownPassword('warmup-password', pepper)
}

export async function rejectUnknownPassword(password: string, pepper: string): Promise<void> {
  if (!cachedUnknownHash || cachedUnknownHash.pepper !== pepper) {
    cachedUnknownHash = { pepper, encoded: await hashPassword('crew-support-unknown-user', pepper) }
  }
  await verifyPassword(password, pepper, cachedUnknownHash.encoded)
}

export async function verifyPassword(password: string, pepper: string, encoded: string): Promise<boolean> {
  const parsed = parseHash(encoded)
  const salt = parsed?.salt ?? Buffer.alloc(SALT_LENGTH, 1)
  const actual = await deriveKey(password, pepper, salt)
  const expected = parsed?.key ?? Buffer.alloc(KEY_LENGTH)
  if (actual.length !== expected.length) return false
  return timingSafeEqual(actual, expected) && parsed !== null
}

async function deriveKey(password: string, pepper: string, salt: Buffer): Promise<Buffer> {
  await acquirePasswordCheck()
  try {
    return await deriveKeyUnlocked(password, pepper, salt)
  } finally {
    releasePasswordCheck()
  }
}

function deriveKeyUnlocked(password: string, pepper: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(`${pepper}\0${password}`, salt, KEY_LENGTH, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: MAX_MEMORY }, (error, key) => {
      if (error) reject(error)
      else resolve(Buffer.from(key))
    })
  })
}

function acquirePasswordCheck(): Promise<void> {
  if (activeChecks < ACTIVE_LIMIT) {
    activeChecks += 1
    peakActiveChecks = Math.max(peakActiveChecks, activeChecks)
    return Promise.resolve()
  }
  if (waitingChecks >= WAIT_LIMIT) return Promise.reject(new AuthBusyError())
  waitingChecks += 1
  return new Promise((resolve) => {
    waiters.push(() => {
      waitingChecks -= 1
      activeChecks += 1
      peakActiveChecks = Math.max(peakActiveChecks, activeChecks)
      resolve()
    })
  })
}

function releasePasswordCheck(): void {
  activeChecks -= 1
  const next = waiters.shift()
  if (next) next()
  else peakActiveChecks = Math.max(peakActiveChecks, activeChecks)
}

function parseHash(encoded: string): { salt: Buffer; key: Buffer } | null {
  const parts = encoded.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null
  if (Number(parts[1]) !== SCRYPT_N || Number(parts[2]) !== SCRYPT_R || Number(parts[3]) !== SCRYPT_P) return null
  const salt = decode(parts[4] ?? '')
  const key = decode(parts[5] ?? '')
  if (!salt || salt.length !== SALT_LENGTH || !key || key.length !== KEY_LENGTH) return null
  return { salt, key }
}

function decode(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null
  const buffer = Buffer.from(value, 'base64url')
  return buffer.length > 0 ? buffer : null
}
