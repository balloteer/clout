import test from 'node:test'
import assert from 'node:assert/strict'
import { walletConnectionError } from './wallet-errors'

const native = { native: true, apiUrl: 'http://127.0.0.1:8787' }
const web = { ...native, native: false }

test('normal web and native association cancellations stay quiet without matching unrelated text', () => {
  for (const error of [
    { code: 'cancelled', message: 'Cancelled' },
    { code: 'ERROR_ASSOCIATION_CANCELLED', message: 'Association cancelled' },
    {
      code: 'Session not established: Local association cancelled by user',
      message: 'Local association cancelled by user',
    },
    new Error('Local association cancelled by user'),
  ])
    assert.equal(walletConnectionError(error, native), null)
  assert.equal(walletConnectionError({ code: 'cancelled' }, web), null)
  assert.equal(
    walletConnectionError(new Error('Session failed after Local association cancelled by user'), native),
    'Session failed after Local association cancelled by user',
  )
  assert.equal(
    walletConnectionError(new Error('Local association cancelled by user'), web),
    'Local association cancelled by user',
  )
  assert.notEqual(walletConnectionError(new DOMException('Aborted', 'AbortError'), native), null)
  assert.equal(
    walletConnectionError(
      { code: 'UNEXPECTED_FAILURE', message: 'Local association cancelled by user' },
      native,
    ),
    'Local association cancelled by user',
  )
})

test('explicit declines and MWA authorization failure retain different explanations', () => {
  for (const code of ['request-declined', 'authorization-declined'])
    assert.match(walletConnectionError({ code }, web)!, /request was declined/)
  assert.match(
    walletConnectionError({ code: -1, message: 'Authorization failed' }, native)!,
    /did not authorize/,
  )
  assert.doesNotMatch(walletConnectionError({ code: -1 }, native)!, /declined/)
  assert.equal(
    walletConnectionError({ code: -3, message: 'Signing request failed' }, native),
    'Signing request failed',
  )
})

test('USB guidance applies to native loopback API fetch failures, not wallet association timeouts', () => {
  for (const apiUrl of ['http://127.0.0.1:8787', 'http://localhost:8787', 'http://[::1]:8787']) {
    const options = { native: true, apiUrl }
    assert.match(
      walletConnectionError(new TypeError('Network request failed'), options)!,
      /USB API forwarding/,
    )
    assert.match(
      walletConnectionError(new DOMException('Timed out', 'TimeoutError'), options)!,
      /local server/,
    )
  }
  const association = walletConnectionError(
    { code: 'Timed out waiting for local association to be ready', message: 'Association timeout' },
    native,
  )!
  assert.match(association, /wallet connection timed out/)
  assert.doesNotMatch(association, /USB|server/)
  assert.doesNotMatch(
    walletConnectionError({ code: 'ERROR_SESSION_TIMEOUT', name: 'TimeoutError' }, native)!,
    /USB|server/,
  )
  for (const options of [
    web,
    { native: true, apiUrl: 'https://api.example.com' },
    { native: true, apiUrl: 'http://localhost.evil.example:8787' },
    { native: true, apiUrl: '' },
  ])
    assert.equal(
      walletConnectionError(new TypeError('Network request failed'), options),
      'Network request failed',
    )
})

test('explicit API preflight failures give scoped connectivity guidance without masking configuration errors', () => {
  assert.match(walletConnectionError({ code: 'CLOUT_API_UNREACHABLE' }, native)!, /USB API forwarding/)
  assert.match(walletConnectionError({ code: 'CLOUT_API_UNREACHABLE' }, web)!, /sign-in server/)
  assert.doesNotMatch(
    walletConnectionError(
      { code: 'CLOUT_API_UNREACHABLE' },
      { native: true, apiUrl: 'https://api.example.com' },
    )!,
    /USB/,
  )
  assert.equal(
    walletConnectionError(
      { code: 'CLOUT_API_CONFIG_INVALID', message: 'This server is not configured for devnet sign-in.' },
      native,
    ),
    'This server is not configured for devnet sign-in.',
  )
})

test('unexpected wallet and API failures remain visible without serializing error payloads', () => {
  for (const message of [
    'Only the Seeker built-in wallet can connect to Clout.',
    'The wallet signed a different message. Please reconnect.',
    'The wallet account changed. Disconnect and reconnect before continuing.',
    'Challenge expired',
  ])
    assert.equal(walletConnectionError(new Error(message), native), message)
  assert.equal(
    walletConnectionError({ code: 'UNKNOWN', payload: { authToken: 'never-render-this' } }, native),
    'Wallet connection failed. Please try again.',
  )
  assert.match(walletConnectionError({ code: 'ERROR_WALLET_NOT_FOUND' }, native)!, /built-in Seeker wallet/)
})
