import { isAddress } from '@solana/kit'

// Published by Solana Mobile's Seeker Connect example; never accept a URL from
// query parameters, a wallet chooser, or an authorization response as the target.
// https://github.com/solana-mobile/seeker-connect/blob/main/js/examples/example-web/src/config.ts
export const SEEKER_WALLET_URI = 'https://connect.solanamobile.com'
export const SEEKER_CHAIN = 'solana:devnet' as const
export const SEEKER_STORAGE_KEY = 'clout-seeker-wallet-v1'

export type SeekerAuthorization = {
  address: string
  authToken: string
  walletUriBase: string
}

export function assertSeekerWalletUri(value: unknown): asserts value is string {
  if (typeof value !== 'string') throw new Error('Only the Seeker built-in wallet can connect to Clout.')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Only the Seeker built-in wallet can connect to Clout.')
  }
  if (
    url.origin !== SEEKER_WALLET_URI ||
    url.pathname !== '/' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('Only the Seeker built-in wallet can connect to Clout.')
}

export function validateSeekerAuthorization(value: unknown, expectedAddress?: string): SeekerAuthorization {
  if (!value || typeof value !== 'object') throw new Error('Invalid Seeker wallet authorization.')
  const candidate = value as Partial<SeekerAuthorization>
  assertSeekerWalletUri(candidate.walletUriBase)
  if (
    typeof candidate.address !== 'string' ||
    !isAddress(candidate.address) ||
    typeof candidate.authToken !== 'string' ||
    !candidate.authToken
  ) {
    throw new Error('Invalid Seeker wallet authorization.')
  }
  if (expectedAddress && candidate.address !== expectedAddress) {
    throw new Error('The wallet account changed. Disconnect and reconnect before continuing.')
  }
  return { address: candidate.address, authToken: candidate.authToken, walletUriBase: SEEKER_WALLET_URI }
}

export function signedMessageParts(payload: Uint8Array, expected: Uint8Array) {
  if (payload.length !== 64 && payload.length !== expected.length + 64) {
    throw new Error('The wallet returned an invalid signed message.')
  }
  const signedMessage = payload.length === 64 ? expected : payload.slice(0, -64)
  if (!signedMessage.every((byte, index) => byte === expected[index])) {
    throw new Error('The wallet signed a different message. Please reconnect.')
  }
  return { signedMessage, signature: payload.slice(-64) }
}
