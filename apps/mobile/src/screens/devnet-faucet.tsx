import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState, Linking, RefreshControl, ScrollView, StyleSheet, View } from 'react-native'
import { api, API_URL, postJson } from '../lib/api'
import { displayAtomic } from '../lib/amounts'
import { useWallet } from '../lib/wallet'
import { colors as c } from '../lib/theme'
import { Badge, Button, Icon, Txt } from '../components/ui'

type FaucetClaim = {
  id: string
  state: 'reserved' | 'prepared' | 'submitted' | 'finalized' | 'failed' | 'expired'
  signature: string | null
  amount: string
  createdAt: string
  needsReview: boolean
  retryable?: boolean
  day?: string
}
type FaucetStatus = {
  available: boolean
  reason?: string
  symbol: 'SKR'
  label: 'Mock SKR'
  network: 'devnet'
  mint: string | null
  amount: string
  decimals: number
  cooldownSeconds: number
  nextClaimAt: string | null
  period?: 'utc-day'
  resetAt?: string
  dailyLimit?: string
  claimedAmount?: string
  remainingAmount?: string
  claim?: FaucetClaim | null
}
const pendingClaim = (claim?: FaucetClaim | null) =>
  !!claim && ['reserved', 'prepared', 'submitted'].includes(claim.state)

export function DevnetFaucet({ onConnect }: { onConnect: () => void }) {
  const wallet = useWallet()
  return <WalletFaucet key={wallet.address ?? 'guest'} onConnect={onConnect} />
}

