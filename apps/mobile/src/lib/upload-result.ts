export function assertUploadSucceeded(status: number, body = '') {
  if (status >= 200 && status < 300) return
  let message: string | undefined
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } }
    message = parsed.error?.message
  } catch {}
  if (message) throw new Error(message)
  throw new Error('The upload did not finish. Please try again.')
}
