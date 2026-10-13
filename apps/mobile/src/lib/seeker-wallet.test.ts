import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import * as kit from '@solana/kit'
import { generateKeyPairSync, sign } from 'node:crypto'
import { AuthService } from '../../../api/src/auth'
import { MemoryRepository } from '../../../api/src/memory'
import type { WalletState } from './wallet-context'
import * as policy from './seeker-wallet-policy'
import type { SeekerTransport } from './seeker-wallet-provider'

const address = '11111111111111111111111111111111'
const authorization = {
  address,
  authToken: 'wallet-issued-test-token',
  walletUriBase: policy.SEEKER_WALLET_URI,
}

test('Seeker endpoint policy rejects lookalikes, generic schemes, missing endpoints and redirected paths', () => {
  for (const value of [
    undefined,
    '',
    'solana-wallet:',
    'https://fakewallet.example',
    'https://connect.solanamobile.com.evil.test',
    'http://connect.solanamobile.com',
    'https://user@connect.solanamobile.com',
    'https://connect.solanamobile.com:8443',
    'https://connect.solanamobile.com/other',
    'https://connect.solanamobile.com/?wallet=fake',
    'https://connect.solanamobile.com/#fake',
  ]) {
    assert.throws(() => policy.assertSeekerWalletUri(value), /Only the Seeker/)
  }
  policy.assertSeekerWalletUri(policy.SEEKER_WALLET_URI)
  policy.assertSeekerWalletUri(`${policy.SEEKER_WALLET_URI}/`)
  assert.deepEqual(policy.validateSeekerAuthorization(authorization), authorization)
  assert.throws(() => policy.validateSeekerAuthorization({ ...authorization, address: 'bad' }))
  assert.throws(
    () => policy.validateSeekerAuthorization(authorization, 'different-wallet'),
    /account changed/,
  )
})

test('authentication rejects a wallet signature over a changed or truncated challenge', () => {
  const message = new TextEncoder().encode('single-use server challenge')
  const signature = new Uint8Array(64).fill(3)
  assert.deepEqual(policy.signedMessageParts(signature, message), { signedMessage: message, signature })
  assert.deepEqual(policy.signedMessageParts(new Uint8Array([...message, ...signature]), message), {
    signedMessage: message,
    signature,
  })
  assert.throws(() => policy.signedMessageParts(new Uint8Array(63), message), /invalid/)
  const changed = new Uint8Array([...message, ...signature])
  changed[0] ^= 1
  assert.throws(() => policy.signedMessageParts(changed, message), /different message/)
})

