import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { BuiltTrade, MarketService } from '@clout/markets'
import type { Connection } from '@solana/web3.js'
import { MemoryRepository } from '../src/memory.js'
import { reconcileIntent, reconcilePending } from '../src/transactions.js'
import type { TransactionIntent } from '../src/domain.js'

function tradeIntent(): TransactionIntent {
  const envelope = {
    owner: 'buyer',
    lastValidBlockHeight: 100,
    messageBase64: 'exact-message',
    quote: { market: { baseMint: 'post-token', quoteMint: 'test-skr' } },
  } as BuiltTrade
  return {
    id: 'intent',
    wallet: 'buyer',
    kind: 'trade',
    postId: 'big-buck-bunny',
    envelope: envelope as unknown as Record<string, unknown>,
    signature: null,
    state: 'prepared',
    createdAt: new Date().toISOString(),
  }
}

test('confirmed trades use verified deltas and only finalized history earns early badges', async () => {
  const repository = new MemoryRepository()
  const intent = tradeIntent()
  await repository.putIntent(intent)
  let finalized = false
  const chain = {
    getSignatureStatuses: async () => ({
      value: [{ err: null, confirmationStatus: finalized ? 'finalized' : 'confirmed' }],
    }),
  } as unknown as Connection
  const markets = {
    reconcileTrade: async ({ trade }: { trade: BuiltTrade }) => {
      assert.equal(trade.messageBase64, 'exact-message')
      return {
        status: 'confirmed',
        signature: 'signature',
        slot: 55,
        tokenDeltas: { 'post-token': '900', 'test-skr': '-100' },
        feeLamports: '5000',
        blockTime: 1,
      }
    },
  } as unknown as MarketService
  await reconcileIntent(repository, markets, intent, 'signature', chain)
  assert.equal((await repository.getEvents('buyer'))[0].baseAmount, '900')
  assert.equal((await repository.getEvents('buyer'))[0].quoteAmount, '100')
  assert.equal((await repository.getEvents('buyer'))[0].finality, 'confirmed')
  finalized = true
  await reconcileIntent(repository, markets, intent, 'signature', chain)
  assert.equal((await repository.getEvents('buyer')).length, 1)
  assert.equal((await repository.getEvents('buyer'))[0].finality, 'finalized')
  assert.equal((await repository.getIntent(intent.id))?.state, 'finalized')
})

test('failed and expired transaction reconciliation removes only provisional history', async () => {
  const repository = new MemoryRepository()
  const intent = tradeIntent()
  intent.signature = 'signature'
  intent.state = 'confirmed'
  await repository.putIntent(intent)
  await repository.ingest(
    [
      {
        signature: 'signature',
        instructionPath: 'verified-intent',
        slot: 2,
        wallet: 'buyer',
        postId: intent.postId,
        kind: 'buy',
        baseAmount: '1',
        quoteAmount: '2',
        finality: 'confirmed',
      },
    ],
    { source: 'test', signature: 'signature', slot: 2 },
  )
  const markets = {
    reconcileTrade: async () => ({ status: 'expired', signature: 'signature' }),
  } as unknown as MarketService
  await reconcileIntent(repository, markets, intent, 'signature')
  assert.equal((await repository.getEvents('buyer')).length, 0)
  assert.equal((await repository.getIntent(intent.id))?.state, 'expired')
})

test('restart worker expires unsigned intents by block height without resending', async () => {
  const repository = new MemoryRepository()
  const intent = tradeIntent()
  await repository.putIntent(intent)
  let checks = 0
  const markets = {
    reconcileTrade: async () => {
      checks++
      throw new Error('Should never resubmit')
    },
  } as unknown as MarketService
  const chain = { getBlockHeight: async () => 101 } as unknown as Connection
  const result = await reconcilePending(repository, markets, chain)
  assert.equal(result.checked, 1)
  assert.equal(result.failed, 0)
  assert.equal(checks, 0)
  assert.equal((await repository.getIntent(intent.id))?.state, 'expired')
})

test('pending market launch is unique until the existing transaction expires', async () => {
  const repository = new MemoryRepository()
  const first = { ...tradeIntent(), kind: 'launch' as const, id: 'launch-1' }
  const second = { ...first, id: 'launch-2' }
  await Promise.all([repository.putIntent(first), repository.putIntent(second)])
  assert.equal(repository.intents.size, 1)
  assert.equal((await repository.getActiveLaunch(first.postId))?.id, first.id)
  await repository.updateIntent(first.id, 'expired', null)
  await repository.putIntent(second)
  assert.equal((await repository.getActiveLaunch(first.postId))?.id, second.id)
})

test('concurrent different signatures cannot both settle the same intent', async () => {
  const repository = new MemoryRepository()
  const intent = tradeIntent()
  await repository.putIntent(structuredClone(intent))
  let started = 0
  let release!: () => void
  const bothStarted = new Promise<void>((resolve) => {
    release = resolve
  })
  const markets = {
    reconcileTrade: async ({ signature }: { signature: string }) => {
      if (++started === 2) release()
      await bothStarted
      return {
        status: 'confirmed',
        signature,
        slot: 55,
        tokenDeltas: { 'post-token': '900', 'test-skr': '-100' },
        feeLamports: '5000',
        blockTime: 1,
      }
    },
  } as unknown as MarketService
  const chain = {
    getSignatureStatuses: async () => ({ value: [{ err: null, confirmationStatus: 'finalized' }] }),
  } as unknown as Connection
  const results = await Promise.allSettled([
    reconcileIntent(repository, markets, structuredClone(intent), 'signature-a', chain),
    reconcileIntent(repository, markets, structuredClone(intent), 'signature-b', chain),
  ])
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult
  assert.equal(rejected.reason.code, 'SIGNATURE_MISMATCH')
  const stored = (await repository.getIntent(intent.id))!
  assert.equal(stored.state, 'finalized')
  assert.deepEqual(
    (await repository.getEvents(intent.wallet)).map((event) => event.signature),
    [stored.signature],
  )
  // A same-signature retry after finalization remains idempotent.
  await reconcileIntent(repository, markets, structuredClone(intent), stored.signature!, chain)
  assert.equal((await repository.getEvents(intent.wallet)).length, 1)
})
