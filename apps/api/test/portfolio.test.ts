import assert from 'node:assert/strict'
import test from 'node:test'
import type { PositionHistory } from '../src/domain.js'
import { positionPerformance } from '../src/portfolio.js'

const history: PositionHistory = {
  postId: 'post',
  boughtBaseAmount: '100',
  soldBaseAmount: '40',
  boughtQuoteAmount: '100',
  soldQuoteAmount: '60',
}

test('position performance includes realized sales and current executable value', () => {
  assert.deepEqual(positionPerformance('60', '90', history), {
    boughtQuoteAmount: '100',
    soldQuoteAmount: '60',
    netInvestedQuoteAmount: '40',
    backingAvailable: true,
    performanceAvailable: true,
    profitLossQuoteAmount: '50',
    returnBps: '5000',
  })
})

test('transferred holdings keep value visible without inventing performance', () => {
  assert.deepEqual(positionPerformance('70', '90', history), {
    boughtQuoteAmount: '100',
    soldQuoteAmount: '60',
    netInvestedQuoteAmount: null,
    backingAvailable: false,
    performanceAvailable: false,
    profitLossQuoteAmount: null,
    returnBps: null,
  })
})

test('a holding with no recorded history never claims backing or performance', () => {
  const result = positionPerformance('10', '20')
  assert.equal(result.backingAvailable, false)
  assert.equal(result.performanceAvailable, false)
  assert.equal(result.profitLossQuoteAmount, null)
})