type HarnessOptions = {
  returnedUri?: string | null
  address?: string
  gate?: 'missing' | 'old' | 'rejected'
  authorizeErrors?: unknown[]
  signError?: unknown
  signer?: (message: Uint8Array) => Uint8Array
}
function transportHarness(platform: 'native' | 'web', options: HarnessOptions = {}) {
  const returnedUri =
    options.returnedUri === null ? undefined : (options.returnedUri ?? policy.SEEKER_WALLET_URI)
  const walletAddress = options.address ?? address
  const storage = new Map<string, string>()
  const deleted: string[] = []
  const authorizeErrors = [...(options.authorizeErrors ?? [])]
  let active = false
  let gateChecks = 0
  const relative = `src/lib/wallet${platform === 'native' ? '.native' : ''}.tsx`
  const path = [resolve(relative), resolve('apps/mobile', relative)].find(existsSync)
  assert.ok(path)
  const source = ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  }).outputText
  const launches: unknown[][] = []
  const requests: Record<string, unknown>[] = []
  let signatures = 0
  const fakeWallet = {
    authorize: async (request: Record<string, unknown>) => {
      requests.push(request)
      const failure = authorizeErrors.shift()
      if (failure) throw failure
      return platform === 'native'
        ? {
            accounts: [
              { address: kit.getBase64Decoder().decode(kit.getBase58Encoder().encode(walletAddress)) },
            ],
            auth_token: authorization.authToken,
            wallet_uri_base: returnedUri,
          }
        : {
            accounts: [{ address: walletAddress }],
            authToken: authorization.authToken,
            walletUriBase: returnedUri,
          }
    },
    signMessages: async (request: { addresses: string[]; payloads: Uint8Array[] }) => {
      signatures++
      assert.equal(active, true, 'signing occurs before association closes')
      assert.equal(
        request.addresses[0],
        platform === 'native'
          ? kit.getBase64Decoder().decode(kit.getBase58Encoder().encode(walletAddress))
          : walletAddress,
      )
      if (options.signError) throw options.signError
      const message = request.payloads[0]
      return [options.signer ? new Uint8Array([...message, ...options.signer(message)]) : new Uint8Array(64)]
    },
    signTransactions: async () => {
      signatures++
      return [new Uint8Array(64)]
    },
  }
  const exports: Record<string, unknown> = {}
  runInNewContext(source, {
    exports,
    module: { exports },
    process: { env: {} },
    Uint8Array,
    Promise,
    Error,
    navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 16; Seeker)' },
    window: {
      location: { origin: 'https://clout.test' },
      sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    },
    require: (name: string) => {
      if (name === 'react') return { useMemo: (create: () => unknown) => create() }
      if (name === 'react/jsx-runtime') return { jsx: (_type: unknown, props: unknown) => ({ props }) }
      if (name === 'react-native')
        return {
          Platform: { OS: 'android' },
          NativeModules: {
            CloutSeekerWallet:
              options.gate === 'missing'
                ? undefined
                : {
                    routingPolicy: options.gate === 'old' ? 'old-policy' : 'seeker-certified-v1',
                    assertAvailable: async () => {
                      gateChecks++
                      if (options.gate === 'rejected')
                        throw Object.assign(new Error('No certified Seeker wallet'), {
                          code: 'CLOUT_SEEKER_WALLET_REQUIRED',
                        })
                    },
                  },
          },
        }
      if (name === 'expo-secure-store')
        return {
          getItemAsync: async (key: string) => storage.get(key) ?? null,
          setItemAsync: async (key: string, value: string) => {
            storage.set(key, value)
          },
          deleteItemAsync: async (key: string) => {
            deleted.push(key)
            storage.delete(key)
          },
        }
      if (name === '@solana/kit') return kit
      if (name === './seeker-wallet-policy') return policy
      if (name === '@solana-mobile/mobile-wallet-adapter-protocol-kit')
        return {
          transact: async (callback: (wallet: typeof fakeWallet) => unknown, config: unknown) => {
            launches.push([config])
            active = true
            try {
              return await callback(fakeWallet)
            } finally {
              active = false
            }
          },
        }
      if (name === '@solana-mobile/seeker-connect-web')
        return {
          createNostrSeekerLink: () => ({
            transact: async (
              config: unknown,
              callback: (wallet: typeof fakeWallet) => unknown,
              options: unknown,
            ) => {
              launches.push([config, options])
              active = true
              try {
                return await callback(fakeWallet)
              } finally {
                active = false
              }
            },
          }),
        }
      return {}
    },
  })
  const component = exports.WalletProvider as (props: { children: null }) => {
    props: { transport: SeekerTransport }
  }
  return {
    transport: component({ children: null }).props.transport,
    launches,
    requests,
    signatures: () => signatures,
    active: () => active,
    gateChecks: () => gateChecks,
    storage,
    deleted,
  }
}

const nativeAuthorization = { ...authorization, walletUriBase: policy.SEEKER_NATIVE_SOURCE }

test('native transport uses only guarded standard association and ignores optional returned URI metadata', async () => {
  for (const returnedUri of [null, 'https://other.example/path', policy.SEEKER_WALLET_URI]) {
    const native = transportHarness('native', { returnedUri })
    const result = await native.transport.signMessage(nativeAuthorization, new Uint8Array([1, 2, 3]))
    assert.equal(native.requests[0].chain, 'solana:devnet')
    assert.equal(native.gateChecks(), 1)
    assert.equal(native.launches[0][0], undefined, 'no wallet-returned or generic chooser baseUri')
    assert.equal(result.authorization.walletUriBase, policy.SEEKER_NATIVE_SOURCE)
    assert.equal(native.signatures(), 1)
  }
  const stale = transportHarness('native')
  await assert.rejects(stale.transport.authorize(authorization), /Only the Seeker/)
  assert.equal(stale.launches.length, 0, 'old web-URI native cache never opens an association')
  assert.throws(() => policy.validateSeekerAuthorization(nativeAuthorization), /Only the Seeker/)
})

