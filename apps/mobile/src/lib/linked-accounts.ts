export type LinkedProvider = 'x' | 'fomo'
export type LinkedAccount = {
  id: string
  provider: LinkedProvider
  handle: string
  displayName?: string
  status: 'active' | 'paused' | 'reauthorization_required' | 'error'
  lastImportedAt?: string | null
  lastError?: string | null
  createdAt: string
}
export type LinkedAccountsResult = {
  limit: 3
  providers: Record<LinkedProvider, { available: boolean; reason?: string }>
  accounts: LinkedAccount[]
}

export function authorizationLinkExpired(expiresAt: string, now = Date.now()) {
  const expiry = Date.parse(expiresAt)
  return !Number.isFinite(expiry) || expiry <= now
}

function isLocalHost(hostname: string) {
  if (['localhost', '[::1]', '::1'].includes(hostname)) return true
  const parts = hostname.split('.')
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return false
  const [a, b] = parts.map(Number)
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)
}

// The API supplies a one-time browser-start URL. Provider tokens never reach the app.
export function accountAuthorizationUrl(value: string, apiUrl: string, development = false): string {
  let target: URL
  let base: URL
  try {
    target = new URL(value)
    base = new URL(apiUrl)
  } catch {
    throw new Error('The account connection link is invalid. Refresh and try again.')
  }
  const secure = target.protocol === 'https:'
  const localDevelopment = development && target.protocol === 'http:' && isLocalHost(target.hostname)
  const prefix = `${base.pathname.replace(/\/$/, '')}/v1/linked-accounts/`
  if (
    (!secure && !localDevelopment) ||
    target.origin !== base.origin ||
    target.username ||
    target.password ||
    target.hash ||
    !target.pathname.startsWith(prefix)
  ) {
    throw new Error('The account connection link must use your secure Clout server. Refresh and try again.')
  }
  return target.toString()
}
