import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createHmac, generateKeyPairSync, sign } from 'node:crypto'
import { PublicKey } from '@solana/web3.js'
import { createApp, type AppOptions } from '../src/app.js'
import { RewardService } from '../src/rewards.js'
import { MemoryRepository } from '../src/memory.js'
import { FaucetService } from '../src/faucet.js'
import { LinkedAccountService } from '../src/linked-accounts.js'
import { MemoryLinkedStore } from '../src/linked-store.js'
import { TokenVault } from '../src/linked-provider.js'
import type { MarketService, BuiltTrade } from '@clout/markets'

async function fixture(
  markets?: MarketService,
  configure?: (repository: MemoryRepository) => Promise<Partial<AppOptions>>,
) {
  const repository = new MemoryRepository()
  // Keep HTTP unit fixtures independent from the verified live devnet registry.
  for (const post of repository.posts.values()) post.market = null
  const { server } = createApp({
    repository,
    origin: 'https://clout.example',
    mode: 'demo',
    webhookSecret: 'test-secret',
    markets,
    ...(await configure?.(repository)),
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Server did not listen')
  const url = `http://127.0.0.1:${address.port}`
  const request = async (path: string, init?: RequestInit) => {
    const response = await fetch(`${url}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init?.headers },
    })
    return { status: response.status, data: (await response.json()) as any }
  }
  const login = async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const wallet = new PublicKey(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)).toBase58()
    const { data: challenge } = await request('/v1/auth/challenge', {
      method: 'POST',
      body: JSON.stringify({ address: wallet }),
    })
    const { data } = await request('/v1/auth/verify', {
      method: 'POST',
      body: JSON.stringify({
        challengeId: challenge.challengeId,
        signedMessage: challenge.messageBase64,
        signature: sign(null, Buffer.from(challenge.message), privateKey).toString('base64'),
      }),
    })
    return { wallet, token: data.token as string, headers: { Authorization: `Bearer ${data.token}` } }
  }
  return {
    url,
    repository,
    request,
    login,
    close: () =>
      new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  }
}

test('HTTP feed, wallet sign-in, idempotent likes, comments, following and logout', async () => {
  const app = await fixture()
  try {
    const config = await app.request('/v1/config')
    assert.equal(config.data.slogan, 'Seek the best content, win SKR')
    assert.equal(config.data.features.trading, false)
    const feed = await app.request('/v1/feed')
    assert.equal(feed.status, 200)
    assert.equal(
      feed.data.posts.every((post: any) => post.demo && post.market === null),
      true,
    )
    const post = feed.data.posts[0]
    assert.equal((await app.request(`/v1/posts/${post.id}/likes`, { method: 'POST' })).status, 401)
    const login = await app.login()
    for (let i = 0; i < 2; i++)
      assert.equal(
        (await app.request(`/v1/posts/${post.id}/likes`, { method: 'POST', headers: login.headers })).data
          .count,
        1,
      )
    const comment = await app.request(`/v1/posts/${post.id}/comments`, {
      method: 'POST',
      headers: login.headers,
      body: JSON.stringify({ body: 'Found it early.', wallet: 'forged-author' }),
    })
    assert.equal(comment.status, 201)
    assert.equal(comment.data.comments[0].wallet, login.wallet)
    assert.equal(comment.data.comments[0].earlyBacker, false)
    await app.request(`/v1/profiles/${post.creatorWallet}/follow`, { method: 'POST', headers: login.headers })
    assert.equal(
      (await app.request('/v1/feed?tab=following', { headers: login.headers })).data.posts.length,
      feed.data.posts.filter((item: { creatorWallet: string }) => item.creatorWallet === post.creatorWallet)
        .length,
    )
    const profile = await app.request('/v1/me', {
      method: 'PATCH',
      headers: login.headers,
      body: JSON.stringify({ displayName: 'Real person', seekerVerified: true }),
    })
    assert.equal(profile.data.profile.seekerVerified, false)
    assert.equal((await app.request('/v1/claims', { method: 'POST', headers: login.headers })).status, 503)
    const portfolio = await app.request('/v1/portfolio', { headers: login.headers })
    assert.equal(portfolio.data.balance, null)
    assert.deepEqual(portfolio.data.positions, [])
    await app.request('/v1/auth/logout', { method: 'POST', headers: login.headers })
    assert.equal((await app.request('/v1/me', { headers: login.headers })).status, 401)
  } finally {
    await app.close()
  }
})

test('HTTP rejects hostile origins, malformed JSON and unauthenticated uploads', async () => {
  const app = await fixture()
  try {
    assert.equal((await app.request('/v1/feed', { headers: { Origin: 'https://evil.example' } })).status, 403)
    assert.equal((await app.request('/v1/auth/challenge', { method: 'POST', body: '{broken' })).status, 400)
    assert.equal(
      (await app.request('/v1/uploads', { method: 'POST', body: JSON.stringify({ caption: 'test' }) }))
        .status,
      401,
    )
    assert.equal(
      (
        await app.request('/v1/auth/challenge', {
          method: 'POST',
          body: JSON.stringify({ address: 'x'.repeat(70000) }),
        })
      ).status,
      413,
    )
  } finally {
    await app.close()
  }
})

test('HTTP links require wallet ownership and disabled providers remain unavailable', async () => {
  const app = await fixture()
  try {
    assert.equal((await app.request('/v1/linked-accounts')).status, 401)
    const owner = await app.login()
    const links = await app.request('/v1/linked-accounts', { headers: owner.headers })
    assert.equal(links.data.limit, 3)
    assert.equal(links.data.providers.x.available, false)
    assert.deepEqual(links.data.accounts, [])
    assert.equal(
      (
        await app.request('/v1/linked-accounts/x/connect', {
          method: 'POST',
          headers: owner.headers,
          body: '{}',
        })
      ).status,
      503,
    )
    assert.equal((await app.request('/v1/faucet')).data.available, false)
    assert.equal((await app.request('/v1/faucet/claims', { method: 'POST', body: '{}' })).status, 401)
  } finally {
    await app.close()
  }
})

test('HTTP X callback hands off a browser-only secret; only the initiating app can finish, with replay-safe receipt', async () => {
  const app = await fixture(undefined, async (repository) => ({
    linkedAccounts: new LinkedAccountService(
      new MemoryLinkedStore(repository),
      repository,
      {
        authorizationUrl: (state, challenge) =>
          `https://x.com/i/oauth2/authorize?state=${state}&code_challenge=${challenge}`,
        exchange: async () => ({
          accessToken: 'private-access',
          refreshToken: 'private-refresh',
          expiresAt: Date.now() + 600000,
        }),
        refresh: async () => {
          throw new Error('unused')
        },
        identity: async () => ({ id: '123', handle: 'owner', displayName: 'Owner', protected: false }),
        videos: async () => ({ videos: [] }),
      },
      new TokenVault(Buffer.alloc(32, 7).toString('base64')),
      {
        issueUpload: async () => {
          throw new Error('unused')
        },
        copyVideo: async () => ({ uid: 'a'.repeat(32) }),
      },
      'https://clout.example',
    ),
  }))
  try {
    const owner = await app.login()
    const other = await app.login()
    const verifier = '1'.repeat(64)
    const clientChallenge = createHash('sha256').update(verifier).digest('hex')
    const started = await app.request('/v1/linked-accounts/x/connect', {
      method: 'POST',
      headers: owner.headers,
      body: JSON.stringify({ clientChallenge }),
    })
    assert.equal(started.status, 200)
    assert.ok(!JSON.stringify(started.data).includes('private-access'))
    assert.match(
      started.data.authorizationUrl,
      /^https:\/\/clout.example\/v1\/linked-accounts\/x\/start\?state=/,
    )
    assert.equal((await app.request('/v1/linked-accounts/x/callback?state=forged&code=forged')).status, 400)
    assert.deepEqual((await app.request('/v1/linked-accounts', { headers: other.headers })).data.accounts, [])
    const state = started.data.state
    const browser = await fetch(`${app.url}/v1/linked-accounts/x/start?state=${state}`, {
      redirect: 'manual',
    })
    assert.equal(browser.status, 302)
    assert.match(browser.headers.get('location')!, /^https:\/\/x.com\/i\/oauth2\/authorize/)
    const cookie = browser.headers.get('set-cookie')!.split(';')[0]
    const callback = await fetch(`${app.url}/v1/linked-accounts/x/callback?state=${state}&code=code`, {
      redirect: 'manual',
      headers: { Cookie: cookie },
    })
    assert.equal(callback.status, 302)
    assert.equal(callback.headers.get('cache-control'), 'no-store')
    assert.equal(callback.headers.get('referrer-policy'), 'no-referrer')
    const handoff = new URL(callback.headers.get('location')!)
    assert.equal(handoff.protocol, 'clout:')
    assert.equal(handoff.hostname, 'linked-accounts')
    assert.equal(handoff.searchParams.get('attempt'), state)
    assert.equal(handoff.searchParams.has('state'), false)
    assert.deepEqual((await app.request('/v1/linked-accounts', { headers: owner.headers })).data.accounts, [])
    const completion = handoff.searchParams.get('completion')!
    const completeBody = JSON.stringify({ state, completion, verifier })
    assert.equal(
      (
        await app.request('/v1/linked-accounts/x/complete', {
          method: 'POST',
          headers: other.headers,
          body: completeBody,
        })
      ).status,
      400,
    )
    for (let replay = 0; replay < 2; replay++)
      assert.deepEqual(
        (
          await app.request('/v1/linked-accounts/x/complete', {
            method: 'POST',
            headers: owner.headers,
            body: completeBody,
          })
        ).data,
        { ok: true },
      )
    const accounts = (await app.request('/v1/linked-accounts', { headers: owner.headers })).data.accounts
    assert.equal(accounts.length, 1)
    assert.ok(!JSON.stringify(accounts).includes('private-access'))
    assert.ok(!JSON.stringify(accounts).includes(completion))

    assert.equal(
      (
        await app.request('/v1/linked-accounts/00000000-0000-4000-8000-000000000001/disconnect', {
          method: 'POST',
          headers: other.headers,
          body: '{}',
        })
      ).status,
      404,
    )
  } finally {
    await app.close()
  }
})

