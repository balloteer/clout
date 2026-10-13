import test from 'node:test'
import assert from 'node:assert/strict'
import { toAtomic, displayAtomic, isQuoteExpired } from './amounts'
test('preserves atomic precision without floating point for SKR amounts', () => {
  assert.equal(toAtomic('9007199254.123456', 6), '9007199254123456')
  assert.equal(displayAtomic('9007199254123456', 6, 6), '9007199254.123456')
  assert.equal(toAtomic('0.000001', 6), '1')
})
test('rejects malformed, zero, overprecise and overflowing amounts', () => {
  for (const input of ['-1', 'NaN', '1e9', '0', '0.0000001', '18446744073709551616']) {
    assert.throws(() => toAtomic(input, 6))
  }
})
test('expired and malformed quotes cannot be submitted', () => {
  assert.equal(isQuoteExpired('bad date'), true)
  assert.equal(isQuoteExpired('2026-10-12T00:00:00Z', Date.parse('2026-10-12T00:00:00Z')), true)
  assert.equal(isQuoteExpired('2026-10-12T00:01:00Z', Date.parse('2026-10-12T00:00:00Z')), false)
})
