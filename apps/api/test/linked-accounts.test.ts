import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { MemoryRepository } from '../src/memory.js'
import { MemoryLinkedStore, PostgresLinkedStore, type LinkedAccount } from '../src/linked-store.js'
import { LinkedAccountService } from '../src/linked-accounts.js'
import {
  TokenVault,
  XProvider,
  isXVideoUrl,
  type LinkedProvider,
  type ImportVideo,
} from '../src/linked-provider.js'
const uid = 'a'.repeat(32)
const verifier = '1'.repeat(64)
const challenge = createHash('sha256').update(verifier).digest('hex')
async function fixture() {
  const repository = new MemoryRepository(false)
  const store = new MemoryLinkedStore(repository)
  const vault = new TokenVault(randomBytes(32).toString('base64'))
  const session = { hash: 'session', wallet: 'owner', expiresAt: Date.now() + 600_000 }
  await repository.ensureProfile('owner')
  await repository.putSession(session)
  const state = {
    identity: '123',
    protected: false,
    copies: 0,
    uncertain: false,
    videos: [] as ImportVideo[],
    refreshes: 0,
  }
  const tokens = {
    accessToken: 'access-secret',
    refreshToken: 'refresh-secret',
    expiresAt: Date.now() + 600_000,
  }
  const provider: LinkedProvider = {
    authorizationUrl: (state, challenge) =>
      `https://x.com/i/oauth2/authorize?state=${state}&code_challenge=${challenge}`,
    exchange: async () => tokens,
    refresh: async () => {
      state.refreshes++
      return tokens
    },
    identity: async () => ({
      id: state.identity,
      handle: 'owner',
      displayName: 'Owner',
      protected: state.protected,
    }),
    videos: async () => ({ videos: state.videos, newestId: '999' }),
  }
  const service = new LinkedAccountService(
    store,
    repository,
    provider,
    vault,
    {
      issueUpload: async () => {
        throw new Error('unused')
      },
      copyVideo: async () => {
        state.copies++
        assert.equal([...store.imports.values()][0].state, 'submitting')
        if (state.uncertain) throw new Error('lost response')
        return { uid }
      },
    },
    'https://clout.example',
  )
  async function link(accountId?: string) {
    const start = await service.connect(session, 'x', challenge, accountId)
    const nonce = new URL(start.authorizationUrl).searchParams.get('state')!
    const browser = await service.begin(nonce)
    const callback = await service.callback(nonce, browser.browserToken, 'code')
    const completion = new URL(callback.location).searchParams.get('completion')!
    await service.complete(session, nonce, completion, verifier)
    return (await store.list('owner')).find((row) => row.providerUserId === state.identity)!
  }
  return { repository, store, vault, session, state, tokens, provider, service, link }
}
test('OAuth verifies one-use state, browser binding, live wallet session, and encrypted token context', async () => {
  const f = await fixture()
  const start = await f.service.connect(f.session, 'x', challenge)
  const state = new URL(start.authorizationUrl).searchParams.get('state')!
  const browser = await f.service.begin(state)
  await assert.rejects(f.service.begin(state), /expired/)
  await assert.rejects(f.service.callback(state, 'different-browser', 'code'), /verified/)
  const callback = await f.service.callback(state, browser.browserToken, 'code')
  assert.equal((await f.store.list('owner')).length, 0)
  const completion = new URL(callback.location).searchParams.get('completion')!
  assert.ok(!JSON.stringify([...f.store.attempts.values()]).includes(completion))
  assert.ok(!JSON.stringify([...f.store.attempts.values()]).includes('access-secret'))
  await assert.rejects(f.service.callback(state, browser.browserToken, 'code'), /verified/)
  await f.service.complete(f.session, state, completion, verifier)
  await f.service.complete(f.session, state, completion, verifier)
  const [account] = await f.store.list('owner')
  assert.ok(!account.tokens.includes('access-secret'))
  assert.throws(() => f.vault.open(account.tokens, 'other-wallet:x:123'))
  assert.ok(!JSON.stringify(await f.service.list('owner')).includes('tokens'))
  const next = await f.service.connect(f.session, 'x', challenge)
  const nonce = new URL(next.authorizationUrl).searchParams.get('state')!
  const nextBrowser = await f.service.begin(nonce)
  await f.repository.revokeSession('session')
  await assert.rejects(f.service.callback(nonce, nextBrowser.browserToken, 'code'), /wallet/)
})
test('forwarded start URL cannot link victim X to attacker wallet; completion requires both app and callback browser secrets', async () => {
  const f = await fixture()
  const started = await f.service.connect(f.session, 'x', challenge)
  const browser = await f.service.begin(started.state) // Victim follows attacker's start URL.
  const callback = await f.service.callback(started.state, browser.browserToken, 'victim-x-code')
  const completion = new URL(callback.location).searchParams.get('completion')!
  const victimSession = { hash: 'victim-session', wallet: 'victim', expiresAt: Date.now() + 600000 }
  await f.repository.ensureProfile('victim')
  await f.repository.putSession(victimSession)
  assert.deepEqual((await f.service.list('owner')).accounts, [])
  // Attacker retains its verifier but never receives the callback-only secret.
  await assert.rejects(f.service.complete(f.session, started.state, 'x'.repeat(43), verifier), /verified/)
  // Victim receives the callback secret but cannot prove the initiating wallet/session or verifier.
  await assert.rejects(f.service.complete(victimSession, started.state, completion, verifier), /verified/)
  await assert.rejects(f.service.complete(f.session, started.state, completion, '2'.repeat(64)), /verified/)
  assert.equal((await f.store.list()).length, 0)
  const pending = [...f.store.attempts.values()][0]
  pending.expiresAt = Date.now() - 1
  await assert.rejects(f.service.complete(f.session, started.state, completion, verifier), /verified/)
  assert.equal((await f.store.list()).length, 0)
})
test('combined account limit, ownership, reconnect identity, protected accounts and disconnect', async () => {
  const f = await fixture()
  for (const id of ['1', '2', '3']) {
    f.state.identity = id
    await f.link()
  }
  await assert.rejects(f.service.connect(f.session, 'x', challenge), /three/)
  const [account] = await f.store.list('owner')
  f.state.identity = account.providerUserId
  await f.link(account.id)
  assert.equal((await f.store.list('owner')).length, 3)
  await assert.rejects(f.service.change('attacker', account.id, 'disconnect'), /not found/)
  await f.service.change('owner', account.id, 'pause')
  assert.equal((await f.store.get(account.id))?.status, 'paused')
  await f.service.change('owner', account.id, 'resume')
  assert.equal((await f.store.get(account.id))?.status, 'active')
  await f.service.change('owner', account.id, 'disconnect')
  assert.equal(await f.store.get(account.id), null)
  f.state.protected = true
  await assert.rejects(f.link(), /public/)
  await assert.rejects(f.service.connect(f.session, 'fomo', challenge), /awaiting/)
})
test('owned video import is deduplicated, unpublished until signed processing callback, and never launches a market', async () => {
  const f = await fixture()
  const account = await f.link()
  f.state.videos = [
    {
      id: '900',
      authorId: '123',
      caption: 'Owned video',
      url: 'https://video.twimg.com/ext_tw_video/clip.mp4',
      createdAt: new Date().toISOString(),
      sourceUrl: 'https://x.com/i/status/900',
    },
  ]
  await f.service.run()
  assert.equal(f.state.copies, 1)
  const [job] = [...f.store.imports.values()]
  assert.equal((await f.repository.listPosts()).length, 0)
  assert.equal(
    await f.service.webhook(
      { meta: { importId: 'unknown' }, duration: 90, readyToStream: true, status: { state: 'ready' } },
      uid,
    ),
    true,
  )
  assert.equal((await f.repository.listPosts()).length, 0)
  f.store.accounts.get(account.id)!.nextPollAt = 0
  await f.service.run()
  assert.equal(f.state.copies, 1)
  await f.service.webhook(
    {
      meta: { importId: job.id, postId: job.post.id, creator: 'owner' },
      duration: 20,
      readyToStream: true,
      status: { state: 'ready' },
    },
    uid,
  )
  const [post] = await f.repository.listPosts()
  assert.equal(post.caption, 'Owned video')
  assert.equal(post.market, null)
  assert.ok((await f.service.list('owner')).accounts[0].lastImportedAt)
  await f.service.change('owner', account.id, 'disconnect')
  assert.equal((await f.repository.listPosts()).length, 1)
})
test('ambiguous Cloudflare copy is not repeated; callback repairs lost response, overlong video remains hidden', async () => {
  const f = await fixture()
  const account = await f.link()
  f.state.uncertain = true
  f.state.videos = [
    {
      id: '901',
      authorId: '123',
      caption: 'Owned',
      url: 'https://video.twimg.com/clip.mp4',
      createdAt: new Date().toISOString(),
      sourceUrl: 'https://x.com/i/status/901',
    },
  ]
  await f.service.run()
  assert.equal(f.state.copies, 1)
  const [job] = [...f.store.imports.values()]
  assert.equal(job.state, 'needs_review')
  f.store.accounts.get(account.id)!.nextPollAt = 0
  await f.service.run()
  assert.equal(f.state.copies, 1)
  await f.service.webhook(
    {
      meta: { importId: job.id, postId: job.post.id, creator: 'owner' },
      duration: 61,
      readyToStream: true,
      status: { state: 'ready' },
    },
    uid,
  )
  assert.equal((await f.repository.getPost(job.post.id))?.status, 'failed')
  assert.equal((await f.repository.listPosts()).length, 0)
})
test('X adapter requests read-only PKCE scopes and excludes foreign, referenced, long and unsafe video sources', async () => {
  const requests: string[] = []
  const provider = new XProvider('client', 'secret', 'https://clout.example/callback', async (url) => {
    requests.push(String(url))
    return new Response(
      JSON.stringify({
        data: [
          {
            id: '1',
            author_id: '123',
            created_at: '2026-10-12T02:00:00Z',
            text: 'Own',
            attachments: { media_keys: ['m'] },
          },
          {
            id: '2',
            author_id: 'other',
            created_at: '2026-10-12T02:00:00Z',
            attachments: { media_keys: ['m'] },
          },
          {
            id: '3',
            author_id: '123',
            created_at: '2026-10-12T02:00:00Z',
            referenced_tweets: [{ type: 'retweeted' }],
            attachments: { media_keys: ['m'] },
          },
        ],
        includes: {
          media: [
            {
              media_key: 'm',
              type: 'video',
              duration_ms: 10000,
              variants: [
                { content_type: 'video/mp4', url: 'http://127.0.0.1/secret.mp4', bit_rate: 999999 },
                { content_type: 'video/mp4', url: 'https://video.twimg.com/clip.mp4', bit_rate: 1000 },
              ],
            },
          ],
        },
        meta: { newest_id: '3' },
      }),
      { status: 200 },
    )
  })
  const authorization = new URL(provider.authorizationUrl('state', 'challenge'))
  assert.equal(authorization.searchParams.get('scope'), 'tweet.read users.read offline.access')
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256')
  const page = await provider.videos('secret', '123', '2026-10-12T00:00:00Z')
  assert.deepEqual(
    page.videos.map((row) => row.id),
    ['1'],
  )
  assert.match(requests[0], /exclude=retweets%2Creplies/)
  for (const url of [
    'https://video.twimg.com.evil/clip.mp4',
    'https://user@video.twimg.com/clip.mp4',
    'file:///video.mp4',
  ])
    assert.equal(isXVideoUrl(url), false)
})
test('actual SQL enforces three combined links, global provider identity, private access and idempotent source imports', async () => {
  const db = new PGlite()
  try {
    await db.exec('create role anon; create role authenticated;')
    for (const file of ['20261013000133_clout_initial.sql', '20261013020605_linked_accounts.sql'])
      await db.exec(await readFile(new URL(`../../../supabase/migrations/${file}`, import.meta.url), 'utf8'))
    await db.exec("insert into public.profiles(wallet,data) values('owner','{}'),('other','{}')")
    for (let i = 0; i < 3; i++)
      await db.query(
        'insert into private.linked_accounts(id,wallet,provider,provider_user_id,data) values($1,$2,$3,$4,$5)',
        [randomUUID(), 'owner', i === 2 ? 'fomo' : 'x', String(i), {}],
      )
    await assert.rejects(
      db.query(
        'insert into private.linked_accounts(id,wallet,provider,provider_user_id,data) values($1,$2,$3,$4,$5)',
        [randomUUID(), 'owner', 'x', '4', {}],
      ),
      /three/,
    )
    await assert.rejects(
      db.query(
        'insert into private.linked_accounts(id,wallet,provider,provider_user_id,data) values($1,$2,$3,$4,$5)',
        [randomUUID(), 'other', 'x', '0', {}],
      ),
      /unique/,
    )
    await db.exec(
      "update private.linked_accounts set data='{" +
        '"pageToken":"old","pageNewestId":"9"' +
        "}'::jsonb; update private.linked_accounts set data=data || '{" +
        '"pageToken":null,"pageNewestId":null,"sinceId":"9"' +
        "}'::jsonb",
    )
    const cleared = await db.query<{ data: LinkedAccount }>('select data from private.linked_accounts')
    assert.equal(cleared.rows[0].data.pageToken, null)
    const args = [randomUUID(), randomUUID(), 'owner', 'x', 'source', randomUUID(), {}]
    await db.query(
      'insert into private.link_imports(id,account_id,wallet,provider,source_id,post_id,data) values($1,$2,$3,$4,$5,$6,$7)',
      args,
    )
    await assert.rejects(
      db.query(
        'insert into private.link_imports(id,account_id,wallet,provider,source_id,post_id,data) values($1,$2,$3,$4,$5,$6,$7)',
        [randomUUID(), ...args.slice(1)],
      ),
      /unique/,
    )
    await db.exec('set role authenticated')
    await assert.rejects(db.query('select * from private.linked_accounts'), /permission denied/)
    await assert.rejects(db.query('select * from private.link_oauth'), /permission denied/)
  } finally {
    await db.close()
  }
})