test('HTTP faucet fixes amount and recipient, is idempotent and protects receipts', async () => {
  const app = await fixture(undefined, async (repository) => {
    const faucet = new FaucetService(
      repository,
      {
        id: 'faucet_http',
        period: 'utc-day',
        symbol: 'SKR',
        mint: 'mock',
        amount: '1000000000',
        maxClaims: 2,
        enabled: true,
        authority: 'authority',
        maxSupply: '2000000000',
      },
      6,
      {
        treasury: 'authority',
        quoteMint: 'mock',
        availableBalance: async () => '2000000000',
        validateBudget: async () => {},
        prepare: async ({ wallet }) => ({
          signedBase64: wallet,
          signature: wallet,
          lastValidBlockHeight: 100,
        }),
        submit: async (bytes) => bytes,
        reconcile: async () => 'pending',
      },
    )
    await faucet.initialize()
    return { faucet }
  })
  try {
    const owner = await app.login()
    const other = await app.login()
    assert.equal((await app.request('/v1/faucet', { headers: owner.headers })).data.available, true)
    assert.equal(
      (
        await app.request('/v1/faucet/claims', {
          method: 'POST',
          headers: owner.headers,
          body: JSON.stringify({ amount: '999', wallet: other.wallet }),
        })
      ).status,
      400,
    )
    const first = await app.request('/v1/faucet/claims', {
      method: 'POST',
      headers: owner.headers,
      body: '{}',
    })
    assert.equal(first.status, 200)
    assert.equal(first.data.state, 'submitted')
    assert.equal(first.data.amount, '1000000000')
    assert.match(first.data.day, /^\d{4}-\d{2}-\d{2}$/)
    const daily = (await app.request('/v1/faucet', { headers: owner.headers })).data
    assert.equal(daily.period, 'utc-day')
    assert.equal(daily.dailyLimit, '1000000000')
    assert.equal(daily.claimedAmount, '1000000000')
    assert.equal(daily.remainingAmount, '0')
    assert.match(daily.resetAt, /T00:00:00.000Z$/)
    assert.equal('signedTransaction' in first.data, false)
    assert.equal((await app.request('/v1/faucet', { headers: owner.headers })).data.available, false)
    assert.equal(
      (await app.request(`/v1/faucet/claims/${first.data.id}`, { headers: other.headers })).status,
      404,
    )
    assert.equal(
      (await app.request('/v1/faucet/claims', { method: 'POST', headers: owner.headers, body: '{}' })).data
        .id,
      first.data.id,
    )
  } finally {
    await app.close()
  }
})

