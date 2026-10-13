import { useMemo, type PropsWithChildren } from 'react'
import { getBase64Encoder, getBase64EncodedWireTransaction, getTransactionDecoder } from '@solana/kit'
import { SeekerWalletProvider, type SeekerTransport } from './seeker-wallet-provider'
import {
  SEEKER_CHAIN,
  SEEKER_STORAGE_KEY,
  SEEKER_WALLET_URI,
  validateSeekerAuthorization,
  type SeekerAuthorization,
} from './seeker-wallet-policy'
import type { SeekerWallet } from '@solana-mobile/seeker-connect-web'
export { useWallet } from './wallet-context'

async function withSeeker<T>(
  previous: SeekerAuthorization | undefined,
  callback: (wallet: SeekerWallet, authorization: SeekerAuthorization) => Promise<T>,
) {
  if (previous) validateSeekerAuthorization(previous)
  // Load the web-only SDK on interaction; desktop remains a read-only preview.
  const { createNostrSeekerLink } = await import('@solana-mobile/seeker-connect-web')
  return createNostrSeekerLink().transact(
    {
      identity: { name: 'Clout', uri: window.location.origin },
      chain: SEEKER_CHAIN,
      relayDomain: 'relay.solanamobile.com',
      firstConnectWalletBaseUri: SEEKER_WALLET_URI,
      associationTimeoutMs: 30000,
    },
    async (wallet) => {
      const result = await wallet.authorize({
        chain: SEEKER_CHAIN,
        ...(previous ? { authToken: previous.authToken } : {}),
      })
      const account = result.accounts[0]
      if (!account) throw new Error('The Seeker wallet did not authorize an account.')
      const authorization = validateSeekerAuthorization(
        { address: account.address, authToken: result.authToken, walletUriBase: result.walletUriBase },
        previous?.address,
      )
      return callback(wallet, authorization)
    },
    { walletUriBase: SEEKER_WALLET_URI },
  )
}
export function WalletProvider({ children }: PropsWithChildren) {
  const transport = useMemo<SeekerTransport>(() => {
    // A presentation check only. Wallet routing is pinned independently; UA is
    // never sent to the server as proof of a Seeker device.
    const available = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent)
    return {
      native: false,
      available,
      unavailableReason: available
        ? undefined
        : 'Open Clout in the browser on your Seeker. Desktop browsing is read-only.',
      read: async () => window.sessionStorage.getItem(SEEKER_STORAGE_KEY),
      write: async (value) => {
        window.sessionStorage.setItem(SEEKER_STORAGE_KEY, value)
      },
      clear: async () => {
        window.sessionStorage.removeItem(SEEKER_STORAGE_KEY)
      },
      authorize: (previous) => withSeeker(previous, async (_wallet, authorization) => authorization),
      signMessage: (previous, message) =>
        withSeeker(previous, async (wallet, authorization) => {
          const [payload] = await wallet.signMessages({
            addresses: [authorization.address],
            payloads: [message],
          })
          if (!payload) throw new Error('The Seeker wallet did not return a signature.')
          return { authorization, payload }
        }),
      signTransaction: (previous, transaction) =>
        withSeeker(previous, async (wallet, authorization) => {
          const [bytes] = await wallet.signTransactions({
            payloads: [
              new Uint8Array(getBase64Encoder().encode(getBase64EncodedWireTransaction(transaction))),
            ],
          })
          if (!bytes) throw new Error('The Seeker wallet did not return a signed transaction.')
          return { authorization, transaction: getTransactionDecoder().decode(bytes) }
        }),
    }
  }, [])
  return <SeekerWalletProvider transport={transport}>{children}</SeekerWalletProvider>
}
