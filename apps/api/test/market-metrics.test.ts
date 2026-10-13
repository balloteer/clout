import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import type { MarketSnapshot } from '@clout/markets'
import { investmentHistory, MarketMetrics } from '../src/market-metrics.js'
import type { IndexedEvent } from '../src/domain.js'
import { MemoryRepository } from '../src/memory.js'
import { PostgresRepository } from '../src/postgres.js'

const post = { id: 'video', market: { baseMint: 'base', dbcPool: 'curve' } }
const snapshot: MarketSnapshot = {
  postId: post.id,
  ...post.market,
  status: 'dbc',
  pool: 'curve',
  creator: 'creator',
  config: 'config',
  quoteMint: 'mock-skr',
  baseDecimals: 6,
  quoteDecimals: 6,
  quoteReserve: '2500000',
  migrationThreshold: '10000000',
  progressBps: 2500,
  slot: 123,
}
const event = (overrides: Partial<IndexedEvent> = {}): IndexedEvent => ({
  postId: 'video',
  signature: 'a',
  instructionPath: '0',
  wallet: 'private-owner',
  slot: 1,
  kind: 'buy',
  baseAmount: '100',
  quoteAmount: '1000000',
  finality: 'confirmed',
  ...overrides,
})

test('investment history is exact signed window cash flow with deterministic trade order, not liquidity', () => {
  assert.deepEqual(investmentHistory([]).points, [])
  const history = investmentHistory([
    event({ signature: 'c', slot: 3, kind: 'sell', quoteAmount: '3000000' }),
    event({ signature: 'b', slot: 2, quoteAmount: '500000' }),
    event(),
  ])
  assert.deepEqual(
    history.points.map((point) => point.netQuoteAmount),
    ['1000000', '1500000', '-1500000'],
  )
  assert.equal(history.buyVolume, '1500000')
  assert.equal(history.sellVolume, '3000000')
  assert.equal(history.netQuoteAmount, '-1500000')
  assert.equal(history.coverage, 'latest-100-trades')
  assert.equal(history.baseline, 'window-start-zero')
  assert.equal('wallet' in history.points[0], false)
  const bounded = investmentHistory(
    Array.from({ length: 101 }, (_, slot) =>
      event({
        slot,
        signature: String(slot),
        quoteAmount: '18446744073709551615',
      }),
    ),
  )
  assert.equal(bounded.points.length, 100)
  assert.equal(bounded.points[0].slot, 1)
  assert.equal(bounded.netQuoteAmount, '1844674407370955161500')
})

test('SQL and memory select the same latest100 events including deterministic same-slot ties', async () => {
  const db = new PGlite()
  const sql = async (parts: TemplateStringsArray, ...values: unknown[]) =>
    (
      await db.query(
        parts.reduce((text, part, index) => text + (index ? `$${index}` : '') + part, ''),
        values,
      )
    ).rows
  const repository = Object.create(PostgresRepository.prototype) as PostgresRepository
  Object.defineProperty(repository, 'sql', { value: sql })
  const memory = new MemoryRepository()
  try {
    await db.exec(
      'create schema private; create table private.indexed_events(post_id text, slot bigint, signature text, instruction_path text, data jsonb)',
    )
    const events = [
      event({ postId: 'other', slot: 999 }),
      ...Array.from({ length: 103 }, (_, n) =>
        event({
          slot: Math.floor(n / 3),
          signature: String(n % 3),
          instructionPath: String(n),
        }),
      ),
    ]
    for (const row of events) {
      memory.events.set(`${row.signature}:${row.instructionPath}`, row)
      await db.query('insert into private.indexed_events values($1,$2,$3,$4,$5)', [
        row.postId,
        row.slot,
        row.signature,
        row.instructionPath,
        row,
      ])
    }
    const actual = await repository.getPostEvents('video')
    assert.equal(actual.length, 100)
    assert.equal(
      actual.every((row) => row.postId === 'video'),
      true,
    )
    assert.deepEqual(actual, await memory.getPostEvents('video'))
    assert.deepEqual(
      investmentHistory(actual)
        .points.slice(-3)
        .map((row) => row.signature),
      ['1', '2', '0'],
    )
  } finally {
    await db.close()
  }
})

