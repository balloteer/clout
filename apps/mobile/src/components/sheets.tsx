import { useEffect, useRef, useState } from 'react'
import {
  Image,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { colors as c, fonts } from '../lib/theme'
import { useWallet } from '../lib/wallet'
import { walletConnectionError } from '../lib/wallet-errors'
import { useApp } from '../lib/store'
import { api, API_URL, postJson } from '../lib/api'
import { sampleComments, imageSource, type Post } from '../lib/data'
import { displayAtomic, isQuoteExpired, toAtomic } from '../lib/amounts'
import {
  confirmPending,
  executeIntent,
  getPending,
  type BuiltIntent,
  type PendingTransaction,
  type TransactionResult,
} from '../lib/transactions'
import { Avatar, Badge, Button, Icon, Txt } from './ui'
import { InvestmentChart } from './investment-chart'
import type { ApiProfile } from '../lib/contracts'
type Quote = {
  id: string
  expectedAmountOut: string
  minimumAmountOut: string
  outputDecimals: number
  inputDecimals: number
  feeAmount: string
  expiresAt: string
  route: string
  priceImpactPercent: string | null
}
export function Sheet({
  title,
  onClose,
  children,
}: {
  title: string
  onClose: () => void
  children: React.ReactNode
}) {
  const insets = useSafeAreaInsets()
  return (
    <Modal transparent animationType="slide" onRequestClose={onClose} visible>
      <KeyboardAvoidingView
        style={s.overlay}
        enabled={Platform.OS !== 'web'}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={Platform.OS === 'android' ? insets.top : 0}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close dialog"
          onPress={onClose}
          style={StyleSheet.absoluteFill}
        />
        <View accessibilityViewIsModal accessibilityLabel={title} style={s.sheet}>
          <View style={s.handle} />
          <View style={s.header}>
            <Txt display style={{ fontSize: 23, flex: 1, flexShrink: 1, minWidth: 0 }}>
              {title}
            </Txt>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close"
              onPress={onClose}
              style={s.close}
            >
              <Icon name="close" />
            </Pressable>
          </View>
          <ScrollView
            style={s.sheetScroll}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
            contentContainerStyle={{ paddingBottom: Math.max(30, insets.bottom + 16) }}
          >
            {children}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  )
}
export function ConnectSheet({ onClose }: { onClose: () => void }) {
  const wallet = useWallet()
  const [error, setError] = useState('')
  async function connect() {
    setError('')
    try {
      await wallet.connect()
      onClose()
    } catch (err) {
      const message = walletConnectionError(err, { native: wallet.native, apiUrl: API_URL })
      if (message !== null) setError(message)
    }
  }
  return (
    <Sheet title="Your taste. Your wallet." onClose={onClose}>
      <View style={{ alignItems: 'center', gap: 18, paddingVertical: 24 }}>
        <Image
          source={require('../../assets/brand/icon.png')}
          style={{ width: 80, height: 80, borderRadius: 19 }}
        />
        <Txt style={{ color: c.muted, textAlign: 'center' }}>
          Sign in with your Seeker’s built-in wallet. Other wallets are not supported.
        </Txt>
        <Badge>Devnet · Test SKR</Badge>
      </View>
      <Button
        onPress={() => void connect()}
        disabled={wallet.busy || !wallet.connectAvailable}
        icon="wallet-outline"
      >
        {wallet.busy
          ? 'Check your Seeker wallet…'
          : wallet.connectAvailable
            ? 'Connect Seeker wallet'
            : 'Open on Seeker'}
      </Button>
      {!!wallet.connectUnavailableReason && <Txt style={s.helper}>{wallet.connectUnavailableReason}</Txt>}
      {!!error && (
        <Txt accessibilityRole="alert" style={s.error}>
          {error}
        </Txt>
      )}
      <Txt style={s.helper}>
        Connection proves wallet ownership. Every trade needs a separate approval. SOL is used only for
        network fees.
      </Txt>
    </Sheet>
  )
}
type MarketSheetProps = {
  post: Post
  onClose: () => void
  onConnect: () => void
  initialSide?: 'buy' | 'sell'
}
export function MarketSheet(props: MarketSheetProps) {
  const wallet = useWallet()
  return (
    <WalletMarketSheet
      key={`${wallet.address ?? 'guest'}:${props.post.id}:${props.initialSide ?? 'buy'}`}
      {...props}
    />
  )
}
function WalletMarketSheet({ post, onClose, onConnect, initialSide = 'buy' }: MarketSheetProps) {
  const wallet = useWallet()
  const { notify } = useApp()
  const [side, setSide] = useState<'buy' | 'sell'>(initialSide)
  const [amount, setAmount] = useState('10')
  const [quote, setQuote] = useState<Quote | null>(null)
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [pending, setPending] = useState<PendingTransaction | null>(null)
  const [decimals, setDecimals] = useState(6)
  const [configReady, setConfigReady] = useState(false)
  const [activityRevision, setActivityRevision] = useState(0)
  const action = useRef(false)
  useEffect(() => {
    let active = true
    if (wallet.address)
      void getPending(wallet.address)
        .then((saved) => {
          if (active) {
            setPending(saved)
            if (saved) {
              setStatus(`${saved.description ?? 'A signed wallet transaction'} needs confirmation.`)
            }
          }
        })
        .catch(
          () =>
            active &&
            setError(
              'Could not restore your pending transaction. Check wallet activity before trading again.',
            ),
        )
    if (post.market)
      void api<{ network: string; quoteDecimals: number; features: { trading: boolean } }>('/v1/config')
        .then((config) => {
          if (active) {
            const ready = config.network === 'devnet' && config.features.trading
            setDecimals(config.quoteDecimals)
            setConfigReady(ready)
            if (!ready)
              setStatus(
                'This devnet market is created. Trading opens when the Clout market service is connected.',
              )
          }
        })
        .catch((err) => {
          if (active)
            setError(
              err instanceof Error
                ? err.message
                : 'Market configuration is unavailable. Reopen this post to retry.',
            )
        })
    return () => {
      active = false
    }
  }, [post.id, post.market, wallet.address])
  function changeAmount(value: string) {
    if (action.current || pending) return
    setAmount(value)
    setQuote(null)
    setError('')
  }
  function changeSide(value: 'buy' | 'sell') {
    if (action.current || pending) return
    setSide(value)
    setQuote(null)
    setError('')
  }
  function report(result: TransactionResult, description: string) {
    if (result.status === 'confirmed') {
      setActivityRevision((value) => value + 1)
      setStatus(`${description} confirmed on devnet.`)
      notify(`${description} confirmed.`)
    } else if (result.status === 'failed' || result.status === 'expired') {
      setStatus(`Transaction ${result.status}. Review a new request to try again.`)
    } else setStatus('Confirmation is still pending; it is safe to check again.')
  }
  async function restorePending() {
    if (!wallet.address) return
    try {
      const saved = await getPending(wallet.address)
      setPending(saved)
      if (saved) setQuote(null)
    } catch {
      setError('Could not read transaction recovery. Check wallet activity before proceeding.')
    }
  }
  async function check(p: PendingTransaction) {
    if (action.current) return
    action.current = true
    setBusy(true)
    setError('')
    try {
      if (p.owner !== wallet.address) throw new Error('Connect the wallet that signed this transaction.')
      report(await confirmPending(p.owner), p.description ?? 'Wallet transaction')
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Confirmation unavailable. Your transaction may still settle.',
      )
    } finally {
      await restorePending()
      action.current = false
      setBusy(false)
    }
  }
  async function getQuote() {
    if (action.current || pending || !configReady) return
    if (!wallet.address) {
      onConnect()
      return
    }
    action.current = true
    setBusy(true)
    setError('')
    try {
      const previous = await getPending(wallet.address)
      if (previous) {
        setPending(previous)
        setStatus('A previous transaction needs confirmation before another trade.')
        return
      }
      const result = await postJson<Quote>(`/v1/posts/${post.id}/quote`, {
        side,
        amountIn: toAtomic(amount, side === 'buy' ? decimals : 6),
        slippageBps: 100,
      })
      setQuote(result)
      setStatus('Review the quote before opening your wallet.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not get a quote')
    } finally {
      action.current = false
      setBusy(false)
    }
  }
  async function trade() {
    if (action.current || !quote || pending) return
    if (isQuoteExpired(quote.expiresAt)) {
      setQuote(null)
      setError('This quote expired. Get a fresh quote before signing.')
      return
    }
    action.current = true
    setBusy(true)
    setError('')
    try {
      if (!wallet.address) throw new Error('Connect your wallet first.')
      const previous = await getPending(wallet.address)
      if (previous) {
        setPending(previous)
        throw new Error('Check your previous transaction before submitting another.')
      }
      const built = await postJson<BuiltIntent>('/v1/trades/build', { quoteId: quote.id })
      if (isQuoteExpired(quote.expiresAt)) {
        setQuote(null)
        throw new Error('This quote expired while preparing the transaction. Request a fresh quote.')
      }
      setStatus('Approve the transaction in your wallet.')
      const description = side === 'buy' ? 'Post backing' : 'Position sale'
      const result = await executeIntent(built, wallet, description)
      setQuote(null)
      report(result, description)
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'The transaction could not be completed. Check its status before retrying.',
      )
    } finally {
      await restorePending()
      action.current = false
      setBusy(false)
    }
  }
  return (
    <Sheet title="Video investments" onClose={onClose}>
      <View style={s.post}>
        <Image source={imageSource(post.poster)} style={s.thumb} />
        <View style={{ flex: 1, gap: 5 }}>
          <Txt style={{ fontWeight: '700' }}>{post.creator}</Txt>
          <Txt numberOfLines={2} style={{ fontSize: 12, color: c.muted }}>
            {post.caption}
          </Txt>
        </View>
      </View>
      {!!post.source && post.market && (
        <Txt style={s.marketAttribution}>Clout demo market · Independent of the source publisher.</Txt>
      )}
      {!post.market ? (
        <View style={s.marketEmpty}>
          <Icon name="sparkles-outline" size={34} color={c.pink} />
          <Txt display style={{ fontSize: 22 }}>
            Catch the next beginning.
          </Txt>
          <Txt style={{ color: c.muted, textAlign: 'center' }}>
            This {post.source ? 'curated ' : post.sample ? 'sample ' : ''}post has no market. Once a creator
            launches, you can back it with SKR and see your position here.
          </Txt>
          <Badge color={c.surface}>
            <Txt style={{ color: c.muted, fontSize: 11 }}>No wallet transaction · No simulated returns</Txt>
          </Badge>
        </View>
      ) : (
        <>
          <InvestmentChart postId={post.id} revision={activityRevision} />
          <View style={s.tradeTabs}>
            {(['buy', 'sell'] as const).map((value) => (
              <Pressable
                accessibilityRole="tab"
                aria-selected={side === value}
                disabled={busy || !!pending}
                accessibilityState={{ selected: side === value }}
                key={value}
                onPress={() => changeSide(value)}
                style={[s.tradeTab, side === value && { backgroundColor: c.cream }]}
              >
                <Txt style={{ color: side === value ? c.ink : c.muted, fontWeight: '700' }}>
                  {value === 'buy' ? 'Back this' : 'Sell position'}
                </Txt>
              </Pressable>
            ))}
          </View>
          <View style={s.amount}>
            <TextInput
              accessibilityLabel={side === 'buy' ? 'SKR amount' : 'Post token amount'}
              keyboardType="decimal-pad"
              editable={!busy && !pending}
              value={amount}
              onChangeText={changeAmount}
              style={s.amountInput}
            />
            <Txt display style={{ fontSize: 22, color: c.lime, flexShrink: 0 }}>
              {side === 'buy' ? 'Mock SKR' : 'Post tokens'}
            </Txt>
          </View>
          <View style={s.presets}>
            {['10', '25', '50', '100'].map((value) => (
              <Pressable
                accessibilityRole="button"
                disabled={busy || !!pending}
                key={value}
                onPress={() => changeAmount(value)}
                style={s.preset}
              >
                <Txt style={{ fontSize: 13 }}>{value}</Txt>
              </Pressable>
            ))}
          </View>
          {quote && (
            <View style={s.quote}>
              <Row
                label="Estimated receive"
                value={`${displayAtomic(quote.expectedAmountOut, quote.outputDecimals)} ${side === 'buy' ? 'post tokens' : 'Test SKR'}`}
              />
              <Row
                label="Minimum receive"
                value={displayAtomic(quote.minimumAmountOut, quote.outputDecimals)}
              />
              <Row label="Slippage limit" value="1%" />
              <Row
                label="Route"
                value={quote.route === 'dbc' ? 'Meteora bonding curve' : 'Meteora DAMM v2'}
              />
              <Row label="Network fee" value="SOL · shown by wallet" />
            </View>
          )}
          <Button
            disabled={busy || (!pending && !configReady)}
            onPress={() => void (pending ? check(pending) : quote ? trade() : getQuote())}
          >
            {busy ? 'Working…' : pending ? 'Check transaction' : quote ? 'Approve in wallet' : 'Get quote'}
          </Button>
        </>
      )}
      {pending && !post.market && (
        <Button disabled={busy} onPress={() => void check(pending)}>
          Check pending transaction
        </Button>
      )}
      {!!status && <Txt style={s.helper}>{status}</Txt>}
      {!!error && (
        <Txt accessibilityRole="alert" style={s.error}>
          {error}
        </Txt>
      )}
      <View style={s.footer}>
        <Icon name="information-circle-outline" size={17} color={c.muted} />
        <Txt style={{ color: c.muted, fontSize: 11, flex: 1 }}>
          Devnet · Mock SKR. Views don’t determine prices. SOL pays network fees.
        </Txt>
      </View>
    </Sheet>
  )
}
export function CommentsSheet({
  post,
  onClose,
  onConnect,
}: {
  post: Post
  onClose: () => void
  onConnect: () => void
}) {
  const wallet = useWallet()
  const { refresh } = useApp()
  const [items, setItems] = useState<
    { id: string; name: string; text: string; backer?: boolean; address?: string }[]
  >(sampleComments[post.id] ?? [])
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  async function send() {
    if (!wallet.address) {
      onConnect()
      return
    }
    if (!API_URL) {
      setError('Connect the Clout service to join this discussion.')
      return
    }
    setBusy(true)
    setError('')
    try {
      const result = await postJson<{ comments: ApiComment[] }>(`/v1/posts/${post.id}/comments`, {
        body: draft.trim(),
      })
      setItems(result.comments.map(presentComment))
      setDraft('')
      void refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not post comment')
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => {
    let active = true
    if (API_URL && !post.source)
      void api<{ comments: ApiComment[] }>(`/v1/posts/${post.id}/comments`)
        .then((result) => {
          if (active) setItems(result.comments.map(presentComment))
        })
        .catch(() => {
          if (active) setError('Could not load comments. Try reopening this post.')
        })
    return () => {
      active = false
    }
  }, [post.id, post.sample, post.source])
  if (post.source) {
    const source = post.source
    return (
      <Sheet title="Original conversation" onClose={onClose}>
        <Txt style={s.helper}>
          This video was shared by @{source.handle}. Join the conversation on their original post.
        </Txt>
        <Button
          onPress={() =>
            void Linking.openURL(source.url).catch(() => setError('Could not open the original post.'))
          }
        >
          View conversation on X
        </Button>
        {!!error && <Txt style={s.error}>{error}</Txt>}
      </Sheet>
    )
  }
  return (
    <Sheet title={`The conversation (${items.length})`} onClose={onClose}>
      {post.sample && <Txt style={s.helper}>Sample discussion</Txt>}
      <View style={{ gap: 23, paddingVertical: 20 }}>
        {items.map((item, index) => (
          <View key={item.id} style={{ flexDirection: 'row', gap: 11 }}>
            <Avatar letter={item.name} color={index % 2 ? c.pink : c.lime} size={34} />
            <View style={{ flex: 1 }}>
              <Txt style={{ fontWeight: '700', fontSize: 13 }}>{item.name}</Txt>
              {item.address && item.name !== item.address && (
                <Txt style={{ fontSize: 10, color: c.muted }}>{item.address}</Txt>
              )}
              {item.backer && <Badge color={c.lime}>Confirmed backer</Badge>}
              <Txt style={{ color: c.muted, fontSize: 14, marginTop: 3 }}>{item.text}</Txt>
            </View>
          </View>
        ))}
      </View>
      <TextInput
        accessibilityLabel="Your comment"
        placeholder={!API_URL ? 'Comments open when Clout is connected' : 'You saw it here first…'}
        placeholderTextColor={c.muted}
        value={draft}
        editable={!!API_URL && !busy}
        maxLength={500}
        onChangeText={setDraft}
        style={s.comment}
      />
      <Button onPress={() => void send()} disabled={!API_URL || busy || !draft.trim()}>
        Post comment
      </Button>
      {!!error && <Txt style={s.error}>{error}</Txt>}
    </Sheet>
  )
}
type ApiComment = {
  id: string
  wallet: string
  body: string
  creator?: ApiProfile | null
  earlyBacker?: boolean
}
function presentComment(item: ApiComment) {
  const address = `${item.wallet.slice(0, 4)}…${item.wallet.slice(-4)}`
  return {
    id: item.id,
    name: item.creator?.handle ?? address,
    address,
    text: item.body,
    backer: item.earlyBacker === true,
  }
}
function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 16 }}>
      <Txt style={{ fontSize: 12, color: c.muted }}>{label}</Txt>
      <Txt style={{ fontSize: 12, fontWeight: '600' }}>{value}</Txt>
    </View>
  )
}
const s = StyleSheet.create({
  overlay: {
    flex: 1,
    width: '100%',
    backgroundColor: 'rgba(0,0,0,.72)',
    justifyContent: Platform.OS === 'web' ? 'center' : 'flex-end',
    alignItems: 'center',
  },
  sheet: {
    width: '100%',
    maxWidth: 490,
    maxHeight: '90%',
    backgroundColor: c.ink,
    borderRadius: 26,
    paddingHorizontal: 24,
    borderWidth: 1,
    borderColor: c.line,
  },
  sheetScroll: { flexShrink: 1 },
  handle: {
    height: 4,
    width: 35,
    backgroundColor: c.line,
    borderRadius: 5,
    alignSelf: 'center',
    marginTop: 11,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingVertical: 19,
  },
  close: {
    width: 48,
    height: 48,
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.surface,
    borderRadius: 24,
  },
  helper: { fontSize: 13, color: c.muted, textAlign: 'center', marginVertical: 15 },
  error: { fontSize: 13, color: c.orange, marginTop: 16, lineHeight: 20 },
  post: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 10 },
  thumb: { width: 44, height: 52, borderRadius: 10 },
  marketAttribution: { fontSize: 10, lineHeight: 14, color: c.muted, marginBottom: 12 },
  tradeTabs: { backgroundColor: c.surface, borderRadius: 13, padding: 4, flexDirection: 'row' },
  tradeTab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
    padding: 10,
    borderRadius: 10,
  },
  marketEmpty: { alignItems: 'center', paddingVertical: 30, gap: 18 },
  amount: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
  amountInput: { fontFamily: fonts.display, color: c.cream, fontSize: 43, flex: 1, minWidth: 0 },
  presets: { flexDirection: 'row', gap: 10, marginBottom: 12 },
  preset: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
    backgroundColor: c.surface,
    borderRadius: 10,
    padding: 10,
  },
  quote: { gap: 14, marginBottom: 25, backgroundColor: c.surface, borderRadius: 16, padding: 16 },
  footer: {
    flexDirection: 'row',
    gap: 8,
    borderTopWidth: 1,
    borderColor: c.line,
    paddingTop: 19,
    marginTop: 12,
  },
  comment: {
    fontFamily: fonts.body,
    color: c.cream,
    fontSize: 14,
    backgroundColor: c.surface,
    padding: 16,
    borderRadius: 14,
    marginBottom: 15,
  },
})
