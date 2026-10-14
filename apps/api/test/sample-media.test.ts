import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { handleSampleMedia, rebaseLoopbackSampleMedia, sampleByteRange } from '../src/sample-media.js'
import { sampleContent } from '../../../packages/shared/src/sample-content.js'

test('loopback bundled videos and posters follow the configured public API origin', () => {
  for (const host of ['http://127.0.0.1:8787', 'http://localhost:8080', 'https://[::1]:8787']) {
    for (const extension of ['mp4', 'jpg']) {
      const path = `/v1/samples/media/sample-001.${extension}?version=1#preview`
      assert.equal(
        rebaseLoopbackSampleMedia(`${host}${path}`, 'https://api.clout.example'),
        `https://api.clout.example${path}`,
      )
    }
  }
})

test('rebasing preserves external media, user uploads, unknown files and malformed URLs', () => {
  for (const value of [
    null,
    'https://video.twimg.com/clip.mp4',
    'https://cdn.example/v1/samples/media/sample-001.mp4',
    'http://localhost.evil.example/v1/samples/media/sample-001.mp4',
    'http://localhost@evil.example/v1/samples/media/sample-001.mp4',
    'http://user:password@localhost/v1/samples/media/sample-001.mp4',
    'http://127.0.0.1:8787/v1/local-media/upload.mp4',
    'http://127.0.0.1:8787/v1/samples/media/sample-051.mp4',
    'http://127.0.0.1:8787/v1/samples/media/sample-001%2emp4',
    'http://127.0.0.1:8787/v1/samples/media/../../private.mp4',
    'file:///v1/samples/media/sample-001.mp4',
    '//localhost/v1/samples/media/sample-001.mp4',
    'not a URL',
  ])
    assert.equal(rebaseLoopbackSampleMedia(value, 'https://api.clout.example'), value)
})

test('sample catalog has 50 distinct video/poster files and nonoverlapping source intervals', () => {
  assert.equal(sampleContent.length, 50)
  for (const field of ['id', 'videoFile', 'posterFile'] as const)
    assert.equal(new Set(sampleContent.map((post) => post[field])).size, 50)
  for (const post of sampleContent) {
    assert.match(post.videoFile, /^sample-\d{3}\.mp4$/)
    assert.match(post.posterFile, /^sample-\d{3}\.jpg$/)
    assert.ok(post.credit && post.licenseUrl.startsWith('https://creativecommons.org/'))
    for (const other of sampleContent) {
      if (post.id === other.id || post.film !== other.film) continue
      assert.ok(
        post.sourceStartSeconds + post.durationSeconds <= other.sourceStartSeconds ||
          other.sourceStartSeconds + other.durationSeconds <= post.sourceStartSeconds,
        `${post.id} overlaps ${other.id}`,
      )
    }
  }
})

test('byte ranges reject ambiguity, overflow, reversed and unsatisfiable requests', () => {
  assert.deepEqual(sampleByteRange('bytes=0-9', 100), { start: 0, end: 9 })
  assert.deepEqual(sampleByteRange('bytes=90-', 100), { start: 90, end: 99 })
  assert.deepEqual(sampleByteRange('bytes=-10', 100), { start: 90, end: 99 })
  assert.deepEqual(sampleByteRange('bytes=-200', 100), { start: 0, end: 99 })
  assert.deepEqual(sampleByteRange('bytes=10-1000', 100), { start: 10, end: 99 })
  for (const invalid of [
    'bytes=100-',
    'bytes=10-9',
    'bytes=-0',
    'bytes=-',
    'bytes=0-1,3-4',
    'bytes=0-9007199254740992',
    'items=0-1',
  ])
    assert.equal(sampleByteRange(invalid, 100), null, invalid)
})

test('known sample assets stream exact bytes and HEAD metadata; traversal cannot escape the whitelist', async () => {
  const server = createServer(async (request, response) => {
    if (!(await handleSampleMedia(request, response))) {
      response.writeHead(404)
      response.end()
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`
  const bytes = await readFile(new URL('../../mobile/assets/media/sample-001.mp4', import.meta.url))
  try {
    const full = await fetch(`${origin}/v1/samples/media/sample-001.mp4`)
    assert.equal(full.status, 200)
    assert.equal(full.headers.get('content-type'), 'video/mp4')
    assert.equal(full.headers.get('content-length'), String(bytes.length))
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), bytes)
    const head = await fetch(`${origin}/v1/samples/media/sample-001.mp4`, { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(head.headers.get('content-length'), String(bytes.length))
    assert.equal((await head.arrayBuffer()).byteLength, 0)
    for (const [range, start, end] of [
      ['bytes=0-31', 0, 32],
      ['bytes=-17', bytes.length - 17, bytes.length],
      [`bytes=${bytes.length - 9}-`, bytes.length - 9, bytes.length],
    ] as const) {
      const response = await fetch(`${origin}/v1/samples/media/sample-001.mp4`, { headers: { Range: range } })
      assert.equal(response.status, 206)
      assert.equal(response.headers.get('content-range'), `bytes ${start}-${end - 1}/${bytes.length}`)
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(start, end))
    }
    const invalid = await fetch(`${origin}/v1/samples/media/sample-001.mp4`, {
      headers: { Range: `bytes=${bytes.length}-` },
    })
    assert.equal(invalid.status, 416)
    assert.equal(invalid.headers.get('content-range'), `bytes */${bytes.length}`)
    for (const path of [
      'sample-051.mp4',
      'CREDITS.md',
      '%2e%2e%2fCREDITS.md',
      'sample-001.mp4/../../CREDITS.md',
      'sample-001%2emp4',
    ]) {
      const response = await fetch(`${origin}/v1/samples/media/${path}`)
      assert.equal(response.status, 404, path)
    }
    const poster = await fetch(`${origin}/v1/samples/media/sample-001.jpg`, { method: 'HEAD' })
    assert.equal(poster.headers.get('content-type'), 'image/jpeg')
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