function WalletFaucet({ onConnect }: { onConnect: () => void }) {
  const wallet = useWallet()
  const [status, setStatus] = useState<FaucetStatus | null>(null)
  const [loading, setLoading] = useState(!!API_URL)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const mounted = useRef(true)
  const submitting = useRef(false)
  const generation = useRef(0)
  const refresh = useCallback(async () => {
    if (!API_URL) return
    const version = ++generation.current
    setLoading(true)
    try {
      const next = await api<FaucetStatus>('/v1/faucet')
      if (mounted.current && version === generation.current) {
        setStatus(next)
        setError('')
      }
    } catch (err) {
      if (mounted.current && version === generation.current)
        setError(err instanceof Error ? err.message : 'The mock SKR faucet is temporarily unavailable.')
    } finally {
      if (mounted.current && version === generation.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    void Promise.resolve().then(refresh)
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active' && !submitting.current) void refresh()
    })
    return () => {
      mounted.current = false
      subscription.remove()
    }
  }, [refresh])
  useEffect(() => {
    if (!API_URL || !status?.claim || ['finalized', 'expired'].includes(status.claim.state)) return
    const timer = setInterval(() => {
      if (!submitting.current) void refresh()
    }, 15_000)
    return () => clearInterval(timer)
  }, [status?.claim, refresh])
  useEffect(() => {
    if (!status?.resetAt) return
    const reset = Date.parse(status.resetAt)
    if (!Number.isFinite(reset)) return
    const timer = setTimeout(
      () => {
        if (!submitting.current) void refresh()
      },
      Math.max(1000, reset - Date.now() + 500),
    )
    return () => clearTimeout(timer)
  }, [status?.resetAt, refresh])

  async function mint() {
    if (!wallet.address) {
      onConnect()
      return
    }
    if (
      submitting.current ||
      !status?.available ||
      pendingClaim(status.claim) ||
      status.claim?.needsReview ||
      status.claim?.state === 'expired'
    )
      return
    submitting.current = true
    generation.current++
    setBusy(true)
    setError('')
    let failure = ''
    try {
      const claim = await postJson<FaucetClaim>('/v1/faucet/claims', {})
      if (mounted.current) setStatus((value) => value && { ...value, available: false, claim })
    } catch (err) {
      failure = err instanceof Error ? err.message : 'The claim could not be completed.'
    } finally {
      // A lost POST response is recovered from the wallet's durable server claim.
      if (mounted.current) await refresh()
      submitting.current = false
      if (mounted.current) {
        setBusy(false)
        if (failure) setError(failure)
      }
    }
  }

  const claim = status?.claim
  const amount =
    status?.amount && status.amount !== '0' ? displayAtomic(status.amount, status.decimals) : '1000'
  const disabled =
    busy ||
    loading ||
    !status?.available ||
    pendingClaim(claim) ||
    !!claim?.needsReview ||
    claim?.state === 'expired'
  return (
    <ScrollView
      contentContainerStyle={s.content}
      refreshControl={
        <RefreshControl refreshing={loading} onRefresh={() => void refresh()} tintColor={c.lime} />
      }
    >
      <Badge color={c.yellow}>Early alpha · Devnet only</Badge>
      <Txt display style={s.title}>
        Mint mock SKR
      </Txt>
      <Txt style={s.subtitle}>1,000 mock SKR per wallet, every day. Resets at 00:00 UTC.</Txt>
      <View style={s.card}>
        <View style={s.heading}>
          <Txt style={s.small}>Your daily allocation</Txt>
          <Badge color={c.sky}>Mock SKR</Badge>
        </View>
        <Txt display style={s.amount}>
          {amount ?? '—'}
        </Txt>
        {status?.remainingAmount !== undefined && (
          <Txt style={s.copy}>
            {displayAtomic(status.remainingAmount, status.decimals)} SKR remaining today
          </Txt>
        )}
        {!API_URL ? (
          <Txt style={s.copy}>The mock SKR faucet is not connected in this preview.</Txt>
        ) : status?.reason ? (
          <Txt style={s.copy}>{status.reason}</Txt>
        ) : loading && !status ? (
          <Txt style={s.copy}>Checking faucet availability…</Txt>
        ) : null}
        <Button disabled={!!wallet.address && disabled} onPress={() => void mint()} icon="water-outline">
          {!wallet.address
            ? 'Connect Seeker wallet to mint'
            : busy
              ? 'Requesting mock SKR…'
              : pendingClaim(claim)
                ? 'Claim pending'
                : claim?.needsReview || claim?.state === 'expired'
                  ? 'Claim needs review'
                  : claim && status?.remainingAmount === '0' && !claim.retryable
                    ? claim.state === 'failed'
                      ? 'Daily attempts used'
                      : 'Daily allocation claimed'
                    : claim?.retryable
                      ? 'Retrying your saved claim'
                      : `Mint ${amount} mock SKR`}
        </Button>
        {status?.nextClaimAt && (
          <Txt style={s.small}>Available again: {new Date(status.nextClaimAt).toLocaleString()}</Txt>
        )}
        {wallet.address && (
          <View style={{ gap: 4 }}>
            <Txt style={s.small}>Receiving Seeker wallet</Txt>
            <Txt selectable numberOfLines={1} ellipsizeMode="middle" style={s.address}>
              {wallet.name ?? wallet.address}
            </Txt>
          </View>
        )}
        <Txt style={s.small}>
          The faucet sends to your connected wallet. Trading requires devnet SOL for network fees and account
          rent.
        </Txt>
      </View>
      <View style={s.notice}>
        <Icon name="flask-outline" color={c.yellow} size={20} />
        <Txt style={[s.copy, { flex: 1 }]}>Mock SKR has no monetary value. All activity stays on devnet.</Txt>
      </View>
      {claim && (
        <View style={s.card}>
          <Txt display style={s.receiptTitle}>
            Your latest claim
          </Txt>
          <Badge color={claim.state === 'finalized' ? c.lime : c.yellow}>
            {claim.state === 'finalized'
              ? 'Received · finalized'
              : claim.needsReview || claim.state === 'expired'
                ? 'Needs review'
                : claim.state === 'failed'
                  ? 'Claim failed'
                  : 'Waiting for confirmation'}
          </Badge>
          <Txt style={s.copy}>{displayAtomic(claim.amount, status?.decimals ?? 6)} mock SKR</Txt>
          {claim.needsReview || claim.state === 'expired' ? (
            <Txt style={s.copy}>
              Payment history needs review. A replacement claim will not be sent automatically.
            </Txt>
          ) : claim.state === 'failed' ? (
            <Txt style={s.copy}>
              This claim failed. Refresh for the latest status; a replacement is not sent automatically.
            </Txt>
          ) : claim.state !== 'finalized' ? (
            <Txt style={s.copy}>
              Your request is saved. Status updates automatically while this screen is open.
            </Txt>
          ) : null}
          {status?.nextClaimAt && (
            <Txt style={s.small}>Next claim: {new Date(status.nextClaimAt).toLocaleString()}</Txt>
          )}
          {claim.signature && (
            <Button
              secondary
              onPress={() => {
                void Linking.openURL(
                  `https://explorer.solana.com/tx/${encodeURIComponent(claim.signature!)}?cluster=devnet`,
                ).catch(() => setError('Could not open the devnet transaction receipt.'))
              }}
              icon="open-outline"
            >
              View devnet receipt
            </Button>
          )}
        </View>
      )}
      {!!error && (
        <Txt accessibilityRole="alert" style={s.error}>
          {error}
        </Txt>
      )}
      {!!API_URL && (
        <Button secondary disabled={busy || loading} onPress={() => void refresh()} icon="refresh">
          Refresh faucet status
        </Button>
      )}
      {status?.mint && (
        <View style={{ gap: 7, marginTop: 22 }}>
          <Txt style={s.small}>Devnet mock SKR mint</Txt>
          <Txt selectable style={s.address}>
            {status.mint}
          </Txt>
        </View>
      )}
    </ScrollView>
  )
}

const s = StyleSheet.create({
  content: {
    padding: 16,
    paddingTop: 18,
    paddingBottom: 40,
    maxWidth: 650,
    width: '100%',
    alignSelf: 'center',
  },
  title: { fontSize: 30, lineHeight: 38, marginTop: 14 },
  subtitle: { color: c.muted, fontSize: 13, lineHeight: 20, marginTop: 8, marginBottom: 16 },
  notice: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 4, gap: 10, marginBottom: 20 },
  card: { padding: 18, borderRadius: 18, backgroundColor: c.surface, gap: 12, marginBottom: 16 },
  heading: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  amount: { fontSize: 42, lineHeight: 52, color: c.lime },
  copy: { fontSize: 13, lineHeight: 21, color: c.muted },
  small: { fontSize: 11, lineHeight: 18, color: c.muted },
  address: { fontSize: 12, lineHeight: 20, color: c.cream },
  receiptTitle: { fontSize: 23, lineHeight: 31 },
  error: { fontSize: 13, lineHeight: 21, color: c.orange, marginBottom: 18 },
})
