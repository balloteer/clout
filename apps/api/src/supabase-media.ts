import { randomBytes } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdtemp, open, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { ApiError } from './domain.js'
import { isXVideoUrl } from './linked-provider.js'
import type { MediaService } from './media.js'
import { mp4DurationSeconds } from './mp4-validation.js'

export const STORAGE_VIDEO_MAX_BYTES = 50 * 1024 * 1024
const UPLOAD_LIFETIME_MS = 2 * 60 * 60_000
const uidPattern = /^supabase:(\d{13}):([a-f0-9]{32})$/
type Config = {
  url: string
  secretKey: string
  stagingBucket?: string
  publicBucket?: string
}
type Inspection = Awaited<ReturnType<NonNullable<MediaService['inspectVideo']>>>

export class SupabaseMedia implements MediaService {
  private readonly origin: string
  private readonly staging: string
  private readonly published: string
  private readonly headers: Record<string, string>
  private readonly pending = new Map<string, Promise<Inspection>>()
  private bucketCheck: Promise<void> | undefined
  private checkedUntil = 0

  constructor(
    config: Config,
    private readonly request: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {
    const url = new URL(config.url)
    if (
      url.protocol !== 'https:' ||
      !/^[a-z0-9]{20}\.supabase\.co$/.test(url.hostname) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/'
    )
      throw new Error('SUPABASE_URL must be the HTTPS origin of the configured Supabase project.')
    if (!config.secretKey || /\s/.test(config.secretKey))
      throw new Error('Supabase Storage requires a server secret key.')
    this.origin = url.origin
    this.staging = config.stagingBucket ?? 'clout-upload-staging'
    this.published = config.publicBucket ?? 'clout-videos'
    if (
      this.staging === this.published ||
      ![this.staging, this.published].every((value) => /^[a-z0-9][a-z0-9-]{1,62}$/.test(value))
    )
      throw new Error('Supabase Storage requires separate private staging and public video buckets.')
    // New sb_secret keys belong in apikey, never in a JWT Authorization header.
    this.headers = { apikey: config.secretKey }
    if (!config.secretKey.startsWith('sb_secret_')) this.headers.Authorization = `Bearer ${config.secretKey}`
  }

  private async api(path: string, init: RequestInit = {}) {
    return this.request(`${this.origin}/storage/v1${path}`, {
      ...init,
      headers: { ...this.headers, ...init.headers },
      redirect: 'error',
      signal: init.signal ?? AbortSignal.timeout(20_000),
    })
  }

  /** No buckets or policies are created at runtime; configuration errors fail closed. */
  async validateConfiguration() {
    if (this.now() < this.checkedUntil) return
    if (this.bucketCheck) return this.bucketCheck
    this.bucketCheck = (async () => {
      for (const [id, isPublic] of [
        [this.staging, false],
        [this.published, true],
      ] as const) {
        const response = await this.api(`/bucket/${id}`)
        if (!response.ok)
          throw new ApiError(503, 'STORAGE_CONFIGURATION', 'Video storage is not configured correctly.')
        const bucket = (await response.json()) as {
          id?: string
          public?: boolean
          file_size_limit?: number | string
          allowed_mime_types?: string[]
        }
        const max = Number(bucket.file_size_limit)
        if (
          bucket.id !== id ||
          bucket.public !== isPublic ||
          !Number.isSafeInteger(max) ||
          max <= 0 ||
          max > STORAGE_VIDEO_MAX_BYTES ||
          !Array.isArray(bucket.allowed_mime_types) ||
          !bucket.allowed_mime_types.includes('video/mp4') ||
          bucket.allowed_mime_types.some((value) => value !== 'video/mp4')
        )
          throw new ApiError(
            503,
            'STORAGE_CONFIGURATION',
            'Video storage needs private staging, public playback and an MP4 file limit of at most 50 MB.',
          )
      }
      this.checkedUntil = this.now() + 60_000
    })().finally(() => {
      this.bucketCheck = undefined
    })
    return this.bucketCheck
  }

  async issueUpload(_input: { postId: string; wallet: string }) {
    await this.validateConfiguration()
    const uid = `supabase:${this.now()}:${randomBytes(16).toString('hex')}`
    const key = this.key(uid)
    const expectedPath = `/object/upload/sign/${this.staging}/${key}`
    const response = await this.api(expectedPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-upsert': 'false' },
      body: '{}',
    })
    const body = (await response.json().catch(() => null)) as { url?: string } | null
    if (!response.ok || !body?.url)
      throw new ApiError(502, 'UPLOAD_UNAVAILABLE', 'Video upload is temporarily unavailable.')
    const url = new URL(`${this.origin}/storage/v1${body.url}`)
    if (
      url.origin !== this.origin ||
      url.pathname !== `/storage/v1${expectedPath}` ||
      !url.searchParams.get('token') ||
      url.hash
    )
      throw new ApiError(502, 'UPLOAD_UNAVAILABLE', 'Video upload is temporarily unavailable.')
    return {
      uid,
      uploadUrl: url.toString(),
      uploadMethod: 'PUT' as const,
      uploadHeaders: { 'x-upsert': 'false' },
      maxBytes: STORAGE_VIDEO_MAX_BYTES,
      requiresCompletion: true,
    }
  }

