import { useCallback, useEffect, useRef, useState } from 'react'
import { Linking, View } from 'react-native'
import { api, API_URL, postJson } from '../lib/api'
import { displayAtomic } from '../lib/amounts'
import { useWallet } from '../lib/wallet'
import { useApp } from '../lib/store'
import { colors as c } from '../lib/theme'
import { Button, Txt } from './ui'

type Campaign = {
  id: string
  symbol: 'Test SKR'
  amount: string
  decimals: number
  maxClaims: number
  remaining: number
}
type CampaignResult = { available: boolean; campaign: Campaign | null; claim?: Claim | null; reason?: string }
type Claim = {
  id: string
  campaignId: string
  attemptCount?: number
  state: 'reserved' | 'prepared' | 'submitted' | 'finalized' | 'expired' | 'failed'
  amount: string
  signature: string | null
  network: 'devnet'
  symbol: 'Test SKR'
}
const activeClaim = (claim: Claim | null) =>
  !!claim &&
  (['reserved', 'prepared', 'submitted'].includes(claim.state) ||
    (claim.state === 'failed' && (claim.attemptCount ?? 0) < 3))

export function RewardPanel({ onConnect }: { onConnect: () => void }) {
  const wallet = useWallet()
  return <WalletRewards key={wallet.address ?? 'guest'} onConnect={onConnect} />
}
function WalletRewards({ onConnect }: { onConnect: () => void }) {
  const wallet = useWallet()
  const { notify } = useApp()
  const [campaign, setCampaign] = useState<CampaignResult | null>(null)
  const [claim, setClaim] = useState<Claim | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const mounted = useRef(true)
  const submitting = useRef(false)
  const generation = useRef(0)
  const refresh = useCallback(async () => {
    if (!API_URL) return
    const request = ++generation.current
    try {
      const next = await api<CampaignResult>('/v1/rewards/campaign')
      if (mounted.current && request === generation.current) {
        setCampaign(next)
        setClaim(next.claim?.campaignId === next.campaign?.id ? (next.claim ?? null) : null)
        setError('')
      }
    } catch (err) {
      if (mounted.current && request === generation.current)
        setError(err instanceof Error ? err.message : 'Reward status unavailable.')
    }
  }, [])
  useEffect(() => {
    mounted.current = true
    void Promise.resolve().then(refresh)
    return () => {
      mounted.current = false
    }
  }, [refresh])
  useEffect(() => {
    if (!activeClaim(claim)) return
    const timer = setInterval(() => void refresh(), 15_000)
    return () => clearInterval(timer)
  }, [claim, refresh])
  async function requestClaim() {
    if (!wallet.address) {
      onConnect()
      return
    }
    if (submitting.current || !campaign?.available || claim) return
    submitting.current = true
    generation.current++
    setBusy(true)
    setError('')
    try {
      const result = await postJson<Claim>('/v1/claims', { campaignId: campaign.campaign?.id })
      if (mounted.current && result.campaignId === campaign.campaign?.id) setClaim(result)
    } catch (err) {
      // The server can recover an idempotent reservation even if the response was lost.
      await refresh()
      if (mounted.current) setError(err instanceof Error ? err.message : 'Could not submit your claim.')
    } finally {
      submitting.current = false
      if (mounted.current) setBusy(false)
    }
  }
  const info = campaign?.campaign
  return (
    <View style={{ gap: 12, marginTop: 18 }}>
      <Txt style={{ color: c.muted, fontSize: 13 }}>
        {info
          ? `${displayAtomic(info.amount, info.decimals)} Test SKR per eligible Seeker · ${info.remaining} of ${info.maxClaims} claims available.`
          : !API_URL
            ? 'No funded campaign is connected.'
            : (campaign?.reason ?? (error ? 'Campaign status unavailable.' : 'Checking funded campaigns…'))}
      </Txt>
      {info && (
        <Txt style={{ color: c.muted, fontSize: 11 }}>
          Devnet test tokens. One claim per eligible Seeker Genesis Token.
        </Txt>
      )}
      {info && campaign?.reason && <Txt style={{ color: c.muted, fontSize: 12 }}>{campaign.reason}</Txt>}
      {claim && (
        <Txt style={{ color: claim.state === 'finalized' ? c.lime : c.yellow, fontSize: 13 }}>
          {claim.state === 'finalized'
            ? 'Reward paid · finalized on devnet'
            : claim.state === 'expired'
              ? 'Claim expired; payment history needs review. No replacement payment will be sent automatically.'
              : claim.state === 'failed'
                ? activeClaim(claim)
                  ? 'Payment failed onchain. The server will retry automatically.'
                  : 'Payment failed. Automatic retries are exhausted.'
                : 'Reward pending · waiting for finality'}
        </Txt>
      )}
      {!!error && (
        <Txt accessibilityRole="alert" style={{ fontSize: 12, color: c.pink }}>
          {error}
        </Txt>
      )}
      {campaign?.available && !claim && (
        <Button disabled={busy || activeClaim(claim)} onPress={() => void requestClaim()} icon="gift-outline">
          {busy
            ? 'Submitting claim…'
            : activeClaim(claim)
              ? 'Claim pending'
              : wallet.address
                ? 'Claim Test SKR'
                : 'Connect wallet to claim'}
        </Button>
      )}
      {!!API_URL && (
        <Button secondary disabled={busy} onPress={() => void refresh()}>
          Check reward status
        </Button>
      )}
      {claim?.signature && (
        <Button
          secondary
          onPress={() => {
            void Linking.openURL(`https://explorer.solana.com/tx/${claim.signature}?cluster=devnet`).catch(
              () => notify('Could not open the explorer.'),
            )
          }}
        >
          View reward transaction
        </Button>
      )}
    </View>
  )
}
