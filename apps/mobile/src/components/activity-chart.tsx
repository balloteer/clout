import { useEffect, useState } from 'react'
import { View } from 'react-native'
import Svg, { Circle, Line, Polyline } from 'react-native-svg'
import { api } from '../lib/api'
import { executionPrices, type MarketActivity } from '../lib/activity'
import { colors as c } from '../lib/theme'
import { Txt } from './ui'

export function ActivityChart({ postId }: { postId: string }) {
  const [activity, setActivity] = useState<MarketActivity | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    async function load() {
      try {
        const value = await api<MarketActivity>(`/v1/posts/${encodeURIComponent(postId)}/activity`)
        if (active) {
          setActivity(value)
          setError('')
        }
      } catch {
        if (active) setError('Trade history is temporarily unavailable.')
      }
    }
    void load()
    const timer = setInterval(() => void load(), 20_000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [postId])
  const points = activity ? executionPrices(activity) : []
  const low = points.length ? Math.min(...points.map((p) => p.price)) : 0
  const high = points.length ? Math.max(...points.map((p) => p.price)) : 0
  const coordinate = (i: number) => ({
    x: points.length === 1 ? 150 : 8 + (i / (points.length - 1)) * 284,
    y: high === low ? 45 : 80 - ((points[i].price - low) / (high - low)) * 65,
  })
  const format = (value: number) =>
    value < 0.0001 ? value.toExponential(3) : value.toLocaleString('en-US', { maximumSignificantDigits: 5 })
  return (
    <View style={{ paddingVertical: 16, gap: 7 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Txt style={{ fontSize: 12, color: c.muted }}>Execution history</Txt>
        {points.length > 0 && (
          <Txt style={{ fontSize: 12, color: c.lime }}>{format(points.at(-1)!.price)} Test SKR</Txt>
        )}
      </View>
      {points.length > 0 ? (
        <View
          accessible
          accessibilityLabel={`Clout trade history, ${points.length} trades. Latest executed price ${format(points.at(-1)!.price)} Test SKR per post token.`}
        >
          <Svg width="100%" height={95} viewBox="0 0 300 95">
            <Line x1={8} y1={85} x2={292} y2={85} stroke={c.line} />
            <Polyline
              points={points
                .map((_, i) => {
                  const p = coordinate(i)
                  return `${p.x},${p.y}`
                })
                .join(' ')}
              fill="none"
              stroke={c.lime}
              strokeWidth={2.5}
            />
            <Circle
              cx={coordinate(points.length - 1).x}
              cy={coordinate(points.length - 1).y}
              r={4}
              fill={c.lime}
            />
          </Svg>
        </View>
      ) : (
        <Txt style={{ color: c.muted, fontSize: 12, paddingVertical: 12 }}>
          {error || (activity ? 'No confirmed Clout trades yet.' : 'Loading trade history…')}
        </Txt>
      )}
      {points.length > 0 && (
        <Txt style={{ fontSize: 10, color: c.muted }}>
          SKR per post token · recorded Clout trades · quotes reflect current liquidity.
        </Txt>
      )}
      {points.length > 0 && !!error && (
        <Txt accessibilityRole="alert" style={{ fontSize: 12, color: c.yellow }}>
          Trade history could not refresh. Showing previously loaded trades.
        </Txt>
      )}
    </View>
  )
}
