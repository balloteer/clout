import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import { PostgresRepository } from '../src/postgres.js'
import { newProfile } from '../src/domain.js'

test('feed metadata uses one bounded SQL query with independent counts, viewer likes and missing creators', async () => {
  const db = new PGlite()
  let queries = 0
  const sql = async (parts: TemplateStringsArray, ...values: unknown[]) => {
    queries++
    const query = parts.reduce((text, part, index) => text + (index ? `$${index}` : '') + part, '')
    return (await db.query(query, values)).rows
  }
  const repository = Object.create(PostgresRepository.prototype) as PostgresRepository
  Object.defineProperty(repository, 'sql', { value: sql })
  try {
    // The minimal read-model fixture deliberately permits an absent creator, testing the LEFT JOIN.
    await db.exec(`create table public.profiles(wallet text primary key, data jsonb not null);
      create table public.posts(id text primary key, creator_wallet text not null);
      create table public.likes(post_id text not null, wallet text not null, primary key(post_id,wallet));
      create table public.comments(id int primary key, post_id text not null);`)
    const creator = newProfile('creator')
    await db.query('insert into public.profiles values($1,$2)', ['creator', creator])
    await db.exec(`insert into public.posts values ('busy','creator'),('empty','creator'),('missing','absent'),('excluded','creator');
      insert into public.likes values ('busy','alice'),('busy','bob'),('missing','bob'),('excluded','alice');
      insert into public.comments select n,'busy' from generate_series(1,105) n;
      insert into public.comments values (106,'missing');`)
    const summaries = await repository.getPostSummaries(['busy', 'empty', 'missing', 'not-found'], 'alice')
    assert.equal(queries, 1)
    assert.deepEqual(Object.keys(summaries).sort(), ['busy', 'empty', 'missing'])
    assert.deepEqual(summaries.busy, {
      creator,
      likes: { count: 2, liked: true },
      commentCount: 100,
    })
    assert.deepEqual(summaries.empty, { creator, likes: { count: 0, liked: false }, commentCount: 0 })
    assert.deepEqual(summaries.missing, {
      creator: null,
      likes: { count: 1, liked: false },
      commentCount: 1,
    })
    const guest = await repository.getPostSummaries(['busy'])
    assert.deepEqual(guest.busy.likes, { count: 2, liked: false })
    const bob = await repository.getPostSummaries(['missing'], 'bob')
    assert.equal(bob.missing.likes.liked, true)
    const before = queries
    assert.deepEqual(await repository.getPostSummaries([]), {})
    await assert.rejects(repository.getPostSummaries(Array(101).fill('busy')), /feed limit/)
    assert.equal(queries, before)
  } finally {
    await db.close()
  }
})
