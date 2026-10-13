import test from 'node:test'
import assert from 'node:assert/strict'
import { executionPrices, type MarketActivity } from './activity'

test('executed-price display sorts by chain slot and respects unequal token decimals', () => {
  const activity: MarketActivity = {
    baseDecimals: 6,
    quoteDecimals: 9,
    source: 'clout-transactions',
    events: [
      {
        signature: 'later',
        slot: 2,
        kind: 'sell',
        baseAmount: '2000000',
        quoteAmount: '8000000000',
        finality: 'finalized',
      },
      {
        signature: 'first',
        slot: 1,
        kind: 'buy',
        baseAmount: '1000000',
        quoteAmount: '2000000000',
        finality: 'confirmed',
      },
    ],
  }
  assert.deepEqual(
    executionPrices(activity).map(({ signature, price }) => ({ signature, price })),
    [
      { signature: 'first', price: 2 },
      { signature: 'later', price: 4 },
    ],
  )
  assert.equal(activity.events[0].signature, 'later', 'does not reorder API input')
})
test('invalid or zero amounts never manufacture chart prices', () => {
  const activity: MarketActivity = {
    baseDecimals: 6,
    quoteDecimals: 6,
    source: 'clout-transactions',
    events: [
      { signature: 'zero', slot: 1, kind: 'buy', baseAmount: '0', quoteAmount: '1', finality: 'confirmed' },
      { signature: 'bad', slot: 1, kind: 'buy', baseAmount: 'NaN', quoteAmount: '1', finality: 'confirmed' },
    ],
  }
  assert.deepEqual(executionPrices(activity), [])
  assert.deepEqual(executionPrices({ ...activity, baseDecimals: 99 }), [])
})
