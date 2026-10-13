import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

test('Supabase migration executes and RLS/grants block forged writes and private reads', async () => {
  const db = new PGlite()
  try {
    await db.exec('create role anon; create role authenticated;')
    await db.exec(
      await readFile(
        new URL('../../../supabase/migrations/20261013000133_clout_initial.sql', import.meta.url),
        'utf8',
      ),
    )
    await db.query('insert into public.profiles (wallet, data) values ($1, $2)', [
      'owner',
      { wallet: 'owner', seekerVerified: false },
    ])
    await db.query('insert into public.posts (id, creator_wallet, status, data) values ($1, $2, $3, $4)', [
      'ready',
      'owner',
      'ready',
      { id: 'ready', creatorWallet: 'owner', status: 'ready' },
    ])
    await db.query('insert into public.posts (id, creator_wallet, status, data) values ($1, $2, $3, $4)', [
      'processing',
      'owner',
      'processing',
      { id: 'processing', creatorWallet: 'owner', status: 'processing' },
    ])
    await db.exec('set role anon;')
    const visible = await db.query<{ id: string }>('select id from public.posts')
    assert.deepEqual(
      visible.rows.map((row) => row.id),
      ['ready'],
    )
    await assert.rejects(db.query('select * from private.wallet_sessions'), /permission denied/)
    await assert.rejects(
      db.query('insert into public.profiles (wallet, data) values ($1, $2)', [
        'attacker',
        { wallet: 'attacker' },
      ]),
      /permission denied/,
    )
    await assert.rejects(
      db.query('update public.profiles set data = $1', [{ wallet: 'owner', seekerVerified: true }]),
      /permission denied/,
    )
    await assert.rejects(db.query('delete from public.posts'), /permission denied/)
    await db.exec('reset role; set role authenticated;')
    await assert.rejects(db.query('select * from private.reward_claims'), /permission denied/)
    await assert.rejects(db.query('update public.posts set status = $1', ['ready']), /permission denied/)
    await assert.rejects(
      db.query('insert into public.likes (post_id, wallet) values ($1, $2)', ['ready', 'owner']),
      /permission denied/,
    )
    await db.exec('reset role;')
    const tables = await db.query<{ enabled: boolean }>(
      "select bool_and(c.relrowsecurity) as enabled from pg_class c join pg_namespace n on c.relnamespace = n.oid where n.nspname in ('public', 'private') and c.relkind='r'",
    )
    assert.equal(tables.rows[0].enabled, true)
  } finally {
    await db.close()
  }
})

test('database enforces claim uniqueness by SGT and atomically consumes challenges', async () => {
  const db = new PGlite()
  try {
    await db.exec('create role anon; create role authenticated;')
    await db.exec(
      await readFile(
        new URL('../../../supabase/migrations/20261013000133_clout_initial.sql', import.meta.url),
        'utf8',
      ),
    )
    const campaign = { symbol: 'SKR', maxClaims: 100, amount: '1000000', enabled: true }
    await db.query('insert into private.campaigns (id, data) values ($1, $2)', ['starter', campaign])
    await assert.rejects(
      db.query('insert into private.campaigns (id, data) values ($1, $2)', [
        'invalid',
        { ...campaign, symbol: 'CLOUT' },
      ]),
      /campaign_bounds/,
    )
    await db.query(
      'insert into private.reward_claims (id,campaign_id,sgt_mint,wallet,data) values ($1,$2,$3,$4,$5)',
      ['00000000-0000-4000-8000-000000000001', 'starter', 'one-device', 'wallet-a', { state: 'reserved' }],
    )
    await assert.rejects(
      db.query(
        'insert into private.reward_claims (id,campaign_id,sgt_mint,wallet,data) values ($1,$2,$3,$4,$5)',
        ['00000000-0000-4000-8000-000000000002', 'starter', 'one-device', 'wallet-b', {}],
      ),
      /unique constraint/,
    )
    await assert.rejects(
      db.query(
        'insert into private.reward_claims (id,campaign_id,sgt_mint,wallet,data) values ($1,$2,$3,$4,$5)',
        ['00000000-0000-4000-8000-000000000003', 'starter', 'second-device', 'wallet-a', {}],
      ),
      /unique constraint/,
    )
    const leaseSql =
      "update private.reward_claims set data = data || $1::jsonb where id = $2 and data->>'state' <> 'finalized' and coalesce((data->>'leaseExpiresAt')::bigint, 0) <= $3 returning data"
    const claimId = '00000000-0000-4000-8000-000000000001'
    assert.equal(
      (await db.query(leaseSql, [{ leaseToken: 'first', leaseExpiresAt: 1000 }, claimId, 1])).rows.length,
      1,
    )
    assert.equal(
      (await db.query(leaseSql, [{ leaseToken: 'second', leaseExpiresAt: 2000 }, claimId, 100])).rows.length,
      0,
    )
    assert.equal(
      (await db.query(leaseSql, [{ leaseToken: 'second', leaseExpiresAt: 3000 }, claimId, 1001])).rows.length,
      1,
    )
    const saveSql =
      "update private.reward_claims set data = $1::jsonb where id = $2 and data->>'leaseToken' = $3 and data->>'state' <> 'finalized' returning id"
    assert.equal((await db.query(saveSql, [{ state: 'finalized' }, claimId, 'first'])).rows.length, 0)
    assert.equal(
      (await db.query(saveSql, [{ state: 'finalized', signature: 'paid-once' }, claimId, 'second'])).rows
        .length,
      1,
    )
    assert.equal(
      (await db.query(leaseSql, [{ leaseToken: 'third', leaseExpiresAt: 5000 }, claimId, 4000])).rows.length,
      0,
    )
    await assert.rejects(
      db.query(
        'insert into private.reward_claims (id,campaign_id,sgt_mint,wallet,data) values ($1,$2,$3,$4,$5)',
        [
          '00000000-0000-4000-8000-000000000004',
          'starter',
          'third-device',
          'wallet-b',
          { signature: 'paid-once' },
        ],
      ),
      /unique constraint/,
    )
    await db.query(
      'insert into private.wallet_challenges (id,address,message,expires_at) values ($1,$2,$3,$4)',
      ['a'.repeat(48), 'wallet-a', 'message', new Date(Date.now() + 60000).toISOString()],
    )
    const consumed = await db.query('delete from private.wallet_challenges where id = $1 returning id', [
      'a'.repeat(48),
    ])
    const replay = await db.query('delete from private.wallet_challenges where id = $1 returning id', [
      'a'.repeat(48),
    ])
    assert.equal(consumed.rows.length, 1)
    assert.equal(replay.rows.length, 0)
  } finally {
    await db.close()
  }
})

