import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { SupabaseMedia, STORAGE_VIDEO_MAX_BYTES } from '../src/supabase-media.js'
import { MemoryRepository } from '../src/memory.js'
import { reconcilePendingUploads } from '../src/media.js'
import { PGlite } from '@electric-sql/pglite'

const origin = 'https://abcdefghijklmnopqrst.supabase.co'
const secret = 'sb_secret_test_server_only'
const start = Date.parse('2026-10-14T12:00:00Z')
const payload = await readFile(new URL('../../mobile/assets/media/sample-001.mp4', import.meta.url))
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

function fixture() {
  const objects = new Map<string, Buffer>()
  const calls: { url: string; method: string; headers: Headers }[] = []
  let now = start
  let stagingPublic = false
  let publishFailure = false
  const request: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input))
    const method = init.method ?? 'GET'
    const headers = new Headers(init.headers)
    calls.push({ url: url.toString(), method, headers })
    assert.equal(url.origin, origin)
    assert.equal(headers.get('apikey'), secret)
    assert.equal(headers.get('authorization'), null, 'secret keys are not JWT bearer tokens')
    assert.equal(init.redirect, 'error')
    const path = url.pathname.replace('/storage/v1', '')
    if (path.startsWith('/bucket/')) {
      const id = path.slice('/bucket/'.length)
      return json({
        id,
        public: id === 'clout-videos' || stagingPublic,
        file_size_limit: STORAGE_VIDEO_MAX_BYTES,
        allowed_mime_types: ['video/mp4'],
      })
    }
    if (path.startsWith('/object/upload/sign/')) {
      assert.equal(method, 'POST')
      assert.equal(headers.get('x-upsert'), 'false')
      return json({ url: `${path}?token=single-object-upload-token` })
    }
    const key = path.replace(/^\/object\/(authenticated\/)?/, '')
    if (method === 'POST') {
      if (publishFailure) return json({ code: 'ServiceUnavailable' }, 503)
      if (objects.has(key)) return json({ code: 'Duplicate', statusCode: '409' }, 400)
      const chunks: Buffer[] = []
      for await (const chunk of init.body as unknown as AsyncIterable<Buffer>) chunks.push(Buffer.from(chunk))
      objects.set(key, Buffer.concat(chunks))
      assert.equal(headers.get('x-upsert'), 'false')
      assert.equal(headers.get('content-type'), 'video/mp4')
      return json({ Key: key })
    }
    const file = objects.get(key)
    if (!file) return json({ code: 'NoSuchKey', statusCode: '404' }, 400)
    return new Response(method === 'HEAD' ? null : new Uint8Array(file), {
      headers: { 'content-length': String(file.length), 'content-type': 'video/mp4' },
    })
  }
  const create = () => new SupabaseMedia({ url: origin, secretKey: secret }, request, () => now)
  const media = create()
  return {
    media,
    create,
    calls,
    objects,
    setNow: (value: number) => {
      now = value
    },
    setPublic: () => {
      stagingPublic = true
    },
    failPublish: (value: boolean) => {
      publishFailure = value
    },
    put: (uploadUrl: string, value: Buffer) =>
      objects.set(new URL(uploadUrl).pathname.replace('/storage/v1/object/upload/sign/', ''), value),
  }
}

test('Storage issues object-scoped PUT uploads without exposing server credentials; unsafe bucket configuration fails closed', async () => {
  const app = fixture()
  const first = await app.media.issueUpload({ postId: 'one', wallet: 'owner' })
  const second = await app.media.issueUpload({ postId: 'two', wallet: 'owner' })
  assert.equal(first.uploadMethod, 'PUT')
  assert.equal(first.requiresCompletion, true)
  assert.equal(first.maxBytes, 52428800)
  assert.notEqual(first.uid, second.uid)
  assert.match(
    first.uploadUrl,
    /^https:\/\/abcdefghijklmnopqrst.supabase.co\/storage\/v1\/object\/upload\/sign\/clout-upload-staging\/uploads\//,
  )
  assert.equal(JSON.stringify(first).includes(secret), false)
  app.setPublic()
  await assert.rejects(app.create().issueUpload({ postId: 'x', wallet: 'owner' }), /private staging/)
  assert.throws(
    () => new SupabaseMedia({ url: 'https://attacker.example', secretKey: secret }),
    /SUPABASE_URL/,
  )
})

