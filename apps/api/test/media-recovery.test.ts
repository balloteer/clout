import assert from 'node:assert/strict'
import test from 'node:test'
import { MemoryRepository } from '../src/memory.js'
import { reconcilePendingUploads } from '../src/media.js'
import type { Post } from '../src/domain.js'

const processingPost = (id: string, source?: Post['source']): Post => ({
  id,
  creatorWallet: 'wallet',
  caption: id,
  videoUrl: null,
  thumbnailUrl: null,
  streamUid: id.repeat(32).slice(0, 32),
  status: 'processing',
  createdAt: `2026-01-0${id === 'a' ? '1' : '2'}T00:00:00Z`,
  demo: false,
  tags: [],
  market: null,
  source,
})

test('ordinary Cloudflare uploads recover ready and failed terminal states', async () => {
  const repository = new MemoryRepository(false)
  const ready = processingPost('a')
  const failed = processingPost('b')
  await repository.insertPost(ready)
  await repository.insertPost(failed)

  const result = await reconcilePendingUploads(repository, {
    inspectVideo: async (uid) => ({
      readyToStream: uid === ready.streamUid,
      status: { state: uid === ready.streamUid ? 'ready' : 'error' },
    }),
  })

  assert.deepEqual(result, { checked: 2, updated: 2, next: undefined })
  assert.deepEqual(await repository.getPost(ready.id), {
    ...ready,
    status: 'ready',
    videoUrl: `https://videodelivery.net/${ready.streamUid}/manifest/video.m3u8`,
    thumbnailUrl: `https://videodelivery.net/${ready.streamUid}/thumbnails/thumbnail.jpg`,
  })
  assert.equal((await repository.getPost(failed.id))?.status, 'failed')
})

test('upload recovery skips linked imports and isolates transient Stream failures', async () => {
  const repository = new MemoryRepository(false)
  const unavailable = processingPost('a')
  const ready = processingPost('b')
  const linked = processingPost('c', {
    provider: 'x',
    accountHandle: 'creator',
    postId: 'source',
    url: 'https://x.com/creator/status/source',
  })
  for (const post of [unavailable, ready, linked]) await repository.insertPost(post)
  const inspected: string[] = []

  const result = await reconcilePendingUploads(repository, {
    inspectVideo: async (uid) => {
      inspected.push(uid)
      if (uid === unavailable.streamUid) throw new Error('temporary outage')
      return { readyToStream: true, status: { state: 'ready' } }
    },
  })

  assert.deepEqual(result, { checked: 2, updated: 1, next: undefined })
  assert.deepEqual(inspected, [unavailable.streamUid, ready.streamUid])
  assert.equal((await repository.getPost(unavailable.id))?.status, 'processing')
  assert.equal((await repository.getPost(ready.id))?.status, 'ready')
  assert.equal((await repository.getPost(linked.id))?.status, 'processing')
})

test('upload recovery leaves in-progress encoding unchanged', async () => {
  const repository = new MemoryRepository(false)
  const post = processingPost('a')
  await repository.insertPost(post)
  const result = await reconcilePendingUploads(repository, {
    inspectVideo: async () => ({ readyToStream: false, status: { state: 'inprogress' } }),
  })
  assert.deepEqual(result, { checked: 1, updated: 0, next: undefined })
  assert.equal((await repository.getPost(post.id))?.status, 'processing')
})

test('upload recovery cursor prevents an old in-progress upload from starving later rows', async () => {
  const repository = new MemoryRepository(false)
  const first = processingPost('a')
  const second = processingPost('b')
  await repository.insertPost(first)
  await repository.insertPost(second)
  const media = {
    inspectVideo: async (uid: string) => ({
      readyToStream: uid === second.streamUid,
      status: { state: uid === second.streamUid ? 'ready' : 'inprogress' },
    }),
  }

  const initial = await reconcilePendingUploads(repository, media, 1)
  assert.equal((await repository.getPost(first.id))?.status, 'processing')
  const following = await reconcilePendingUploads(repository, media, 1, initial.next)

  assert.equal(following.updated, 1)
  assert.equal((await repository.getPost(second.id))?.status, 'ready')
})