test('only signed media callbacks publish posts; replay cannot regress ready status', async () => {
  const app = await fixture()
  try {
    const post = {
      ...app.repository.posts.get('big-buck-bunny')!,
      id: 'upload-test',
      streamUid: 'a'.repeat(32),
      status: 'processing' as const,
      demo: false,
    }
    await app.repository.insertPost(post)
    const payload = JSON.stringify({ uid: post.streamUid, status: { state: 'ready' }, readyToStream: true })
    assert.equal((await app.request('/v1/webhooks/stream', { method: 'POST', body: payload })).status, 401)
    assert.equal((await app.repository.getPost(post.id))?.status, 'processing')
    const time = Math.floor(Date.now() / 1000)
    const signature = createHmac('sha256', 'test-secret').update(`${time}.${payload}`).digest('hex')
    const valid = await app.request('/v1/webhooks/stream', {
      method: 'POST',
      headers: { 'Webhook-Signature': `time=${time},sig1=${signature}` },
      body: payload,
    })
    assert.equal(valid.status, 200)
    assert.equal((await app.repository.getPost(post.id))?.status, 'ready')
    await app.repository.updateStream(post.streamUid, 'failed', null, null)
    assert.equal((await app.repository.getPost(post.id))?.status, 'ready')
  } finally {
    await app.close()
  }
})

