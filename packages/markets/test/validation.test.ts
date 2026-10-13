import assert from 'node:assert/strict'
import test from 'node:test'
import {
  U64_MAX,
  decimalToUnits,
  formatUnits,
  marketStatus,
  minOutput,
  progressBps,
  units,
  validateMetadata,
  validateSlippage,
} from '../src/validation.js'

test('SKR amounts stay exact beyond the JavaScript safe-integer range', () => {
  assert.equal(decimalToUnits('9007199254.740993', 6), '9007199254740993')
  assert.equal(formatUnits('9007199254740993', 6), '9007199254.740993')
  assert.equal(decimalToUnits('0.000001', 6), '1')
  assert.equal(formatUnits('1000000', 6), '1')
})

test('amount parser rejects rounding, exponent, negative, zero and u64 overflow', () => {
  for (const value of ['-1', '1e9', '1.1', ' 1', '01', '0', (U64_MAX + 1n).toString()]) {
    assert.throws(() => units(value), { code: 'INVALID_AMOUNT' })
  }
  assert.throws(() => decimalToUnits('1.0000001', 6), { code: 'INVALID_AMOUNT' })
  assert.throws(() => decimalToUnits('1e3', 6), { code: 'INVALID_AMOUNT' })
  assert.equal(units(U64_MAX.toString()), U64_MAX)
})

test('slippage has explicit small bounds and minimum output never rounds up', () => {
  assert.equal(minOutput('9999', 100), '9899')
  assert.equal(minOutput(U64_MAX.toString(), 1), '18444899399302180659')
  for (const value of [0, -1, 501, 10_000, NaN, 1.5]) assert.throws(() => validateSlippage(value))
  assert.throws(() => minOutput('1', 500), { code: 'INVALID_AMOUNT' })
})

test('graduation distinguishes threshold reached, migration pending and tradable successor', () => {
  assert.equal(marketStatus(false, false, '99', '100'), 'dbc')
  assert.equal(marketStatus(false, true, '100', '100'), 'migration-required')
  assert.equal(marketStatus(true, false, '100', '100'), 'migration-pending')
  assert.equal(marketStatus(true, true, '0', '100'), 'damm-v2')
  assert.equal(progressBps('150', '100'), 10_000)
  assert.equal(progressBps('1', '3'), 3333)
})

test('metadata enforces byte length, safe HTTPS location and uppercase ticker', () => {
  validateMetadata('Cat video', 'CAT', 'https://example.com/post.json')
  assert.throws(() => validateMetadata('🐈'.repeat(9), 'CAT', 'https://example.com/post.json'))
  assert.throws(() => validateMetadata('Cat', 'cat', 'https://example.com/post.json'))
  assert.throws(() => validateMetadata('Cat', 'CAT', 'http://example.com/post.json'))
  assert.throws(() => validateMetadata('Cat', 'CAT', 'https://secret:password@example.com/post.json'))
})
