import test from 'node:test'
import assert from 'node:assert/strict'
import { investmentCoordinates, signedInvestmentAmount, type InvestmentPoint } from './investments'

const point = (amount: string, slot: number): InvestmentPoint => ({
  signature: `trade-${slot}`,
  slot,
  kind: 'buy',
  quoteAmount: '1',
  netQuoteAmount: amount,
})
test('investment graph preserves negative cash flow and exact amounts above safe integer range', () => {
  const graph = investmentCoordinates([
    point('-90071992547409930', 10),
    point('0', 20),
    point('90071992547409930', 30),
  ])
  assert.deepEqual(graph?.points, [
    { x: 8, y: 94 },
    { x: 150, y: 53 },
    { x: 292, y: 12 },
  ])
  assert.equal(signedInvestmentAmount('-90071992547409930', 6), '−90071992547.40993')
  assert.equal(signedInvestmentAmount('1', 6), '0.000001')
})
test('empty, one-trade and unchanged histories never fabricate extra trade points', () => {
  assert.deepEqual(investmentCoordinates([])?.points, [])
  assert.deepEqual(investmentCoordinates([point('25', 10)])?.points, [{ x: 150, y: 53 }])
  assert.deepEqual(investmentCoordinates([point('25', 10), point('25', 10)])?.points, [
    { x: 8, y: 53 },
    { x: 292, y: 53 },
  ])
})
test('invalid cash flow or reversed slots cannot render a plausible investment graph', () => {
  for (const amount of ['NaN', '1.5', '1e9', '', '--1'])
    assert.equal(investmentCoordinates([point(amount, 10)]), null)
  assert.equal(investmentCoordinates([point('1', 11), point('2', 10)]), null)
})