test('trade build retries return the persisted message and enforce wallet ownership', async () => {
  let builds = 0
  const markets = {
    buildTrade: async ({ owner, quoteId }: { owner: string; quoteId: string }) => {
      builds++
      await new Promise((resolve) => setTimeout(resolve, 10))
      return {
        owner,
        quoteId,
        id: `built-${builds}`,
        messageBase64: `message-${builds}`,
        transactionBase64: `tx-${builds}`,
        quote: { market: { postId: 'big-buck-bunny' } },
      } as BuiltTrade
    },
  } as MarketService
  const app = await fixture(markets)
  try {
    const owner = await app.login()
    const other = await app.login()
    const input = {
      method: 'POST',
      headers: owner.headers,
      body: JSON.stringify({ quoteId: 'persisted-quote' }),
    }
    const [a, b] = await Promise.all([
      app.request('/v1/trades/build', input),
      app.request('/v1/trades/build', input),
    ])
    assert.equal(a.status, 201)
    assert.equal(b.status, 201)
    assert.equal(a.data.messageBase64, b.data.messageBase64)
    const repeat = await app.request('/v1/trades/build', input)
    assert.equal(repeat.status, 200)
    assert.equal(repeat.data.messageBase64, a.data.messageBase64)
    assert.equal((await app.request('/v1/trades/build', { ...input, headers: other.headers })).status, 403)
  } finally {
    await app.close()
  }
})

