import { useCallback, useEffect, useRef } from 'react'
import { Asset } from 'expo-asset'
import type { FeedVideoProps } from './feed-video'

// The browser player handles rejected play promises during rapid tab/source changes.
export function FeedVideo({
  source,
  muted,
  paused,
  onStatus,
  playRequestRef,
  fit = 'cover',
}: FeedVideoProps) {
  const ref = useRef<HTMLVideoElement>(null)
  const uri = typeof source === 'number' ? Asset.fromModule(source).uri : source
  const play = useCallback(() => {
    const video = ref.current
    if (!video || video.readyState < 3) return
    if (paused || document.hidden) {
      video.pause()
      return
    }
    void video
      .play()
      .then(() => {
        if (video === ref.current) onStatus('readyToPlay')
      })
      .catch((error: unknown) => {
        if (video !== ref.current || (error instanceof DOMException && error.name === 'AbortError')) return
        onStatus(
          error instanceof DOMException && error.name === 'NotAllowedError' ? 'autoplayBlocked' : 'error',
        )
      })
  }, [paused, onStatus])
  useEffect(() => {
    play()
  }, [play, uri, muted])
  useEffect(() => {
    if (!playRequestRef) return
    playRequestRef.current = play
    return () => {
      if (playRequestRef.current === play) playRequestRef.current = null
    }
  }, [play, playRequestRef])
  useEffect(() => {
    document.addEventListener('visibilitychange', play)
    return () => document.removeEventListener('visibilitychange', play)
  }, [play])
  return (
    <video
      ref={ref}
      src={uri}
      muted={muted}
      loop
      playsInline
      preload="auto"
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: fit }}
      onLoadStart={() => onStatus('loading')}
      onCanPlay={() => {
        onStatus('readyToPlay')
        play()
      }}
      onError={() => onStatus('error')}
    />
  )
}