test('actual repository campaign SQL blocks switching pending campaigns and stale reservations', async () => {
  const { PostgresRepository } = await import('../src/postgres.js')
  const db = new PGlite()
  // Adapt the parameterized postgres.js tag to PGlite; execute the repository's actual SQL.
  const sql = Object.assign(
    async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const statement = parts.reduce((query, part, index) => query + (index ? `$${index}` : '') + part, '')
      return (await db.query(statement, values)).rows
    },
    {
      json: (value: unknown) => JSON.stringify(value),
      begin: async <T>(fn: (client: any) => Promise<T>) => {
        await db.exec('begin')
        try {
          const result = await fn(sql)
          await db.exec('commit')
          return result
        } catch (error) {
          await db.exec('rollback')
          throw error
        }
      },
    },
  )
  const repository = Object.create(PostgresRepository.prototype) as InstanceType<typeof PostgresRepository>
  Object.defineProperty(repository, 'sql', { value: sql })
  try {
    await db.exec('create role anon; create role authenticated;')
    await db.exec(
      await readFile(
        new URL('../../../supabase/migrations/20261013000133_clout_initial.sql', import.meta.url),
        'utf8',
      ),
    )
    const first = {
      id: 'first',
      symbol: 'SKR' as const,
      mint: 'test-skr',
      amount: '1000000',
      maxClaims: 2,
      enabled: true,
    }
    const next = { ...first, id: 'next' }
    await repository.putCampaign(first)
    const claim = await repository.reserveClaim(first, 'device-1', 'wallet-1')
    await assert.rejects(repository.putCampaign(next), /unresolved/)
    await assert.rejects(repository.putCampaign({ ...first, amount: '2000000' }), /cannot change/)
    const lease = (await repository.acquireClaim(claim.id, 1000))!
    assert.equal(await repository.saveClaim({ ...lease, state: 'expired' }, lease.leaseToken!), true)
    await assert.rejects(repository.putCampaign(next), /unresolved/)
    assert.equal(await repository.acquireClaim(claim.id, 1000000), null)
    // Operator review is deliberately outside the automatic payout worker.
    await db.query(
      'update private.reward_claims set data = data || \'{"state":"finalized"}\'::jsonb where id = $1',
      [claim.id],
    )
    await repository.putCampaign(next)
    await assert.rejects(repository.reserveClaim(first, 'device-2', 'wallet-2'), /not active/)
    assert.equal((await repository.reserveClaim(next, 'device-2', 'wallet-2')).campaignId, next.id)
  } finally {
    await db.close()
  }
})
