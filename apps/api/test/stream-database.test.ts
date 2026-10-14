import assert from 'node:assert/strict'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { PostgresRepository } from '../src/postgres.js'

test('stream updates accept exact terminal retries without regressing the post', async () => {
  const db = new PGlite()
  const sql = Object.assign(
    async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const query = parts.reduce((text, part, index) => text + (index ? `$${index}` : '') + part, '')
      return (await db.query(query, values)).rows
    },
    { json: (value: unknown) => JSON.stringify(value) },
  )
  const repository = Object.create(PostgresRepository.prototype) as PostgresRepository
  Object.defineProperty(repository, 'sql', { value: sql })
  try {
    await db.exec(`create table public.posts(
      id text primary key,
      stream_uid text unique,
      status text not null,
      data jsonb not null
    )`)
    await db.query('insert into public.posts values ($1,$2,$3,$4)', [
      'post',
      'a'.repeat(32),
      'processing',
      { id: 'post', status: 'processing', videoUrl: null, thumbnailUrl: null },
    ])
    const videoUrl = `/v1/local-media/${'a'.repeat(32)}.mp4`
    assert.equal(await repository.updateStream('a'.repeat(32), 'ready', videoUrl, null), true)
    assert.equal(await repository.updateStream('a'.repeat(32), 'ready', videoUrl, null), true)
    assert.equal(await repository.updateStream('a'.repeat(32), 'failed', null, null), false)
    const result = await db.query<{ status: string; data: Record<string, unknown> }>(
      'select status,data from public.posts where id=$1',
      ['post'],
    )
    assert.equal(result.rows[0].status, 'ready')
    assert.equal(result.rows[0].data.videoUrl, videoUrl)
  } finally {
    await db.close()
  }
})
