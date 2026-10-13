type WalletErrorOptions = { native: boolean; apiUrl: string }

const nativeCancellation = 'Local association cancelled by user'
const nativeCancellationCode = `Session not established: ${nativeCancellation}`

function isLoopbackApi(value: string) {
  try {
    const url = new URL(value)
    return (
      ['http:', 'https:'].includes(url.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    )
  } catch {
    return false
  }
}

/** null means an explicit cancellation, never a completed wallet connection. */
export function walletConnectionError(error: unknown, options: WalletErrorOptions): string | null {
  const value = error && typeof error === 'object' ? error : {}
  const code = 'code' in value ? value.code : undefined
  const message =
    'message' in value && typeof value.message === 'string'
      ? value.message
      : typeof error === 'string'
        ? error
        : ''
  const name = 'name' in value ? value.name : undefined

  if (
    code === 'cancelled' ||
    code === 'ERROR_ASSOCIATION_CANCELLED' ||
    (options.native &&
      (code === nativeCancellationCode ||
        (code === undefined && (message === nativeCancellation || message === nativeCancellationCode))))
  )
    return null

  if (code === 'request-declined' || code === 'authorization-declined')
    return 'The wallet request was declined. You can try again when you’re ready.'
  // MWA -1 also covers expired authorization; it does not establish that the user declined.
  if (code === -1) return 'The wallet did not authorize this request. Please try connecting again.'

  if (code === 'ERROR_WALLET_NOT_FOUND')
    return 'Clout could not open the built-in Seeker wallet. Open the wallet, return to Clout, and try again.'
  if (
    code === 'ERROR_SESSION_TIMEOUT' ||
    (options.native && code === 'Timed out waiting for local association to be ready')
  )
    return 'The Seeker wallet connection timed out. Open the wallet, return to Clout, and try again.'

  if (
    options.native &&
    isLoopbackApi(options.apiUrl) &&
    (code === 'CLOUT_API_UNREACHABLE' ||
      (code === undefined && message === 'Network request failed') ||
      ((code === undefined || code === 23) && name === 'TimeoutError'))
  )
    return 'Clout could not reach the local server. Keep your Seeker connected by USB, keep the Clout server running, and restore USB API forwarding before trying again.'
  if (code === 'CLOUT_API_UNREACHABLE')
    return 'Clout could not reach the sign-in server. Check your connection and try again.'

  return message || 'Wallet connection failed. Please try again.'
}
