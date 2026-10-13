import { parseAccountLinkReturn, type AccountLinkReturn } from './account-link-flow'

// Holds the browser callback only while replacing the secret-bearing route with its clean URL.
let callback: { value: AccountLinkReturn; expires: number } | undefined
export function rememberAccountReturn(attempt: unknown, completion: unknown) {
  callback = { value: parseAccountLinkReturn(attempt, completion), expires: Date.now() + 120_000 }
  return callback.value
}
export function readAccountReturn(): AccountLinkReturn | undefined {
  if (!callback || callback.expires <= Date.now()) {
    callback = undefined
    return undefined
  }
  return callback.value
}
export function clearAccountReturn(state?: string) {
  if (!state || callback?.value.state === state) callback = undefined
}
