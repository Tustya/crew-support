export type AuthMode = 'disabled' | 'mock'
export type SourceAdapter = 'disabled' | 'sample'
export type MailAdapter = 'disabled' | 'scripted'

export interface AppConfig {
  nodeEnv: string
  databaseUrl: string
  authMode: AuthMode
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
  now: () => Date
}

export function readConfig(env: NodeJS.ProcessEnv, now: () => Date = () => new Date()): AppConfig {
  const nodeEnv = env.NODE_ENV ?? 'development'
  const config: AppConfig = {
    nodeEnv,
    databaseUrl: env.DATABASE_URL ?? '',
    authMode: env.AUTH_MODE === 'mock' ? 'mock' : 'disabled',
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
    now,
  }
  assertSafeConfig(config)
  if (!config.databaseUrl) throw new Error('DATABASE_URL is required')
  return config
}

export function assertSafeConfig(config: AppConfig): void {
  if (config.nodeEnv !== 'production') return
  if (config.authMode !== 'disabled') throw new Error('production auth is fail-closed until approved SSO')
  if (config.mailAdapter !== 'disabled') throw new Error('production mail is disabled until approved transport')
  if (config.sourceAdapter !== 'disabled') throw new Error('production source adapter is disabled until an approved feed exists')
  if (config.databaseUrl.includes('://crew:crew@')) throw new Error('refusing default database credentials')
  if (config.allowSyntheticRecipients) throw new Error('synthetic recipients are forbidden in production')
}
