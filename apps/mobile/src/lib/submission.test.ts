import test from 'node:test'
import assert from 'node:assert/strict'
import { persistThenBroadcast } from './submission'
test('does not broadcast while recovery storage is still pending', async () => {
  let release!: () => void
  const persisted = new Promise<void>((resolve) => {
    release = resolve
  })
  let broadcasts = 0
  const result = persistThenBroadcast({
    sign: async () => ({ signature: 'known-before-send' }),
    signature: (tx) => tx.signature,
    persist: () => persisted,
    broadcast: async () => {
      broadcasts++
    },
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(broadcasts, 0)
  release()
  assert.equal(await result, 'known-before-send')
  assert.equal(broadcasts, 1)
})
test('storage failure prevents any network submission', async () => {
  let broadcasts = 0
  await assert.rejects(
    persistThenBroadcast({
      sign: async () => 'signature',
      signature: (tx) => tx,
      persist: async () => {
        throw new Error('disk full')
      },
      broadcast: async () => {
        broadcasts++
      },
    }),
    /disk full/,
  )
  assert.equal(broadcasts, 0)
})
test('uncertain RPC outcome keeps the exact persisted signature for recovery', async () => {
  let recovery: string | undefined
  await assert.rejects(
    persistThenBroadcast({
      sign: async () => 'signed-transaction',
      signature: () => 'known-signature',
      persist: async (signature) => {
        recovery = signature
      },
      broadcast: async () => {
        throw new Error('RPC timed out after submission')
      },
    }),
    /RPC timed out/,
  )
  assert.equal(recovery, 'known-signature')
})
test('wallet cancellation neither persists nor submits a transaction', async () => {
  let persisted = false
  let sent = false
  await assert.rejects(
    persistThenBroadcast({
      sign: async () => {
        throw new Error('cancelled')
      },
      signature: () => '',
      persist: async () => {
        persisted = true
      },
      broadcast: async () => {
        sent = true
      },
    }),
    /cancelled/,
  )
  assert.equal(persisted, false)
  assert.equal(sent, false)
})
