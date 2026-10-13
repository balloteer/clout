import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac, generateKeyPairSync, sign } from 'node:crypto'
import { PublicKey } from '@solana/web3.js'
import { AuthService, hashToken } from '../src/auth.js'
import { MemoryRepository } from '../src/memory.js'
import { verifyStreamWebhook } from '../src/media.js'
import { TransactionIndexer } from '../src/indexer.js'
import type { Campaign, IndexedEvent } from '../src/domain.js'
import { deriveAnsRoot } from '../src/identity.js'

function identity() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const wallet = new PublicKey(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)).toBase58()
  return { wallet, privateKey }
}
const owner = identity()
const attacker = identity()

test('AllDomains PDA derivation matches the canonical ANS root', () => {
  assert.equal(deriveAnsRoot().toBase58(), '3mX9b4AZaQehNoQGfckVcmgmA6bkBoFcbLj9RMmMyNcU')
})

test('wallet sign-in verifies exact server message and hashed session, rejects replay', async () => {
  const repository = new MemoryRepository(false)
  const auth = new AuthService(repository, 'https://clout.example')
  const challenge = await auth.issue(owner.wallet)
  assert.equal(challenge.chainId, 'solana:devnet')
  assert.match(challenge.message, /\nChain ID: solana:devnet\n/)
  assert.ok(!challenge.message.includes('mainnet'))
  assert.equal(Buffer.from(challenge.messageBase64, 'base64').toString('utf8'), challenge.message)
  const signature = sign(null, Buffer.from(challenge.message), owner.privateKey).toString('base64')
  const input = { challengeId: challenge.challengeId, signature, signedMessage: challenge.messageBase64 }
  const result = await auth.verify(input)
  assert.equal(result.profile.wallet, owner.wallet)
  assert.equal(repository.sessions.has(result.token), false)
  assert.equal(repository.sessions.has(hashToken(result.token)), true)
  assert.equal((await auth.session(`Bearer ${result.token}`))?.wallet, owner.wallet)
  await assert.rejects(auth.verify(input), /already used/)
})

test('a different key signing a victim message cannot authenticate as that victim', async () => {
  const auth = new AuthService(new MemoryRepository(false), 'https://clout.example')
  const challenge = await auth.issue(owner.wallet)
  await assert.rejects(
    auth.verify({
      challengeId: challenge.challengeId,
      signature: sign(null, Buffer.from(challenge.message), attacker.privateKey).toString('base64'),
      signedMessage: challenge.messageBase64,
    }),
    /could not be verified/,
  )
})

test('origin/chain substitution, expired challenges and malformed input fail closed', async () => {
  let clock = Date.now()
  const auth = new AuthService(new MemoryRepository(false), 'https://clout.example', () => clock)
  const challenge = await auth.issue(owner.wallet)
  const changed = challenge.message.replace('https://clout.example', 'https://attacker.example')
  await assert.rejects(
    auth.verify({
      challengeId: challenge.challengeId,
      signature: sign(null, Buffer.from(changed), owner.privateKey).toString('base64'),
      signedMessage: Buffer.from(changed).toString('base64'),
    }),
    /did not match/,
  )
  const devnetChallenge = await auth.issue(owner.wallet)
  const wrongChain = devnetChallenge.message.replace('solana:devnet', 'solana:mainnet')
  await assert.rejects(
    auth.verify({
      challengeId: devnetChallenge.challengeId,
      signature: sign(null, Buffer.from(wrongChain), owner.privateKey).toString('base64'),
      signedMessage: Buffer.from(wrongChain).toString('base64'),
    }),
    /did not match/,
  )
  const expired = await auth.issue(owner.wallet)
  clock += 300001
  await assert.rejects(
    auth.verify({ challengeId: expired.challengeId, signature: '', signedMessage: '' }),
    /expired/,
  )
  await assert.rejects(auth.issue('not-a-wallet'), /valid Solana/)
})

test('concurrent challenge verification admits exactly one session', async () => {
  const auth = new AuthService(new MemoryRepository(false), 'https://clout.example')
  const challenge = await auth.issue(owner.wallet)
  const input = {
    challengeId: challenge.challengeId,
    signature: sign(null, Buffer.from(challenge.message), owner.privateKey).toString('base64'),
    signedMessage: challenge.messageBase64,
  }
  const outcomes = await Promise.allSettled([auth.verify(input), auth.verify(input)])
  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1)
})

