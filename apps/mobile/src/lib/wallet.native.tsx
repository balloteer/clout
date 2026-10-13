import { type PropsWithChildren } from 'react'
import { Platform } from 'react-native'
import * as SecureStore from 'expo-secure-store'
import { transact, type KitMobileWallet } from '@solana-mobile/mobile-wallet-adapter-protocol-kit'
import { getBase58Decoder, getBase58Encoder, getBase64Decoder, getBase64Encoder } from '@solana/kit'
import { SeekerWalletProvider, type SeekerTransport } from './seeker-wallet-provider'
import {
  SEEKER_CHAIN,
  SEEKER_STORAGE_KEY,
  SEEKER_WALLET_URI,
  validateSeekerAuthorization,
  type SeekerAuthorization,
} from './seeker-wallet-policy'
export { useWallet } from './wallet-context'

const identity = {
  name: 'Clout',
  ...(process.env.EXPO_PUBLIC_APP_IDENTITY_URI ? { uri: process.env.EXPO_PUBLIC_APP_IDENTITY_URI } : {}),
}
async function withSeeker<T>(
  previous: SeekerAuthorization | undefined,
  callback: (wallet: KitMobileWallet, authorization: SeekerAuthorization) => Promise<T>,
) {
  if (previous) validateSeekerAuthorization(previous)
  return transact(
    async (wallet) => {
      const result = await wallet.authorize({
        identity,
        chain: SEEKER_CHAIN,
        ...(previous ? { auth_token: previous.authToken } : {}),
      })
      const account = result.accounts[0]
      if (!account) throw new Error('The Seeker wallet did not authorize an account.')
      const authorization = validateSeekerAuthorization(
        {
          address: getBase58Decoder().decode(getBase64Encoder().encode(account.address)),
          authToken: result.auth_token,
          walletUriBase: result.wallet_uri_base,
        },
        previous?.address,
      )
      return callback(wallet, authorization)
    },
    { baseUri: SEEKER_WALLET_URI },
  )
}
const transport: SeekerTransport = {
  native: true,
  available: Platform.OS === 'android',
  unavailableReason:
    Platform.OS === 'android'
      ? undefined
      : 'Open Clout on your Seeker. Only its built-in wallet can sign in.',
  read: async () => {
    // Previous generic-wallet sessions are never restored under this policy.
    await SecureStore.deleteItemAsync('clout-session')
    return SecureStore.getItemAsync(SEEKER_STORAGE_KEY)
  },
  write: (value) => SecureStore.setItemAsync(SEEKER_STORAGE_KEY, value),
  clear: () => SecureStore.deleteItemAsync(SEEKER_STORAGE_KEY),
  authorize: (previous) => withSeeker(previous, async (_wallet, authorization) => authorization),
  signMessage: (previous, message) =>
    withSeeker(previous, async (wallet, authorization) => {
      const [payload] = await wallet.signMessages({
        addresses: [getBase64Decoder().decode(getBase58Encoder().encode(authorization.address))],
        payloads: [message],
      })
      if (!payload) throw new Error('The Seeker wallet did not return a signature.')
      return { authorization, payload }
    }),
  signTransaction: (previous, transaction) =>
    withSeeker(previous, async (wallet, authorization) => {
      const [signed] = await wallet.signTransactions({ transactions: [transaction] })
      if (!signed) throw new Error('The Seeker wallet did not return a signed transaction.')
      return { authorization, transaction: signed }
    }),
}
export function WalletProvider({ children }: PropsWithChildren) {
  return <SeekerWalletProvider transport={transport}>{children}</SeekerWalletProvider>
}