test('native transport refuses missing, outdated, or rejected package guard before any wallet launch', async () => {
  for (const gate of ['missing', 'old', 'rejected'] as const) {
    const native = transportHarness('native', { gate })
    await assert.rejects(native.transport.authorize(), /latest Clout APK|certified Seeker/)
    assert.equal(native.launches.length, 0)
    assert.equal(native.requests.length, 0)
  }
})

test('web transport still pins official origin and rejects redirected wallet metadata before signing', async () => {
  const valid = transportHarness('web')
  await valid.transport.signMessage(authorization, new Uint8Array([1, 2, 3]))
  assert.equal(valid.requests[0].chain, 'solana:devnet')
  const [config, options] = valid.launches[0] as [
    { firstConnectWalletBaseUri: string; chain: string },
    { walletUriBase: string },
  ]
  assert.equal(config.firstConnectWalletBaseUri, policy.SEEKER_WALLET_URI)
  assert.equal(config.chain, 'solana:devnet')
  assert.equal(options.walletUriBase, policy.SEEKER_WALLET_URI)
  const fake = transportHarness('web', { returnedUri: 'https://fakewallet.example' })
  await assert.rejects(fake.transport.signMessage(authorization, new Uint8Array([1])), /Only the Seeker/)
  assert.equal(fake.signatures(), 0)
  await assert.rejects(valid.transport.authorize(nativeAuthorization), /Only the Seeker/)
})

test('native cached authorization retries exactly once only for explicit token rejection', async () => {
  for (const failure of [
    Object.assign(new Error('expired'), { code: -1 }),
    Object.assign(new Error('expired'), { code: 'JSON_RPC_ERROR', userInfo: { jsonRpcErrorCode: -1 } }),
  ]) {
    const native = transportHarness('native', { authorizeErrors: [failure] })
    await native.transport.authorize(nativeAuthorization)
    assert.equal(native.launches.length, 1)
    assert.equal(native.requests.length, 2)
    assert.equal(native.requests[0].auth_token, authorization.authToken)
    assert.equal('auth_token' in native.requests[1], false)
    assert.deepEqual(native.deleted, [policy.SEEKER_STORAGE_KEY])
  }
  for (const code of ['ERROR_SESSION_CANCELLED', 'ERROR_ASSOCIATION_TIMEOUT', -3, -100]) {
    const native = transportHarness('native', {
      authorizeErrors: [Object.assign(new Error('stop'), { code })],
    })
    await assert.rejects(native.transport.authorize(nativeAuthorization), /stop/)
    assert.equal(native.requests.length, 1)
  }
  const fresh = transportHarness('native', {
    authorizeErrors: [Object.assign(new Error('rejected'), { code: -1 })],
  })
  await assert.rejects(fresh.transport.authorize(), /rejected/)
  assert.equal(fresh.requests.length, 1, 'a first authorization rejection is not retried')
  const signing = transportHarness('native', {
    signError: Object.assign(new Error('signature rejected'), { code: -1 }),
  })
  await assert.rejects(
    signing.transport.signMessage(nativeAuthorization, new Uint8Array([1])),
    /signature rejected/,
  )
  assert.equal(signing.requests.length, 1)
  assert.equal(signing.signatures(), 1, 'signatures are never retried')
})

