import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState, Linking, StyleSheet, View } from 'react-native'
import { api, API_URL, postJson } from '../lib/api'
import { type LinkedAccount, type LinkedAccountsResult, type LinkedProvider } from '../lib/linked-accounts'
import { colors as c } from '../lib/theme'
import { useWallet } from '../lib/wallet'
import { Badge, Button, Icon, Section, Txt } from './ui'
import { accountLinking } from '../lib/account-linking'

const providerName = { x: 'X', fomo: 'Fomo' } as const
const statusLabel = {
  active: 'Auto-import on',
  paused: 'Imports paused',
  reauthorization_required: 'Reconnect needed',
  error: 'Import needs attention',
} as const

export function LinkedAccounts({ onConnect }: { onConnect: () => void }) {
  const wallet = useWallet()
  return <WalletLinkedAccounts key={wallet.address ?? 'guest'} onConnect={onConnect} />
}

function WalletLinkedAccounts({ onConnect }: { onConnect: () => void }) {
  const wallet = useWallet()
  const [data, setData] = useState<LinkedAccountsResult | null>(null)
  const [loading, setLoading] = useState(!!wallet.address && !!API_URL)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [disconnectId, setDisconnectId] = useState<string | null>(null)
  const mounted = useRef(true)
  const action = useRef(false)
  const generation = useRef(0)
  const request = useRef<AbortController | null>(null)

  const refresh = useCallback(async () => {
    if (!wallet.address || !API_URL) return
    const version = ++generation.current
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, 15_000)
    setLoading(true)
    try {
      const next = await api<LinkedAccountsResult>('/v1/linked-accounts', { signal: controller.signal })
      if (!mounted.current || version !== generation.current) return
      setData(next)
      setDisconnectId((id) => (next.accounts.some((account) => account.id === id) ? id : null))
      setError('')
    } catch (err) {
      if (mounted.current && version === generation.current && (!controller.signal.aborted || timedOut))
        setError(
          timedOut
            ? 'Linked account status timed out. Try again.'
            : err instanceof Error
              ? err.message
              : 'Linked accounts are temporarily unavailable.',
        )
    } finally {
      clearTimeout(timeout)
      if (mounted.current && version === generation.current) setLoading(false)
    }
  }, [wallet.address])

  useEffect(() => {
    mounted.current = true
    void Promise.resolve().then(refresh)
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active' && !action.current) void refresh()
    })
    return () => {
      mounted.current = false
      request.current?.abort()
      subscription.remove()
    }
  }, [refresh])

  async function connect(provider: LinkedProvider, accountId?: string) {
    if (!wallet.address) {
      onConnect()
      return
    }
    if (action.current || !data?.providers[provider].available) return
    if (!accountId && data.accounts.length >= data.limit) return
    action.current = true
    generation.current++
    request.current?.abort()
    setBusy(`connect:${accountId ?? provider}`)
    setError('')
    setMessage('')
    let failure = ''
    try {
      const url = await accountLinking.start(wallet.address, provider, accountId)
      if (!mounted.current) return
      await Linking.openURL(url)
      if (mounted.current)
        setMessage(
          `Finish connecting on ${providerName[provider]}, then use Return to Clout to verify it on this device.`,
        )
    } catch (err) {
      failure = err instanceof Error ? err.message : 'Could not open the account connection.'
    } finally {
      action.current = false
      if (mounted.current) {
        await refresh()
        if (mounted.current) {
          setBusy('')
          if (failure) setError(failure)
        }
      }
    }
  }

  async function updateAccount(account: LinkedAccount, operation: 'pause' | 'resume' | 'disconnect') {
    if (action.current) return
    action.current = true
    generation.current++
    request.current?.abort()
    setBusy(`${operation}:${account.id}`)
    setError('')
    setMessage('')
    let failure = ''
    try {
      await postJson(`/v1/linked-accounts/${encodeURIComponent(account.id)}/${operation}`, {})
      if (mounted.current) {
        setDisconnectId(null)
        setMessage(
          operation === 'disconnect'
            ? `${providerName[account.provider]} account disconnected. Existing Clout posts remain.`
            : operation === 'pause'
              ? `Imports from @${account.handle} are paused.`
              : `Automatic imports from @${account.handle} are on.`,
        )
      }
    } catch (err) {
      failure = err instanceof Error ? err.message : 'Could not update this linked account.'
    } finally {
      action.current = false
      if (mounted.current) {
        await refresh()
        if (mounted.current) {
          setBusy('')
          if (failure) setError(failure)
        }
      }
    }
  }

  const disabled = !!busy || loading
  const full = !!data && data.accounts.length >= data.limit
  return (
    <Section
      title="Linked accounts"
      aside={
        <Badge color={c.sky}>{data ? `${data.accounts.length} of ${data.limit} linked` : 'Up to 3'}</Badge>
      }
    >
      <View style={s.intro}>
        <Icon name="link-outline" color={c.sky} size={26} />
        <Txt style={s.copy}>
          Bring new supported video posts from your X or Fomo accounts into Clout automatically. Link up to
          three accounts across both apps.
        </Txt>
      </View>
      {!API_URL && <Txt style={s.copy}>Account linking is unavailable in this preview.</Txt>}
      {!wallet.address ? (
        <Button onPress={onConnect} icon="wallet-outline">
          Connect wallet to link accounts
        </Button>
      ) : (
        <>
          {loading && <Txt style={s.copy}>Refreshing linked accounts…</Txt>}
          {data?.accounts.map((account) => (
            <View key={account.id} style={s.card}>
              <View style={s.row}>
                <Badge color={c.sky}>{providerName[account.provider]}</Badge>
                <Txt style={{ ...s.status, color: account.status === 'active' ? c.lime : c.yellow }}>
                  {statusLabel[account.status]}
                </Txt>
              </View>
              <Txt selectable style={s.handle}>
                @{account.handle}
              </Txt>
              {!!account.displayName && <Txt style={s.copy}>{account.displayName}</Txt>}
              {!!account.lastImportedAt && (
                <Txt style={s.small}>Last imported: {new Date(account.lastImportedAt).toLocaleString()}</Txt>
              )}
              {!!account.lastError && <Txt style={s.problem}>{account.lastError}</Txt>}
              {account.status === 'reauthorization_required' && (
                <Button
                  disabled={disabled || !data.providers[account.provider].available}
                  onPress={() => void connect(account.provider, account.id)}
                >
                  {busy === `connect:${account.id}`
                    ? 'Opening connection…'
                    : `Reconnect ${providerName[account.provider]}`}
                </Button>
              )}
              {account.status !== 'reauthorization_required' && (
                <Button
                  secondary
                  disabled={disabled}
                  onPress={() =>
                    void updateAccount(account, account.status === 'paused' ? 'resume' : 'pause')
                  }
                >
                  {busy.endsWith(`:${account.id}`)
                    ? 'Updating account…'
                    : account.status === 'paused'
                      ? 'Resume imports'
                      : 'Pause imports'}
                </Button>
              )}
              {disconnectId === account.id ? (
                <View style={s.confirm}>
                  <Txt style={s.copy}>
                    Disconnecting stops future imports. Your Clout posts stay in your profile.
                  </Txt>
                  <Button disabled={disabled} onPress={() => void updateAccount(account, 'disconnect')}>
                    Confirm disconnect
                  </Button>
                  <Button secondary disabled={disabled} onPress={() => setDisconnectId(null)}>
                    Keep account linked
                  </Button>
                </View>
              ) : (
                <Button secondary disabled={disabled} onPress={() => setDisconnectId(account.id)}>
                  Disconnect account
                </Button>
              )}
            </View>
          ))}
          {data && !data.accounts.length && <Txt style={s.copy}>No accounts linked yet.</Txt>}
          {full && <Txt style={s.copy}>All three slots are used. Disconnect an account to add another.</Txt>}
        </>
      )}
      {(['x', 'fomo'] as const).map((provider) => {
        const availability = data?.providers[provider]
        const reason = !API_URL
          ? 'Available when account imports are connected.'
          : !wallet.address
            ? 'Connect your wallet to check availability.'
            : (availability?.reason ?? (!availability?.available && !loading ? 'Currently unavailable.' : ''))
        return (
          <View key={provider} style={s.provider}>
            <Button
              secondary
              disabled={!wallet.address || disabled || full || !availability?.available}
              onPress={() => void connect(provider)}
              icon="add"
            >
              {busy === `connect:${provider}`
                ? 'Opening connection…'
                : `Link ${providerName[provider]} account`}
            </Button>
            {!!reason && <Txt style={s.small}>{reason}</Txt>}
          </View>
        )
      })}
      {!!message && (
        <Txt accessibilityLiveRegion="polite" style={s.copy}>
          {message}
        </Txt>
      )}
      {!!error && (
        <Txt accessibilityRole="alert" style={s.problem}>
          {error}
        </Txt>
      )}
      {!!API_URL && !!wallet.address && (
        <Button secondary disabled={disabled} onPress={() => void refresh()} icon="refresh">
          Refresh account status
        </Button>
      )}
    </Section>
  )
}

const s = StyleSheet.create({
  intro: { gap: 12 },
  copy: { color: c.muted, fontSize: 13, lineHeight: 21 },
  small: { color: c.muted, fontSize: 11, lineHeight: 18 },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 12 },
  status: { fontSize: 12, lineHeight: 19, flexShrink: 1 },
  card: {
    backgroundColor: c.surface,
    borderColor: c.line,
    borderWidth: 1,
    borderRadius: 20,
    padding: 18,
    gap: 12,
  },
  handle: { fontSize: 18, fontWeight: '700', lineHeight: 26 },
  problem: { color: c.orange, fontSize: 12, lineHeight: 20 },
  confirm: { borderTopColor: c.line, borderTopWidth: 1, paddingTop: 12, gap: 12 },
  provider: { gap: 8 },
})
