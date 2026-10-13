import { createContext, useContext } from 'react'
export type WalletState = {
  address?: string
  name?: string
  seeker: boolean
  busy: boolean
  native: boolean
  connectAvailable: boolean
  connectUnavailableReason?: string
  connect: () => Promise<void>
  disconnect: () => Promise<void>
  send: (
    transaction: string,
    minContextSlot: number,
    beforeBroadcast: (signature: string) => Promise<void>,
  ) => Promise<string>
}
export const WalletContext = createContext<WalletState | null>(null)
export function useWallet() {
  const value = useContext(WalletContext)
  if (!value) throw new Error('WalletProvider is missing')
  return value
}
