import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { pipeline } from 'node:stream/promises'
import { sampleContent } from '../../../packages/shared/src/sample-content.js'

const prefix = '/v1/samples/media/'
const allowedFiles = new Set(sampleContent.flatMap((post) => [post.videoFile, post.posterFile]))
const mediaDirectory = new URL('../../mobile/assets/media/', import.meta.url)

/** Old seeded rows keep their original URLs; only our bundled loopback assets move with the API. */
export function rebaseLoopbackSampleMedia(value: string | null, origin: string): string | null {
  if (value === null) return value
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return value
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    !url.pathname.startsWith(prefix) ||
    !allowedFiles.has(url.pathname.slice(prefix.length))
  )
    return value
  return new URL(`${url.pathname}${url.search}${url.hash}`, origin).href
}

/** Single HTTP byte ranges are enough for Android/HTML video seeking. */
export function sampleByteRange(header: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header)
  if (!match || (!match[1] && !match[2]) || size < 1) return null
  if (!match[1]) {
    const count = Number(match[2])
    if (!Number.isSafeInteger(count) || count <= 0) return null
    return { start: Math.max(0, size - count), end: size - 1 }
  }
  const start = Number(match[1])
  const requestedEnd = match[2] ? Number(match[2]) : size - 1
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd)) return null
  if (start >= size || requestedEnd < start) return null
  return { start, end: Math.min(requestedEnd, size - 1) }
}

/** Call only for demo mode after the normal CORS/rate-limit checks. */
export async function handleSampleMedia(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<boolean> {
  const pathname = (request.url ?? '').split('?', 1)[0]
  if (!pathname.startsWith(prefix)) return false
  if (request.method !== 'GET' && request.method !== 'HEAD') return false
  // Never decode user paths, concatenate arbitrary paths, or serve unlisted files.
  const filename = pathname.slice(prefix.length)
  if (!allowedFiles.has(filename)) {
    response.writeHead(404, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ error: 'SAMPLE_NOT_FOUND', message: 'Sample media not found.' }))
    return true
  }
  const file = new URL(filename, mediaDirectory)
  let size: number
  try {
    const info = await stat(file)
    if (!info.isFile()) throw new Error('Not a regular media file')
    size = info.size
  } catch {
    response.writeHead(404, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ error: 'SAMPLE_NOT_FOUND', message: 'Sample media not installed.' }))
    return true
  }
  response.setHeader('Content-Type', filename.endsWith('.mp4') ? 'video/mp4' : 'image/jpeg')
  response.setHeader('Accept-Ranges', 'bytes')
  response.setHeader('Cache-Control', 'public, max-age=3600')
  response.setHeader('X-Content-Type-Options', 'nosniff')
  const rangeHeader = request.headers.range
  const range = rangeHeader ? sampleByteRange(rangeHeader, size) : undefined
  if (rangeHeader && !range) {
    response.writeHead(416, { 'Content-Range': `bytes */${size}`, 'Content-Length': '0' })
    response.end()
    return true
  }
  const start = range?.start ?? 0
  const end = range?.end ?? size - 1
  response.statusCode = range ? 206 : 200
  response.setHeader('Content-Length', end - start + 1)
  if (range) response.setHeader('Content-Range', `bytes ${start}-${end}/${size}`)
  if (request.method === 'HEAD') {
    response.end()
    return true
  }
  try {
    await pipeline(createReadStream(file, { start, end }), response)
  } catch (error) {
    // Aborted video requests are normal when the user scrolls to the next clip.
    if (!request.destroyed && !response.destroyed) throw error
  }
  return true
}
