import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import postgres from 'postgres'
import { buildSampleSeed, seedInTransaction } from './seed-samples.mjs'
import { demoPosts, demoProfiles } from '../apps/api/src/fixtures.ts'
import { sampleContent } from '../packages/shared/src/sample-content.ts'
import { originalCuratedContent } from '../packages/shared/src/curated-content.ts'
import { PostgresRepository } from '../apps/api/src/postgres.ts'

const catalogSize = demoPosts.length

const registry = Object.fromEntries(
  demoPosts.map((post, index) => [
    post.id,
    {
      postId: post.id,
      creatorWallet: 'fixture-operator',
      baseMint: `fixture-mint-${index}`,
      dbcPool: `fixture-pool-${index}`,
      signature: `fixture-receipt-${index}`,
    },
  ]),
)
const seedFor = (origin) => buildSampleSeed(origin, registry)

test('retiring exact operator catalog posts only changes visibility and preserves direct history, markets and socials', async () => {
  const db = new PGlite()
  await db.exec('create role anon; create role authenticated;')
  await db.exec(await readFile('supabase/migrations/20261013000133_clout_initial.sql', 'utf8'))
  const target = originalCuratedContent[0].id
  const desired = seedFor('http://127.0.0.1:8787')
  desired.posts.find((post) => post.id === target).feedHidden = true
  const initial = structuredClone(desired)
  for (const post of initial.posts) delete post.feedHidden
  const repository = Object.create(PostgresRepository.prototype)
  Object.defineProperty(repository, 'sql', {
    value: async (parts, ...values) =>
      (
        await db.query(
          parts.reduce((text, part, index) => text + (index ? `$${index}` : '') + part, ''),
          values,
        )
      ).rows,
  })
  try {
    await db.transaction((tx) => seedInTransaction(tx, initial, true))
    const previous = (await db.query('select data from public.posts where id=$1', [target])).rows[0].data
    await db.query('insert into public.likes(wallet,post_id) values($1,$2)', [previous.creatorWallet, target])
    const event = {
      postId: target,
      signature: 'preserved-signature',
      instructionPath: 'verified',
      wallet: previous.creatorWallet,
      slot: 10,
      kind: 'buy',
      baseAmount: '50',
      quoteAmount: '100',
      finality: 'finalized',
    }
    await db.query('insert into private.indexed_events values($1,$2,$3,$4,$5,$6,$7::jsonb)', [
      event.signature,
      event.instructionPath,
      event.slot,
      event.wallet,
      event.postId,
      event.finality,
      event,
    ])
    const result = await db.transaction((tx) => seedInTransaction(tx, desired, true))
    assert.ok(result.visibilityUpdates >= 1)
    assert.equal(result.newPosts, 0)
    const stored = await repository.getPost(target)
    assert.deepEqual(stored, { ...previous, feedHidden: true })
    assert.equal(
      (await repository.listPosts()).some((post) => post.id === target),
      false,
    )
    assert.equal(
      (await repository.listPosts({ includeHidden: true })).some((post) => post.id === target),
      true,
    )
    assert.deepEqual(await repository.getPostEvents(target), [event])
    assert.equal(
      (await db.query('select count(*)::int n from public.likes where post_id=$1', [target])).rows[0].n,
      1,
    )
    assert.equal((await db.transaction((tx) => seedInTransaction(tx, desired, true))).visibilityUpdates, 0)
    const user = { ...stored, demo: false }
    await db.query('update public.posts set data=$2::jsonb where id=$1', [target, user])
    await assert.rejects(
      db.transaction((tx) => seedInTransaction(tx, desired, true)),
      /conflicts/,
    )
    assert.deepEqual(await repository.getPost(target), user)
  } finally {
    await db.close()
  }
})

test('demo seed binds active and archived attributed posts to distinct markets and safe media origins', () => {
  const seed = seedFor('https://api.clout.example')
  assert.equal(seed.posts.length, catalogSize)
  assert.equal(seed.posts.filter((post) => post.market).length, catalogSize)
  assert.equal(new Set(seed.posts.map((post) => post.id)).size, catalogSize)
  assert.ok(seed.posts.every((post) => post.demo && post.creatorWallet === 'fixture-operator'))
  assert.equal(
    seed.posts.filter((post) => post.videoUrl.startsWith('https://api.clout.example/v1/samples/media/'))
      .length,
    50,
  )
  const curated = seed.posts.filter((post) => post.source)
  assert.equal(curated.length, catalogSize - 50)
  assert.ok(
    curated.every(
      (post) =>
        post.source.provider === 'x' &&
        post.source.url.startsWith('https://x.com/') &&
        post.source.publishedAt &&
        post.source.accountHandle !== post.creatorWallet,
    ),
  )
  assert.throws(() => buildSampleSeed('https://api.example', {}), /incomplete/)
  const duplicate = structuredClone(registry)
  duplicate[demoPosts[1].id].baseMint = duplicate[demoPosts[0].id].baseMint
  assert.throws(() => buildSampleSeed('https://api.example', duplicate), /distinct/)
  for (const value of [
    'http://remote.example',
    'file:///tmp',
    'https://user:pass@api.example',
    'https://api.example/private',
    'https://api.example/?token=bad',
  ])
    assert.throws(() => buildSampleSeed(value))
})

