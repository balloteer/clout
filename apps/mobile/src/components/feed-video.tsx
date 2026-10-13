import { useEffect } from 'react'
import { AppState, StyleSheet } from 'react-native'
import { useEvent } from 'expo'
import { useVideoPlayer, VideoView } from 'expo-video'

export type PlaybackStatus = 'idle' | 'loading' | 'readyToPlay' | 'error'
export type FeedVideoProps = {
  source: string | number
  muted: boolean
  paused: boolean
  fit?: 'cover' | 'contain'
  onStatus: (status: PlaybackStatus) => void
}

export function FeedVideo({ source, muted, paused, onStatus, fit = 'cover' }: FeedVideoProps) {
  const player = useVideoPlayer(source, (p) => {
    p.loop = true
    p.muted = true
  })
  const { status } = useEvent(player, 'statusChange', { status: player.status })
  useEffect(() => onStatus(status), [onStatus, status])
  useEffect(() => {
    // Expo Video exposes an imperative native player with writable properties.
    // eslint-disable-next-line react-hooks/immutability
    player.muted = muted
  }, [muted, player])
  useEffect(() => {
    if (status !== 'readyToPlay') return
    if (paused || AppState.currentState !== 'active') player.pause()
    else player.play()
  }, [paused, player, status])
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active' && !paused && status === 'readyToPlay') player.play()
      else player.pause()
    })
    // The useVideoPlayer hook owns disposal; never call a released native player here.
    return () => sub.remove()
  }, [player, paused, status])
  return (
    <VideoView
      player={player}
      style={StyleSheet.absoluteFill}
      contentFit={fit}
      nativeControls={false}
      surfaceType="textureView"
    />
  )
}
