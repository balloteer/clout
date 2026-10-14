export type UploadMethod = 'POST' | 'PUT'
export type UploadCompletionStatus = 'processing' | 'ready'

export const UPLOAD_COMPLETION_TIMEOUT_MS = 60_000
export const UPLOAD_MAX_VIDEO_BYTES = 50 * 1024 * 1024

export function resolveUploadMethod(value: unknown): UploadMethod {
  if (value === undefined) return 'POST'
  if (value === 'POST' || value === 'PUT') return value
  throw new Error('The upload destination is not supported. Please try again.')
}

export function resolveUploadHeaders(value: unknown): Record<string, string> {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('The upload destination is not supported. Please try again.')
  const headers: Record<string, string> = {}
  for (const [rawName, rawValue] of Object.entries(value)) {
    const name = rawName.toLowerCase()
    if (name !== 'x-upsert' || rawValue !== 'false')
      throw new Error('The upload destination is not supported. Please try again.')
    headers[name] = rawValue
  }
  return headers
}

export function resolveMaxBytes(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || (value as number) <= 0)
    throw new Error('The upload destination is not supported. Please try again.')
  return value as number
}

export function assertUploadSize(fileSize: number | undefined, maxBytes: number | undefined) {
  if (fileSize === undefined || maxBytes === undefined) return
  if (!Number.isSafeInteger(fileSize) || fileSize < 0)
    throw new Error('The selected video size could not be verified.')
  if (fileSize > maxBytes)
    throw new Error(`Choose a video no larger than ${Math.floor(maxBytes / (1024 * 1024))} MB.`)
}

export function resolveCompleteUrl(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (
    typeof value !== 'string' ||
    !/^\/v1\/uploads\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/complete$/i.test(
      value,
    )
  )
    throw new Error('The upload destination is not supported. Please try again.')
  return value
}

export function resolveCompletionStatus(value: unknown): UploadCompletionStatus {
  if (value === 'processing' || value === 'ready') return value
  if (value === 'failed') throw new Error('Video processing failed. Choose another MP4 video.')
  throw new Error('Video processing returned an invalid status. Please try again.')
}

export function assertUploadSucceeded(status: number, body = '') {
  if (status >= 200 && status < 300) return
  let message: string | undefined
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown }; message?: unknown }
    const candidate = parsed.error?.message ?? parsed.message
    if (typeof candidate === 'string' && candidate.length <= 280) message = candidate
  } catch {}
  if (message) throw new Error(message)
  throw new Error('The upload did not finish. Please try again.')
}
