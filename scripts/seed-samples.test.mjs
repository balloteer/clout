import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import postgres from 'postgres'
import { buildSampleSeed, seedInTransaction } from './seed-samples.mjs'

test('sample seed binds 50 licensed posts to 30 verified markets and safe media origins', () => {
  const seed = buildSampleSeed('https://api.clout.example')
  assert.equal(seed.posts.length, 50)
  assert.equal(seed.posts.filter((post) => post.market).length, 30)
  assert.equal(new Set(seed.posts.map((post) => post.id)).size, 50)
  assert.ok(
    seed.posts.every(
      (post) => post.demo && post.videoUrl.startsWith('https://api.clout.example/v1/samples/media/'),
    ),
  )
  for (const value of [
    'http://remote.example',
    'file:///tmp',
    'https://user:pass@api.example',
    'https://api.example/private',
    'https://api.example/?token=bad',
  ])
    assert.throws(() => buildSampleSeed(value))
})

test('seed DTOs pass through the actual postgres.js JSONB serializer once and retain 30 nested markets', async () => {
  const db = new PGlite()
  // Use the installed production driver's actual OID 3802 serializer, not a test JSON imitation.
  // No socket is opened: PGlite executes the resulting wire-value strings as SQL parameters.
  const driver = postgres('postgresql://synthetic:synthetic@127.0.0.1/postgres')
  const serializeJsonb = driver.options.serializers[3802]
  const seed = buildSampleSeed('http://127.0.0.1:8787')
  const adapter = (tx, corrupt = false) => ({
    query: (text, values = []) => {
      const wireValues = [...values]
      for (const match of text.matchAll(/\$(\d+)::jsonb/g)) {
        const index = Number(match[1]) - 1
        wireValues[index] = serializeJsonb(corrupt ? JSON.stringify(values[index]) : values[index])
      }
      return tx.query(text, wireValues)
    },
  })
  try {
    await db.exec('create role anon; create role authenticated;')
    await db.exec(await readFile('supabase/migrations/20261013000133_clout_initial.sql', 'utf8'))
    assert.equal(
      (
        await db.query('select jsonb_typeof($1::jsonb) as kind', [
          serializeJsonb(JSON.stringify(seed.posts[0])),
        ])
      ).rows[0].kind,
      'string',
    )
    await assert.rejects(
      db.transaction((tx) => seedInTransaction(adapter(tx, true), seed, true)),
      /JSON serialization failed/,
    )
    assert.equal((await db.query('select count(*)::int n from public.profiles')).rows[0].n, 0)
    assert.equal((await db.transaction((tx) => seedInTransaction(adapter(tx), seed, true))).newPosts, 50)
    const [stored] = (
      await db.query(`select count(*)::int as posts,
        count(*) filter(where jsonb_typeof(data) = 'object' and data->>'id' = id)::int as objects,
        count(*) filter(where jsonb_typeof(data->'market') = 'object')::int as markets from public.posts`)
    ).rows
    assert.deepEqual(stored, { posts: 50, objects: 50, markets: 30 })
    assert.equal(
      (
        await db.query(
          "select count(*)::int n from public.profiles where jsonb_typeof(data) = 'object' and data->>'wallet' = wallet",
        )
      ).rows[0].n,
      seed.profiles.length,
    )
    assert.equal((await db.transaction((tx) => seedInTransaction(adapter(tx), seed, true))).newPosts, 0)
  } finally {
    await driver.end()
    await db.close()
  }
})
test('sample seed is additive, idempotent, preserves profiles and rolls back conflicting post IDs', async () => {
  const db = new PGlite()
  await db.exec('create role anon; create role authenticated;')
  await db.exec(await readFile('supabase/migrations/20261013000133_clout_initial.sql', 'utf8'))
  const seed = buildSampleSeed('http://127.0.0.1:8787')
  try {
    assert.equal((await db.transaction((tx) => seedInTransaction(tx, seed))).newPosts, 50)
    assert.equal((await db.query('select count(*)::integer n from public.posts')).rows[0].n, 0)
    assert.equal((await db.transaction((tx) => seedInTransaction(tx, seed, true))).newPosts, 50)
    const owner = seed.profiles[0].wallet
    await db.query(
      "update public.profiles set data=jsonb_set(data,'{displayName}','\"Owner edit\"') where wallet=$1",
      [owner],
    )
    assert.equal((await db.transaction((tx) => seedInTransaction(tx, seed, true))).newPosts, 0)
    assert.equal(
      (await db.query('select data from public.profiles where wallet=$1', [owner])).rows[0].data.displayName,
      'Owner edit',
    )
    const changed = structuredClone(seed)
    changed.posts[2].caption = 'Conflicting user content'
    await assert.rejects(
      db.transaction((tx) => seedInTransaction(tx, changed, true)),
      /conflicts/,
    )
    assert.equal((await db.query('select count(*)::integer n from public.posts')).rows[0].n, 50)
  } finally {
    await db.close()
  }
})
