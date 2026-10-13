import {
  AccessibilityInfo,
  Animated,
  Image,
  Pressable,
  RefreshControl,
  ScrollView,
  Share,
  StyleSheet,
  View,
} from 'react-native'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useApp } from '../lib/store'
import { useWallet } from '../lib/wallet'
import { api, API_URL } from '../lib/api'
import { displayAtomic } from '../lib/amounts'
import { mapPost, type Portfolio } from '../lib/contracts'
import { colors as c } from '../lib/theme'
import { Badge, Button, Empty, Icon, Txt } from '../components/ui'
import { Sheet } from '../components/sheets'
import { archivedPosts, imageSource, type Post } from '../lib/data'

type Position = Portfolio['positions'][number]

function Receipt({
  position,
  events,
  quoteDecimals,
  onClose,
}: {
  position: Position
  events: Portfolio['events']
  quoteDecimals: number
  onClose: () => void
}) {
  const { notify } = useApp()
  const [reveal] = useState(() => new Animated.Value(0))
  const post = mapPost(position.post)
  const purchase = events.filter((event) => event.postId === position.post.id && event.kind === 'buy').at(-1)
  useEffect(() => {
    let active = true
    void AccessibilityInfo.isReduceMotionEnabled()
      .then((reduced) => {
        if (!active) return
        if (reduced) reveal.setValue(1)
        else
          Animated.spring(reveal, {
            toValue: 1,
            damping: 15,
            stiffness: 110,
            mass: 0.8,
            useNativeDriver: true,
          }).start()
      })
      .catch(() => reveal.setValue(1))
    return () => {
      active = false
    }
  }, [reveal])
  async function share() {
    if (!purchase) return
    try {
      await Share.share({
        title: 'My Clout discovery',
        message: `I backed this on Clout: ${post.caption}\n${displayAtomic(purchase.quoteAmount, quoteDecimals)} Test SKR on devnet.\nSeek the best content, win SKR\nhttps://explorer.solana.com/tx/${purchase.signature}?cluster=devnet`,
      })
    } catch {
      notify('The receipt could not be shared. Try again.')
    }
  }
  return (
    <Sheet title="Keep the receipt" onClose={onClose}>
      <Animated.View
        style={[
          s.receipt,
          {
            opacity: reveal,
            transform: [
              { scale: reveal.interpolate({ inputRange: [0, 1], outputRange: [0.88, 1] }) },
              { rotate: reveal.interpolate({ inputRange: [0, 1], outputRange: ['-6deg', '-1deg'] }) },
            ],
          },
        ]}
      >
        <View style={s.receiptHeader}>
          <Txt display style={{ color: c.ink, fontSize: 26 }}>
            clout
          </Txt>
          <Icon name="sparkles" color={c.ink} />
        </View>
        <Image source={imageSource(post.poster)} style={s.receiptImage} />
        <View style={{ padding: 20, gap: 12 }}>
          <Badge color={c.pink}>{position.earlyBacker ? 'Confirmed backer' : 'Wallet-held position'}</Badge>
          <Txt display style={{ fontSize: 24, lineHeight: 31 }}>
            {post.caption}
          </Txt>
          <Txt style={{ color: c.muted }}>{post.creator}</Txt>
          {purchase ? (
            <>
              <Txt style={{ color: c.lime }}>
                Backed with {displayAtomic(purchase.quoteAmount, quoteDecimals)} Test SKR
              </Txt>
              <Txt style={s.small}>
                Received {displayAtomic(purchase.baseAmount, 6)} post tokens in this purchase.
              </Txt>
            </>
          ) : (
            <Txt style={s.small}>
              Ownership verified from your wallet. No Clout purchase receipt is recorded for this position.
            </Txt>
          )}
          <Txt style={s.small}>Devnet · A purchase receipt, not a separate NFT.</Txt>
        </View>
      </Animated.View>
      <Button onPress={() => void share()} disabled={!purchase} icon="share-social-outline">
        Share verified receipt
      </Button>
    </Sheet>
  )
}

type CollectionProps = {
  onConnect: () => void
  onPost: (post: Post, side?: 'buy' | 'sell') => void
  onExplore: () => void
}

export function Collection(props: CollectionProps) {
  const wallet = useWallet()
  return <WalletCollection key={wallet.address ?? 'guest'} {...props} />
}

