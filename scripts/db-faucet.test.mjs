import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { MIGRATION, expectedTables, inspectDatabase } from './db-setup.mjs'
import { LINKED_MIGRATION, linkedTables, inspectGuards, assertLinkedMigrationSafe } from './db-linked.mjs'
import { FAUCET_MIGRATION, inspectFaucetGuards, assertFaucetMigrationSafe, main } from './db-faucet.mjs'

test('daily migration helper verifies history, private grants and daily uniqueness before and after apply', async () => {
  const db = new PGlite()
  const tag = (client) =>
    Object.assign(
      async (parts, ...values) =>
        (
          await client.query(
            parts.reduce((query, part, index) => query + (index ? `$${index}` : '') + part, ''),
            values,
          )
        ).rows,
      {
        begin: async (mode, fn) => {
          assert.equal(mode, 'read only')
          return db.transaction(async (tx) => {
            await tx.exec('set transaction read only')
            return fn(tag(tx))
          })
        },
      },
    )
  const sql = tag(db)
  try {
    await db.exec('create role anon; create role authenticated;')
    const files = await Promise.all(
      [MIGRATION, LINKED_MIGRATION, FAUCET_MIGRATION].map((name) =>
        readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8'),
      ),
    )
    const inspect = async () => {
      const initial = await inspectDatabase(sql, expectedTables(files[0]))
      const linked = await inspectDatabase(sql, linkedTables, LINKED_MIGRATION)
      const linkedGuards = await inspectGuards(sql)
      const faucet = await inspectDatabase(sql, ['private.faucet_budgets'], FAUCET_MIGRATION)
      const guards = await inspectFaucetGuards(sql)
      return { initial, linked, linkedGuards, faucet, guards }
    }
    const status = (s) => assertFaucetMigrationSafe(s.initial, s.linked, s.linkedGuards, s.faucet, s.guards)
    await db.exec(files[0])
    await db.exec(
      'create schema supabase_migrations; create table supabase_migrations.schema_migrations(version text primary key)',
    )
    await db.query('insert into supabase_migrations.schema_migrations values($1)', [MIGRATION.split('_')[0]])
    const initialOnly = await inspect()
    assert.throws(() => status(initialOnly), /linked-account/)
    await db.exec(files[1])
    await db.query('insert into supabase_migrations.schema_migrations values($1)', [
      LINKED_MIGRATION.split('_')[0],
    ])
    assert.equal(status(await inspect()), 'ready')
    await db.exec(files[2])
    const partial = await inspect()
    assert.throws(() => status(partial), /Partial/)
    await db.query('insert into supabase_migrations.schema_migrations values($1)', [
      FAUCET_MIGRATION.split('_')[0],
    ])
    const complete = await inspect()
    assert.equal(status(complete), 'already-applied')
    assert.equal(
      assertLinkedMigrationSafe(complete.initial, complete.linked, complete.linkedGuards),
      'already-applied',
    )
    await db.exec('grant execute on function private.reserve_daily_faucet(text,text,uuid) to authenticated')
    const exposed = await inspect()
    assert.throws(() => status(exposed), /drift/)
    await db.exec(
      'revoke execute on function private.reserve_daily_faucet(text,text,uuid) from authenticated; drop index private.reward_claims_daily_wallet_idx',
    )
    const missing = await inspect()
    assert.throws(() => status(missing), /drift/)
  } finally {
    await db.close()
  }
})

test('daily migration helper rejects unknown flags before reading credentials or connecting', async () => {
  await assert.rejects(main(['--apply', '--dry-run']), /Use no arguments/)
})