function providerHarness(
  transport: SeekerTransport,
  backend: {
    config?: unknown
    configError?: Error
    post: (path: string, body: Record<string, unknown>) => Promise<unknown>
  },
) {
  const path = [
    resolve('src/lib/seeker-wallet-provider.tsx'),
    resolve('apps/mobile/src/lib/seeker-wallet-provider.tsx'),
  ].find(existsSync)
  assert.ok(path)
  const source = ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  }).outputText
  const slots: unknown[] = []
  const pendingEffects: (() => void)[] = []
  let cursor = 0
  let token: string | undefined
  let invalidation: (() => void) | undefined
  let configReads = 0
  const exported: Record<string, unknown> = {}
  runInNewContext(source, {
    exports: exported,
    module: { exports: exported },
    process: { env: {} },
    Uint8Array,
    TextEncoder,
    AbortSignal,
    Date,
    Error,
    JSON,
    Promise,
    setTimeout,
    clearTimeout,
    require: (name: string) => {
      if (name === 'react')
        return {
          useState: (initial?: unknown) => {
            const index = cursor++
            if (!(index in slots)) slots[index] = initial
            return [
              slots[index],
              (value: unknown) => {
                slots[index] = value
              },
            ]
          },
          useRef: (initial: unknown) => {
            const index = cursor++
            if (!(index in slots)) slots[index] = { current: initial }
            return slots[index]
          },
          useEffect: (effect: () => unknown) => {
            const index = cursor++
            if (!(index in slots)) {
              slots[index] = true
              pendingEffects.push(() => {
                effect()
              })
            }
          },
        }
      if (name === 'react/jsx-runtime') return { jsx: (_type: unknown, props: unknown) => ({ props }) }
      if (name === '@solana/kit') return kit
      if (name === './seeker-wallet-policy') return policy
      if (name === './wallet-context') return { WalletContext: { Provider: {} } }
      if (name === './api')
        return {
          API_URL: 'http://127.0.0.1:8787',
          api: async (path: string, options: { signal: AbortSignal }) => {
            assert.equal(path, '/v1/config')
            assert.ok(options.signal instanceof AbortSignal)
            configReads++
            if (backend.configError) throw backend.configError
            return backend.config ?? { name: 'Clout', mode: 'connected', network: 'devnet' }
          },
          postJson: backend.post,
          setSessionToken: (value?: string) => {
            token = value
          },
          onSessionInvalidated: (callback: () => void) => {
            invalidation = callback
            return () => {}
          },
        }
      return {}
    },
  })
  const component = exported.SeekerWalletProvider as (props: {
    transport: SeekerTransport
    children: null
  }) => { props: { value: WalletState } }
  const render = () => {
    cursor = 0
    const state = component({ transport, children: null }).props.value
    while (pendingEffects.length) pendingEffects.shift()!()
    return state
  }
  return { render, token: () => token, invalidate: () => invalidation?.(), configReads: () => configReads }
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

test('native login signs a real API challenge in one association and restores only the verified v2 session', async () => {
  const keys = generateKeyPairSync('ed25519')
  const walletAddress = kit
    .getBase58Decoder()
    .decode(keys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32))
  const repo = new MemoryRepository(false)
  const auth = new AuthService(repo, 'http://127.0.0.1:8787')
  const native = transportHarness('native', {
    returnedUri: null,
    address: walletAddress,
    signer: (message) => sign(null, message, keys.privateKey),
  })
  let verification: Record<string, unknown> | undefined
  const backend = {
    post: async (path: string, body: Record<string, unknown>) => {
      if (path === '/v1/auth/challenge') {
        assert.equal(native.active(), true, 'API challenge is requested inside the same native association')
        return auth.issue(body.address)
      }
      assert.equal(path, '/v1/auth/verify')
      assert.equal(native.active(), false, 'wallet association closes before API verification')
      verification = body
      return auth.verify(body)
    },
  }
  const provider = providerHarness(native.transport, backend)
  provider.render()
  await tick()
  await provider.render().connect()
  assert.equal(native.launches.length, 1)
  assert.equal(native.requests.length, 1)
  assert.equal(native.signatures(), 1)
  assert.equal(provider.configReads(), 1)
  assert.equal(provider.render().address, walletAddress)
  assert.equal((await auth.session(`Bearer ${provider.token()}`))?.wallet, walletAddress)
  assert.ok(verification)
  assert.match(
    Buffer.from(verification.signedMessage as string, 'base64').toString(),
    /Chain ID: solana:devnet/,
  )
  await assert.rejects(auth.verify(verification), /already used/)
  const stored = JSON.parse(native.storage.get(policy.SEEKER_STORAGE_KEY)!)
  assert.equal(stored.policy, 'clout-seeker-wallet-v2')
  assert.equal(stored.authorization.walletUriBase, policy.SEEKER_NATIVE_SOURCE)
  const restored = providerHarness(native.transport, backend)
  restored.render()
  await tick()
  assert.equal(restored.render().address, walletAddress)
  assert.equal(
    native.launches.length,
    1,
    'restart restores authenticated session without another wallet launch',
  )
})

