import { API_URL, postJson } from './api'
import { createAccountLinkFlow } from './account-link-flow'
import { accountLinkStorage } from './account-link-storage'

const hex = (bytes: Uint8Array) => Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')
export const accountLinking = createAccountLinkFlow({
  ...accountLinkStorage,
  apiOrigin: API_URL,
  development: __DEV__,
  post: postJson,
  randomVerifier: () => hex(globalThis.crypto.getRandomValues(new Uint8Array(32))),
  challenge: async (verifier) =>
    hex(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))),
})
