import { BlockList } from 'node:net'

export type AuthMode = 'disabled' | 'mock' | 'password'

export const DEV_AUTH_PEPPER = 'dev-only-pepper-change-me-000000'
export type SourceAdapter = 'disabled' | 'sample'
export type MailAdapter = 'disabled' | 'scripted'

export interface AppConfig {
  nodeEnv: string
  databaseUrl: string
  authMode: AuthMode
  authPepper: string
  cookieSecure: boolean
  sourceAdapter: SourceAdapter
  mailAdapter: MailAdapter
  host: string
  port: number
  bodyLimitBytes: number
  importLimitBytes: number
  allowedOrigins: string[]
  schedulerEnabled: boolean
  allowSyntheticRecipients: boolean
  unknownAfterSeconds: number
  rateLimitPerMinute: number
  loginRateLimitPerMinute: number
  trustedProxies: BlockList
  requestTimeoutMs: number
  headersTimeoutMs: number
  now: () => Date
}

export function readConfig(env: NodeJS.ProcessEnv, now: () => Date = () => new Date()): AppConfig {
  const nodeEnv = env.NODE_ENV ?? 'development'
  const config: AppConfig = {
    nodeEnv,
    databaseUrl: env.DATABASE_URL ?? '',
    authMode: env.AUTH_MODE === 'mock' ? 'mock' : env.AUTH_MODE === 'password' ? 'password' : 'disabled',
    authPepper: env.AUTH_PEPPER ?? '',
    cookieSecure: env.COOKIE_SECURE === 'true' || (env.COOKIE_SECURE !== 'false' && nodeEnv === 'production'),
    sourceAdapter: env.SOURCE_ADAPTER === 'sample' ? 'sample' : 'disabled',
    mailAdapter: env.MAIL_ADAPTER === 'scripted' ? 'scripted' : 'disabled',
    host: env.HOST ?? '127.0.0.1',
    port: Number(env.PORT ?? 8080),
    bodyLimitBytes: Number(env.BODY_LIMIT_BYTES ?? 65_536),
    importLimitBytes: Number(env.IMPORT_LIMIT_BYTES ?? 1_048_576),
    allowedOrigins: (env.ALLOWED_ORIGINS ?? '').split(',').map((item) => item.trim()).filter(Boolean),
    schedulerEnabled: env.SCHEDULER_ENABLED === 'true',
    allowSyntheticRecipients: nodeEnv === 'test',
    unknownAfterSeconds: Number(env.UNKNOWN_AFTER_SECONDS ?? 120),
    rateLimitPerMinute: Number(env.RATE_LIMIT_PER_MINUTE ?? 120),
    loginRateLimitPerMinute: Number(env.LOGIN_RATE_LIMIT_PER_MINUTE ?? 10),
    trustedProxies: trustedProxyList(env.TRUSTED_PROXY_CIDRS ?? ''),
    requestTimeoutMs: Number(env.REQUEST_TIMEOUT_MS ?? 30_000),
    headersTimeoutMs: Math.min(Number(env.HEADERS_TIMEOUT_MS ?? 15_000), Number(env.REQUEST_TIMEOUT_MS ?? 30_000)),
    now,
  }
  assertSafeConfig(config)
  if (!config.databaseUrl) throw new Error('DATABASE_URL is required')
  if (config.authMode === 'password' && config.authPepper.length < 32) throw new Error('AUTH_PEPPER must be at least 32 characters')
  return config
}

function trustedProxyList(value: string): BlockList {
  const list = new BlockList()
  for (const item of value.split(',').map((entry) => entry.trim()).filter(Boolean)) {
    const [address, prefix] = item.split('/')
    if (!address || prefix === undefined) throw new Error('TRUSTED_PROXY_CIDRS entries must be address/prefix')
    const family = address.includes(':') ? 'ipv6' : 'ipv4'
    list.addSubnet(address, Number(prefix), family)
  }
  return list
}

export function assertSafeConfig(config: AppConfig): void {
  if (config.nodeEnv !== 'production') return
  if (config.authMode === 'mock') throw new Error('production auth rejects mock subjects')
  if (config.authMode === 'password' && config.authPepper === DEV_AUTH_PEPPER) throw new Error('refusing dev auth pepper')
  if (config.mailAdapter !== 'disabled') throw new Error('production mail is disabled until approved transport')
  if (config.sourceAdapter !== 'disabled') throw new Error('production source adapter is disabled until an approved feed exists')
  if (config.databaseUrl.includes('://crew:crew@')) throw new Error('refusing default database credentials')
  if (config.allowSyntheticRecipients) throw new Error('synthetic recipients are forbidden in production')
}
