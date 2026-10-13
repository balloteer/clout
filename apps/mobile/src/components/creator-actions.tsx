import { useState } from 'react'
import { Image, StyleSheet, TextInput, View } from 'react-native'
import { postJson } from '../lib/api'
import { toAtomic, displayAtomic } from '../lib/amounts'
import type { ApiPost } from '../lib/contracts'
import { useWallet } from '../lib/wallet'
import { executeIntent, type BuiltIntent } from '../lib/transactions'
import { colors as c, fonts } from '../lib/theme'
import { Badge, Button, Icon, Txt } from './ui'

type LaunchIntent = BuiltIntent & { metadataName?: string; metadataSymbol?: string }

function resultMessage(status: string, action: string) {
  if (status === 'confirmed') return `${action} confirmed on devnet.`
  if (status === 'pending') return 'Submitted. Check the pending transaction above before continuing.'
  return `Transaction ${status}. Refresh and try again.`
}

export function CreatorPost({
  post,
  blocked,
  onChanged,
}: {
  post: ApiPost
  blocked: boolean
  onChanged: () => Promise<void>
}) {
  const wallet = useWallet()
  const [expanded, setExpanded] = useState(false)
  const [name, setName] = useState('')
  const [symbol, setSymbol] = useState('')
  const [built, setBuilt] = useState<LaunchIntent | null>(null)
  const [claims, setClaims] = useState<BuiltIntent[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const isReady = !post.status || post.status === 'ready'
  async function prepareLaunch() {
    setBusy(true)
    setError('')
    try {
      setBuilt(
        await postJson<LaunchIntent>(`/v1/posts/${post.id}/launch`, {
          name: name.trim(),
          symbol: symbol.trim(),
        }),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Market launch is unavailable.')
    } finally {
      setBusy(false)
    }
  }
  async function prepareClaim() {
    setBusy(true)
    setError('')
    try {
      const result = await postJson<{ transactions: BuiltIntent[] }>(`/v1/posts/${post.id}/fees/build`, {})
      setClaims(result.transactions)
      setMessage(
        result.transactions.length
          ? `${result.transactions.length} fee claim${result.transactions.length === 1 ? '' : 's'} ready for wallet review.`
          : 'No accumulated fees are available to claim.',
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Fee claims are unavailable.')
    } finally {
      setBusy(false)
    }
  }
  async function approve(intent: BuiltIntent, kind: 'launch' | 'claim') {
    setBusy(true)
    setError('')
    try {
      const result = await executeIntent(
        intent,
        wallet,
        kind === 'launch' ? 'Launch post market' : 'Claim creator fees',
      )
      setMessage(resultMessage(result.status, kind === 'launch' ? 'Market launch' : 'Creator fee claim'))
      if (kind === 'launch') setBuilt(null)
      else setClaims((values) => values.filter((value) => value.intentId !== intent.intentId))
    } catch (err) {
      if (kind === 'launch') setBuilt(null)
      else setClaims((values) => values.filter((value) => value.intentId !== intent.intentId))
      setError(err instanceof Error ? err.message : 'Check your pending transaction before retrying.')
    } finally {
      setBusy(false)
      await onChanged()
    }
  }
  return (
    <View style={s.post}>
      <View style={s.postHeading}>
        {post.thumbnailUrl ? (
          <Image source={{ uri: post.thumbnailUrl }} style={s.thumbnail} />
        ) : (
          <View style={[s.thumbnail, { alignItems: 'center', justifyContent: 'center' }]}>
            <Icon name="videocam-outline" color={c.pink} />
          </View>
        )}
        <View style={{ flex: 1, gap: 8 }}>
          <Txt numberOfLines={2} style={{ fontWeight: '700' }}>
            {post.caption}
          </Txt>
          <Badge color={post.market ? c.lime : c.yellow}>
            {post.market
              ? 'Market launched'
              : post.status === 'processing'
                ? 'Processing video'
                : post.status === 'failed'
                  ? 'Video processing failed'
                  : 'Video only'}
          </Badge>
        </View>
      </View>
      {post.market ? (
        <>
          <Button
            secondary
            disabled={busy || blocked}
            onPress={() => void prepareClaim()}
            icon="download-outline"
          >
            {busy ? 'Checking fees…' : 'Check creator fees'}
          </Button>
          {claims.map((intent, index) => (
            <Button
              key={intent.intentId}
              disabled={busy || blocked}
              onPress={() => void approve(intent, 'claim')}
            >
              Approve claim {index + 1} in wallet
            </Button>
          ))}
        </>
      ) : (
        <>
          {!isReady ? (
            <Txt style={s.helper}>
              {post.status === 'processing'
                ? 'Your video is being prepared. Refresh to check when it is ready to launch.'
                : 'This video could not be prepared. Upload it again from Create before launching a market.'}
            </Txt>
          ) : !expanded ? (
            <Button secondary disabled={blocked} onPress={() => setExpanded(true)} icon="sparkles-outline">
              Launch this post
            </Button>
          ) : (
            <View style={{ gap: 12 }}>
              <Txt style={s.helper}>
                Create this post’s market with Test SKR. Launching is a separate wallet transaction.
              </Txt>
              <TextInput
                accessibilityLabel="Post market name"
                placeholder="Market name"
                placeholderTextColor={c.muted}
                value={name}
                editable={!busy}
                onChangeText={(value) => {
                  setName(value)
                  setBuilt(null)
                }}
                maxLength={32}
                style={s.input}
              />
              <TextInput
                accessibilityLabel="Post market ticker"
                placeholder="Ticker, e.g. CLIP"
                placeholderTextColor={c.muted}
                value={symbol}
                editable={!busy}
                onChangeText={(value) => {
                  setSymbol(value.toUpperCase().replace(/[^A-Z0-9]/g, ''))
                  setBuilt(null)
                }}
                maxLength={10}
                autoCapitalize="characters"
                style={s.input}
              />
              {built ? (
                <>
                  {!!built.metadataName && (
                    <Txt style={{ fontWeight: '700' }}>
                      {built.metadataName} · {built.metadataSymbol}
                    </Txt>
                  )}
                  <Txt style={s.helper}>
                    Fixed supply: 1 billion post tokens. Trading fee: 1%. Test SKR backs the market; SOL
                    covers account creation and network fees.
                  </Txt>
                  <Button disabled={busy || blocked} onPress={() => void approve(built, 'launch')}>
                    Approve launch in wallet
                  </Button>
                </>
              ) : (
                <Button
                  disabled={busy || blocked || !name.trim() || !symbol.trim()}
                  onPress={() => void prepareLaunch()}
                >
                  {busy ? 'Preparing…' : 'Review market launch'}
                </Button>
              )}
            </View>
          )}
        </>
      )}
      {!!message && <Txt style={s.helper}>{message}</Txt>}
      {!!error && (
        <Txt accessibilityRole="alert" style={s.error}>
          {error}
        </Txt>
      )}
    </View>
  )
}

function newRequestId() {
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

type TipIntent = BuiltIntent & { recipient: string; amountIn: string; quoteDecimals: number }
export function TipForm({
  decimals,
  blocked,
  onChanged,
}: {
  decimals: number
  blocked: boolean
  onChanged: () => Promise<void>
}) {
  const wallet = useWallet()
  const [recipient, setRecipient] = useState('')
  const [amount, setAmount] = useState('1')
  const [requestId, setRequestId] = useState<string | null>(null)
  const [built, setBuilt] = useState<TipIntent | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  function invalidate() {
    setBuilt(null)
    setRequestId(null)
    setMessage('')
    setError('')
  }
  async function prepare() {
    setBusy(true)
    setError('')
    try {
      const id = requestId ?? newRequestId()
      setRequestId(id)
      setBuilt(
        await postJson<TipIntent>('/v1/tips/build', {
          recipient: recipient.trim(),
          amountIn: toAtomic(amount, decimals),
          requestId: id,
        }),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not prepare your tip.')
    } finally {
      setBusy(false)
    }
  }
  async function approve() {
    if (!built) return
    setBusy(true)
    setError('')
    try {
      const result = await executeIntent(built, wallet, 'Send SKR tip')
      setMessage(resultMessage(result.status, 'SKR tip'))
      setBuilt(null)
      setRequestId(null)
    } catch (err) {
      setBuilt(null)
      setRequestId(null)
      setError(err instanceof Error ? err.message : 'Check the pending transaction before retrying.')
    } finally {
      setBusy(false)
      await onChanged()
    }
  }
  return (
    <View style={s.post}>
      <Txt style={s.helper}>
        Send Test SKR directly to a creator’s wallet. SOL pays network fees and any new token account rent.
      </Txt>
      <TextInput
        accessibilityLabel="Tip recipient wallet address"
        placeholder="Recipient wallet address"
        placeholderTextColor={c.muted}
        autoCapitalize="none"
        autoCorrect={false}
        value={recipient}
        editable={!busy}
        onChangeText={(value) => {
          setRecipient(value)
          invalidate()
        }}
        style={s.input}
      />
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
        <TextInput
          accessibilityLabel="Tip amount in SKR"
          keyboardType="decimal-pad"
          value={amount}
          editable={!busy}
          onChangeText={(value) => {
            setAmount(value)
            invalidate()
          }}
          style={[s.input, { flex: 1 }]}
        />
        <Txt style={{ color: c.lime }}>Test SKR</Txt>
      </View>
      {built && (
        <View style={s.preview}>
          <Txt style={{ fontWeight: '700' }}>
            Send {displayAtomic(built.amountIn, built.quoteDecimals)} Test SKR
          </Txt>
          <Txt selectable style={s.helper}>
            To {built.recipient}
          </Txt>
          <Badge>Devnet</Badge>
        </View>
      )}
      <Button
        disabled={blocked || busy || !recipient.trim() || !amount.trim()}
        onPress={() => void (built ? approve() : prepare())}
        icon="heart-outline"
      >
        {busy ? 'Working…' : built ? 'Approve tip in wallet' : 'Review tip'}
      </Button>
      {!!message && <Txt style={s.helper}>{message}</Txt>}
      {!!error && (
        <Txt accessibilityRole="alert" style={s.error}>
          {error}
        </Txt>
      )}
    </View>
  )
}

const s = StyleSheet.create({
  post: {
    padding: 18,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.line,
    borderRadius: 20,
    gap: 15,
  },
  postHeading: { flexDirection: 'row', gap: 13, alignItems: 'center' },
  thumbnail: { width: 58, height: 76, borderRadius: 12, backgroundColor: c.ink },
  helper: { fontSize: 12, color: c.muted, lineHeight: 19 },
  error: { fontSize: 13, color: c.orange, lineHeight: 20 },
  input: {
    fontFamily: fonts.body,
    fontSize: 14,
    color: c.cream,
    padding: 14,
    borderWidth: 1,
    borderColor: c.line,
    backgroundColor: c.ink,
    borderRadius: 13,
  },
  preview: { gap: 10, borderLeftWidth: 3, borderLeftColor: c.lime, paddingLeft: 14 },
})
