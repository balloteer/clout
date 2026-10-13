import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryRepository } from '../src/memory.js'
import { RewardService, type RewardTransport, publicClaim } from '../src/rewards.js'
import type { Campaign, Claim } from '../src/domain.js'

const campaign: Campaign = {
  id: 'starter',
  symbol: 'SKR',
  mint: 'test-skr',
  amount: '1000000',
  maxClaims: 2,
  enabled: true,
}
function fixture(repository = new MemoryRepository(false)) {
  const state = {
    funded: true,
    verified: true,
    checks: 0,
    sgt: 'sgt-1',
    builds: 0,
    submits: [] as string[],
    outcome: 'pending' as 'pending' | 'expired' | 'failed' | 'finalized',
    lookupError: false,
    submitError: false,
  }
  const transport: RewardTransport = {
    treasury: 'treasury',
    quoteMint: campaign.mint,
    validateBudget: async ({ amountIn }) => {
      assert.ok(BigInt(amountIn) <= 2000000n)
      if (!state.funded) throw new Error('unfunded')
    },
    prepare: async () => {
      state.builds++
      return {
        signature: `signature-${state.builds}`,
        signedBase64: `signed-${state.builds}`,
        lastValidBlockHeight: 100 + state.builds,
      }
    },
    submit: async (bytes) => {
      const stored = (await repository.listClaims(campaign.id)).find((row) => row.signedTransaction === bytes)
      assert.ok(stored, 'signed bytes must be durable BEFORE transmission')
      assert.equal(stored.signature, `signature-${bytes.split('-')[1]}`)
      state.submits.push(bytes)
      if (state.submitError) throw new Error('response lost after broadcast')
      return stored.signature!
    },
    reconcile: async () => {
      if (state.lookupError) throw new Error('RPC unavailable')
      return state.outcome
    },
  }
  const seeker = {
    check: async () => {
      state.checks++
      return { hasSGT: state.verified, mintAddress: state.verified ? state.sgt : null }
    },
  }
  const service = new RewardService(repository, campaign, 6, seeker, transport)
  return { service, repository, state, transport }
}

test('claims verify fresh SGT, enforce full budget and unique device AND wallet', async () => {
  const f = fixture()
  await f.service.initialize()
  f.state.funded = false
  assert.equal((await f.service.status()).available, false)
  await assert.rejects(f.service.claim('wallet-a'), /fully funded/)
  assert.equal(f.repository.claims.size, 0)
  f.state.funded = true
  f.state.verified = false
  await assert.rejects(f.service.claim('wallet-a'), /currently hold/)
  f.state.verified = true
  const first = await f.service.claim('wallet-a')
  assert.equal(first.state, 'submitted')
  assert.equal('signedTransaction' in first, false)
  assert.equal('leaseToken' in first, false)
  await assert.rejects(f.service.claim('wallet-b'), /already reserved/)
  f.state.sgt = 'sgt-2'
  assert.equal((await f.service.claim('wallet-a')).id, first.id)
  assert.equal(f.state.builds, 1)
  assert.equal(f.state.checks, 5)
})

test('crash after broadcast recovers exact signature and finalization cannot pay twice', async () => {
  const f = fixture()
  await f.service.initialize()
  f.state.submitError = true
  const claim = await f.service.claim('wallet-a')
  assert.equal(claim.state, 'prepared')
  assert.equal(f.state.builds, 1)
  f.state.submitError = false
  const restarted = new RewardService(
    f.repository,
    campaign,
    6,
    {
      check: async () => {
        throw new Error('worker does not re-authorize new recipients')
      },
    },
    f.transport,
  )
  await restarted.resume()
  assert.deepEqual(f.state.submits, ['signed-1', 'signed-1'])
  f.state.outcome = 'finalized'
  await restarted.resume()
  await restarted.resume()
  assert.equal((await f.repository.getClaim(claim.id))?.state, 'finalized')
  assert.equal(f.state.builds, 1)
  assert.equal(f.state.submits.length, 2)
})

