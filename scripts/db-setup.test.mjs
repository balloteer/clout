import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import {
  PROJECT_REF,
  MIGRATION,
  validateTarget,
  migrationConnection,
  cliConnection,
  redact,
  expectedTables,
  assertInitialMigrationSafe,
  inspectDatabase,
} from './db-setup.mjs'

const secret = 'fake:/@?value%'
const direct = `postgresql://postgres:${encodeURIComponent(secret)}@db.${PROJECT_REF}.supabase.co:5432/postgres`
const pooled = `postgresql://postgres.${PROJECT_REF}:${encodeURIComponent(secret)}@aws-0-us-east-1.pooler.supabase.com:6543/postgres`

test('database target binds direct host or pooler identity to the one authorized project', () => {
  assert.equal(validateTarget(direct).projectRef, PROJECT_REF)
  assert.equal(validateTarget(pooled).kind, 'shared-pooler')
  for (const invalid of [
    direct.replace(PROJECT_REF, 'wrongproject'),
    pooled.replace(PROJECT_REF, 'wrongproject'),
    pooled.replace('.supabase.com', '.supabase.com.evil.test'),
    direct.replace('/postgres', '/another'),
    direct + '?password=secret',
    direct + '?sslmode=disable',
    'https://example.com',
    undefined,
  ])
    assert.throws(() => validateTarget(invalid))
})

test('migration connection retains project identity and keeps passwords out of CLI arguments', () => {
  const target = validateTarget(pooled)
  const migration = migrationConnection(target)
  assert.equal(migration.url.port, '5432')
  assert.equal(target.url.port, '6543')
  const cli = cliConnection(migration)
  assert.equal(cli.password, secret)
  assert.equal(new URL(cli.url).password, '')
  assert.equal(cli.url.includes(encodeURIComponent(secret)), false)
  assert.equal(new URL(cli.url).searchParams.get('sslmode'), 'verify-full')
  assert.equal(
    redact(`raw ${secret}; encoded ${encodeURIComponent(secret)}`, [secret, encodeURIComponent(secret)]),
    'raw [REDACTED]; encoded [REDACTED]',
  )
})

test('initial migration refuses existing application data and only recognizes complete protected schema', async () => {
  const migration = await readFile(new URL(`../supabase/migrations/${MIGRATION}`, import.meta.url), 'utf8')
  const tables = expectedTables(migration)
  const empty = {
    supabaseRolesPresent: true,
    migrationApplied: false,
    targetTables: [],
    unrelatedRelationCount: 0,
    privateFunctionCount: 0,
    privateSchemaExists: false,
    expectedTableCount: tables.length,
  }
  assert.equal(assertInitialMigrationSafe(empty), 'ready')
  for (const changed of [
    { unrelatedRelationCount: 1 },
    { privateFunctionCount: 1 },
    { privateSchemaExists: true },
    { targetTables: [{ name: 'public.posts', rls: true }] },
    { supabaseRolesPresent: false },
  ])
    assert.throws(() => assertInitialMigrationSafe({ ...empty, ...changed }))
  const applied = {
    ...empty,
    migrationApplied: true,
    targetTables: tables.map((name) => ({ name, rls: true })),
  }
  assert.equal(assertInitialMigrationSafe(applied), 'already-applied')
  assert.throws(() => assertInitialMigrationSafe({ ...applied, privateClientAccess: true }))
  assert.throws(() =>
    assertInitialMigrationSafe({ ...applied, targetTables: [{ name: 'public.posts', rls: false }] }),
  )
  assert.throws(() =>
    assertInitialMigrationSafe({
      ...applied,
      targetTables: applied.targetTables.map((table) => ({ ...table, anonWrite: true })),
    }),
  )
})

test('read-only catalog inspection verifies actual migration RLS/grants without reading user rows', async () => {
  const db = new PGlite()
  const sql = Object.assign(
    async (parts, ...values) =>
      (
        await db.query(
          parts.reduce((q, part, i) => q + (i ? `$${i}` : '') + part, ''),
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
    await db.exec('create role anon; create role authenticated;')
    const migration = await readFile(new URL(`../supabase/migrations/${MIGRATION}`, import.meta.url), 'utf8')
    const tables = expectedTables(migration)
    const before = await inspectDatabase(sql, tables)
    assert.equal(assertInitialMigrationSafe(before), 'ready')
    await db.exec(migration)
    await db.exec(
      'create schema supabase_migrations; create table supabase_migrations.schema_migrations(version text);',
    )
    await db.query('insert into supabase_migrations.schema_migrations values ($1)', [MIGRATION.split('_')[0]])
    const after = await inspectDatabase(sql, tables)
    assert.equal(after.targetTables.length, 13)
    assert.equal(assertInitialMigrationSafe(after), 'already-applied')
    await db.exec('grant insert on public.posts to anon')
    const drift = await inspectDatabase(sql, tables)
    assert.throws(() => assertInitialMigrationSafe(drift), /drift/)
  } finally {
    await db.close()
  }
})