test('Storage validates real MP4 bytes before public publication; concurrent completion and restart recover one immutable object', async () => {
  const app = fixture()
  const upload = await app.media.issueUpload({ postId: 'one', wallet: 'owner' })
  app.put(upload.uploadUrl, payload)
  const [a, b] = await Promise.all([app.media.inspectVideo(upload.uid), app.media.inspectVideo(upload.uid)])
  assert.deepEqual(a, b)
  assert.equal(a.status.state, 'ready')
  assert.ok(a.duration! > 0 && a.duration! <= 60)
  assert.match(a.videoUrl!, /\/object\/public\/clout-videos\//)
  assert.equal(a.thumbnailUrl, null, 'Storage does not fabricate thumbnails')
  assert.equal(
    app.calls.some((row) => row.url.includes('/object/authenticated/')),
    false,
    'private downloads use the authenticated object API, not an invalid URL prefix',
  )
  assert.equal(
    app.calls.filter((row) => row.method === 'POST' && row.url.includes('/object/clout-videos/')).length,
    1,
  )
  assert.deepEqual([...app.objects.values()], [payload, payload])
  assert.deepEqual(
    await app.create().inspectVideo(upload.uid),
    a,
    'lost completion response recovers after restart',
  )
})

test('Storage publication outage keeps durable upload processing and later recovery publishes the real Storage URL', async () => {
  const app = fixture()
  const upload = await app.media.issueUpload({ postId: 'one', wallet: 'owner' })
  app.put(upload.uploadUrl, payload)
  const repository = new MemoryRepository(false)
  await repository.insertPost({
    id: 'one',
    creatorWallet: 'owner',
    caption: 'Test',
    streamUid: upload.uid,
    videoUrl: null,
    thumbnailUrl: null,
    status: 'processing',
    createdAt: new Date(start).toISOString(),
    demo: false,
    tags: [],
    market: null,
  })
  app.failPublish(true)
  assert.equal((await reconcilePendingUploads(repository, app.media)).failed, 1)
  assert.equal((await repository.getPost('one'))?.status, 'processing')
  app.failPublish(false)
  assert.equal((await reconcilePendingUploads(repository, app.create())).updated, 1)
  assert.equal((await repository.getPost('one'))?.status, 'ready')
  assert.match((await repository.getPost('one'))!.videoUrl!, /\/object\/public\/clout-videos\//)
})

test('Storage rejects malformed, audio-only, over-duration and oversized uploads without public writes', async () => {
  const box = (type: string, content: Buffer) => {
    const out = Buffer.alloc(8 + content.length)
    out.writeUInt32BE(out.length)
    out.write(type, 4)
    content.copy(out, 8)
    return out
  }
  const clip = (duration: number, handler: string) => {
    const mvhd = Buffer.alloc(20)
    mvhd.writeUInt32BE(1000, 12)
    mvhd.writeUInt32BE(duration * 1000, 16)
    const hdlr = Buffer.alloc(12)
    hdlr.write(handler, 8)
    return Buffer.concat([
      box('ftyp', Buffer.from('isom0000')),
      box('moov', Buffer.concat([box('mvhd', mvhd), box('trak', box('mdia', box('hdlr', hdlr)))])),
      box('mdat', Buffer.from([1])),
    ])
  }
  for (const value of [
    Buffer.from('<html>not a video</html>'),
    clip(61, 'vide'),
    clip(30, 'soun'),
    Buffer.alloc(STORAGE_VIDEO_MAX_BYTES + 1),
  ]) {
    const app = fixture()
    const upload = await app.media.issueUpload({ postId: 'one', wallet: 'owner' })
    app.put(upload.uploadUrl, value)
    assert.equal((await app.media.inspectVideo(upload.uid)).status.state, 'error')
    assert.equal(
      app.calls.some((row) => row.url.includes('/object/clout-videos/') && row.method === 'POST'),
      false,
    )
  }
})

test('Storage pending uploads expire after the signed URL lifetime and unsupported identifiers never cause network requests', async () => {
  const app = fixture()
  const upload = await app.media.issueUpload({ postId: 'one', wallet: 'owner' })
  const pending = await app.media.inspectVideo(upload.uid)
  assert.equal(pending.status.state, 'pendingupload')
  assert.equal(pending.uploadExpiry, '2026-10-14T14:00:00.000Z')
  const count = app.calls.length
  assert.throws(() => app.media.inspectVideo('../../other-wallet/file'), /Invalid Storage/)
  await assert.rejects(
    app.media.copyVideo({ postId: 'p', wallet: 'w', importId: 'i', url: 'http://127.0.0.1/private' }),
    /source is not supported/,
  )
  assert.equal(app.calls.length, count)
})

test('Storage migration restricts both buckets even under preexisting broad client policies', async () => {
  const db = new PGlite()
  try {
    await db.exec(`create role anon; create role authenticated; create schema storage;
      create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
      create table storage.objects(id text primary key,bucket_id text); alter table storage.objects enable row level security;
      grant usage on schema storage to anon,authenticated; grant all on storage.objects to anon,authenticated;
      create policy old_permissive on storage.objects for all to anon,authenticated using(true) with check(true);`)
    await db.exec(
      await readFile(
        new URL('../../../supabase/migrations/20261014034917_supabase_video_storage.sql', import.meta.url),
        'utf8',
      ),
    )
    await db.exec(
      `insert into storage.objects values('private','clout-upload-staging'),('public','clout-videos'),('unrelated','elsewhere'); set role anon;`,
    )
    assert.deepEqual((await db.query('select id from storage.objects')).rows, [{ id: 'unrelated' }])
    await assert.rejects(
      db.exec(`insert into storage.objects values('evil','clout-videos')`),
      /row-level security/,
    )
    await db.exec(`reset role; set role authenticated;`)
    await assert.rejects(
      db.exec(`insert into storage.objects values('evil','clout-upload-staging')`),
      /row-level security/,
    )
    await db.exec(`insert into storage.objects values('other','elsewhere'); reset role;`)
    const result = await db.query('select id,public,file_size_limit from storage.buckets order by id')
    assert.equal(result.rows.length, 2)
  } finally {
    await db.close()
  }
})
