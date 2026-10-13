export const API_URL = process.env.EXPO_PUBLIC_API_URL?.replace(/\/$/, '') ?? ''
let sessionToken: string | undefined
const sessionInvalidated = new Set<() => void>()
export function onSessionInvalidated(callback: () => void) {
  sessionInvalidated.add(callback)
  return () => {
    sessionInvalidated.delete(callback)
  }
}
export function setSessionToken(token: string | undefined) {
  sessionToken = token
}
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  if (!API_URL)
    throw new Error('Connect a Clout server to use this feature. You can keep exploring the sample feed.')
  const requestToken = sessionToken
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    signal: options.signal ?? AbortSignal.timeout(15000),
    headers: {
      'Content-Type': 'application/json',
      ...(requestToken ? { Authorization: `Bearer ${requestToken}` } : {}),
      ...options.headers,
    },
  })
  const data = await response.json()
  if (response.status === 401 && requestToken && requestToken === sessionToken) {
    setSessionToken(undefined)
    for (const callback of sessionInvalidated) callback()
  }
  if (!response.ok)
    throw new Error(data.error?.message ?? data.error ?? 'The request could not be completed. Try again.')
  return data as T
}
export const postJson = <T>(path: string, body: unknown) =>
  api<T>(path, { method: 'POST', body: JSON.stringify(body) })