test('HTTP quote, build and confirmation bind the wallet and record actual settlement once', async () => {
  let quote: any
  const markets = {
    quote: async (input: any) => {
      quote = {
        ...input,
        id: '00000000-0000-4000-8000-000000000001',
        market: { ...input.market, quoteMint: 'test-skr' },
        minimumAmountOut: '800',
        expectedAmountOut: '900',
      }
      return quote
    },
    buildTrade: async ({ owner, quoteId }: { owner: string; quoteId: string }) => {
      assert.equal(owner, quote.owner)
      assert.equal(quoteId, quote.id)
      return {
        owner,
        quoteId,
        quote,
        messageBase64: 'persisted-message',
        transactionBase64: 'unsigned',
        lastValidBlockHeight: 100,
      }
    },
    reconcileTrade: async ({ trade, signature }: any) => {
      assert.equal(trade.messageBase64, 'persisted-message')
      return {
        status: 'confirmed',
        signature,
        slot: 20,
        feeLamports: '5000',
        blockTime: 1,
        tokenDeltas: { 'post-token': '900', 'test-skr': '-100' },
      }
    },
  } as unknown as MarketService
  const app = await fixture(markets)
  try {
    const owner = await app.login()
    const other = await app.login()
    await app.repository.attachMarket('big-buck-bunny', { baseMint: 'post-token', dbcPool: 'pool' })
    const quoted = await app.request('/v1/posts/big-buck-bunny/quote', {
      method: 'POST',
      headers: owner.headers,
      body: JSON.stringify({ side: 'buy', amountIn: '100', slippageBps: 100, owner: other.wallet }),
    })
    assert.equal(quoted.status, 200)
    assert.equal(quoted.data.owner, owner.wallet)
    const built = await app.request('/v1/trades/build', {
      method: 'POST',
      headers: owner.headers,
      body: JSON.stringify({ quoteId: quoted.data.id }),
    })
    const signature = '1'.repeat(88)
    const submit = { method: 'POST', headers: owner.headers, body: JSON.stringify({ signature }) }
    assert.equal(
      (
        await app.request(`/v1/transactions/${built.data.intentId}/confirm`, {
          ...submit,
          headers: other.headers,
        })
      ).status,
      404,
    )
    for (let attempt = 0; attempt < 2; attempt++)
      assert.equal(
        (await app.request(`/v1/transactions/${built.data.intentId}/confirm`, submit)).data.status,
        'confirmed',
      )
    const events = await app.repository.getEvents(owner.wallet)
    assert.equal(events.length, 1)
    assert.equal(events[0].baseAmount, '900')
    assert.equal(events[0].quoteAmount, '100')
    const activity = await app.request('/v1/posts/big-buck-bunny/activity')
    assert.equal(activity.data.source, 'clout-transactions')
    assert.equal(activity.data.events.length, 1)
    assert.equal(activity.data.events[0].signature, signature)
    assert.equal('wallet' in activity.data.events[0], false)
    assert.deepEqual((await app.request('/v1/posts/sintel/activity')).data.events, [])
    assert.equal((await app.request('/v1/posts/missing/activity')).status, 404)
  } finally {
    await app.close()
  }
})

test('HTTP tip retries use stable bytes and reject reuse with changed payment details', async () => {
  let builds = 0
  const markets = {
    buildTip: async ({ owner, recipient, amountIn }: any) => {
      builds++
      return {
        owner,
        recipient,
        amountIn,
        messageBase64: `tip-${builds}`,
        transactionBase64: `unsigned-${builds}`,
        quoteMint: 'test-skr',
        quoteDecimals: 6,
      }
    },
  } as unknown as MarketService
  const app = await fixture(markets)
  try {
    const owner = await app.login()
    const recipient = await app.login()
    const details = {
      recipient: recipient.wallet,
      amountIn: '1000000',
      requestId: '00000000-0000-4000-8000-000000000002',
    }
    const request = { method: 'POST', headers: owner.headers, body: JSON.stringify(details) }
    const first = await app.request('/v1/tips/build', request)
    const retry = await app.request('/v1/tips/build', request)
    assert.equal(first.status, 201)
    assert.equal(retry.status, 200)
    assert.equal(first.data.intentId, retry.data.intentId)
    assert.equal(first.data.messageBase64, retry.data.messageBase64)
    assert.equal(builds, 1)
    assert.equal(
      (
        await app.request('/v1/tips/build', {
          ...request,
          body: JSON.stringify({ ...details, amountIn: '2000000' }),
        })
      ).status,
      409,
    )
  } finally {
    await app.close()
  }
})

