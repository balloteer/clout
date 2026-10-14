const hostname = (value: string | undefined, name: string): string | undefined => {
  if (value === undefined) return undefined
  if (
    value.length > 253 ||
    !/^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(
      value,
    )
  )
    throw new Error(`${name} must be a valid hostname.`)
  return value.toLowerCase()
}

export function resolveOrigin(env: NodeJS.ProcessEnv): string {
  const vercelHost =
    !env.CLOUT_ORIGIN && env.VERCEL === '1'
      ? hostname(env.VERCEL_PROJECT_PRODUCTION_URL, 'VERCEL_PROJECT_PRODUCTION_URL')
      : undefined
  const candidate = env.CLOUT_ORIGIN ?? (vercelHost ? `https://${vercelHost}` : undefined)
  const origin = candidate ?? 'http://localhost:8787'
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    throw new Error('CLOUT_ORIGIN must be an absolute HTTP(S) origin.')
  }
  if (
    parsed.origin !== origin.replace(/\/$/, '') ||
    parsed.username ||
    parsed.password ||
    !['http:', 'https:'].includes(parsed.protocol)
  )
    throw new Error('CLOUT_ORIGIN must be an absolute HTTP(S) origin without credentials or a path.')
  if (env.NODE_ENV === 'production' && parsed.protocol !== 'https:')
    throw new Error('Production requires an HTTPS CLOUT_ORIGIN.')
  return parsed.origin
}

export function resolveAllowedOrigins(env: NodeJS.ProcessEnv, origin: string): string[] {
  const configured = env.CLOUT_ALLOWED_ORIGINS
  const values = configured
    ? configured.split(',').map((value) => value.trim())
    : env.NODE_ENV === 'production'
      ? [origin]
      : [origin, 'http://localhost:8081']
  if (!values.length || values.some((value) => !value))
    throw new Error('CLOUT_ALLOWED_ORIGINS must contain valid origins.')
  return values.map((value) => {
    const parsed = new URL(value)
    if (parsed.origin !== value.replace(/\/$/, '') || !['http:', 'https:'].includes(parsed.protocol))
      throw new Error('CLOUT_ALLOWED_ORIGINS must contain only absolute HTTP(S) origins.')
    return parsed.origin
  })
}

export function resolveTrustProxyHops(env: NodeJS.ProcessEnv): string | undefined {
  return env.CLOUT_TRUST_PROXY_HOPS ?? (env.VERCEL === '1' ? '1' : undefined)
}