test('pool reads are exact, cached and singleflight; true zero is available and empty history is independent', async () => {
  let now = 10000
  let calls = 0
  let release!: (value: MarketSnapshot) => void
  const metrics = new MarketMetrics({
    quoteMint: 'mock-skr',
    decimals: 6,
    now: () => now,
    inspect: async () => {
      calls++
      return new Promise((resolve) => {
        release = resolve
      })
    },
  })
  const one = metrics.read(post)
  const two = metrics.read(post)
  assert.equal(calls, 1)
  assert.equal((await metrics.read({ ...post, id: 'other' })).available, false)
  release(snapshot)
  const [first, second] = await Promise.all([one, two])
  assert.deepEqual(first, second)
  assert.equal(first.amount, '2500000')
  assert.equal(first.observedAt, new Date(now).toISOString())
  assert.deepEqual(investmentHistory([]).points, [])
  assert.deepEqual(await metrics.read(post), first)
  assert.equal(calls, 1)
  now += 30001
  const fresh = metrics.read(post)
  release({ ...snapshot, quoteReserve: '0' })
  assert.equal((await fresh).amount, '0')
  assert.equal((await metrics.read(post)).available, true)
  assert.equal(calls, 2)
})

test('pool cache cannot reuse other bindings or repopulate with a pre-confirmation in-flight balance', async () => {
  let now = 10000
  let calls = 0
  let release!: (value: MarketSnapshot) => void
  const metrics = new MarketMetrics({
    quoteMint: 'mock-skr',
    decimals: 6,
    now: () => now,
    inspect: async () => {
      calls++
      return new Promise((resolve) => {
        release = resolve
      })
    },
  })
  const beforeTrade = metrics.read(post)
  metrics.invalidate(post.id)
  release(snapshot)
  assert.equal((await beforeTrade).amount, null)
  now += 3000
  const afterTrade = metrics.read(post)
  release({ ...snapshot, quoteReserve: '3500000' })
  assert.equal((await afterTrade).amount, '3500000')
  now += 3000
  const moved = metrics.read({ ...post, market: { ...post.market, dbcPool: 'another-curve' } })
  release(snapshot) // wrong pool cannot be presented under a new reference
  assert.equal((await moved).available, false)
  assert.equal(calls, 3)
})

test('migration, missing configuration, mismatched mint and RPC failures never become a zero balance', async () => {
  const create = (inspect?: (market: unknown) => Promise<MarketSnapshot>) =>
    new MarketMetrics({ quoteMint: 'mock-skr', decimals: 6, inspect })
  assert.equal((await create().read(post)).amount, null)
  assert.equal((await create().read({ ...post, market: null })).amount, null)
  for (const status of ['damm-v2', 'migration-required', 'migration-pending'] as const) {
    const result = await create(async () => ({ ...snapshot, status })).read(post)
    assert.equal(result.status, status)
    assert.equal(result.amount, null)
    assert.equal(result.available, false)
  }
  for (const changed of [{ quoteMint: 'wrong-mint' }, { quoteDecimals: 9 }, { quoteReserve: '-1' }])
    assert.equal((await create(async () => ({ ...snapshot, ...changed })).read(post)).amount, null)
  const failed = await create(async () => {
    throw new Error('private RPC URL must not leak')
  }).read(post)
  assert.equal(failed.amount, null)
  assert.equal(JSON.stringify(failed).includes('private RPC'), false)
})

test('HTTP reader timeout retains the global RPC lock instead of flooding a slow upstream', async () => {
  let calls = 0
  let release!: (value: MarketSnapshot) => void
  const metrics = new MarketMetrics({
    quoteMint: 'mock-skr',
    decimals: 6,
    timeoutMs: 5,
    gapMs: 0,
    inspect: async () => {
      calls++
      return new Promise((resolve) => {
        release = resolve
      })
    },
  })
  assert.equal((await metrics.read(post)).available, false)
  assert.equal((await metrics.read({ ...post, id: 'other' })).available, false)
  assert.equal(calls, 1)
  release(snapshot)
  await Promise.resolve()
  assert.equal((await metrics.read(post)).amount, '2500000')
  assert.equal(calls, 1)
})