test('HTTP configured reward claims are owner scoped, secret free and distinguish pending from paid', async () => {
  let rewards: RewardService
  let finalized = false
  const app = await fixture(undefined, async (repository) => {
    rewards = new RewardService(
      repository,
      { id: 'starter', symbol: 'SKR', mint: 'test-skr', amount: '1000000', maxClaims: 2, enabled: true },
      6,
      { check: async (wallet) => ({ hasSGT: true, mintAddress: `sgt-${wallet}` }) },
      {
        treasury: 'treasury',
        quoteMint: 'test-skr',
        validateBudget: async () => {},
        prepare: async () => ({
          signedBase64: 'secret-signed-bytes',
          signature: 'sig-1',
          lastValidBlockHeight: 100,
        }),
        submit: async () => 'sig-1',
        reconcile: async () => (finalized ? 'finalized' : 'pending'),
      },
    )
    await rewards.initialize()
    return { rewards }
  })
  try {
    const owner = await app.login()
    const stranger = await app.login()
    assert.equal((await app.request('/v1/config')).data.features.rewards, true)
    const available = await app.request('/v1/rewards/campaign')
    assert.equal(available.data.available, true)
    assert.equal(available.data.campaign.symbol, 'Test SKR')
    const response = await app.request('/v1/claims', {
      method: 'POST',
      headers: owner.headers,
      body: JSON.stringify({ campaignId: 'starter' }),
    })
    assert.equal(response.status, 200)
    assert.equal(response.data.state, 'submitted')
    assert.equal(
      (await app.request('/v1/rewards/campaign', { headers: owner.headers })).data.claim.id,
      response.data.id,
    )
    assert.equal((await app.request('/v1/rewards/campaign')).data.claim, null)
    assert.equal(JSON.stringify(response.data).includes('secret-signed-bytes'), false)
    assert.equal(
      (await app.request(`/v1/claims/${response.data.id}`, { headers: stranger.headers })).status,
      404,
    )
    finalized = true
    await rewards!.resume()
    assert.equal(
      (await app.request(`/v1/claims/${response.data.id}`, { headers: owner.headers })).data.state,
      'finalized',
    )
  } finally {
    await app.close()
  }
})

test('launch retries preserve canonical name and reject changed metadata', async () => {
  const markets = {
    buildLaunch: async ({ creator, ...input }: any) => ({
      ...input,
      owner: creator,
      messageBase64: 'launch',
      transactionBase64: 'launch-unsigned',
    }),
  } as MarketService
  const app = await fixture(markets)
  try {
    const owner = await app.login()
    await app.repository.insertPost({
      ...app.repository.posts.get('big-buck-bunny')!,
      id: 'own-post',
      creatorWallet: owner.wallet,
      demo: false,
    })
    const request = {
      method: 'POST',
      headers: owner.headers,
      body: JSON.stringify({ name: 'Original', symbol: 'OG' }),
    }
    const first = await app.request('/v1/posts/own-post/launch', request)
    assert.equal(first.status, 201)
    assert.equal(first.data.metadataUri, 'https://clout.example/v1/posts/own-post/metadata')
    assert.equal((await app.request('/v1/posts/own-post/launch', request)).data.intentId, first.data.intentId)
    assert.equal(
      (
        await app.request('/v1/posts/own-post/launch', {
          ...request,
          body: JSON.stringify({ name: 'Changed', symbol: 'NEW' }),
        })
      ).status,
      409,
    )
    assert.equal((await app.request('/v1/posts/own-post/metadata')).data.name, 'Original')
  } finally {
    await app.close()
  }
})
