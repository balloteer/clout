import { useEffect, useRef, useState } from 'react'
import { ScrollView, StyleSheet } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { router, useLocalSearchParams } from 'expo-router'
import { Button, Badge, Txt } from '../components/ui'
import { accountLinking } from '../lib/account-linking'
import { parseAccountLinkReturn } from '../lib/account-link-flow'
import { clearAccountReturn, readAccountReturn, rememberAccountReturn } from '../lib/account-link-return'
import { colors as c } from '../lib/theme'
import { useWallet } from '../lib/wallet'

export default function AccountLinkReturn() {
  const params = useLocalSearchParams<{ attempt?: string; completion?: string }>()
  const [returned] = useState(() => {
    if (params.attempt || params.completion) {
      try {
        return rememberAccountReturn(params.attempt, params.completion)
      } catch {
        return { state: params.attempt, completion: params.completion }
      }
    }
    return readAccountReturn() ?? {}
  })
  const wallet = useWallet()
  useEffect(() => {
    // Remove the callback secret from navigation/browser history before making any API request.
    if (params.attempt || params.completion) router.replace('/linked-accounts')
  }, [params.attempt, params.completion])
  return <WalletAccountReturn key={wallet.address ?? 'guest'} returned={returned} />
}

function WalletAccountReturn({ returned }: { returned: { state?: string; completion?: string } }) {
  const wallet = useWallet()
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState('')
  const working = useRef(false)
  const attempted = useRef<string | undefined>(undefined)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    if (!wallet.address || attempted.current === wallet.address) return
    attempted.current = wallet.address
    void Promise.resolve().then(async () => {
      if (!mounted.current || working.current) return
      working.current = true
      setBusy(true)
      try {
        const callback =
          returned.state || returned.completion
            ? parseAccountLinkReturn(returned.state, returned.completion)
            : undefined
        await accountLinking.complete(wallet.address!, callback)
        clearAccountReturn(returned.state)
        if (mounted.current) {
          setDone(true)
          setError('')
        }
      } catch (err) {
        if (mounted.current)
          setError(err instanceof Error ? err.message : 'Could not confirm the account connection.')
      } finally {
        working.current = false
        if (mounted.current) setBusy(false)
      }
    })
  }, [wallet.address, returned])
  async function retry() {
    if (!wallet.address || working.current) return
    working.current = true
    setBusy(true)
    try {
      await accountLinking.complete(wallet.address)
      clearAccountReturn(returned.state)
      if (mounted.current) {
        setDone(true)
        setError('')
      }
    } catch (err) {
      if (mounted.current)
        setError(err instanceof Error ? err.message : 'Could not confirm the account connection.')
    } finally {
      working.current = false
      if (mounted.current) setBusy(false)
    }
  }
  return (
    <SafeAreaView style={s.safe}>
      <ScrollView contentContainerStyle={s.content}>
        <Badge color={c.sky}>Linked accounts</Badge>
        <Txt display style={s.title}>
          {done ? 'Account connected' : 'Finish connecting'}
        </Txt>
        <Txt style={s.copy}>
          {done
            ? 'Your linked account is ready. New supported public videos will import into Clout automatically.'
            : busy
              ? 'Verifying the account connection started on this device…'
              : 'Return with the same wallet and device that started this connection.'}
        </Txt>
        {!wallet.address && (
          <Button
            disabled={wallet.busy || busy}
            onPress={() => {
              void wallet
                .connect()
                .catch((err) =>
                  setError(err instanceof Error ? err.message : 'Could not reconnect your wallet.'),
                )
            }}
            icon="wallet-outline"
          >
            Reconnect wallet
          </Button>
        )}
        {!!error && (
          <Txt accessibilityRole="alert" style={s.error}>
            {error} If the request timed out, check linked accounts in Profile before starting again.
          </Txt>
        )}
        {!done && !!wallet.address && !!error && (
          <Button secondary disabled={busy} onPress={() => void retry()}>
            Retry connection
          </Button>
        )}
        <Button
          secondary
          disabled={busy}
          onPress={() => {
            clearAccountReturn(returned.state)
            router.replace({ pathname: '/', params: { destination: 'Profile' } })
          }}
        >
          Back to profile
        </Button>
      </ScrollView>
    </SafeAreaView>
  )
}
const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: c.ink },
  content: { padding: 24, gap: 24, paddingTop: 48, maxWidth: 650, width: '100%', alignSelf: 'center' },
  title: { fontSize: 32, lineHeight: 42 },
  copy: { fontSize: 14, lineHeight: 23, color: c.muted },
  error: { fontSize: 13, lineHeight: 22, color: c.orange },
})
