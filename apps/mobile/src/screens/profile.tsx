import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState, Image, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native'
import { useWallet } from '../lib/wallet'
import { useApp } from '../lib/store'
import { api, API_URL, postJson } from '../lib/api'
import { displayAtomic, displayBps, displaySignedAtomic } from '../lib/amounts'
import { mapPost, type ApiPost, type ApiProfile, type Portfolio } from '../lib/contracts'
import { confirmPending, getPending, type PendingTransaction } from '../lib/transactions'
import { imageSource, mediaCredits, type Post } from '../lib/data'
import { colors as c, SLOGAN } from '../lib/theme'
import { Avatar, Badge, Button, Icon, Section, Txt } from '../components/ui'
import { CreatorPost, TipForm } from '../components/creator-actions'
import { RewardPanel } from '../components/reward-panel'
import { LinkedAccounts } from '../components/linked-accounts'
import { profileName } from '../lib/profile-name'

type ProfileResponse = { profile: ApiProfile; posts: ApiPost[] }
type AppConfig = {
  quoteDecimals: number
  features: { trading: boolean; rewards: boolean; seekerVerification: boolean }
}

type ProfileProps = {
  onConnect: () => void
  onFaucet?: () => void
  onPost: (post: Post, side?: 'buy' | 'sell') => void
  portfolioRevision?: number
}

export function Profile({ onConnect, onFaucet, onPost, portfolioRevision }: ProfileProps) {
  const wallet = useWallet()
  return (
    <WalletProfile
      key={wallet.address ?? 'guest'}
      onConnect={onConnect}
      onFaucet={onFaucet}
      onPost={onPost}
      portfolioRevision={portfolioRevision}
    />
  )
}

