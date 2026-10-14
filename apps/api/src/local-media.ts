import Busboy from 'busboy'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createReadStream, createWriteStream, readFileSync } from 'node:fs'
import { link, mkdir, open, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { ApiError } from './domain.js'
import type { MediaService } from './media.js'
import { sampleByteRange } from './sample-media.js'
import { mp4DurationSeconds } from './mp4-validation.js'

const MAX_VIDEO_BYTES = 128 * 1024 * 1024
const MAX_MULTIPART_OVERHEAD = 1024 * 1024
const MAX_UPLOAD_TICKETS = 1_000
const uploadPattern = /^\/v1\/local-uploads\/([a-f0-9]{32})$/
const mediaPattern = /^\/v1\/local-media\/([a-f0-9]{32})\.mp4$/

type Ticket = { digest: Buffer; expiresAt: number; state: 'ready' | 'uploading' }
type StoredTicket = { digest: string; expiresAt: number }

export class LocalMedia implements MediaService {
  private readonly tickets = new Map<string, Ticket>()
  private readonly restored: Promise<void>

  constructor(
    private readonly origin: string,
    private readonly root: string,
    private readonly publish: (uid: string, videoUrl: string) => Promise<boolean>,
    private readonly fail: (uid: string) => Promise<boolean>,
    private readonly now: () => number = Date.now,
  ) {
    this.restored = this.restoreTickets()
    // Keep a startup filesystem error observable by callers without creating an unhandled rejection.
    void this.restored.catch(() => {})
  }

  async issueUpload() {
    await this.restored
    await this.pruneTickets()
    if (this.tickets.size >= MAX_UPLOAD_TICKETS)
      throw new ApiError(503, 'UPLOAD_CAPACITY', 'Video uploads are busy. Try again shortly.')
    const uid = randomBytes(16).toString('hex')
    const ticket = randomBytes(32).toString('base64url')
    const stored = {
      digest: createHash('sha256').update(ticket).digest(),
      expiresAt: this.now() + 30 * 60_000,
      state: 'ready',
    } satisfies Ticket
    await writeFile(
      this.ticketPath(uid),
      JSON.stringify({ digest: stored.digest.toString('hex'), expiresAt: stored.expiresAt }),
      { flag: 'wx', mode: 0o600 },
    )
    this.tickets.set(uid, stored)
    return {
      uid,
      uploadUrl: new URL(`/v1/local-uploads/${uid}?ticket=${ticket}`, this.origin).toString(),
    }
  }

  async handleRequest(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? '/', this.origin)
    const upload = uploadPattern.exec(url.pathname)
    if (upload) {
      if (request.method !== 'POST') return this.error(response, 405, 'METHOD_NOT_ALLOWED', 'Use POST.')
      const uid = upload[1]
      const ticket = url.searchParams.get('ticket') ?? ''
      await this.restored
      await this.pruneTickets()
      const stored = this.tickets.get(uid) ?? this.loadTicket(uid)
      if (stored && stored.expiresAt <= this.now()) {
        await this.expireTicket(uid, stored)
        return this.error(response, 401, 'INVALID_UPLOAD_TICKET', 'Upload link is invalid or expired.')
      }
      const digest = createHash('sha256').update(ticket).digest()
      if (
        !stored ||
        stored.state !== 'ready' ||
        stored.digest.length !== digest.length ||
        !timingSafeEqual(stored.digest, digest)
      )
        return this.error(response, 401, 'INVALID_UPLOAD_TICKET', 'Upload link is invalid or expired.')
      stored.state = 'uploading'
      let videoUrl: string
      try {
        videoUrl = await this.receive(uid, request)
      } catch (error) {
        const failed = await this.markFailed(uid)
        if (failed !== undefined) await this.discardTicket(uid, stored)
        else if (this.tickets.get(uid) === stored) stored.state = 'ready'
        const known =
          error instanceof ApiError ? error : new ApiError(400, 'INVALID_VIDEO', 'Video upload failed.')
        this.error(response, known.status, known.code, known.message)
        return true
      }
      try {
        if (!(await this.publish(uid, videoUrl))) {
          await unlink(join(this.root, `${uid}.mp4`)).catch(() => {})
          await this.discardTicket(uid, stored)
          throw new ApiError(404, 'UPLOAD_NOT_FOUND', 'Upload request no longer exists.')
        }
        await this.discardTicket(uid, stored)
        response.writeHead(201, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        response.end(JSON.stringify({ ok: true }))
      } catch (error) {
        if (this.tickets.get(uid) === stored && stored.expiresAt > this.now()) stored.state = 'ready'
        const known =
          error instanceof ApiError ? error : new ApiError(400, 'INVALID_VIDEO', 'Video upload failed.')
        this.error(response, known.status, known.code, known.message)
      }
      return true
    }
    const media = mediaPattern.exec(url.pathname)
    if (!media) return false
    if (request.method !== 'GET' && request.method !== 'HEAD')
      return this.error(response, 405, 'METHOD_NOT_ALLOWED', 'Use GET or HEAD.')
    await this.serve(media[1], request, response)
    return true
  }

  private async receive(uid: string, request: IncomingMessage) {
    const length = Number(request.headers['content-length'] ?? 0)
    if (!Number.isSafeInteger(length) || length <= 0 || length > MAX_VIDEO_BYTES + MAX_MULTIPART_OVERHEAD)
      throw new ApiError(413, 'VIDEO_TOO_LARGE', 'Choose a video smaller than 128 MB.')
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const partial = join(this.root, `${uid}.${randomBytes(8).toString('hex')}.partial`)
    const final = join(this.root, `${uid}.mp4`)
    let fileCount = 0
    let invalid: ApiError | null = null
    let firstBytes = Buffer.alloc(0)
    let fileWrite: Promise<void> | null = null
    try {
      const parser = Busboy({
        headers: request.headers,
        limits: { files: 1, fields: 0, fileSize: MAX_VIDEO_BYTES },
      })
      const parsed = new Promise<void>((resolve, reject) => {
        parser.on('file', (field, stream, info) => {
          fileCount++
          if (field !== 'file' || !['video/mp4', 'application/octet-stream'].includes(info.mimeType)) {
            invalid = new ApiError(415, 'INVALID_VIDEO_TYPE', 'Choose an MP4 video.')
            stream.resume()
            return
          }
          stream.on('limit', () => {
            invalid = new ApiError(413, 'VIDEO_TOO_LARGE', 'Choose a video smaller than 128 MB.')
          })
          const inspect = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              if (firstBytes.length < 12) firstBytes = Buffer.concat([firstBytes, chunk]).subarray(0, 12)
              callback(null, chunk)
            },
          })
          fileWrite = pipeline(stream, inspect, createWriteStream(partial, { flags: 'wx', mode: 0o600 }))
        })
        parser.on('filesLimit', () => {
          invalid = new ApiError(400, 'INVALID_UPLOAD', 'Upload exactly one video file.')
        })
        parser.on('fieldsLimit', () => {
          invalid = new ApiError(400, 'INVALID_UPLOAD', 'Upload exactly one video file.')
        })
        parser.on('error', reject)
        parser.on('close', async () => {
          try {
            if (fileWrite) await fileWrite
            if (invalid) throw invalid
            if (fileCount !== 1 || !fileWrite)
              throw new ApiError(400, 'INVALID_UPLOAD', 'Upload exactly one video file.')
            if (firstBytes.length < 12 || firstBytes.subarray(4, 8).toString('ascii') !== 'ftyp')
              throw new ApiError(415, 'INVALID_VIDEO_TYPE', 'The selected file is not a valid video.')
            if (firstBytes.subarray(8, 12).toString('ascii') === 'qt  ')
              throw new ApiError(415, 'INVALID_VIDEO_TYPE', 'Choose an MP4 video.')
            resolve()
          } catch (error) {
            reject(error)
          }
        })
      })
      request.pipe(parser)
      await parsed
      const duration = await mp4DurationSeconds(partial)
      if (duration === null || !Number.isFinite(duration) || duration <= 0)
        throw new ApiError(415, 'INVALID_VIDEO_TYPE', 'The selected file is not a valid MP4 video.')
      if (duration > 60.5)
        throw new ApiError(400, 'INVALID_VIDEO_DURATION', 'Choose a video that is 60 seconds or shorter.')
      const file = await open(partial, 'r+')
      await file.sync()
      await file.close()
      try {
        await link(partial, final)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      await unlink(partial)
      return `/v1/local-media/${uid}.mp4`
    } catch (error) {
      await unlink(partial).catch(() => {})
      throw error
    }
  }

  private async serve(uid: string, request: IncomingMessage, response: ServerResponse) {
    const path = join(this.root, `${uid}.mp4`)
    let size: number
    try {
      const info = await stat(path)
      if (!info.isFile()) throw new Error('Not a file')
      size = info.size
    } catch {
      this.error(response, 404, 'VIDEO_NOT_FOUND', 'Video not found.')
      return
    }
    const rangeHeader = request.headers.range
    const range = rangeHeader ? sampleByteRange(rangeHeader, size) : undefined
    if (rangeHeader && !range) {
      response.writeHead(416, { 'Content-Range': `bytes */${size}`, 'Content-Length': '0' })
      response.end()
      return
    }
    const start = range?.start ?? 0
    const end = range?.end ?? size - 1
    response.statusCode = range ? 206 : 200
    response.setHeader('Content-Type', 'video/mp4')
    response.setHeader('Accept-Ranges', 'bytes')
    response.setHeader('Cache-Control', 'public, max-age=3600')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Content-Length', end - start + 1)
    if (range) response.setHeader('Content-Range', `bytes ${start}-${end}/${size}`)
    if (request.method === 'HEAD') response.end()
    else
      await pipeline(createReadStream(path, { start, end }), response).catch((error) => {
        if (!request.destroyed && !response.destroyed) throw error
      })
  }

  private error(response: ServerResponse, status: number, code: string, message: string): true {
    if (!response.headersSent)
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    response.end(JSON.stringify({ error: { code, message } }))
    return true
  }

  private async restoreTickets() {
    await mkdir(this.ticketRoot(), { recursive: true, mode: 0o700 })
    const names = await readdir(this.ticketRoot())
    for (const name of names) {
      const match = /^([a-f0-9]{32})\.json$/.exec(name)
      if (!match) continue
      const ticket = this.loadTicket(match[1])
      if (ticket?.expiresAt && ticket.expiresAt <= this.now()) await this.expireTicket(match[1], ticket)
    }
  }

  private loadTicket(uid: string): Ticket | undefined {
    try {
      const value = JSON.parse(readFileSync(this.ticketPath(uid), 'utf8')) as Partial<StoredTicket>
      if (!/^[a-f0-9]{64}$/.test(value.digest ?? '') || !Number.isSafeInteger(value.expiresAt)) return
      const ticket: Ticket = {
        digest: Buffer.from(value.digest!, 'hex'),
        expiresAt: value.expiresAt!,
        state: 'ready',
      }
      this.tickets.set(uid, ticket)
      return ticket
    } catch {
      return
    }
  }

  private async markFailed(uid: string): Promise<boolean | undefined> {
    try {
      return await this.fail(uid)
    } catch {
      return undefined
    }
  }

  private async expireTicket(uid: string, ticket: Ticket) {
    if ((await this.markFailed(uid)) !== undefined) await this.discardTicket(uid, ticket)
  }

  private async discardTicket(uid: string, ticket: Ticket) {
    try {
      await unlink(this.ticketPath(uid))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (this.tickets.get(uid) === ticket) this.tickets.delete(uid)
  }

  private async pruneTickets() {
    const now = this.now()
    for (const [uid, ticket] of this.tickets)
      if (ticket.expiresAt <= now && ticket.state === 'ready') await this.expireTicket(uid, ticket)
  }

  private ticketRoot() {
    return join(this.root, '.tickets')
  }

  private ticketPath(uid: string) {
    return join(this.ticketRoot(), `${uid}.json`)
  }
}
