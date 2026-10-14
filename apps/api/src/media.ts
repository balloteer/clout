import { createHmac, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { ApiError, type Repository } from './domain.js'
import { isXVideoUrl } from './linked-provider.js'

export function verifyStreamWebhook(
  raw: Buffer,
  header: string | undefined,
  secret: string,
  now = Date.now(),
): boolean {
  if (!header || header.length > 1024) return false
  const fields = header.split(',').map((part) => part.trim().split('='))
  const times = fields.filter(([name]) => name === 'time')
  const signatures = fields.filter(([name]) => name === 'sig1')
  if (times.length !== 1 || signatures.length < 1 || !/^\d{10}$/.test(times[0][1] ?? '')) return false
  const timestamp = Number(times[0][1])
  if (Math.abs(now / 1000 - timestamp) > 300) return false
  const expected = createHmac('sha256', secret).update(`${timestamp}.`).update(raw).digest()
  return signatures.some(
    ([, signature]) =>
      /^[a-f0-9]{64}$/i.test(signature ?? '') && timingSafeEqual(expected, Buffer.from(signature, 'hex')),
  )
}
export interface MediaService {
  issueUpload(input: { postId: string; wallet: string }): Promise<{ uid: string; uploadUrl: string }>
  handleRequest?(request: IncomingMessage, response: ServerResponse): Promise<boolean>
  copyVideo?(input: {
    postId: string
    wallet: string
    importId: string
    url: string
  }): Promise<{ uid: string }>
  inspectVideo?(uid: string): Promise<{
    readyToStream: boolean
    status: { state: string }
    duration?: number
    uploadExpiry?: string
  }>
}

export async function reconcilePendingUploads(
  repository: Repository,
  media: Pick<MediaService, 'inspectVideo'>,
  limit = 25,
  after?: { createdAt: string; id: string },
  claim = false,
) {
  const inspectVideo = media.inspectVideo
  if (!inspectVideo) return { checked: 0, updated: 0, failed: 0, next: undefined }
  const posts = claim
    ? await repository.claimProcessingUploads(limit)
    : await repository.listProcessingUploads(limit, after)
  let updated = 0
  let failed = 0
  for (let start = 0; start < posts.length; start += 5)
    await Promise.all(
      posts.slice(start, start + 5).map(async (post) => {
        if (!post.streamUid) return
        try {
          const video = await inspectVideo(post.streamUid)
          if (video.status.state === 'ready' && video.readyToStream) {
            if (
              await repository.updateStream(
                post.streamUid,
                'ready',
                `https://videodelivery.net/${post.streamUid}/manifest/video.m3u8`,
                `https://videodelivery.net/${post.streamUid}/thumbnails/thumbnail.jpg`,
              )
            )
              updated++
          } else if (
            video.status.state === 'error' ||
            (video.status.state === 'pendingupload' &&
              !!video.uploadExpiry &&
              Date.parse(video.uploadExpiry) <= Date.now())
          ) {
            if (await repository.updateStream(post.streamUid, 'failed', null, null)) updated++
          }
        } catch {
          // A transient Stream read must not prevent the remaining durable uploads from recovering.
          failed++
        }
      }),
    )
  const last = posts.at(-1)
  return {
    checked: posts.length,
    updated,
    failed,
    next: posts.length === limit && last ? { createdAt: last.createdAt, id: last.id } : undefined,
  }
}

export class CloudflareMedia implements MediaService {
  constructor(
    private accountId: string,
    private apiToken: string,
    private allowedOrigins: string[],
  ) {
    if (!/^[a-f0-9]{32}$/.test(accountId)) throw new Error('Invalid Cloudflare account ID.')
  }
  async issueUpload({ postId, wallet }: { postId: string; wallet: string }) {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/stream/direct_upload`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          maxDurationSeconds: 60,
          expiry: new Date(Date.now() + 30 * 60_000).toISOString(),
          allowedOrigins: this.allowedOrigins,
          meta: { postId, creator: wallet },
          requireSignedURLs: false,
        }),
        signal: AbortSignal.timeout(15000),
      },
    )
    const body = (await response.json()) as { success: boolean; result?: { uid: string; uploadURL: string } }
    if (!response.ok || !body.success || !body.result?.uid || !body.result.uploadURL)
      throw new ApiError(502, 'UPLOAD_UNAVAILABLE', 'Video upload is temporarily unavailable.')
    return { uid: body.result.uid, uploadUrl: body.result.uploadURL }
  }
  async copyVideo(input: { postId: string; wallet: string; importId: string; url: string }) {
    if (!isXVideoUrl(input.url))
      throw new ApiError(400, 'INVALID_VIDEO_SOURCE', 'The video source is not supported.')
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/stream/copy`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: input.url,
          allowedOrigins: this.allowedOrigins,
          requireSignedURLs: false,
          meta: { postId: input.postId, creator: input.wallet, importId: input.importId },
        }),
        signal: AbortSignal.timeout(15000),
        redirect: 'error',
      },
    )
    const body = (await response.json()) as { success?: boolean; result?: { uid?: string } }
    if (!response.ok || !body.success || !/^[a-f0-9]{32}$/.test(body.result?.uid ?? ''))
      throw new ApiError(502, 'IMPORT_COPY_UNCERTAIN', 'Video processing could not be confirmed.')
    return { uid: body.result!.uid! }
  }
  async inspectVideo(uid: string) {
    if (!/^[a-f0-9]{32}$/.test(uid)) throw new Error('Invalid Stream UID.')
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/stream/${uid}`,
      {
        headers: { Authorization: `Bearer ${this.apiToken}` },
        signal: AbortSignal.timeout(15000),
        redirect: 'error',
      },
    )
    const body = (await response.json()) as {
      success?: boolean
      result?: {
        readyToStream: boolean
        status: { state: string }
        duration?: number
        uploadExpiry?: string
      }
    }
    if (!response.ok || !body.success || !body.result?.status)
      throw new ApiError(
        503,
        'VIDEO_STATUS_UNAVAILABLE',
        'Video processing status is temporarily unavailable.',
      )
    return body.result
  }
}
