import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import type { WalletState } from './wallet-context'

// Exercise the actual native helper with deterministic storage and HTTP, without loading native modules.
function harness() {
  const file = ['src/lib/transactions.ts', 'apps/mobile/src/lib/transactions.ts']
    .map((file) => resolve(file))
    .find(existsSync)
  assert.ok(file)
  const source = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText
  const saved = new Map<string, string>()
  const requests: {
    path: string
    finish: (result: { status: string }) => void
    fail: (error: Error) => void
  }[] = []
  const exported = {}
  runInNewContext(source, {
    exports: exported,
    module: { exports: exported },
    Set,
    JSON,
    Error,
    require: (name: string) =>
      name.includes('async-storage')
        ? {
            getItem: async (key: string) => saved.get(key) ?? null,
            setItem: async (key: string, value: string) => {
              saved.set(key, value)
            },
            removeItem: async (key: string) => {
              saved.delete(key)
            },
          }
        : {
            postJson: (path: string) =>
              new Promise((finish, fail) => {
                requests.push({ path, finish, fail })
              }),
          },
  })
  const transactions = exported as typeof import('./transactions')
  const seed = (owner: string, intentId: string) =>
    saved.set(
      `clout:pending-trade:${owner}`,
      JSON.stringify({ owner, intentId, signature: `sig-${intentId}` }),
    )
  return { ...transactions, saved, requests, seed }
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

test('late recovery cannot clear a newer signed transaction across different screens', async () => {
  const tx = harness()
  tx.seed('wallet', 'A')
  const first = tx.confirmPending('wallet')
  await tick()
  await assert.rejects(tx.confirmPending('wallet'), /already in progress/)
  assert.equal(tx.requests.length, 1, 'second screen cannot send a concurrent confirmation')
  tx.requests[0].finish({ status: 'confirmed' })
  await first

  let releaseBroadcast!: () => void
  const broadcast = new Promise<void>((resolve) => {
    releaseBroadcast = resolve
  })
  const wallet: WalletState = {
    address: 'wallet',
    busy: false,
    native: true,
    connectAvailable: true,
    seeker: false,
    connect: async () => {},
    disconnect: async () => {},
    send: async (_bytes, _slot, persist) => {
      await persist('sig-B')
      await broadcast
      return 'sig-B'
    },
  }
  const second = tx.executeIntent(
    { intentId: 'B', transactionBase64: 'unsigned', simulation: { slot: 10 } },
    wallet,
  )
  await tick()
  assert.equal((await tx.getPending('wallet'))?.intentId, 'B')
  await assert.rejects(tx.confirmPending('wallet'), /already in progress/)
  assert.equal((await tx.getPending('wallet'))?.intentId, 'B', 'signed recovery survives late UI actions')
  releaseBroadcast()
  await tick()
  tx.requests[1].finish({ status: 'pending' })
  await second
  assert.equal((await tx.getPending('wallet'))?.intentId, 'B')
  const confirmed = tx.confirmPending('wallet')
  await tick()
  tx.requests[2].finish({ status: 'confirmed' })
  await confirmed
  assert.equal(await tx.getPending('wallet'), null)
})

test('RPC failure preserves recovery and releases only that wallet lock', async () => {
  const tx = harness()
  tx.seed('one', 'A')
  tx.seed('two', 'B')
  const first = tx.confirmPending('one')
  const other = tx.confirmPending('two')
  await tick()
  assert.equal(tx.requests.length, 2, 'unrelated wallets can independently recover')
  tx.requests[0].fail(new Error('RPC offline'))
  await assert.rejects(first, /RPC offline/)
  tx.requests[1].finish({ status: 'confirmed' })
  await other
  assert.equal((await tx.getPending('one'))?.intentId, 'A')
  const retry = tx.confirmPending('one')
  await tick()
  tx.requests[2].finish({ status: 'confirmed' })
  await retry
  assert.equal(await tx.getPending('one'), null)
})
