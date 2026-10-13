import test from 'node:test'
import assert from 'node:assert/strict'
import { demoActions, demoPlan } from '../scripts/demo-activity-plan.js'

test('demo activity is bounded, varied, and only sells positions previously bought by the same wallet', () => {
  const plan = demoPlan(Array.from({ length: 12 }, (_, i) => `post-${i}`))
  assert.equal(plan.markets.flatMap((m) => m.actions).length, 72)
  assert.equal(plan.grossBuyUnits, '2451000000')
  const walletTotals = [0n, 0n, 0n, 0n]
  for (const market of plan.markets) {
    const bought = new Set<number>()
    let marketTotal = 0n
    for (const action of market.actions) {
      assert.ok(action.walletIndex >= 0 && action.walletIndex < 4)
      if (action.side === 'buy') {
        bought.add(action.walletIndex)
        const units = BigInt(action.amountIn)
        marketTotal += units
        walletTotals[action.walletIndex] += units
      } else {
        assert.ok(bought.has(action.walletIndex))
        assert.ok(action.divisor >= 3)
      }
    }
    assert.ok(marketTotal < 400_000_000n)
  }
  assert.ok(walletTotals.every((total) => total <= 1_000_000_000n))
  assert.notDeepEqual(demoActions(0), demoActions(1))
})
test('demo plan rejects duplicate, unsafe or excessive target sets', () => {
  for (const ids of [[], ['same', 'same'], ['../bad'], Array.from({ length: 13 }, (_, i) => `post-${i}`)])
    assert.throws(() => demoPlan(ids))
  for (const index of [-1, 12, 0.5]) assert.throws(() => demoActions(index))
})
