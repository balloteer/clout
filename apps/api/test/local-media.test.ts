import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { LocalMedia } from '../src/local-media.js'

const box = (type: string, body: Buffer) => {
  const result = Buffer.alloc(8 + body.length)
  result.writeUInt32BE(result.length, 0)
  result.write(type, 4, 4, 'ascii')
  body.copy(result, 8)
  return result
}

const video = (durationSeconds: number, handler = 'vide', brand = 'isom') => {
  const ftyp = box('ftyp', Buffer.from(`${brand}\0\0\0\0isom`, 'binary'))
  const mvhd = Buffer.alloc(20)
  mvhd.writeUInt32BE(1000, 12)
  mvhd.writeUInt32BE(durationSeconds * 1000, 16)
  const hdlr = Buffer.alloc(12)
  hdlr.write(handler, 8, 4, 'ascii')
  return Buffer.concat([
    ftyp,
    box('moov', Buffer.concat([box('mvhd', mvhd), box('trak', box('mdia', box('hdlr', hdlr)))])),
    box('mdat', Buffer.from([1])),
  ])
}

async function fixture(
  now: () => number = Date.now,
  publish?: (uid: string, videoUrl: string) => Promise<boolean>,
) {
  const root = await mkdtemp(join(tmpdir(), 'clout-local-media-'))
  const published: { uid: string; videoUrl: string }[] = []
  const failed: string[] = []
  let media: LocalMedia
  const server = createServer(async (request, response) => {
    try {
      if (await media.handleRequest(request, response)) return
      response.writeHead(404).end()
    } catch {
      response.writeHead(500).end()
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Server did not listen.')
  const origin = `http://127.0.0.1:${address.port}`
  const createMedia = () =>
    new LocalMedia(
      origin,
      root,
      publish ??
        (async (uid, videoUrl) => {
          published.push({ uid, videoUrl })
          return true
        }),
      async (uid) => {
        failed.push(uid)
        return true
      },
      now,
    )
  media = createMedia()
  return {
    get media() {
      return media
    },
    restart: () => {
      media = createMedia()
    },
    origin,
    root,
    published,
    failed,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
      await rm(root, { recursive: true, force: true })
    },
  }
}

test('local upload validates, publishes, serves ranges and rejects ticket replay', async () => {
  const app = await fixture()
  try {
    const upload = await app.media.issueUpload()
    const payload = video(30)
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(payload)], { type: 'video/mp4' }), 'clip.mp4')
    const response = await fetch(upload.uploadUrl, { method: 'POST', body: form })
    assert.equal(response.status, 201)
    assert.deepEqual(await response.json(), { ok: true })
    assert.deepEqual(app.published, [{ uid: upload.uid, videoUrl: `/v1/local-media/${upload.uid}.mp4` }])
    assert.deepEqual(await readFile(join(app.root, `${upload.uid}.mp4`)), payload)

    const replay = await fetch(upload.uploadUrl, { method: 'POST', body: form })
    assert.equal(replay.status, 401)
    const full = await fetch(`${app.origin}/v1/local-media/${upload.uid}.mp4`)
    assert.equal(full.status, 200)
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), payload)
    const range = await fetch(`${app.origin}/v1/local-media/${upload.uid}.mp4`, {
      headers: { Range: 'bytes=4-11' },
    })
    assert.equal(range.status, 206)
    assert.equal(range.headers.get('content-range'), `bytes 4-11/${payload.length}`)
    assert.deepEqual(Buffer.from(await range.arrayBuffer()), payload.subarray(4, 12))
    const head = await fetch(`${app.origin}/v1/local-media/${upload.uid}.mp4`, { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(head.headers.get('content-length'), String(payload.length))
  } finally {
    await app.close()
  }
})

test('local upload accepts a real bundled portrait MP4', async () => {
  const app = await fixture()
  try {
    const upload = await app.media.issueUpload()
    const payload = await readFile(
      fileURLToPath(new URL('../../mobile/assets/media/sample-001.mp4', import.meta.url)),
    )
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(payload)], { type: 'video/mp4' }), 'portrait.mp4')
    assert.equal((await fetch(upload.uploadUrl, { method: 'POST', body: form })).status, 201)
    assert.equal(app.published.length, 1)
  } finally {
    await app.close()
  }
})

