import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Keypair } from '@solana/web3.js'
import { MemoryRepository } from '../src/memory.js'
import { FaucetService, type FaucetTransport } from '../src/faucet.js'
const owner = Keypair.generate().publicKey.toBase58()
const other = Keypair.generate().publicKey.toBase58()
async function fixture() {
  let clock = Date.parse('2026-10-13T23:59:59.000Z')
  const repository = new MemoryRepository(false, () => clock)
  const campaign = {
    id: 'faucet_alpha_v1',
    symbol: 'SKR' as const,
    mint: 'mock-mint',
    amount: '1000000000',
    period: 'utc-day' as const,
    maxClaims: 2,
    enabled: true,
    authority: 'authority',
    maxSupply: '4000000000',
  }
  const state = {
    builds: 0,
    sends: [] as string[],
    outcome: 'pending' as 'pending' | 'failed' | 'expired' | 'finalized',
    funded: true,
    crash: false,
    failCommit: false,
  }
  const save = repository.saveClaim.bind(repository)
  repository.saveClaim = async (claim, lease) => {
    if (state.failCommit) throw new Error('disk unavailable')
    return save(claim, lease)
  }
  const transport: FaucetTransport = {
    treasury: 'authority',
    quoteMint: 'mock-mint',
    validateBudget: async ({ amountIn }) => {
      assert.ok(BigInt(amountIn) <= 1000000000n)
      if (!state.funded) throw new Error('no SOL')
    },
    prepare: async ({ wallet, amountIn }) => {
      assert.ok([owner, other].includes(wallet))
      assert.equal(amountIn, '1000000000')
      state.builds++
      return {
        signedBase64: `bytes-${state.builds}`,
        signature: `signature-${state.builds}`,
        lastValidBlockHeight: 100,
      }
    },
    submit: async (bytes) => {
      assert.ok((await repository.listClaims(campaign.id)).some((claim) => claim.signedTransaction === bytes))
      state.sends.push(bytes)
      if (state.crash) throw new Error('response lost')
      return `signature-${bytes.split('-')[1]}`
    },
    reconcile: async () => state.outcome,
    availableBalance: async () => campaign.maxSupply,
  }
  const service = new FaucetService(repository, campaign, 6, transport)
  await service.initialize()
  return {
    repository,
    campaign,
    state,
    service,
    transport,
    setClock: (value: string) => {
      clock = Date.parse(value)
    },
  }
}
test('daily faucet grants one bounded allocation per wallet/day, exposes no signer bytes, and reserves the daily cap', async () => {
  const f = await fixture()
  assert.equal((await f.service.status()).available, false)
  assert.equal((await f.service.status(owner)).available, true)
  const claims = await Promise.all([f.service.claim(owner), f.service.claim(owner)])
  assert.equal(claims[0].id, claims[1].id)
  assert.equal(f.state.builds, 1)
  assert.equal('signedTransaction' in claims[0], false)
  assert.equal('sgtMint' in claims[0], false)
  assert.equal((await f.service.status(owner)).available, false)
  await assert.rejects(f.service.get(other, claims[0].id), /not found/)
  await f.service.claim(other)
  await assert.rejects(f.service.claim(Keypair.generate().publicKey.toBase58()), /allocation/)
  assert.equal((await f.repository.listClaims(f.campaign.id)).length, 2)
})
test('faucet interruption rebroadcasts exact persisted bytes and only finalized means minted', async () => {
  const f = await fixture()
  f.state.crash = true
  const claim = await f.service.claim(owner)
  assert.equal(claim.state, 'prepared')
  f.state.crash = false
  await f.service.resume()
  assert.equal(f.state.builds, 1)
  assert.deepEqual(f.state.sends, ['bytes-1', 'bytes-1'])
  f.state.outcome = 'finalized'
  await f.service.resume()
  assert.equal((await f.service.get(owner, claim.id)).state, 'finalized')
  assert.match((await f.service.status(owner)).reason!, /00:00 UTC/)
  const reopened = new FaucetService(f.repository, f.campaign, 6, f.transport)
  await reopened.initialize()
  assert.equal((await reopened.status(owner)).claim?.state, 'finalized')
})
test('faucet missing expired history blocks replacement, and failed persistence prevents broadcast', async () => {
  const f = await fixture()
  const claim = await f.service.claim(owner)
  f.state.outcome = 'expired'
  await f.service.resume()
  await f.service.claim(owner)
  assert.equal(f.state.builds, 1)
  assert.equal((await f.service.get(owner, claim.id)).needsReview, true)
  const second = await fixture()
  second.state.failCommit = true
  await second.service.claim(owner)
  assert.equal(second.state.sends.length, 0)
  second.state.funded = false
  await assert.rejects(second.service.initialize(), /no SOL/)
})

