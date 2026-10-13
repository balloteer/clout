import assert from 'node:assert/strict'
import test from 'node:test'
import { accountAuthorizationUrl, authorizationLinkExpired } from './linked-accounts'

test('OAuth starts only through the configured Clout server', () => {
  const url = 'https://api.clout.example/v1/linked-accounts/x/start?ticket=one-time'
  assert.equal(accountAuthorizationUrl(url, 'https://api.clout.example'), url)
  for (const unsafe of [
    'https://api.clout.example.evil.example/v1/linked-accounts/x/start',
    'https://user:password@api.clout.example/v1/linked-accounts/x/start',
    'https://api.clout.example/v1/auth/logout',
    'https://api.clout.example/v1/linked-accounts/x/start#fragment',
    'javascript:alert(1)',
    'https://x.com/i/oauth2/authorize',
  ]) {
    assert.throws(() => accountAuthorizationUrl(unsafe, 'https://api.clout.example'))
  }
})

test('HTTP account linking is limited to local development origins', () => {
  for (const origin of ['http://localhost:3001', 'http://10.0.2.2:3001', 'http://192.168.1.9:3001']) {
    const url = `${origin}/v1/linked-accounts/x/start?ticket=test`
    assert.equal(accountAuthorizationUrl(url, origin, true), url)
    assert.throws(() => accountAuthorizationUrl(url, origin, false))
  }
  assert.throws(() =>
    accountAuthorizationUrl(
      'http://public.example/v1/linked-accounts/x/start',
      'http://public.example',
      true,
    ),
  )
  assert.throws(() =>
    accountAuthorizationUrl(
      'http://127.attacker.example/v1/linked-accounts/x/start',
      'http://127.attacker.example',
      true,
    ),
  )
})

test('invalid and elapsed OAuth link lifetimes fail closed', () => {
  const now = Date.parse('2026-10-13T12:00:00Z')
  assert.equal(authorizationLinkExpired('2026-10-13T12:00:01Z', now), false)
  assert.equal(authorizationLinkExpired('2026-10-13T12:00:00Z', now), true)
  assert.equal(authorizationLinkExpired('invalid', now), true)
})
