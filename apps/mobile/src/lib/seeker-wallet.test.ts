import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import * as kit from '@solana/kit'
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

function transportHarness(platform: 'native' | 'web', returnedUri = policy.SEEKER_WALLET_URI) {
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
      return platform === 'native'
        ? {
            accounts: [{ address: kit.getBase64Decoder().decode(kit.getBase58Encoder().encode(address)) }],
            auth_token: authorization.authToken,
            wallet_uri_base: returnedUri,
          }
        : { accounts: [{ address }], authToken: authorization.authToken, walletUriBase: returnedUri }
    },
    signMessages: async () => {
      signatures++
      return [new Uint8Array(64)]
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
      if (name === 'react-native') return { Platform: { OS: 'android' } }
      if (name === '@solana/kit') return kit
      if (name === './seeker-wallet-policy') return policy
      if (name === '@solana-mobile/mobile-wallet-adapter-protocol-kit')
        return {
          transact: async (callback: (wallet: typeof fakeWallet) => unknown, config: unknown) => {
            launches.push([config])
            return callback(fakeWallet)
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
              return callback(fakeWallet)
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
  }
}

for (const platform of ['native', 'web'] as const) {
  test(`${platform} actual transport pins launch and devnet, rejects Fakewallet before signing`, async () => {
    const valid = transportHarness(platform)
    await valid.transport.signMessage(authorization, new Uint8Array([1, 2, 3]))
    assert.equal(valid.requests[0].chain, 'solana:devnet')
    assert.equal(valid.signatures(), 1)
    const [config, options] = valid.launches[0] as [
      { baseUri?: string; firstConnectWalletBaseUri?: string; chain?: string },
      { walletUriBase?: string }?,
    ]
    assert.equal(
      platform === 'native' ? config.baseUri : config.firstConnectWalletBaseUri,
      policy.SEEKER_WALLET_URI,
    )
    if (platform === 'web') {
      assert.equal(config.chain, 'solana:devnet')
      assert.equal(options?.walletUriBase, policy.SEEKER_WALLET_URI)
    }
    const fake = transportHarness(platform, 'https://fakewallet.example')
    await assert.rejects(fake.transport.signMessage(authorization, new Uint8Array([1])), /Only the Seeker/)
    assert.equal(fake.signatures(), 0)
    const stale = transportHarness(platform)
    await assert.rejects(
      stale.transport.authorize({ ...authorization, walletUriBase: 'solana-wallet:' }),
      /Only the Seeker/,
    )
    assert.equal(stale.launches.length, 0, 'untrusted cached URI never starts a session')
  })
}