test('ambiguous RPC and missing expired history never create another payment', async () => {
  const f = fixture()
  await f.service.initialize()
  const claim = await f.service.claim('wallet-a')
  f.state.lookupError = true
  await f.service.resume()
  await f.service.resume()
  assert.equal(f.state.builds, 1)
  assert.equal(f.state.submits.length, 1)
  f.state.lookupError = false
  f.state.outcome = 'expired'
  await f.service.resume()
  await f.service.resume()
  await f.service.resume()
  await f.service.resume()
  const persisted = await f.repository.getClaim(claim.id)
  await f.service.claim('wallet-a')
  assert.equal(f.state.builds, 1)
  assert.equal(f.state.submits.length, 1)
  assert.equal(persisted?.state, 'expired')
  assert.equal(persisted?.attemptCount, 1)
  assert.equal(publicClaim(persisted!).needsReview, true)
})

test('failed durable commit prevents broadcast, and concurrent workers have one lease', async () => {
  class FailingRepository extends MemoryRepository {
    fail = true
    override async saveClaim(claim: Claim, lease: string) {
      if (this.fail) throw new Error('database offline')
      return super.saveClaim(claim, lease)
    }
  }
  const repository = new FailingRepository(false)
  const f = fixture(repository)
  await f.service.initialize()
  const claim = await f.service.claim('wallet-a')
  assert.equal(claim.state, 'reserved')
  assert.equal(f.state.submits.length, 0)
  repository.fail = false
  await Promise.all([f.service.process(claim.id), f.service.process(claim.id), f.service.process(claim.id)])
  assert.equal(f.state.submits.length, 1)
  assert.equal((await repository.getClaim(claim.id))?.state, 'submitted')
})

test('expired leases recover after restart and stale workers cannot overwrite a newer lease', async () => {
  const f = fixture()
  await f.service.initialize()
  const claim = await f.repository.reserveClaim(campaign, 'sgt-1', 'wallet-a')
  const crashed = (await f.repository.acquireClaim(claim.id, 100))!
  assert.equal(await f.repository.acquireClaim(claim.id, 1000), null)
  const recovered = (await f.repository.acquireClaim(claim.id, 100000))!
  assert.notEqual(crashed.leaseToken, recovered.leaseToken)
  assert.equal(await f.repository.saveClaim({ ...crashed, state: 'finalized' }, crashed.leaseToken!), false)
  await f.repository.releaseClaim(claim.id, crashed.leaseToken!)
  assert.equal((await f.repository.getClaim(claim.id))?.leaseToken, recovered.leaseToken)
  assert.equal('leaseExpiresAt' in publicClaim(recovered), false)
})

test('only a finalized onchain failure permits a replacement, bounded to three attempts', async () => {
  const f = fixture()
  await f.service.initialize()
  const claim = await f.service.claim('wallet-a')
  f.state.outcome = 'failed'
  await f.service.resume()
  await f.service.resume()
  await f.service.resume()
  await f.service.resume()
  const persisted = await f.repository.getClaim(claim.id)
  assert.equal(f.state.builds, 3)
  assert.equal(persisted?.state, 'failed')
  assert.equal(publicClaim(persisted!).retryable, false)
  assert.deepEqual(
    persisted?.previousAttempts?.map((row) => row.signature),
    ['signature-1', 'signature-2'],
  )
})

test('campaign replacement refuses unresolved prior payouts and deactivates completed campaigns', async () => {
  const f = fixture()
  await f.service.initialize()
  await f.service.claim('wallet-a')
  const next = { ...campaign, id: 'next' }
  await assert.rejects(f.repository.putCampaign(next), /unresolved/)
  f.state.outcome = 'finalized'
  await f.service.resume()
  await f.repository.putCampaign(next)
  await assert.rejects(f.repository.reserveClaim(campaign, 'sgt-2', 'wallet-b'), /not active/)
  assert.equal((await f.repository.reserveClaim(next, 'sgt-2', 'wallet-b')).campaignId, next.id)
})
