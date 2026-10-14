const maintenanceUrl = (value) => {
  if (typeof value !== 'string') throw new Error('CLOUT_API_ORIGIN is required.')
  const origin = new URL(value)
  if (origin.protocol !== 'https:' || origin.origin !== value.replace(/\/$/, ''))
    throw new Error('CLOUT_API_ORIGIN must be an HTTPS origin without a path.')
  return new URL('/v1/maintenance/reconcile', origin)
}

export async function runMaintenance(env, fetchImpl = fetch) {
  if (typeof env.MAINTENANCE_SECRET !== 'string' || env.MAINTENANCE_SECRET.length < 32)
    throw new Error('MAINTENANCE_SECRET must contain at least 32 characters.')
  const response = await fetchImpl(maintenanceUrl(env.CLOUT_API_ORIGIN), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.MAINTENANCE_SECRET}`,
      'User-Agent': 'clout-cloudflare-recovery/1.0',
    },
    signal: AbortSignal.timeout(50_000),
  })
  let result
  try {
    result = await response.json()
  } catch {
    throw new Error(`Clout maintenance returned a non-JSON response (${response.status}).`)
  }
  if (!response.ok || result?.ok !== true)
    throw new Error(`Clout maintenance failed with HTTP ${response.status}.`)
  return result
}

export const createWorker = (run = runMaintenance) => ({
  fetch() {
    return new Response('Not found', { status: 404 })
  },
  scheduled(_controller, env, context) {
    context.waitUntil(run(env))
  },
})

export default createWorker()
