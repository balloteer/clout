import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { createAccountLinkFlow, parseAccountLinkReturn } from './account-link-flow'

const state = 's'.repeat(43)
const completion = 'c'.repeat(43)
const verifier = 'a'.repeat(64)
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
function fixture() {
  const storage = new Map<string, string>()
  const calls: { path: string; body: Record<string, string> }[] = []
  let fail = false
  let savedChallenge = ''
  const deps = {
    apiOrigin: 'https://clout.example',
    read: async (owner: string) => storage.get(owner) ?? null,
    write: async (owner: string, value: string) => {
      storage.set(owner, value)
    },
    remove: async (owner: string) => {
      storage.delete(owner)
    },
    randomVerifier: () => verifier,
    challenge: async (value: string) => hash(value),
    post: async <T>(path: string, raw: unknown): Promise<T> => {
      const body = raw as Record<string, string>
      calls.push({ path, body })
      if (path.endsWith('/connect')) {
        savedChallenge = body.clientChallenge
        return {
          state,
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          authorizationUrl: `https://clout.example/v1/linked-accounts/x/start?state=${state}`,
        } as T
      }
      assert.equal(body.state, state)
      assert.equal(body.completion, completion)
      assert.equal(hash(body.verifier), savedChallenge)
      assert.equal(
        JSON.parse(storage.get('owner')!).completion,
        completion,
        'Persist callback before request',
      )
      if (fail) throw new Error('Response timed out')
      return { ok: true } as T
    },
  }
  return {
    deps,
    storage,
    calls,
    flow: createAccountLinkFlow(deps),
    fail: (value: boolean) => {
      fail = value
    },
  }
}

test('account linking saves app-local proof before opening OAuth and completes only a matching callback', async () => {
  const f = fixture()
  const url = await f.flow.start('owner', 'x', 'reauthorize-id')
  assert.equal(new URL(url).searchParams.get('state'), state)
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].body.accountId, 'reauthorize-id')
  assert.equal(f.calls[0].body.clientChallenge, hash(verifier))
  assert.equal('verifier' in f.calls[0].body, false)
  assert.equal((await f.flow.pending('owner'))?.completion, undefined)
  await f.flow.complete('owner', { state, completion })
  assert.equal(f.calls.length, 2)
  assert.equal(await f.flow.pending('owner'), null)
  await assert.rejects(f.flow.complete('owner', { state, completion }), /did not start/)
  assert.equal(f.calls.length, 2)
})

test('forwarded authorization cannot complete in victim app; initiating attacker lacks callback secret', async () => {
  const attacker = fixture()
  const victim = fixture()
  await attacker.flow.start('owner', 'x')
  // Victim authorizes the forwarded browser URL but has no initiating state on its device.
  await assert.rejects(victim.flow.complete('victim-wallet', { state, completion }), /did not start/)
  assert.equal(victim.calls.length, 0)
  // Attacker can authenticate and knows its own verifier, but cannot poll the browser-only completion.
  await assert.rejects(attacker.flow.complete('owner'), /Finish authorizing/)
  assert.equal(attacker.calls.length, 1)
  // A callback from a different attempt cannot replace the legitimate pending proof.
  await assert.rejects(attacker.flow.complete('owner', { state: 'z'.repeat(43), completion }), /different/)
  assert.equal((await attacker.flow.pending('owner'))?.completion, undefined)
})

test('matched callback survives timeout and app restart without polling its secret or replacing the attempt', async () => {
  const f = fixture()
  await f.flow.start('owner', 'x')
  f.fail(true)
  await assert.rejects(f.flow.complete('owner', { state, completion }), /timed out/)
  assert.equal((await f.flow.pending('owner'))?.completion, completion)
  await assert.rejects(
    f.flow.complete('owner', { state, completion: 'z'.repeat(43) }),
    /different return proof/,
  )
  const reopened = createAccountLinkFlow(f.deps)
  f.fail(false)
  await reopened.complete('owner')
  assert.deepEqual(f.calls[1], f.calls[2])
  assert.equal(f.calls.filter((call) => call.path.endsWith('/connect')).length, 1)
})

test('callbacks reject arrays, malformed tokens, expired local proofs and changed API origins', async () => {
  assert.throws(() => parseAccountLinkReturn([state], completion), /invalid/)
  assert.throws(() => parseAccountLinkReturn(state, 'short'), /invalid/)
  const f = fixture()
  await f.flow.start('owner', 'x')
  const value = JSON.parse(f.storage.get('owner')!)
  f.storage.set('owner', JSON.stringify({ ...value, expiresAt: '2000-01-01T00:00:00Z' }))
  await assert.rejects(f.flow.complete('owner', { state, completion }), /expired/)
  assert.equal(f.calls.length, 1)
  assert.equal(f.storage.size, 0)
  await f.flow.start('owner', 'x')
  await assert.rejects(
    createAccountLinkFlow({ ...f.deps, apiOrigin: 'https://different.example' }).complete('owner', {
      state,
      completion,
    }),
    /another server/,
  )
})

test('wallet changes and cancellation cannot activate an account', async () => {
  const f = fixture()
  await f.flow.start('owner', 'x')
  await assert.rejects(f.flow.complete('other-owner', { state, completion }), /did not start/)
  assert.ok(await f.flow.pending('owner'))
  await f.flow.cancel('owner')
  await assert.rejects(f.flow.complete('owner', { state, completion }), /did not start/)
  assert.equal(f.calls.length, 1)
})