test('Cloudflare webhook authenticates raw bytes and bounds replay age and future skew', () => {
  const now = Date.now()
  const time = Math.floor(now / 1000)
  const raw = Buffer.from('{"readyToStream":true}\n')
  const signature = createHmac('sha256', 'test-secret').update(`${time}.`).update(raw).digest('hex')
  const header = `time=${time},sig1=${signature}`
  assert.equal(verifyStreamWebhook(raw, header, 'test-secret', now), true)
  assert.equal(verifyStreamWebhook(Buffer.from(raw.toString().trim()), header, 'test-secret', now), false)
  assert.equal(verifyStreamWebhook(raw, header, 'wrong-secret', now), false)
  assert.equal(verifyStreamWebhook(raw, header, 'test-secret', now + 301000), false)
  assert.equal(verifyStreamWebhook(raw, header, 'test-secret', now - 301000), false)
  assert.equal(
    verifyStreamWebhook(raw, `time=${time},time=${time},sig1=${signature}`, 'test-secret', now),
    false,
  )
})

test('SGT reservations are unique across transferred wallets and respect campaign cap', async () => {
  const repository = new MemoryRepository(false)
  const campaign: Campaign = {
    id: 'starter',
    symbol: 'SKR',
    mint: owner.wallet,
    amount: '1000000',
    maxClaims: 2,
    enabled: true,
  }
  repository.campaigns.set(campaign.id, campaign)
  const claims = await Promise.all([
    repository.reserveClaim(campaign, 'sgt-1', owner.wallet),
    repository.reserveClaim(campaign, 'sgt-1', owner.wallet),
  ])
  assert.equal(claims[0].id, claims[1].id)
  await assert.rejects(repository.reserveClaim(campaign, 'sgt-1', attacker.wallet), /already reserved/)
  await repository.reserveClaim(campaign, 'sgt-2', attacker.wallet)
  await assert.rejects(repository.reserveClaim(campaign, 'sgt-3', identity().wallet), /All rewards/)
  assert.equal(claims[0].state, 'reserved')
  assert.equal(claims[0].signature, null)
})

test('ingestion deduplicates instruction paths, preserves finality and checkpoints', async () => {
  const repository = new MemoryRepository(false)
  const event: IndexedEvent = {
    signature: 'sig-1',
    instructionPath: '0.1',
    slot: 10,
    wallet: owner.wallet,
    postId: 'post-1',
    kind: 'buy',
    baseAmount: '10',
    quoteAmount: '100',
    finality: 'confirmed',
  }
  await repository.ingest([event, { ...event, instructionPath: '0.2' }], {
    source: 'test',
    signature: 'sig-1',
    slot: 10,
  })
  await repository.ingest([event], { source: 'test', signature: 'older', slot: 9 })
  assert.equal(repository.events.size, 2)
  assert.equal(repository.checkpoints.get('test')?.slot, 10)
  await repository.reconcile('sig-1', 'finalized')
  await repository.ingest([event], { source: 'test', signature: 'older', slot: 9 })
  assert.equal((await repository.getEvents(owner.wallet))[0].finality, 'finalized')
  await repository.reconcile('sig-1', 'dropped')
  assert.equal(repository.events.size, 2)
})

test('indexer never credits failed transactions or treats a missing RPC response as rollback', async () => {
  const repository = new MemoryRepository(false)
  let decoded = false
  const indexer = new TransactionIndexer(
    repository,
    {
      fetch: async (signature) =>
        signature === 'missing' ? null : { signature, slot: 20, failed: true, finalized: false },
      decode: async () => {
        decoded = true
        return []
      },
      async *signaturesSince() {
        yield 'failed'
      },
    },
    'test',
  )
  await indexer.backfill(null)
  assert.equal(decoded, false)
  assert.equal(repository.events.size, 0)
  assert.equal(repository.checkpoints.get('test')?.slot, 20)
  await indexer.reconcile('missing')
  assert.equal(repository.checkpoints.get('test')?.slot, 20)
})
