import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { IncomingMessage } from 'node:http'
import { ApiError } from '../src/domain.js'
import { parseTrustProxyHops, requestClientIp } from '../src/request-ip.js'

const request = (forwarded?: string | string[], remoteAddress = '::ffff:192.0.2.10') =>
  ({ socket: { remoteAddress }, headers: { 'x-forwarded-for': forwarded } }) as unknown as IncomingMessage

test('proxy trust is disabled by default and rejects invalid or unbounded configuration', () => {
  assert.equal(parseTrustProxyHops(undefined), 0)
  for (let hops = 0; hops <= 8; hops++) assert.equal(parseTrustProxyHops(String(hops)), hops)
  for (const value of ['', 'true', '-1', '1.5', '9', 'Infinity', ' 1', '1 ', '01'])
    assert.throws(() => parseTrustProxyHops(value), /CLOUT_TRUST_PROXY_HOPS/)
  assert.equal(requestClientIp(request('203.0.113.1'), 0), '192.0.2.10')
  assert.equal(requestClientIp(request('invalid forged header'), 0), '192.0.2.10')
})

test('trusted hop selection ignores attacker prefixes and normalizes equivalent IPv6 addresses', () => {
  assert.equal(requestClientIp(request('203.0.113.99, 198.51.100.7'), 1), '198.51.100.7')
  assert.equal(requestClientIp(request('203.0.113.22, 198.51.100.7'), 1), '198.51.100.7')
  assert.equal(requestClientIp(request('203.0.113.99, 198.51.100.7, 192.0.2.20'), 2), '198.51.100.7')
  assert.equal(requestClientIp(request('2001:0DB8:0000:0000:0000:0000:0000:0001'), 1), '2001:db8::1')
  assert.equal(requestClientIp(request('2001:db8::1'), 1), '2001:db8::1')
})

test('missing, short or malformed trusted proxy chains fail closed', () => {
  for (const header of [
    undefined,
    '',
    '198.51.100.7',
    'bad, 192.0.2.20',
    '198.51.100.7,',
    'fe80::1%eth0, 192.0.2.20',
    ['198.51.100.7', '192.0.2.20'],
    '1'.repeat(2049),
  ]) {
    assert.throws(
      () => requestClientIp(request(header), 2),
      (error: unknown) =>
        error instanceof ApiError && error.status === 400 && error.code === 'INVALID_PROXY_CHAIN',
    )
  }
})
