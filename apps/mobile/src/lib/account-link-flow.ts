import { accountAuthorizationUrl, authorizationLinkExpired, type LinkedProvider } from './linked-accounts'

export type AccountLinkReturn = { state: string; completion: string }
export type PendingAccountLink = {
  owner: string
  apiOrigin: string
  provider: LinkedProvider
  state: string
  verifier: string
  expiresAt: string
  completion?: string
}
type Dependencies = {
  apiOrigin: string
  development?: boolean
  read: (owner: string) => Promise<string | null>
  write: (owner: string, value: string) => Promise<void>
  remove: (owner: string) => Promise<void>
  post: <T>(path: string, body: unknown) => Promise<T>
  randomVerifier: () => string
  challenge: (verifier: string) => Promise<string>
}
const token = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
export function parseAccountLinkReturn(state: unknown, completion: unknown): AccountLinkReturn {
  if (!token(state) || !token(completion))
    throw new Error('The account return link is invalid. Start again from Profile.')
  return { state, completion }
}

/** The callback secret is never polled. Only the app that stored this attempt can complete its callback. */
export function createAccountLinkFlow(deps: Dependencies) {
  const locks = new Set<string>()
  const locked = async <T>(owner: string, action: () => Promise<T>): Promise<T> => {
    if (locks.has(owner)) throw new Error('An account connection is already being processed.')
    locks.add(owner)
    try {
      return await action()
    } finally {
      locks.delete(owner)
    }
  }
  const pending = async (owner: string): Promise<PendingAccountLink | null> => {
    const raw = await deps.read(owner)
    if (!raw) return null
    const value = JSON.parse(raw) as PendingAccountLink
    if (
      value.owner !== owner ||
      value.apiOrigin !== deps.apiOrigin ||
      !token(value.state) ||
      !/^[a-f0-9]{64}$/.test(value.verifier) ||
      value.provider !== 'x' ||
      authorizationLinkExpired(value.expiresAt) ||
      (value.completion !== undefined && !token(value.completion))
    ) {
      await deps.remove(owner)
      throw new Error(
        'This account connection expired or belongs to another server. Start again from Profile.',
      )
    }
    return value
  }
  return {
    pending,
    start: (owner: string, provider: LinkedProvider, accountId?: string) =>
      locked(owner, async () => {
        if (provider !== 'x') throw new Error('This account provider is not available yet.')
        const verifier = deps.randomVerifier()
        if (!/^[a-f0-9]{64}$/.test(verifier)) throw new Error('Secure account linking is unavailable.')
        const result = await deps.post<{ authorizationUrl: string; expiresAt: string; state: string }>(
          '/v1/linked-accounts/x/connect',
          { ...(accountId ? { accountId } : {}), clientChallenge: await deps.challenge(verifier) },
        )
        const url = accountAuthorizationUrl(result.authorizationUrl, deps.apiOrigin, deps.development)
        if (
          !token(result.state) ||
          new URL(url).searchParams.get('state') !== result.state ||
          authorizationLinkExpired(result.expiresAt)
        )
          throw new Error('This account connection could not be verified. Try again.')
        const value: PendingAccountLink = {
          owner,
          apiOrigin: deps.apiOrigin,
          provider,
          state: result.state,
          verifier,
          expiresAt: result.expiresAt,
        }
        await deps.write(owner, JSON.stringify(value))
        return url
      }),
    complete: (owner: string, returned?: AccountLinkReturn) =>
      locked(owner, async () => {
        const value = await pending(owner)
        if (!value)
          throw new Error(
            'This app did not start that account connection. Start again from Profile on this device.',
          )
        if (returned) {
          parseAccountLinkReturn(returned.state, returned.completion)
          if (returned.state !== value.state)
            throw new Error(
              'This return link belongs to a different account connection. Start again from Profile.',
            )
          if (value.completion && value.completion !== returned.completion)
            throw new Error(
              'This account connection already has a different return proof. Use Retry connection.',
            )
          value.completion = returned.completion
          // Preserve the matched callback before the request, so a timeout or restart can retry it safely.
          await deps.write(owner, JSON.stringify(value))
        }
        if (!value.completion)
          throw new Error('Finish authorizing in the browser and use its Return to Clout link.')
        await deps.post('/v1/linked-accounts/x/complete', {
          state: value.state,
          completion: value.completion,
          verifier: value.verifier,
        })
        await deps.remove(owner)
      }),
    cancel: (owner: string) => locked(owner, () => deps.remove(owner)),
  }
}