test('seed DTOs pass through the actual postgres.js JSONB serializer once and retain all nested markets', async () => {
  const db = new PGlite()
  // Use the installed production driver's actual OID 3802 serializer, not a test JSON imitation.
  // No socket is opened: PGlite executes the resulting wire-value strings as SQL parameters.
  const driver = postgres('postgresql://synthetic:synthetic@127.0.0.1/postgres')
  const serializeJsonb = driver.options.serializers[3802]
  const seed = seedFor('http://127.0.0.1:8787')
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
    assert.equal(
      (await db.transaction((tx) => seedInTransaction(adapter(tx), seed, true))).newPosts,
      catalogSize,
    )
    const [stored] = (
      await db.query(`select count(*)::int as posts,
        count(*) filter(where jsonb_typeof(data) = 'object' and data->>'id' = id)::int as objects,
        count(*) filter(where jsonb_typeof(data->'market') = 'object')::int as markets from public.posts`)
    ).rows
    assert.deepEqual(stored, { posts: catalogSize, objects: catalogSize, markets: catalogSize })
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
  const seed = seedFor('http://127.0.0.1:8787')
  try {
    assert.equal((await db.transaction((tx) => seedInTransaction(tx, seed))).newPosts, catalogSize)
    assert.equal((await db.query('select count(*)::integer n from public.posts')).rows[0].n, 0)
    assert.equal((await db.transaction((tx) => seedInTransaction(tx, seed, true))).newPosts, catalogSize)
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
    assert.equal((await db.query('select count(*)::integer n from public.posts')).rows[0].n, catalogSize)
  } finally {
    await db.close()
  }
})

test('catalog expansion preserves 30 markets and user data, attaches only 20 original samples, and inserts attributed sources', async () => {
  const db = new PGlite()
  await db.exec('create role anon; create role authenticated;')
  await db.exec(await readFile('supabase/migrations/20261013000133_clout_initial.sql', 'utf8'))
  const seed = seedFor('http://127.0.0.1:8787')
  const original = sampleContent.map((sample, index) => {
    const current = seed.posts.find((post) => post.id === sample.id)
    return index < 30
      ? current
      : { ...current, creatorWallet: sample.creatorWallet, market: null, operatorNote: 'preserved' }
  })
  try {
    await db.transaction((tx) =>
      seedInTransaction(tx, { posts: original, profiles: [...demoProfiles, ...seed.profiles] }, true),
    )
    const before = (
      await db.query("select id, data from public.posts where data->'market' <> 'null'::jsonb order by id")
    ).rows
    const user = { ...seed.profiles[0], wallet: 'user-wallet', displayName: 'Keep my profile' }
    const userPost = {
      ...original[0],
      id: 'user-post',
      creatorWallet: user.wallet,
      demo: false,
      caption: 'User caption',
      market: null,
    }
    await db.transaction((tx) => seedInTransaction(tx, { profiles: [user], posts: [userPost] }, true))
    const target = original[40].id
    await db.query('insert into public.likes(wallet,post_id) values($1,$2)', [user.wallet, target])
    await db.query('insert into public.comments(id,post_id,wallet,data) values($1,$2,$3,$4::jsonb)', [
      '11111111-1111-4111-8111-111111111111',
      target,
      user.wallet,
      {
        id: '11111111-1111-4111-8111-111111111111',
        postId: target,
        wallet: user.wallet,
        body: 'Keep my comment',
        createdAt: '2026-10-13T00:00:00.000Z',
      },
    ])
    const dry = await db.transaction((tx) => seedInTransaction(tx, seed))
    assert.equal(dry.newPosts, catalogSize - 50)
    assert.equal(dry.attachedMarkets, 20)
    assert.equal(dry.unchangedPosts, 30)
    assert.equal((await db.query('select count(*)::int n from public.posts')).rows[0].n, 51)
    const result = await db.transaction((tx) => seedInTransaction(tx, seed, true))
    assert.equal(result.attachedMarkets, 20)
    assert.equal(result.newPosts, catalogSize - 50)
    for (const previous of before) {
      assert.deepEqual(
        (await db.query('select data from public.posts where id=$1', [previous.id])).rows[0].data,
        previous.data,
      )
    }
    const upgraded = (await db.query('select creator_wallet,data from public.posts where id=$1', [target]))
      .rows[0]
    assert.equal(upgraded.creator_wallet, 'fixture-operator')
    assert.equal(upgraded.data.operatorNote, 'preserved')
    assert.deepEqual(upgraded.data.market, seed.posts.find((post) => post.id === target).market)
    assert.deepEqual(
      (await db.query('select data from public.posts where id=$1', ['user-post'])).rows[0].data,
      userPost,
    )
    assert.equal((await db.query('select count(*)::int n from public.likes')).rows[0].n, 1)
    assert.equal((await db.query('select count(*)::int n from public.comments')).rows[0].n, 1)
    const retry = await db.transaction((tx) => seedInTransaction(tx, seed, true))
    assert.equal(retry.newPosts, 0)
    assert.equal(retry.attachedMarkets, 0)
    assert.equal(retry.unchangedPosts, catalogSize)
    const conflict = structuredClone(seed)
    conflict.posts.find((post) => post.id === original[0].id).market.baseMint = 'replacement-mint'
    await assert.rejects(
      db.transaction((tx) => seedInTransaction(tx, conflict, true)),
      /conflicts/,
    )
    assert.equal((await db.query('select count(*)::int n from public.posts')).rows[0].n, catalogSize + 1)
  } finally {
    await db.close()
  }
})
