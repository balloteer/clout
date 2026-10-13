import { type PropsWithChildren } from 'react'
import { NativeModules, Platform } from 'react-native'
import * as SecureStore from 'expo-secure-store'
import { transact, type KitMobileWallet } from '@solana-mobile/mobile-wallet-adapter-protocol-kit'
import { getBase58Decoder, getBase58Encoder, getBase64Decoder, getBase64Encoder } from '@solana/kit'
import { SeekerWalletProvider, type SeekerTransport } from './seeker-wallet-provider'
import {
  SEEKER_CHAIN,
  SEEKER_STORAGE_KEY,
  SEEKER_NATIVE_SOURCE,
  isWalletAuthorizationFailure,
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
  if (previous) validateSeekerAuthorization(previous, undefined, 'native')
  const gate = NativeModules.CloutSeekerWallet
  if (gate?.routingPolicy !== 'seeker-certified-v1' || typeof gate.assertAvailable !== 'function')
    throw Object.assign(new Error('Install the latest Clout APK to connect your Seeker wallet.'), {
      code: 'CLOUT_SEEKER_BUILD_REQUIRED',
    })
  await gate.assertAvailable()
  // MainActivity pins this standard MWA association to a certificate-verified
  // Seeker package. Never route through optional wallet-returned URI metadata.
  return transact(async (wallet) => {
    const authorize = (cached: boolean) =>
      wallet.authorize({
        identity,
        chain: SEEKER_CHAIN,
        ...(cached && previous ? { auth_token: previous.authToken } : {}),
      })
    let result
    try {
      result = await authorize(!!previous)
    } catch (error) {
      if (!previous || !isWalletAuthorizationFailure(error)) throw error
      await SecureStore.deleteItemAsync(SEEKER_STORAGE_KEY)
      // Exactly one fresh authorization, only for an explicitly rejected
      // cached token. Never retry signing, cancellation, or transport errors.
      try {
        result = await authorize(false)
      } catch (freshError) {
        // Tell the shared provider to discard the invalid in-memory token too,
        // including when the user cancels the fresh authorization prompt.
        throw Object.assign(
          freshError instanceof Error ? freshError : new Error('Wallet authorization failed.'),
          {
            walletAuthorizationInvalidated: true,
          },
        )
      }
    }
    const account = result.accounts[0]
    if (!account) throw new Error('The Seeker wallet did not authorize an account.')
    const authorization = validateSeekerAuthorization(
      {
        address: getBase58Decoder().decode(getBase64Encoder().encode(account.address)),
        authToken: result.auth_token,
        walletUriBase: SEEKER_NATIVE_SOURCE,
      },
      previous?.address,
      'native',
    )
    return callback(wallet, authorization)
  })
}
async function signMessage(wallet: KitMobileWallet, authorization: SeekerAuthorization, message: Uint8Array) {
  const [payload] = await wallet.signMessages({
    addresses: [getBase64Decoder().decode(getBase58Encoder().encode(authorization.address))],
    payloads: [message],
  })
  if (!payload) throw new Error('The Seeker wallet did not return a signature.')
  return { authorization, payload }
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
    await SecureStore.deleteItemAsync('clout-seeker-wallet-v1')
    return SecureStore.getItemAsync(SEEKER_STORAGE_KEY)
  },
  write: (value) => SecureStore.setItemAsync(SEEKER_STORAGE_KEY, value),
  clear: () => SecureStore.deleteItemAsync(SEEKER_STORAGE_KEY),
  authorize: (previous) => withSeeker(previous, async (_wallet, authorization) => authorization),
  authenticate: (previous, getMessage) =>
    withSeeker(previous, async (wallet, authorization) => {
      const message = await getMessage(authorization)
      return signMessage(wallet, authorization, message)
    }),
  signMessage: (previous, message) =>
    withSeeker(previous, (wallet, authorization) => signMessage(wallet, authorization, message)),
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