test('local upload rejects video longer than one minute without publishing it', async () => {
  const app = await fixture()
  try {
    const upload = await app.media.issueUpload()
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(video(61))], { type: 'video/mp4' }), 'long.mp4')
    const response = await fetch(upload.uploadUrl, { method: 'POST', body: form })
    assert.equal(response.status, 400)
    assert.equal((await response.json()).error.code, 'INVALID_VIDEO_DURATION')
    assert.deepEqual(app.published, [])
    assert.deepEqual(app.failed, [upload.uid])
    assert.equal((await fetch(upload.uploadUrl, { method: 'POST', body: form })).status, 401)
  } finally {
    await app.close()
  }
})

test('local upload requires a video track and rejects QuickTime', async () => {
  const app = await fixture()
  try {
    const audioUpload = await app.media.issueUpload()
    const audio = new FormData()
    audio.append('file', new Blob([new Uint8Array(video(12, 'soun'))], { type: 'video/mp4' }), 'audio.mp4')
    const audioResponse = await fetch(audioUpload.uploadUrl, { method: 'POST', body: audio })
    assert.equal(audioResponse.status, 415)
    assert.equal((await audioResponse.json()).error.code, 'INVALID_VIDEO_TYPE')

    const quickTimeUpload = await app.media.issueUpload()
    const quickTime = new FormData()
    quickTime.append(
      'file',
      new Blob([new Uint8Array(video(12, 'vide', 'qt  '))], { type: 'video/quicktime' }),
      'clip.mov',
    )
    const quickTimeResponse = await fetch(quickTimeUpload.uploadUrl, {
      method: 'POST',
      body: quickTime,
    })
    assert.equal(quickTimeResponse.status, 415)
    assert.deepEqual(app.failed, [audioUpload.uid, quickTimeUpload.uid])
  } finally {
    await app.close()
  }
})

test('local upload tickets survive an API restart', async () => {
  const app = await fixture()
  try {
    const upload = await app.media.issueUpload()
    app.restart()
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(video(12))], { type: 'video/mp4' }), 'clip.mp4')
    assert.equal((await fetch(upload.uploadUrl, { method: 'POST', body: form })).status, 201)
    assert.equal(app.published.length, 1)
  } finally {
    await app.close()
  }
})

test('local upload preserves the first file across an ambiguous publish retry', async () => {
  let attempts = 0
  const app = await fixture(Date.now, async () => {
    attempts++
    if (attempts === 1) throw new Error('connection ended after commit')
    return true
  })
  try {
    const upload = await app.media.issueUpload()
    const firstPayload = video(12)
    const first = new FormData()
    first.append('file', new Blob([new Uint8Array(firstPayload)], { type: 'video/mp4' }), 'first.mp4')
    assert.equal((await fetch(upload.uploadUrl, { method: 'POST', body: first })).status, 400)

    const retry = new FormData()
    retry.append('file', new Blob([new Uint8Array(video(20))], { type: 'video/mp4' }), 'retry.mp4')
    assert.equal((await fetch(upload.uploadUrl, { method: 'POST', body: retry })).status, 201)
    assert.deepEqual(await readFile(join(app.root, `${upload.uid}.mp4`)), firstPayload)
  } finally {
    await app.close()
  }
})

test('local upload atomically claims a ticket so concurrent requests cannot delete published media', async () => {
  const app = await fixture()
  try {
    const upload = await app.media.issueUpload()
    const payload = video(12)
    const form = () => {
      const value = new FormData()
      value.append('file', new Blob([new Uint8Array(payload)], { type: 'video/mp4' }), 'clip.mp4')
      return value
    }
    const responses = await Promise.all([
      fetch(upload.uploadUrl, { method: 'POST', body: form() }),
      fetch(upload.uploadUrl, { method: 'POST', body: form() }),
    ])
    assert.deepEqual(responses.map((response) => response.status).sort(), [201, 401])
    assert.equal(app.published.length, 1)
    assert.equal((await fetch(`${app.origin}/v1/local-media/${upload.uid}.mp4`)).status, 200)
  } finally {
    await app.close()
  }
})

test('local upload rejects an expired ticket', async () => {
  let now = Date.parse('2026-10-13T12:00:00Z')
  const app = await fixture(() => now)
  try {
    const upload = await app.media.issueUpload()
    now += 31 * 60_000
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(video(12))], { type: 'video/mp4' }), 'clip.mp4')
    assert.equal((await fetch(upload.uploadUrl, { method: 'POST', body: form })).status, 401)
    assert.deepEqual(app.published, [])
  } finally {
    await app.close()
  }
})
