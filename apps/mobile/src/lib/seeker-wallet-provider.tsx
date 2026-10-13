import { useEffect, useRef, useState, type PropsWithChildren } from 'react'
import {
  createSolanaRpc,
  getBase64Decoder,
  getBase64Encoder,
  getTransactionDecoder,
  getSignatureFromTransaction,
  getBase64EncodedWireTransaction,
  type Transaction,
} from '@solana/kit'
import { WalletContext } from './wallet-context'
import { API_URL, postJson, setSessionToken, onSessionInvalidated } from './api'
import { getPending } from './transactions'
import { persistThenBroadcast } from './submission'
import {
  SEEKER_STORAGE_KEY,
  signedMessageParts,
  validateSeekerAuthorization,
  type SeekerAuthorization,
} from './seeker-wallet-policy'

export type SeekerTransport = {
  native: boolean
  available: boolean
  unavailableReason?: string
  read: () => Promise<string | null>
  write: (value: string) => Promise<void>
  clear: () => Promise<void>
  authorize: (previous?: SeekerAuthorization) => Promise<SeekerAuthorization>
  signMessage: (
    authorization: SeekerAuthorization,
    message: Uint8Array,
  ) => Promise<{ authorization: SeekerAuthorization; payload: Uint8Array }>
  signTransaction: (
    authorization: SeekerAuthorization,
    transaction: Transaction,
  ) => Promise<{ authorization: SeekerAuthorization; transaction: Transaction }>
}
type Session = { token: string; expiresAt: string; profile: { name?: string; seeker?: boolean } }
type Stored = { policy: typeof SEEKER_STORAGE_KEY; authorization: SeekerAuthorization; session?: Session }
const rpc = createSolanaRpc(process.env.EXPO_PUBLIC_SOLANA_RPC_URL ?? 'https://api.devnet.solana.com')