function WalletProfile({ onConnect, onFaucet, onPost, portfolioRevision = 0 }: ProfileProps) {
  const wallet = useWallet()
  const { saved, following, notify, refresh: refreshFeed } = useApp()
  const [profile, setProfile] = useState<ApiProfile | null>(null)
  const [posts, setPosts] = useState<ApiPost[]>([])
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null)
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [pending, setPending] = useState<PendingTransaction | null>(null)
  const [recoveryError, setRecoveryError] = useState('')
  const [error, setError] = useState('')
  const [balanceError, setBalanceError] = useState('')
  const [loading, setLoading] = useState(!!wallet.address)
  const [busy, setBusy] = useState(false)
  const [eligibility, setEligibility] = useState('')
  const generation = useRef(0)
  const load = useCallback(async () => {
    const version = ++generation.current
    if (!wallet.address) return
    setLoading(true)
    setError('')
    setBalanceError('')
    setRecoveryError('')
    try {
      const recovery = await getPending(wallet.address)
      if (version === generation.current) setPending(recovery)
    } catch (err) {
      if (version === generation.current)
        setRecoveryError(err instanceof Error ? err.message : 'Could not read transaction recovery.')
    }
    if (version !== generation.current) return
    if (!API_URL) {
      setBalanceError('Wallet balances are unavailable in this preview.')
      setLoading(false)
      return
    }
    const [identityResult, portfolioResult, configResult] = await Promise.allSettled([
      api<ProfileResponse>(`/v1/profiles/${wallet.address}`),
      api<Portfolio>('/v1/portfolio'),
      api<AppConfig>('/v1/config'),
    ])
    if (version !== generation.current) return
    if (identityResult.status === 'fulfilled') {
      setProfile(identityResult.value.profile)
      setPosts(identityResult.value.posts)
    } else
      setError(
        identityResult.reason instanceof Error
          ? identityResult.reason.message
          : 'Could not load your profile.',
      )
    if (portfolioResult.status === 'fulfilled') {
      setPortfolio(portfolioResult.value)
      if (!portfolioResult.value.balance) setBalanceError('Your SKR balance is temporarily unavailable.')
    } else {
      setPortfolio(null)
      setBalanceError(
        portfolioResult.reason instanceof Error
          ? portfolioResult.reason.message
          : 'Wallet balances are unavailable.',
      )
    }
    if (configResult.status === 'fulfilled') setConfig(configResult.value)
    setLoading(false)
  }, [wallet.address])
  useEffect(() => {
    void portfolioRevision
    let active = true
    const requests = generation
    const refreshVisible = () => {
      if (active) void load()
    }
    void Promise.resolve().then(refreshVisible)
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') refreshVisible()
    })
    return () => {
      active = false
      requests.current++
      subscription.remove()
    }
  }, [load, portfolioRevision])
  async function refresh() {
    if (!wallet.address) return
    await load()
  }
  async function changed() {
    await Promise.all([refresh(), refreshFeed()])
  }
  async function checkPending() {
    if (!wallet.address) return
    setBusy(true)
    try {
      const result = await confirmPending(wallet.address)
      notify(
        result.status === 'confirmed'
          ? 'Your transaction is confirmed.'
          : result.status === 'pending'
            ? 'Still waiting for confirmation. You can safely check again.'
            : `Transaction ${result.status}.`,
      )
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Confirmation is temporarily unavailable.')
    } finally {
      setBusy(false)
      await changed()
    }
  }
  async function checkEligibility() {
    if (!wallet.address) {
      onConnect()
      return
    }
    setBusy(true)
    setEligibility('')
    try {
      const result = await postJson<{ hasSGT: boolean; mintAddress: string | null }>('/v1/eligibility', {})
      setEligibility(
        result.hasSGT
          ? 'Your Seeker ownership is verified. Check available SKR campaigns below.'
          : 'No Seeker Genesis Token was found in this wallet. Use the wallet that holds your SGT.',
      )
      await refresh()
    } catch (err) {
      setEligibility(err instanceof Error ? err.message : 'Seeker verification is temporarily unavailable.')
    } finally {
      setBusy(false)
    }
  }
  const verified = profile?.seekerVerified ?? wallet.seeker
  const blocked = !!pending || !!recoveryError || busy
  const balance = portfolio?.balance
  return (
    <ScrollView
      contentContainerStyle={s.content}
      refreshControl={
        <RefreshControl refreshing={loading} onRefresh={() => void refresh()} tintColor={c.lime} />
      }
    >
      <View style={s.identity}>
        <Avatar letter={profile?.displayName ?? (wallet.address ? 'S' : '?')} size={78} color={c.cream} />
        <Badge color={verified ? c.lime : c.surface}>
          <Txt style={{ fontSize: 11, color: verified ? c.ink : c.muted }}>
            {verified ? 'Verified Seeker' : 'Your next chapter'}
          </Txt>
        </Badge>
      </View>
      <Txt display style={s.name}>
        {profileName(profile?.handle) ??
          profileName(wallet.name) ??
          (wallet.address
            ? `${wallet.address.slice(0, 4)}…${wallet.address.slice(-4)}`
            : 'Your clout starts here.')}
      </Txt>
      <Txt style={s.bio}>{wallet.address ? 'Your discoveries, backed by your wallet.' : SLOGAN}</Txt>
      {!wallet.address && (
        <Button onPress={onConnect} icon="wallet-outline">
          Connect your wallet
        </Button>
      )}
      {!!error && (
        <Txt accessibilityRole="alert" style={s.error}>
          {error}
        </Txt>
      )}
      {!!recoveryError && (
        <View style={s.pending}>
          <Txt style={s.error}>{recoveryError}</Txt>
          <Button secondary onPress={() => void refresh()}>
            Retry transaction recovery
          </Button>
        </View>
      )}
      {pending && (
        <View style={s.pending}>
          <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
            <Icon name="time-outline" color={c.yellow} />
            <Txt style={{ fontWeight: '700' }}>{pending.description ?? 'Pending wallet transaction'}</Txt>
          </View>
          <Txt style={s.small}>
            A signed transaction needs confirmation. Check it before starting another action.
          </Txt>
          <Button disabled={busy} onPress={() => void checkPending()}>
            {busy ? 'Checking…' : 'Check transaction status'}
          </Button>
        </View>
      )}
      <View style={s.balance} testID="profile-skr-balance">
        <View style={s.balanceRow}>
          <Icon name="wallet-outline" color={c.lime} size={25} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Txt style={s.small}>Your balance · Mock SKR</Txt>
            <Txt
              display
              style={s.balanceAmount}
              accessibilityLabel={
                balance ? `${displayAtomic(balance.amount, balance.decimals)} mock SKR` : undefined
              }
            >
              {balance
                ? `${displayAtomic(balance.amount, balance.decimals)} SKR`
                : loading
                  ? 'Loading…'
                  : '—'}
            </Txt>
          </View>
          {wallet.address && !!API_URL && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Refresh SKR balance"
              accessibilityState={{ disabled: loading, busy: loading }}
              disabled={loading}
              onPress={() => void refresh()}
              style={[s.balanceRefresh, loading && { opacity: 0.5 }]}
            >
              <Icon name="refresh-outline" color={c.lime} size={22} />
            </Pressable>
          )}
        </View>
        {!!balanceError ? (
          <Txt accessibilityRole="alert" style={s.balanceError}>
            {balanceError}
          </Txt>
        ) : loading && balance ? (
          <Txt style={s.small}>Updating balance…</Txt>
        ) : !wallet.address ? (
          <Txt style={s.small}>Connect your wallet to see your balance.</Txt>
        ) : portfolio?.gasLamports !== undefined ? (
          <Txt style={s.small}>{displayAtomic(portfolio.gasLamports, 9, 6)} SOL for network fees</Txt>
        ) : null}
      </View>
      <View style={s.stats}>
        {[
          [saved.length, 'Saved finds'],
          [following.length, 'Following'],
          [profile ? posts.length : '—', 'Posts'],
        ].map(([value, label]) => (
          <View key={label} style={{ alignItems: 'center', gap: 5 }}>
            <Txt display style={{ fontSize: 26, lineHeight: 34 }}>
              {value}
            </Txt>
            <Txt style={{ fontSize: 12, color: c.muted }}>{label}</Txt>
          </View>
        ))}
      </View>
      {wallet.address && (
        <Section
          title="Your investments"
          aside={<Txt style={s.small}>{portfolio?.positions.length ?? 0} positions</Txt>}
        >
          {portfolio?.positions.length ? (
            <View style={{ gap: 10 }}>
              {portfolio.positions.map((position, index) => {
                const post = mapPost(position.post, index)
                const positive =
                  position.profitLossQuoteAmount !== null && BigInt(position.profitLossQuoteAmount) >= 0n
                return (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Open investment in ${post.caption}`}
                    key={post.id}
                    onPress={() => onPost(post, 'sell')}
                    style={s.investment}
                  >
                    <Image source={imageSource(post.poster)} style={s.investmentImage} />
                    <View style={{ flex: 1, minWidth: 0, gap: 5 }}>
                      <Txt style={{ fontWeight: '700' }} numberOfLines={1}>
                        {post.caption}
                      </Txt>
                      <Txt style={s.small}>
                        {position.backingAvailable
                          ? `${displayAtomic(position.boughtQuoteAmount, balance?.decimals ?? 6)} SKR backed`
                          : 'Recorded backing unavailable'}
                      </Txt>
                      <Txt style={{ color: c.cream, fontSize: 12 }}>
                        {position.sellQuote
                          ? `${displayAtomic(position.sellQuote.expectedAmountOut, position.sellQuote.outputDecimals)} SKR now`
                          : 'Current value unavailable'}
                      </Txt>
                    </View>
                    <View style={s.investmentReturn}>
                      <Txt
                        numberOfLines={1}
                        adjustsFontSizeToFit
                        style={{
                          color: position.performanceAvailable ? (positive ? c.lime : c.orange) : c.muted,
                          fontWeight: '700',
                          fontSize: 12,
                        }}
                      >
                        {position.performanceAvailable && position.profitLossQuoteAmount
                          ? `${displaySignedAtomic(position.profitLossQuoteAmount, balance?.decimals ?? 6)} SKR`
                          : '—'}
                      </Txt>
                      <Txt
                        numberOfLines={2}
                        style={{
                          color: position.performanceAvailable ? (positive ? c.lime : c.orange) : c.muted,
                          fontSize: 11,
                          textAlign: 'right',
                        }}
                      >
                        {position.performanceAvailable && position.returnBps
                          ? displayBps(position.returnBps)
                          : 'Return unavailable'}
                      </Txt>
                    </View>
                    <Icon name="chevron-forward" color={c.muted} size={18} />
                  </Pressable>
                )
              })}
            </View>
          ) : (
            <Txt style={s.small}>
              {loading ? 'Checking your wallet…' : 'Your backed posts will appear here.'}
            </Txt>
          )}
        </Section>
      )}
      <LinkedAccounts onConnect={onConnect} />
      {config?.features.seekerVerification ? (
        <Section title="A little Seeker perk">
          <View style={s.reward}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <Icon name="gift-outline" size={30} color={c.yellow} />
              <Badge color={c.yellow}>SKR rewards</Badge>
            </View>
            <Txt display style={{ fontSize: 22, marginTop: 17 }}>
              Good finds deserve good things.
            </Txt>
            <Txt style={{ color: c.muted, fontSize: 13, marginTop: 10, marginBottom: 18 }}>
              Seeker holders can claim funded SKR campaigns. Each campaign has a fixed budget.
            </Txt>
            <Button secondary disabled={busy} onPress={() => void checkEligibility()}>
              {busy ? 'Checking…' : 'Check eligibility'}
            </Button>
            {!!eligibility && <Txt style={[s.small, { marginTop: 14 }]}>{eligibility}</Txt>}
            <RewardPanel onConnect={onConnect} />
          </View>
        </Section>
      ) : (
        <Section title="Devnet alpha">
          <View style={s.reward}>
            <Badge color={c.lime}>Test tokens only</Badge>
            <Txt style={[s.small, { marginTop: 14, marginBottom: 16 }]}>
              Try backing posts with mock SKR on Solana devnet. Test tokens have no real value. Seeker rewards
              are unavailable in this alpha.
            </Txt>
            {onFaucet && (
              <Button secondary onPress={onFaucet} icon="water-outline">
                Mint mock SKR
              </Button>
            )}
          </View>
        </Section>
      )}
      <Section
        title="Creator corner"
        aside={<Txt style={s.small}>{wallet.address ? `${posts.length} posts` : ''}</Txt>}
      >
        {wallet.address && posts.length ? (
          posts.map((post) => <CreatorPost key={post.id} post={post} blocked={blocked} onChanged={changed} />)
        ) : (
          <View style={s.emptyCreator}>
            <Icon name="color-wand-outline" color={c.pink} size={30} />
            <Txt style={{ fontWeight: '700' }}>Your next post starts a story.</Txt>
            <Txt style={s.small}>
              {wallet.address
                ? 'Publish a video in Create, then return here to launch its market and claim creator fees.'
                : 'Connect your wallet to manage your posts and creator fees.'}
            </Txt>
          </View>
        )}
      </Section>
      {wallet.address && (
        <Section title="Send a little love">
          <TipForm
            key={wallet.address}
            decimals={config?.quoteDecimals ?? 6}
            blocked={blocked}
            onChanged={changed}
          />
        </Section>
      )}
      {portfolio?.events.length ? (
        <Section title="Wallet activity">
          <View style={{ gap: 14 }}>
            {portfolio.events.slice(0, 5).map((event) => (
              <View key={`${event.signature}:${event.postId}`} style={s.activity}>
                <Icon
                  name={event.kind === 'buy' ? 'arrow-down-outline' : 'arrow-up-outline'}
                  color={event.kind === 'buy' ? c.lime : c.pink}
                />
                <View style={{ flex: 1 }}>
                  <Txt style={{ fontWeight: '700' }}>
                    {event.kind === 'buy' ? 'Backed a post' : 'Sold a position'}
                  </Txt>
                  <Txt style={s.small}>
                    {event.signature.slice(0, 8)}…{event.signature.slice(-6)}
                  </Txt>
                </View>
                <Txt>{displayAtomic(event.quoteAmount, balance?.decimals ?? 6)} Test SKR</Txt>
              </View>
            ))}
          </View>
        </Section>
      ) : null}
      <View style={s.network}>
        <View style={s.dot} />
        <Txt style={s.small}>Development preview · Devnet · Test SKR</Txt>
      </View>
      <Txt style={s.credits}>{mediaCredits}</Txt>
      {wallet.address && (
        <Button
          secondary
          onPress={() =>
            void wallet.disconnect().catch(() => notify('Could not disconnect the wallet. Try again.'))
          }
        >
          Disconnect wallet
        </Button>
      )}
    </ScrollView>
  )
}

const s = StyleSheet.create({
  content: { padding: 24, paddingTop: 30, maxWidth: 700, width: '100%', alignSelf: 'center' },
  identity: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 4,
  },
  name: { fontSize: 26, lineHeight: 34, marginTop: 20 },
  bio: { color: c.muted, marginTop: 7, marginBottom: 20 },
  stats: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 20,
    justifyContent: 'space-around',
    borderBottomWidth: 1,
    borderBottomColor: c.line,
    paddingVertical: 28,
    marginBottom: 30,
  },
  reward: { backgroundColor: c.surface, borderRadius: 22, padding: 22, borderWidth: 1, borderColor: c.line },
  balance: {
    backgroundColor: c.surface,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: c.line,
    padding: 14,
    gap: 5,
    marginTop: 4,
  },
  balanceRow: {
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  balanceAmount: { fontSize: 28, lineHeight: 36, color: c.lime },
  balanceRefresh: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 14 },
  balanceError: { fontSize: 12, lineHeight: 19, color: c.orange },
  pending: {
    gap: 13,
    marginVertical: 18,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.yellow,
    borderRadius: 18,
    padding: 18,
  },
  emptyCreator: { gap: 12, padding: 21, backgroundColor: c.surface, borderRadius: 20 },
  small: { fontSize: 12, color: c.muted, lineHeight: 19 },
  error: { fontSize: 13, color: c.orange, marginVertical: 13 },
  activity: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 9,
    borderBottomWidth: 1,
    borderBottomColor: c.line,
  },
  investment: {
    minHeight: 84,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    padding: 11,
    borderRadius: 16,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.line,
  },
  investmentImage: { width: 48, height: 64, borderRadius: 9, backgroundColor: c.line },
  investmentReturn: { width: 82, flexShrink: 1, alignItems: 'flex-end', gap: 5 },
  network: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: c.lime },
  credits: { fontSize: 11, color: c.muted, marginTop: 15, marginBottom: 25, lineHeight: 17 },
})
