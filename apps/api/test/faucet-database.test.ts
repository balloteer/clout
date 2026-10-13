import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { PostgresRepository } from '../src/postgres.js'
import type { Campaign, Claim } from '../src/domain.js'

const migration = new URL('../../../supabase/migrations/20261013051351_daily_faucet.sql', import.meta.url)
async function database() {
  const db = new PGlite()
  await db.exec('create role anon; create role authenticated;')
  await db.exec(
    await readFile(
      new URL('../../../supabase/migrations/20261013000133_clout_initial.sql', import.meta.url),
      'utf8',
    ),
  )
  await db.exec(await readFile(migration, 'utf8'))
  const tag = (client: Pick<PGlite, 'query'>): any =>
    Object.assign(
      async (parts: TemplateStringsArray, ...values: unknown[]) => {
        const query = parts.reduce((text, part, index) => text + (index ? `$${index}` : '') + part, '')
        return (await client.query(query, values)).rows
      },
      {
        json: (value: unknown) => JSON.stringify(value),
        begin: async (fn: (sql: any) => Promise<unknown>) => db.transaction((tx) => fn(tag(tx))),
      },
    )
  const repository = Object.create(PostgresRepository.prototype) as PostgresRepository
  Object.defineProperty(repository, 'sql', { value: tag(db) })
  const campaign: Campaign = {
    id: 'faucet_sql',
    period: 'utc-day',
    symbol: 'SKR',
    mint: 'mock',
    amount: '1000000000',
    maxClaims: 2,
    enabled: true,
    authority: 'authority',
    maxSupply: '5000000000',
  }
  await repository.putCampaign(campaign)
  await repository.registerFaucetBudget(campaign, '1000000000')
  async function previousDay(claim: Claim, state: Claim['state']) {
    await db.query(
      `update private.reward_claims set claim_day = claim_day - 1,
      data = data || jsonb_build_object('day', to_char(claim_day - 1, 'YYYY-MM-DD'), 'state', $2::text)
      where id = $1`,
      [claim.id, state],
    )
  }
  return { db, repository, campaign, previousDay }
}

test('actual daily reservation SQL serializes owner/day allocation and UTC caps, protects private grants and immutable baseline', async () => {
  const f = await database()
  try {
    const claims = await Promise.all(
      Array.from({ length: 8 }, () => f.repository.reserveFaucetClaim(f.campaign.id, 'owner')),
    )
    assert.equal(new Set(claims.map((claim) => claim.id)).size, 1)
    assert.match(claims[0].day!, /^\d{4}-\d{2}-\d{2}$/)
    const status = await f.repository.getFaucetState(f.campaign.id, 'owner')
    assert.equal(status.claimsToday, 1)
    assert.equal(status.claim?.id, claims[0].id)
    assert.match(status.resetAt, /T00:00:00.000Z$/)
    assert.equal(status.budget.allocatedUnits, '1000000000')
    await f.repository.registerFaucetBudget(f.campaign, '4000000000')
    assert.equal((await f.repository.getFaucetBudget(f.campaign.id))?.baselineSupply, '1000000000')
    await f.repository.reserveFaucetClaim(f.campaign.id, 'other')
    await assert.rejects(f.repository.reserveFaucetClaim(f.campaign.id, 'third'), /Today’s faucet/)
    assert.equal((await f.repository.getFaucetBudget(f.campaign.id))?.allocatedUnits, '2000000000')
    await assert.rejects(
      f.repository.reserveClaim(f.campaign, 'fake-sgt', 'bypass'),
      /Daily faucet reservation/,
    )
    await f.db.exec('set role anon')
    await assert.rejects(f.db.query('select * from private.faucet_budgets'), /permission denied/)
    await assert.rejects(
      f.db.query('select private.reserve_daily_faucet($1,$2,$3)', [f.campaign.id, 'attacker', randomUUID()]),
      /permission denied/,
    )
    await f.db.exec('reset role')
  } finally {
    await f.db.close()
  }
})

