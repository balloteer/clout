import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { MIGRATION, expectedTables, inspectDatabase } from './db-setup.mjs'
import { LINKED_MIGRATION, linkedTables, inspectGuards, assertLinkedMigrationSafe } from './db-linked.mjs'

test('linked migration check requires initial history and verifies actual private grants, limit trigger and unique Stream index', async () => {
  const db = new PGlite()
  const sql = Object.assign(
    async (parts, ...values) =>
      (
        await db.query(
          parts.reduce((query, part, index) => query + (index ? `$${index}` : '') + part, ''),
          values,
        )
      ).rows,
    {
      begin: async (mode, fn) => {
        assert.equal(mode, 'read only')
        await db.exec('begin read only')
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
  try {
    await db.exec('create role anon;create role authenticated;')
    const initial = await readFile(new URL(`../supabase/migrations/${MIGRATION}`, import.meta.url), 'utf8')
    const linked = await readFile(
      new URL(`../supabase/migrations/${LINKED_MIGRATION}`, import.meta.url),
      'utf8',
    )
    const initialTables = expectedTables(initial)
    const inspect = async () => ({
      initial: await inspectDatabase(sql, initialTables),
      linked: await inspectDatabase(sql, linkedTables, LINKED_MIGRATION),
      guards: await inspectGuards(sql),
    })
    let state = await inspect()
    assert.throws(() => assertLinkedMigrationSafe(state.initial, state.linked, state.guards), /initial/)
    await db.exec(initial)
    await db.exec(
      'create schema supabase_migrations;create table supabase_migrations.schema_migrations(version text primary key)',
    )
    await db.query('insert into supabase_migrations.schema_migrations values($1)', [MIGRATION.split('_')[0]])
    state = await inspect()
    assert.equal(assertLinkedMigrationSafe(state.initial, state.linked, state.guards), 'ready')
    await db.exec(linked)
    state = await inspect()
    assert.throws(() => assertLinkedMigrationSafe(state.initial, state.linked, state.guards), /Partial/)
    await db.query('insert into supabase_migrations.schema_migrations values($1)', [
      LINKED_MIGRATION.split('_')[0],
    ])
    state = await inspect()
    assert.equal(assertLinkedMigrationSafe(state.initial, state.linked, state.guards), 'already-applied')
    await db.exec('alter table private.linked_accounts disable trigger linked_accounts_limit')
    state = await inspect()
    assert.throws(() => assertLinkedMigrationSafe(state.initial, state.linked, state.guards), /drift/)
    await db.exec(
      'alter table private.linked_accounts enable trigger linked_accounts_limit;grant execute on function private.enforce_link_limit() to authenticated',
    )
    state = await inspect()
    assert.throws(() => assertLinkedMigrationSafe(state.initial, state.linked, state.guards), /drift/)
  } finally {
    await db.close()
  }
})