function WalletCollection({ onConnect, onPost, onExplore }: CollectionProps) {
  const { posts, saved } = useApp()
  const wallet = useWallet()
  const [tab, setTab] = useState<'Saved' | 'Positions'>('Saved')
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null)
  const [loading, setLoading] = useState(!!wallet.address && !!API_URL)
  const [error, setError] = useState('')
  const [receipt, setReceipt] = useState<Position | null>(null)
  const generation = useRef(0)
  const items = [
    ...posts,
    ...archivedPosts.filter((post) => !posts.some((active) => active.id === post.id)),
  ].filter((post) => saved.includes(post.id))
  const load = useCallback(async () => {
    if (!wallet.address || !API_URL) return
    const version = ++generation.current
    try {
      const result = await api<Portfolio>('/v1/portfolio')
      if (version === generation.current) setPortfolio(result)
    } catch (err) {
      if (version !== generation.current) return
      setPortfolio(null)
      setError(err instanceof Error ? err.message : 'Could not load your collection.')
    } finally {
      if (version === generation.current) setLoading(false)
    }
  }, [wallet.address])
  useEffect(() => {
    void Promise.resolve().then(load)
  }, [load])
  async function refresh() {
    if (!wallet.address || !API_URL) return
    setLoading(true)
    setError('')
    await load()
  }
  const quotes = portfolio?.positions.map((position) => position.sellQuote) ?? []
  const quoteDecimals = portfolio?.balance?.decimals ?? 6
  const total =
    portfolio &&
    portfolio.valuationAvailable &&
    quotes.every((quote) => quote?.outputDecimals === quoteDecimals)
      ? quotes.reduce((sum, quote) => sum + BigInt(quote?.expectedAmountOut ?? '0'), 0n).toString()
      : null
  return (
    <>
      <ScrollView
        contentContainerStyle={s.content}
        refreshControl={
          <RefreshControl refreshing={loading} onRefresh={() => void refresh()} tintColor={c.lime} />
        }
      >
        <View style={s.heading}>
          <Txt display style={s.title}>
            Good taste.{'\n'}Keep the receipts.
          </Txt>
          <View style={s.sticker}>
            <Icon name="layers" size={35} color={c.ink} />
          </View>
        </View>
        <Txt style={s.subtitle}>Your finds, your positions, your collection.</Txt>
        <View style={s.balance}>
          <View>
            <Txt style={s.small}>Sell value · Test SKR</Txt>
            <Txt display style={{ fontSize: 36, lineHeight: 48 }}>
              {total !== null ? displayAtomic(total, quoteDecimals) : '—'}
            </Txt>
          </View>
          <View style={{ alignItems: 'flex-end', gap: 6 }}>
            <Txt style={s.small}>Devnet</Txt>
            <Txt style={{ fontSize: 12, color: c.lime }}>
              {loading ? 'Refreshing…' : 'Includes market fees'}
            </Txt>
          </View>
        </View>
        {!!error && (
          <Txt accessibilityRole="alert" style={s.error}>
            {error}
          </Txt>
        )}
        {wallet.address && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Refresh wallet positions"
            onPress={() => void refresh()}
            style={s.refresh}
          >
            <Icon name="refresh" size={15} color={c.muted} />
            <Txt style={s.small}>Refresh quotes and positions</Txt>
          </Pressable>
        )}
        <View style={s.tabs}>
          {(['Saved', 'Positions'] as const).map((value) => (
            <Pressable
              accessibilityRole="tab"
              aria-selected={tab === value}
              accessibilityState={{ selected: tab === value }}
              key={value}
              onPress={() => setTab(value)}
              style={[s.tab, tab === value && { borderBottomColor: c.pink }]}
            >
              <Txt style={{ fontWeight: '700', color: tab === value ? c.cream : c.muted }}>
                {value}
                {value === 'Saved'
                  ? ` (${items.length})`
                  : portfolio
                    ? ` (${portfolio.positions.length})`
                    : ''}
              </Txt>
            </Pressable>
          ))}
        </View>
        {tab === 'Saved' ? (
          items.length ? (
            <View style={s.grid}>
              {items.map((post, index) => (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Open saved post by ${post.creator}`}
                  key={post.id}
                  onPress={() => onPost(post)}
                  style={[
                    s.card,
                    { transform: [{ rotate: index % 2 ? '2deg' : '-2deg' }], borderColor: post.color },
                  ]}
                >
                  <View style={s.cardHeader}>
                    <Txt display style={{ fontSize: 11, color: post.color }}>
                      GOOD FIND
                    </Txt>
                    <Icon name="bookmark" size={14} color={post.color} />
                  </View>
                  <Image source={imageSource(post.poster)} style={s.image} />
                  <Txt style={{ fontWeight: '700', fontSize: 13, paddingHorizontal: 10 }} numberOfLines={2}>
                    {post.caption}
                  </Txt>
                  <Txt style={{ fontSize: 10, color: c.muted, padding: 10 }}>
                    Saved discovery · {post.creator}
                  </Txt>
                </Pressable>
              ))}
            </View>
          ) : (
            <Empty
              icon="bookmark-outline"
              title="A home for your good finds."
              action={<Button onPress={onExplore}>Find something worth saving</Button>}
            >
              Tap Save on a post and it’ll be waiting here.
            </Empty>
          )
        ) : !wallet.address ? (
          <Empty
            icon="wallet-outline"
            title="Your taste. Your wallet."
            action={
              <Button onPress={onConnect} icon="wallet-outline">
                Connect wallet
              </Button>
            }
          >
            Connect to see your post tokens, sell estimates and verified receipts.
          </Empty>
        ) : portfolio?.positions.length ? (
          <View style={{ gap: 20 }}>
            {portfolio.positions.map((position, index) => {
              const post = mapPost(position.post, index)
              return (
                <View key={post.id} style={[s.position, { borderColor: post.color }]}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Reveal receipt for ${post.caption}`}
                    onPress={() => setReceipt(position)}
                  >
                    <Image source={imageSource(post.poster)} style={s.positionImage} />
                    <View style={s.positionLabel}>
                      <Badge color={post.color}>
                        {position.earlyBacker ? 'Confirmed backer' : 'Wallet position'}
                      </Badge>
                      <Icon name="expand-outline" size={18} />
                    </View>
                  </Pressable>
                  <View style={{ padding: 18, gap: 12 }}>
                    <Txt display style={{ fontSize: 21 }} numberOfLines={2}>
                      {post.caption}
                    </Txt>
                    <Txt style={s.small}>{displayAtomic(position.amount, 6)} post tokens</Txt>
                    <View style={s.row}>
                      <Txt style={s.small}>Estimated sell value</Txt>
                      <Txt style={{ color: c.lime }}>
                        {position.sellQuote
                          ? `${displayAtomic(position.sellQuote.expectedAmountOut, position.sellQuote.outputDecimals)} Test SKR`
                          : 'Quote unavailable'}
                      </Txt>
                    </View>
                    <Button onPress={() => onPost(post, 'sell')} secondary icon="swap-horizontal">
                      Review a sale
                    </Button>
                  </View>
                </View>
              )
            })}
          </View>
        ) : (
          <Empty
            icon="layers-outline"
            title={loading ? 'Checking your wallet…' : 'Your first position is ahead.'}
            action={!loading ? <Button onPress={onExplore}>Explore posts</Button> : undefined}
          >
            {!API_URL
              ? 'Connect a Clout server to load your wallet collection.'
              : error
                ? 'Refresh to try again. Your tokens remain in your wallet.'
                : 'Back a launched post with Test SKR. Your confirmed position will appear here.'}
          </Empty>
        )}
        <View style={s.note}>
          <Icon name="information-circle-outline" size={18} color={c.muted} />
          <Txt style={{ fontSize: 12, color: c.muted, flex: 1 }}>
            Saved posts are bookmarks. Post tokens stay in your wallet. Sell quotes may change before you
            approve a transaction.
          </Txt>
        </View>
      </ScrollView>
      {receipt && portfolio && (
        <Receipt
          position={receipt}
          events={portfolio.events}
          quoteDecimals={quoteDecimals}
          onClose={() => setReceipt(null)}
        />
      )}
    </>
  )
}