export function SeekerWalletProvider({
  children,
  transport,
}: PropsWithChildren<{ transport: SeekerTransport }>) {
  const [authorization, setAuthorization] = useState<SeekerAuthorization>()
  const [session, setSession] = useState<Session>()
  const [busy, setBusy] = useState(false)
  const operation = useRef(false)
  const generation = useRef(0)
  const current = useRef<Stored | undefined>(undefined)

  async function remember(next: SeekerAuthorization, nextSession?: Session) {
    const stored: Stored = {
      policy: SEEKER_STORAGE_KEY,
      authorization: validateSeekerAuthorization(next),
      session: nextSession,
    }
    await transport.write(JSON.stringify(stored))
    current.current = stored
    setAuthorization(stored.authorization)
    setSession(stored.session)
    setSessionToken(stored.session?.token)
  }
  useEffect(() => {
    if (!transport.available) return
    let active = true
    const revision = ++generation.current
    void transport
      .read()
      .then((raw) => {
        if (!raw || !active || generation.current !== revision) return
        const stored = JSON.parse(raw) as Stored
        if (stored.policy !== SEEKER_STORAGE_KEY) return
        const auth = validateSeekerAuthorization(stored.authorization)
        const restoredSession =
          stored.session && Date.parse(stored.session.expiresAt) > Date.now() ? stored.session : undefined
        current.current = { policy: SEEKER_STORAGE_KEY, authorization: auth, session: restoredSession }
        setAuthorization(auth)
        setSession(restoredSession)
        setSessionToken(restoredSession?.token)
      })
      .catch(() => {
        if (active && generation.current === revision) void transport.clear().catch(() => {})
      })
    return () => {
      active = false
      setSessionToken(undefined)
    }
  }, [transport])
  useEffect(
    () =>
      onSessionInvalidated(() => {
        setSession(undefined)
        if (current.current) current.current = { ...current.current, session: undefined }
        void transport.clear().catch(() => {})
      }),
    [transport],
  )
  useEffect(() => {
    if (!session) return
    const timer = setTimeout(
      () => {
        setSession(undefined)
        setSessionToken(undefined)
        if (current.current) current.current = { ...current.current, session: undefined }
        void transport.clear().catch(() => {})
      },
      Math.max(0, Date.parse(session.expiresAt) - Date.now()),
    )
    return () => clearTimeout(timer)
  }, [session, transport])

  async function connect() {
    if (!transport.available)
      throw new Error(transport.unavailableReason ?? 'Open Clout on your Seeker to sign in.')
    if (operation.current) throw new Error('A wallet request is already in progress.')
    operation.current = true
    generation.current++
    setBusy(true)
    try {
      let auth = validateSeekerAuthorization(await transport.authorize(current.current?.authorization))
      let nextSession: Session | undefined
      if (API_URL) {
        const challenge = await postJson<{ challengeId: string; message: string }>('/v1/auth/challenge', {
          address: auth.address,
        })
        const message = new TextEncoder().encode(challenge.message)
        const signed = await transport.signMessage(auth, message)
        auth = validateSeekerAuthorization(signed.authorization, auth.address)
        const parts = signedMessageParts(signed.payload, message)
        const result = await postJson<{
          token: string
          expiresAt: string
          profile: { handle?: string; seekerVerified?: boolean }
        }>('/v1/auth/verify', {
          challengeId: challenge.challengeId,
          signature: getBase64Decoder().decode(parts.signature),
          signedMessage: getBase64Decoder().decode(parts.signedMessage),
        })
        nextSession = {
          token: result.token,
          expiresAt: result.expiresAt,
          profile: { name: result.profile.handle, seeker: result.profile.seekerVerified },
        }
      }
      await remember(auth, nextSession)
    } finally {
      operation.current = false
      setBusy(false)
    }
  }
  async function disconnect() {
    if (operation.current)
      throw new Error('Wait for the current wallet request to finish before disconnecting.')
    operation.current = true
    generation.current++
    setBusy(true)
    try {
      if (API_URL) await postJson('/v1/auth/logout', {}).catch(() => {})
      setSessionToken(undefined)
      current.current = undefined
      setAuthorization(undefined)
      setSession(undefined)
      await transport.clear()
    } finally {
      operation.current = false
      setBusy(false)
    }
  }
  async function send(
    transaction: string,
    minContextSlot: number,
    beforeBroadcast: (signature: string) => Promise<void>,
  ) {
    if (operation.current) throw new Error('A wallet request is already in progress.')
    const auth = current.current?.authorization
    if (!transport.available || !auth || (API_URL && !current.current?.session))
      throw new Error('Connect your Seeker wallet first.')
    validateSeekerAuthorization(auth)
    operation.current = true
    setBusy(true)
    try {
      if (await getPending(auth.address))
        throw new Error('Confirm your pending transaction before submitting another.')
      const decoded = getTransactionDecoder().decode(getBase64Encoder().encode(transaction))
      return await persistThenBroadcast({
        sign: async () => {
          const signed = await transport.signTransaction(auth, decoded)
          await remember(
            validateSeekerAuthorization(signed.authorization, auth.address),
            current.current?.session,
          )
          return signed.transaction
        },
        signature: getSignatureFromTransaction,
        persist: beforeBroadcast,
        broadcast: (signed) =>
          rpc
            .sendTransaction(getBase64EncodedWireTransaction(signed), {
              encoding: 'base64',
              skipPreflight: false,
              minContextSlot: BigInt(minContextSlot),
              preflightCommitment: 'confirmed',
              maxRetries: 3n,
            })
            .send(),
      })
    } finally {
      operation.current = false
      setBusy(false)
    }
  }
  return (
    <WalletContext.Provider
      value={{
        address: transport.available && (!API_URL || session) ? authorization?.address : undefined,
        name: session?.profile.name,
        seeker: session?.profile.seeker ?? false,
        busy,
        native: transport.native,
        connectAvailable: transport.available,
        connectUnavailableReason: transport.unavailableReason,
        connect,
        disconnect,
        send,
      }}
    >
      {children}
    </WalletContext.Provider>
  )
}