test('faucet restart reconciles an already-landed mint when DB submission is stale and budget headroom is gone', async () => {
  const f = await fixture()
  const claim = await f.service.claim(owner)
  assert.equal(claim.state, 'submitted')
  const checks: string[] = []
  const budget = await f.repository.getFaucetBudget(f.campaign.id)
  f.transport.availableBalance = async () => {
    throw new Error('must not recapture baseline')
  }
  f.transport.validateBudget = async ({ amountIn }) => {
    checks.push(amountIn)
    if (amountIn !== '0') throw new Error('mint already consumed remaining capacity')
  }
  f.state.outcome = 'finalized'
  const reopened = new FaucetService(f.repository, f.campaign, 6, f.transport)
  await reopened.initialize()
  assert.deepEqual(await f.repository.getFaucetBudget(f.campaign.id), budget)
  assert.deepEqual(checks, ['0'])
  assert.equal((await reopened.status(other)).available, false)
  await reopened.resume()
  assert.equal((await reopened.get(owner, claim.id)).state, 'finalized')
  assert.equal(f.state.builds, 1)
})

test('UTC midnight resets each wallet and daily cap without resetting the lifetime supply ledger', async () => {
  const f = await fixture()
  const first = await f.service.claim(owner)
  await f.service.claim(other)
  f.state.outcome = 'finalized'
  await f.service.resume()
  const yesterday = await f.service.status(owner)
  assert.equal(yesterday.day, '2026-10-13')
  assert.equal(yesterday.resetAt, '2026-10-14T00:00:00.000Z')
  assert.equal(yesterday.remainingAmount, '0')
  f.setClock('2026-10-14T00:00:00.000Z')
  const fresh = await f.service.status(owner)
  assert.equal(fresh.available, true)
  assert.equal(fresh.claim, null)
  assert.equal(fresh.remainingAmount, '1000000000')
  const next = await Promise.all([f.service.claim(owner), f.service.claim(owner)])
  assert.equal(next[0].id, next[1].id)
  assert.notEqual(next[0].id, first.id)
  assert.equal(next[0].day, '2026-10-14')
  await f.service.claim(other)
  await f.service.resume()
  f.setClock('2026-10-15T00:00:00.000Z')
  assert.match((await f.service.status(owner)).reason!, /supply ceiling/)
  assert.equal((await f.repository.getFaucetBudget(f.campaign.id))?.allocatedUnits, '4000000000')
  assert.equal(f.state.builds, 4)
})

test('prior-day interrupted and expired requests block new-day replacements while recovery keeps the same signed bytes', async () => {
  const f = await fixture()
  f.state.crash = true
  const original = await f.service.claim(owner)
  f.setClock('2026-10-14T00:00:00.000Z')
  assert.equal((await f.service.status(owner)).claim?.id, original.id)
  assert.equal((await f.service.status(owner)).available, false)
  f.state.crash = false
  const resumed = await f.service.claim(owner)
  assert.equal(resumed.id, original.id)
  assert.equal(f.state.builds, 1)
  assert.deepEqual(f.state.sends, ['bytes-1', 'bytes-1'])
  f.state.outcome = 'expired'
  await f.service.resume()
  f.setClock('2026-10-15T00:00:00.000Z')
  assert.equal((await f.service.claim(owner)).id, original.id)
  assert.equal((await f.service.status(owner)).claim?.needsReview, true)
  assert.equal(f.state.builds, 1)
})

test('daily faucet enforces the fixed 1000 SKR amount and never accepts a larger configurable grant', async () => {
  const f = await fixture()
  assert.throws(
    () => new FaucetService(f.repository, { ...f.campaign, amount: '1000000001' }, 6, f.transport),
    /Invalid/,
  )
  assert.throws(
    () => new FaucetService(f.repository, { ...f.campaign, period: undefined }, 6, f.transport),
    /Invalid/,
  )
})