test('Postgres linked-store executes OAuth consumption, lease fencing, cursor clearing and transactional import binding', async () => {
  const db = new PGlite()
  const sql = Object.assign(
    async (parts: TemplateStringsArray, ...values: unknown[]) =>
      (
        await db.query(
          parts.reduce((query, part, index) => query + (index ? `$${index}` : '') + part, ''),
          values,
        )
      ).rows,
    {
      json: (value: unknown) => JSON.stringify(value),
      begin: async <T>(fn: (client: any) => Promise<T>) => {
        await db.exec('begin')
        try {
          const result = await fn(sql)
          await db.exec('commit')
          return result
        } catch (error) {
          await db.exec('rollback')
          throw error
        }
      },
    },
  )
  const store = new PostgresLinkedStore(sql as never)
  try {
    await db.exec('create role anon; create role authenticated;')
    for (const file of ['20261013000133_clout_initial.sql', '20261013020605_linked_accounts.sql'])
      await db.exec(await readFile(new URL(`../../../supabase/migrations/${file}`, import.meta.url), 'utf8'))
    await db.exec("insert into public.profiles(wallet,data) values('owner','{}')")
    const account: LinkedAccount = {
      id: randomUUID(),
      wallet: 'owner',
      provider: 'x',
      providerUserId: '123',
      handle: 'owner',
      displayName: 'Owner',
      status: 'active',
      tokens: 'ciphertext',
      createdAt: new Date().toISOString(),
      since: new Date().toISOString(),
      nextPollAt: 0,
      pageToken: 'old',
    }
    await store.connect(account)
    await store.putOAuth({
      hash: 'hash',
      wallet: 'owner',
      sessionHash: 'session',
      clientChallenge: challenge,
      secret: 'encrypted',
      expiresAt: Date.now() + 60000,
    })
    assert.ok(await store.beginOAuth('hash', 'browser', Date.now()))
    assert.equal(await store.consumeOAuth('hash', 'wrong', Date.now()), null)
    assert.ok(await store.consumeOAuth('hash', 'browser', Date.now()))
    assert.equal(await store.consumeOAuth('hash', 'browser', Date.now()), null)
    const proof = {
      hash: 'completion',
      wallet: 'owner',
      sessionHash: 'session',
      clientChallenge: challenge,
      completionHash: 'callback-secret-hash',
      now: Date.now(),
    }
    await store.putCompletion({
      ...proof,
      secret: '',
      expiresAt: Date.now() + 120000,
      grant: 'encrypted-grant',
    })
    assert.equal(await store.beginOAuth(proof.hash, 'browser', Date.now()), null)
    assert.equal(await store.consumeOAuth(proof.hash, 'browser', Date.now()), null)
    assert.equal(await store.getCompletion({ ...proof, completionHash: 'wrong' }), null)
    assert.equal(await store.finishCompletion({ ...proof, wallet: 'attacker' }, account), false)
    assert.equal(await store.finishCompletion(proof, account), true)
    assert.equal(await store.finishCompletion(proof, account), true)
    const receipt = await store.getCompletion(proof)
    assert.equal(receipt?.completedAccountId, account.id)
    assert.equal(receipt?.grant, undefined)
    assert.equal((await store.list('owner')).length, 1)
    const lease = await store.acquire(account.id, Date.now())
    assert.ok(lease?.leaseToken)
    assert.equal(await store.acquire(account.id, Date.now()), null)
    assert.equal(
      await store.save(account.id, lease!.leaseToken!, {
        pageToken: null,
        pageNewestId: null,
        sinceId: '900',
      }),
      true,
    )
    assert.equal((await store.get(account.id))?.pageToken, null)
    const job = {
      id: randomUUID(),
      accountId: account.id,
      wallet: 'owner',
      provider: 'x',
      sourceId: '900',
      videoUrl: 'https://video.twimg.com/clip.mp4',
      state: 'queued' as const,
      post: {
        id: randomUUID(),
        creatorWallet: 'owner',
        caption: 'Owned',
        videoUrl: null,
        thumbnailUrl: null,
        streamUid: null,
        status: 'processing' as const,
        createdAt: new Date().toISOString(),
        demo: false,
        tags: [],
        market: null,
      },
    }
    assert.equal(await store.reserve(job), true)
    assert.equal(await store.reserve({ ...job, id: randomUUID() }), false)
    assert.equal(await store.markSubmitting(job.id), true)
    assert.equal(await store.markSubmitting(job.id), false)
    assert.equal(await store.bind(job.id, uid), true)
    assert.equal((await store.jobByStream(uid))?.id, job.id)
    assert.equal(
      (
        await db.query<{ stream_uid: string }>('select stream_uid from public.posts where id=$1', [
          job.post.id,
        ])
      ).rows[0].stream_uid,
      uid,
    )
    await store.finish(job.id, 'ready')
    assert.ok((await store.get(account.id))?.lastImportedAt)
    await store.change(account.id, 'owner', 'pause')
    assert.equal(await store.save(account.id, lease!.leaseToken!, { tokens: 'stale-overwrite' }), false)
    await store.change(account.id, 'owner', 'disconnect')
    assert.equal(await store.get(account.id), null)
    assert.equal((await db.query('select id from public.posts')).rows.length, 1)
  } finally {
    await db.close()
  }
})
