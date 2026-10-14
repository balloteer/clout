import { useEffect, useState } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import Svg, { Circle, Line, Polyline } from 'react-native-svg'
import { api } from '../lib/api'
import { investmentCoordinates, signedInvestmentAmount, type InvestmentActivity } from '../lib/investments'
import { colors as c } from '../lib/theme'
import { Icon, Txt } from './ui'

export function InvestmentChart({
  postId,
  revision = 0,
  compact = false,
}: {
  postId: string
  revision?: number
  compact?: boolean
}) {
  const [activity, setActivity] = useState<InvestmentActivity | null>(null)
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState(true)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let active = true
    let inFlight = false
    async function load() {
      if (inFlight) return
      inFlight = true
      if (active) setRefreshing(true)
      try {
        const value = await api<InvestmentActivity>(`/v1/posts/${encodeURIComponent(postId)}/activity`)
        if (active) {
          setActivity(value)
          setError('')
        }
      } catch {
        if (active) setError('Investment data could not refresh. Try again.')
      } finally {
        inFlight = false
        if (active) setRefreshing(false)
      }
    }
    void load()
    const timer = setInterval(() => void load(), 20_000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [postId, revision, attempt])
  const pool = activity?.pool
  const history = activity?.investmentHistory
  const demo = history?.demo
  const hasDemoActivity =
    activity?.demoActivity &&
    Number.isSafeInteger(demo?.tradeCount) &&
    Number.isSafeInteger(demo?.walletCount) &&
    demo!.tradeCount > 0 &&
    demo!.walletCount > 0
  const decimals = activity?.quoteDecimals
  const validDecimals = Number.isInteger(decimals) && decimals! >= 0 && decimals! <= 9
  const graph = history && validDecimals ? investmentCoordinates(history.points) : null
  const poolAmount =
    pool?.available &&
    pool.metric === 'dbc-quote-reserve' &&
    pool.amount !== null &&
    /^\d+$/.test(pool.amount) &&
    Number.isInteger(pool.decimals) &&
    pool.decimals >= 0 &&
    pool.decimals <= 9
      ? signedInvestmentAmount(pool.amount, pool.decimals)
      : null
  const stale = !!error || pool?.stale
  const emptyMessage = !activity
    ? error
      ? 'Investment data unavailable'
      : 'Loading investments…'
    : !graph
      ? 'Recorded investment history unavailable'
      : poolAmount === '0' && !stale && graph.points.length === 0
        ? 'Be the first to back this video'
        : 'No recorded Clout trades yet'
  return (
    <View style={s.root} testID="investment-summary">
      <View style={s.heading}>
        <View style={{ flex: 1, minWidth: 0 }}>
          {compact ? (
            <View style={s.compactAmountRow}>
              <Txt style={s.label}>In market</Txt>
              <Txt display testID="market-invested-amount" style={s.compactAmount} numberOfLines={1}>
                {poolAmount ?? '—'} SKR
              </Txt>
            </View>
          ) : (
            <>
              <Txt style={s.label}>SKR in this market</Txt>
              <View style={s.amountRow}>
                <Txt display testID="market-invested-amount" style={s.amount}>
                  {poolAmount ?? '—'}
                </Txt>
                <Txt style={s.unit}>Mock SKR</Txt>
              </View>
            </>
          )}
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Refresh investments"
          accessibilityState={{ disabled: refreshing, busy: refreshing }}
          disabled={refreshing}
          onPress={() => setAttempt((value) => value + 1)}
          style={[s.refresh, refreshing && { opacity: 0.45 }]}
        >
          <Icon name="refresh-outline" color={c.lime} size={20} />
        </Pressable>
      </View>
      {!compact && (
        <Txt style={s.explanation}>
          {poolAmount !== null
            ? stale
              ? 'Last loaded pool balance · refresh needed'
              : 'Pooled SKR after fees · changes with buys and sells'
            : refreshing
              ? 'Reading the market…'
              : (pool?.reason ?? 'Current pool balance unavailable')}
        </Txt>
      )}
      <View style={s.chartHeader}>
        <Txt style={s.label}>Recorded backing</Txt>
        <Txt style={[s.small, hasDemoActivity && { color: c.yellow }]}>
          {hasDemoActivity ? 'Seeded demo activity' : 'Latest 100 trades'}
        </Txt>
      </View>
      <View style={[s.chart, compact && s.compactChart]} testID="investment-chart">
        <Svg width="100%" height="100%" viewBox="0 0 300 106">
          {[12, 53, 94].map((y) => (
            <Line key={y} x1={8} y1={y} x2={292} y2={y} stroke={c.line} strokeDasharray="3 5" />
          ))}
          {!!graph?.points.length && (
            <>
              <Polyline
                points={graph.points.map((point) => `${point.x},${point.y}`).join(' ')}
                fill="none"
                stroke={c.lime}
                strokeWidth={2.5}
              />
              <Circle cx={graph.points.at(-1)!.x} cy={graph.points.at(-1)!.y} r={4} fill={c.lime} />
            </>
          )}
        </Svg>
        {!graph?.points.length && (
          <View style={s.empty}>
            <Txt style={s.emptyText}>{emptyMessage}</Txt>
          </View>
        )}
      </View>
      {!!graph?.points.length && !compact && (
        <View
          style={s.range}
          accessible
          accessibilityLabel={`Recorded net backing ranges from ${signedInvestmentAmount(graph.low, decimals!)} to ${signedInvestmentAmount(graph.high, decimals!)} Mock SKR across ${graph.points.length} Clout trades.`}
        >
          <Txt style={s.small}>
            {signedInvestmentAmount(graph.low, decimals!)} — {signedInvestmentAmount(graph.high, decimals!)}{' '}
            SKR
          </Txt>
          <Txt style={s.small}>
            {graph.points.length} {graph.points.length === 1 ? 'trade' : 'trades'}
          </Txt>
        </View>
      )}
      {!compact && (
        <Txt style={s.small}>
          {hasDemoActivity
            ? `${demo!.tradeCount} demo trades · ${demo!.walletCount} demo wallets. Latest 100 Clout buys minus sells; window starts at zero.`
            : 'Clout buys minus sells, in trade order. This window starts at zero.'}
        </Txt>
      )}
      {!!error && (
        <Txt accessibilityRole="alert" style={s.error}>
          {activity ? 'Showing previously loaded investments. Refresh to try again.' : error}
        </Txt>
      )}
    </View>
  )
}

const s = StyleSheet.create({
  root: { marginTop: 2, marginBottom: 14 },
  heading: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  label: { color: c.cream, fontSize: 12, fontWeight: '700' },
  amountRow: { flexDirection: 'row', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' },
  amount: { fontSize: 31, lineHeight: 39, color: c.lime, flexShrink: 1 },
  compactAmountRow: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  compactAmount: { fontSize: 22, lineHeight: 29, color: c.lime, flex: 1, textAlign: 'right' },
  unit: { fontSize: 12, color: c.muted },
  refresh: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  explanation: { color: c.muted, fontSize: 10, lineHeight: 14, marginTop: 2 },
  chartHeader: { flexDirection: 'row', justifyContent: 'space-between', gap: 8, marginTop: 14 },
  chart: { height: 108, marginTop: 3 },
  compactChart: { height: 54 },
  empty: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  emptyText: { color: c.muted, fontSize: 12, backgroundColor: c.ink, padding: 8 },
  range: { flexDirection: 'row', justifyContent: 'space-between', gap: 8, marginBottom: 3 },
  small: { color: c.muted, fontSize: 10, lineHeight: 14 },
  error: { color: c.yellow, fontSize: 11, marginTop: 5 },
})
