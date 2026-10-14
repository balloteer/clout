import assert from 'node:assert/strict'
import test from 'node:test'
import { createWorker, runMaintenance } from '../workers/recovery-worker/index.mjs'

const environment = {
  CLOUT_API_ORIGIN: 'https://clout-api.vercel.app',
  MAINTENANCE_SECRET: 's'.repeat(64),
}

test('Cloudflare recovery calls only the fixed HTTPS maintenance route with its secret', async () => {
  let called
  const result = await runMaintenance(environment, async (url, init) => {
    called = { url: String(url), init }
    return Response.json({ ok: true, jobs: { transactions: 'ok' } })
  })
  assert.deepEqual(result, { ok: true, jobs: { transactions: 'ok' } })
  assert.equal(called.url, 'https://clout-api.vercel.app/v1/maintenance/reconcile')
  assert.equal(called.init.method, 'POST')
  assert.equal(called.init.headers.Authorization, `Bearer ${environment.MAINTENANCE_SECRET}`)
})

test('Cloudflare recovery rejects unsafe origins, weak secrets and partial failures', async () => {
  await assert.rejects(
    runMaintenance({ ...environment, CLOUT_API_ORIGIN: 'http://clout-api.vercel.app' }),
    /HTTPS origin/,
  )
  await assert.rejects(
    runMaintenance({ ...environment, CLOUT_API_ORIGIN: 'https://clout-api.vercel.app/path' }),
    /HTTPS origin/,
  )
  await assert.rejects(runMaintenance({ ...environment, MAINTENANCE_SECRET: 'short' }), /at least 32/)
  await assert.rejects(
    runMaintenance(environment, async () => Response.json({ ok: false }, { status: 503 })),
    /HTTP 503/,
  )
})

test('Cloudflare recovery has no public HTTP control surface and waits on scheduled work', async () => {
  const worker = createWorker(async () => ({ ok: true }))
  assert.equal((await worker.fetch()).status, 404)
  let scheduled
  worker.scheduled({}, environment, {
    waitUntil(promise) {
      scheduled = promise
    },
  })
  assert.ok(scheduled instanceof Promise)
  await scheduled
})