const s = StyleSheet.create({
  content: { padding: 24, paddingTop: 34, maxWidth: 820, width: '100%', alignSelf: 'center' },
  heading: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 16,
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: { fontSize: 32, lineHeight: 40, flexBasis: 220, flexGrow: 1, flexShrink: 1, minWidth: 0 },
  sticker: {
    backgroundColor: c.lime,
    width: 66,
    height: 72,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    transform: [{ rotate: '9deg' }],
  },
  subtitle: { color: c.muted, marginTop: 13, marginBottom: 26 },
  balance: {
    backgroundColor: c.surface,
    borderRadius: 20,
    padding: 22,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 16,
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: c.line,
  },
  tabs: { flexDirection: 'row', flexWrap: 'wrap', gap: 20, marginTop: 18, marginBottom: 28 },
  tab: { paddingVertical: 15, borderBottomWidth: 3, borderBottomColor: 'transparent' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 22, padding: 7, paddingBottom: 28 },
  card: {
    width: '45%',
    minWidth: 135,
    backgroundColor: c.surface,
    borderWidth: 2,
    borderRadius: 16,
    overflow: 'hidden',
    gap: 10,
  },
  cardHeader: {
    paddingHorizontal: 12,
    paddingTop: 10,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  image: { height: 180, width: '100%' },
  note: { flexDirection: 'row', gap: 9, marginTop: 20, padding: 16 },
  small: { color: c.muted, fontSize: 12 },
  error: { color: c.orange, marginTop: 15 },
  refresh: { flexDirection: 'row', justifyContent: 'flex-end', gap: 6, paddingTop: 14 },
  position: { backgroundColor: c.surface, borderWidth: 1, borderRadius: 20, overflow: 'hidden' },
  positionImage: { width: '100%', height: 220 },
  positionLabel: {
    position: 'absolute',
    bottom: 14,
    left: 14,
    right: 14,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' },
  receipt: {
    margin: 10,
    marginBottom: 25,
    backgroundColor: c.surface,
    borderWidth: 3,
    borderColor: c.lime,
    borderRadius: 20,
    overflow: 'hidden',
  },
  receiptHeader: {
    padding: 17,
    backgroundColor: c.lime,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  receiptImage: { width: '100%', height: 230 },
})