test('native API preflight blocks unreachable, demo, and wrong-chain servers before wallet launch', async () => {
  for (const backend of [
    { configError: new Error('network unreachable') },
    { config: { name: 'Clout', mode: 'demo', network: 'devnet' } },
    { config: { name: 'Clout', mode: 'connected', network: 'mainnet' } },
    { config: { name: 'Another app', mode: 'connected', network: 'devnet' } },
  ]) {
    const native = transportHarness('native')
    const provider = providerHarness(native.transport, {
      ...backend,
      post: async () => {
        throw new Error('No POST expected')
      },
    })
    provider.render()
    await tick()
    await assert.rejects(provider.render().connect(), (error: unknown) => {
      assert.equal(
        (error as { code: string }).code,
        'configError' in backend ? 'CLOUT_API_UNREACHABLE' : 'CLOUT_API_CONFIG_INVALID',
      )
      return true
    })
    assert.equal(native.launches.length, 0)
    assert.equal(provider.render().busy, false)
    assert.equal(provider.token(), undefined)
  }
})

test('cancelled fresh authorization clears a rejected token from memory before the next connect', async () => {
  const rejected = Object.assign(new Error('expired'), { code: -1 })
  const cancelled = Object.assign(new Error('cancelled'), { code: 'ERROR_SESSION_CANCELLED' })
  const native = transportHarness('native', { authorizeErrors: [rejected, cancelled] })
  native.storage.set(
    policy.SEEKER_STORAGE_KEY,
    JSON.stringify({ policy: policy.SEEKER_STORAGE_KEY, authorization: nativeAuthorization }),
  )
  const provider = providerHarness(native.transport, {
    post: async (path) =>
      path === '/v1/auth/challenge'
        ? { challengeId: 'id', message: 'challenge' }
        : { token: 'verified', expiresAt: new Date(Date.now() + 10000).toISOString(), profile: {} },
  })
  provider.render()
  await tick()
  await assert.rejects(provider.render().connect(), (error: unknown) => {
    assert.equal((error as { code: string }).code, 'ERROR_SESSION_CANCELLED')
    return true
  })
  assert.equal(native.storage.has(policy.SEEKER_STORAGE_KEY), false)
  assert.equal(provider.render().address, undefined)
  assert.equal(provider.token(), undefined)
  await provider.render().connect()
  assert.equal(native.requests.length, 3)
  assert.equal(native.requests[0].auth_token, authorization.authToken)
  assert.equal('auth_token' in native.requests[1], false)
  assert.equal(
    'auth_token' in native.requests[2],
    false,
    'next explicit connect does not reuse rejected in-memory token',
  )
})

test('interrupted API login retains a rotated native wallet token without exposing a session', async () => {
  const native = transportHarness('native')
  const provider = providerHarness(native.transport, {
    post: async () => {
      throw new Error('API interruption')
    },
  })
  provider.render()
  await tick()
  await assert.rejects(provider.render().connect(), /API interruption/)
  const stored = JSON.parse(native.storage.get(policy.SEEKER_STORAGE_KEY)!)
  assert.equal(stored.authorization.authToken, authorization.authToken)
  assert.equal(stored.session, undefined)
  assert.equal(provider.render().address, undefined)
  assert.equal(provider.token(), undefined)
  assert.equal(native.signatures(), 0)
  assert.equal(native.active(), false)
})