test('SQL rollover reuses earlier unresolved intent, grants next settled day, and never resets lifetime supply', async () => {
  const f = await database()
  try {
    const original = await f.repository.reserveFaucetClaim(f.campaign.id, 'owner')
    await f.previousDay(original, 'submitted')
    assert.equal((await f.repository.reserveFaucetClaim(f.campaign.id, 'owner')).id, original.id)
    assert.equal((await f.repository.getFaucetState(f.campaign.id, 'owner')).claim?.id, original.id)
    await f.db.query(
      `update private.reward_claims set data = data || '{"state":"expired"}'::jsonb where id = $1`,
      [original.id],
    )
    assert.equal((await f.repository.reserveFaucetClaim(f.campaign.id, 'owner')).id, original.id)
    // A conclusive reviewed settlement unblocks the next day; unknown expiry never does.
    await f.db.query(
      `update private.reward_claims set data = data || '{"state":"finalized"}'::jsonb where id = $1`,
      [original.id],
    )
    const today = await f.repository.reserveFaucetClaim(f.campaign.id, 'owner')
    assert.notEqual(today.id, original.id)
    assert.notEqual(today.day, (await f.repository.getClaim(original.id))?.day)
    // Move each day far enough back that historical unique owner/day rows remain distinct.
    await f.db.query(
      `update private.reward_claims set claim_day = claim_day - 10,
      data = data || jsonb_build_object('day', to_char(claim_day - 10, 'YYYY-MM-DD')) where id = $1`,
      [original.id],
    )
    await f.previousDay(today, 'finalized')
    const third = await f.repository.reserveFaucetClaim(f.campaign.id, 'owner')
    await f.db.query(
      `update private.reward_claims set claim_day = claim_day - 20,
      data = data || jsonb_build_object('day', to_char(claim_day - 20, 'YYYY-MM-DD')) where id = $1`,
      [today.id],
    )
    await f.previousDay(third, 'finalized')
    const results = await Promise.allSettled([
      f.repository.reserveFaucetClaim(f.campaign.id, 'owner'),
      f.repository.reserveFaucetClaim(f.campaign.id, 'other'),
    ])
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1)
    assert.deepEqual(await f.repository.getFaucetBudget(f.campaign.id), {
      baselineSupply: '1000000000',
      allocatedUnits: '4000000000',
      maxSupply: '5000000000',
    })
  } finally {
    await f.db.close()
  }
})

test('daily uniqueness is enforced by the database and recovery pages beyond 100 old requests', async () => {
  const f = await database()
  try {
    const claim = await f.repository.reserveFaucetClaim(f.campaign.id, 'owner')
    await assert.rejects(
      f.db.query(
        `insert into private.reward_claims(id,campaign_id,sgt_mint,wallet,data,claim_day)
      values($1,$2,$3,$4,$5,$6)`,
        [randomUUID(), claim.campaignId, claim.sgtMint, claim.wallet, claim, claim.day],
      ),
      /duplicate key/,
    )
    // The daily budget can support many requests; existing one-time reward uniqueness remains separate.
    await f.db.query(
      `update private.campaigns set data = data || '{"maxClaims":200,"maxSupply":"1000000000000"}'::jsonb where id = $1`,
      [f.campaign.id],
    )
    await f.db.query('update private.faucet_budgets set max_supply = 1000000000000 where campaign_id = $1', [
      f.campaign.id,
    ])
    for (let index = 0; index < 105; index++)
      await f.repository.reserveFaucetClaim(f.campaign.id, `owner-${index}`)
    const first = await f.repository.listPendingClaims(f.campaign.id)
    assert.equal(first.length, 100)
    const second = await f.repository.listPendingClaims(f.campaign.id, first.at(-1)!.id)
    assert.equal(second.length, 6)
    assert.equal(new Set([...first, ...second].map((item) => item.id)).size, 106)
    assert.equal((await f.repository.listPendingClaims(f.campaign.id, second.at(-1)!.id)).length, 0)
  } finally {
    await f.db.close()
  }
})
