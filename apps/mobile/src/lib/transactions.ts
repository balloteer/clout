import AsyncStorage from '@react-native-async-storage/async-storage'
import { postJson } from './api'
import type { WalletState } from './wallet-context'
export type BuiltIntent = { intentId: string; transactionBase64: string; simulation: { slot: number } }
export type PendingTransaction = {
  intentId: string
  signature: string
  owner: string
  postId?: string
  description?: string
}
export type TransactionResult = { status: 'confirmed' | 'pending' | 'failed' | 'expired'; signature: string }
const key = (owner: string) => `clout:pending-trade:${owner}`
const activeOwners = new Set<string>()
export async function getPending(owner: string): Promise<PendingTransaction | null> {
  const raw = await AsyncStorage.getItem(key(owner))
  if (!raw) return null
  const record = JSON.parse(raw) as PendingTransaction
  if (record.owner !== owner || !record.signature || !record.intentId)
    throw new Error('Saved transaction data could not be read. Check wallet activity before proceeding.')
  return record
}
export async function confirmPending(owner: string): Promise<TransactionResult> {
  return withOwnerLock(owner, () => confirmPendingUnlocked(owner))
}
async function withOwnerLock<T>(owner: string, run: () => Promise<T>): Promise<T> {
  if (activeOwners.has(owner)) throw new Error('A wallet request is already in progress.')
  activeOwners.add(owner)
  try {
    return await run()
  } finally {
    activeOwners.delete(owner)
  }
}
async function confirmPendingUnlocked(owner: string): Promise<TransactionResult> {
  const pending = await getPending(owner)
  if (!pending) throw new Error('There is no transaction waiting for confirmation.')
  const result = await postJson<TransactionResult>(`/v1/transactions/${pending.intentId}/confirm`, {
    signature: pending.signature,
  })
  if (['confirmed', 'failed', 'expired'].includes(result.status)) await AsyncStorage.removeItem(key(owner))
  return { ...result, signature: pending.signature }
}
export async function executeIntent(
  built: BuiltIntent,
  wallet: WalletState,
  description = 'Wallet transaction',
): Promise<TransactionResult> {
  if (!wallet.address) throw new Error('Connect your wallet first.')
  const owner = wallet.address
  return withOwnerLock(owner, async () => {
    if (await getPending(owner))
      throw new Error('A previous transaction still needs confirmation. Check it before submitting another.')
    await wallet.send(built.transactionBase64, built.simulation.slot, async (signature) => {
      await AsyncStorage.setItem(
        key(owner),
        JSON.stringify({
          intentId: built.intentId,
          signature,
          owner,
          description,
        } satisfies PendingTransaction),
      )
    })
    return await confirmPendingUnlocked(owner)
  })
}