  private key(uid: string) {
    const match = uidPattern.exec(uid)
    if (!match) throw new ApiError(400, 'INVALID_UPLOAD', 'Invalid Storage upload identifier.')
    return `uploads/${match[1]}/${match[2]}.mp4`
  }

  inspectVideo(uid: string): Promise<Inspection> {
    this.key(uid)
    const existing = this.pending.get(uid)
    if (existing) return existing
    // Bound simultaneous 50 MB validation downloads per runtime instance.
    if (this.pending.size >= 3)
      return Promise.reject(
        new ApiError(503, 'UPLOAD_CAPACITY', 'Video processing is busy. Try again shortly.'),
      )
    const result = this.inspect(uid).finally(() => this.pending.delete(uid))
    this.pending.set(uid, result)
    return result
  }

  private async inspect(uid: string): Promise<Inspection> {
    await this.validateConfiguration()
    const key = this.key(uid)
    const expiry = Number(uidPattern.exec(uid)![1]) + UPLOAD_LIFETIME_MS
    // Private Storage downloads use the normal object route with the server credential.
    // `/object/authenticated` is not the Storage download API and returns 404.
    const response = await this.api(`/object/${this.staging}/${key}`, {
      signal: AbortSignal.timeout(40_000),
    })
    if (!response.ok) {
      const error = (await response.json().catch(() => ({}))) as { code?: string; statusCode?: string }
      if (
        response.status === 404 ||
        (response.status === 400 && (error.code === 'NoSuchKey' || error.statusCode === '404'))
      )
        return {
          readyToStream: false,
          status: { state: 'pendingupload' },
          uploadExpiry: new Date(expiry).toISOString(),
        }
      throw new ApiError(503, 'VIDEO_STATUS_UNAVAILABLE', 'Video processing is temporarily unavailable.')
    }
    const directory = await mkdtemp(join(tmpdir(), 'clout-storage-'))
    const path = join(directory, 'video.mp4')
    try {
      await this.download(response, path)
      const duration = await this.validateVideo(path)
      if (duration === null) return { readyToStream: false, status: { state: 'error' } }
      const size = (await stat(path)).size
      const uploaded = await this.api(`/object/${this.published}/${key}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'video/mp4',
          'Content-Length': String(size),
          'cache-control': 'max-age=31536000',
          'x-upsert': 'false',
        },
        body: createReadStream(path) as unknown as BodyInit,
        duplex: 'half',
        signal: AbortSignal.timeout(40_000),
      } as RequestInit)
      if (!uploaded.ok) {
        const error = (await uploaded.json().catch(() => ({}))) as { code?: string; statusCode?: string }
        if (!(uploaded.status === 409 || error.code === 'Duplicate' || error.statusCode === '409'))
          throw new ApiError(
            503,
            'VIDEO_PUBLISH_UNAVAILABLE',
            'Video publication is temporarily unavailable.',
          )
        // A second completion or a crash after publication may encounter the immutable destination.
        const existing = await this.api(`/object/${this.published}/${key}`, { method: 'HEAD' })
        if (!existing.ok || Number(existing.headers.get('content-length')) !== size)
          throw new ApiError(503, 'VIDEO_PUBLISH_UNAVAILABLE', 'Video publication could not be verified.')
      } else await uploaded.body?.cancel()
      return {
        readyToStream: true,
        status: { state: 'ready' },
        duration,
        videoUrl: `${this.origin}/storage/v1/object/public/${this.published}/${key}`,
        thumbnailUrl: null,
      }
    } catch (error) {
      if (error instanceof ApiError && ['VIDEO_TOO_LARGE', 'INVALID_VIDEO_TYPE'].includes(error.code))
        return { readyToStream: false, status: { state: 'error' } }
      throw error
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }

  private async download(response: Response, path: string) {
    const size = Number(response.headers.get('content-length'))
    if (!response.body || (Number.isFinite(size) && size > STORAGE_VIDEO_MAX_BYTES)) {
      await response.body?.cancel()
      throw new ApiError(413, 'VIDEO_TOO_LARGE', 'Choose an MP4 video smaller than 50 MB.')
    }
    let received = 0
    const limit = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length
        callback(
          received > STORAGE_VIDEO_MAX_BYTES
            ? new ApiError(413, 'VIDEO_TOO_LARGE', 'Choose an MP4 video smaller than 50 MB.')
            : null,
          chunk,
        )
      },
    })
    await pipeline(
      Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
      limit,
      createWriteStream(path, { flags: 'wx', mode: 0o600 }),
    )
  }

  private async validateVideo(path: string) {
    const file = await open(path, 'r')
    const header = Buffer.alloc(12)
    try {
      await file.read(header, 0, 12, 0)
    } finally {
      await file.close()
    }
    if (
      header.subarray(4, 8).toString('ascii') !== 'ftyp' ||
      header.subarray(8, 12).toString('ascii') === 'qt  '
    )
      return null
    const duration = await mp4DurationSeconds(path)
    return duration !== null && Number.isFinite(duration) && duration > 0 && duration <= 60 ? duration : null
  }

  async copyVideo(input: { postId: string; wallet: string; importId: string; url: string }) {
    if (!isXVideoUrl(input.url))
      throw new ApiError(400, 'INVALID_VIDEO_SOURCE', 'The video source is not supported.')
    await this.validateConfiguration()
    const uid = `supabase:${this.now()}:${randomBytes(16).toString('hex')}`
    const response = await this.request(input.url, { redirect: 'error', signal: AbortSignal.timeout(40_000) })
    if (!response.ok)
      throw new ApiError(502, 'IMPORT_COPY_UNCERTAIN', 'Video importing is temporarily unavailable.')
    const directory = await mkdtemp(join(tmpdir(), 'clout-import-'))
    const path = join(directory, 'video.mp4')
    try {
      await this.download(response, path)
      if ((await this.validateVideo(path)) === null)
        throw new ApiError(400, 'INVALID_VIDEO_TYPE', 'Import requires an MP4 video of at most 60 seconds.')
      const result = await this.api(`/object/${this.staging}/${this.key(uid)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'video/mp4',
          'Content-Length': String((await stat(path)).size),
          'x-upsert': 'false',
        },
        body: createReadStream(path) as unknown as BodyInit,
        duplex: 'half',
        signal: AbortSignal.timeout(40_000),
      } as RequestInit)
      if (!result.ok)
        throw new ApiError(502, 'IMPORT_COPY_UNCERTAIN', 'Video importing could not be confirmed.')
      await result.body?.cancel()
      return { uid }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
}
