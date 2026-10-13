import { useEffect, useEffectEvent, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import type { PostPagerProps } from './post-pager'

export type { PostPagerHandle, PostPagerProps } from './post-pager'

const WHEEL_GESTURE_GAP = 220
const WHEEL_THRESHOLD = 18
const separators = { highlight() {}, unhighlight() {}, updateProps() {} }

// Real page-sized snap children avoid RN Web's intermediary cell wrappers. Touch
// scrolling remains browser-native; wheel bursts advance one page, including
// the trailing momentum events emitted by a trackpad.
export function PostPager({
  listRef,
  data,
  getItemLayout,
  initialScrollIndex,
  keyExtractor,
  renderItem,
  onPageSettled,
  testID,
}: PostPagerProps) {
  const scroller = useRef<HTMLDivElement>(null)
  const [initialIndex] = useState(initialScrollIndex ?? 0)
  const settledIndex = useRef(initialIndex)
  const items = Array.from(data ?? [])
  const count = items.length
  const pageHeight = getItemLayout?.(data, 0).length ?? 0
  const notifySettled = useEffectEvent(onPageSettled)

  useImperativeHandle(
    listRef,
    () => ({
      scrollToOffset: ({ offset, animated }) => {
        const index = Math.max(0, Math.min(count - 1, Math.round(offset / pageHeight)))
        settledIndex.current = index
        scroller.current?.scrollTo({ top: index * pageHeight, behavior: animated ? 'smooth' : 'instant' })
      },
    }),
    [count, pageHeight],
  )

  useLayoutEffect(() => {
    scroller.current?.scrollTo({ top: initialIndex * pageHeight, behavior: 'instant' })
  }, [initialIndex, pageHeight])

  useEffect(() => {
    const element = scroller.current
    if (!element || !pageHeight || !count) return
    let wheelTimer: ReturnType<typeof setTimeout> | undefined
    let settleTimer: ReturnType<typeof setTimeout> | undefined
    let wheelConsumed = false
    let wheelDistance = 0
    let moving = false
    let touching = false
    const clamp = (index: number) => Math.max(0, Math.min(count - 1, index))
    const settle = () => {
      if (touching) return
      const index = clamp(Math.round(element.scrollTop / pageHeight))
      const offset = index * pageHeight
      if (Math.abs(element.scrollTop - offset) > 1) {
        element.scrollTo({ top: offset, behavior: 'smooth' })
        return
      }
      moving = false
      settledIndex.current = index
      notifySettled(offset)
    }
    const scroll = () => {
      clearTimeout(settleTimer)
      settleTimer = setTimeout(settle, 140)
    }
    const advance = (direction: number) => {
      const index = clamp(settledIndex.current + direction)
      if (index === settledIndex.current) return
      moving = true
      element.scrollTo({ top: index * pageHeight, behavior: 'smooth' })
    }
    const wheel = (event: WheelEvent) => {
      // Preserve browser zoom and horizontal input.
      if (event.ctrlKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return
      event.preventDefault()
      clearTimeout(wheelTimer)
      wheelTimer = setTimeout(() => {
        wheelConsumed = false
        wheelDistance = 0
      }, WHEEL_GESTURE_GAP)
      if (wheelConsumed || moving) return
      const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? pageHeight : 1
      const delta = event.deltaY * scale
      if (Math.sign(delta) !== Math.sign(wheelDistance)) wheelDistance = 0
      wheelDistance += delta
      if (Math.abs(wheelDistance) < WHEEL_THRESHOLD) return
      wheelConsumed = true
      advance(Math.sign(wheelDistance))
    }
    const touchStart = () => {
      touching = true
    }
    const touchEnd = () => {
      touching = false
      scroll()
    }
    const keyDown = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement).closest('button,[role="button"],input,textarea')) return
      const direction = ['ArrowDown', 'PageDown'].includes(event.key)
        ? 1
        : ['ArrowUp', 'PageUp'].includes(event.key)
          ? -1
          : 0
      if (!direction) return
      event.preventDefault()
      if (!event.repeat && !moving) advance(direction)
    }
    element.addEventListener('wheel', wheel, { passive: false })
    element.addEventListener('scroll', scroll, { passive: true })
    element.addEventListener('scrollend', settle)
    element.addEventListener('touchstart', touchStart, { passive: true })
    element.addEventListener('touchend', touchEnd, { passive: true })
    element.addEventListener('touchcancel', touchEnd, { passive: true })
    element.addEventListener('keydown', keyDown)
    return () => {
      clearTimeout(wheelTimer)
      clearTimeout(settleTimer)
      element.removeEventListener('wheel', wheel)
      element.removeEventListener('scroll', scroll)
      element.removeEventListener('scrollend', settle)
      element.removeEventListener('touchstart', touchStart)
      element.removeEventListener('touchend', touchEnd)
      element.removeEventListener('touchcancel', touchEnd)
      element.removeEventListener('keydown', keyDown)
    }
  }, [count, pageHeight])

  return (
    <div
      ref={scroller}
      data-testid={testID}
      tabIndex={0}
      aria-label="Video feed"
      style={{
        width: '100%',
        height: '100%',
        minHeight: 0,
        overflowY: 'auto',
        overflowX: 'hidden',
        overscrollBehaviorY: 'contain',
        scrollSnapType: 'y mandatory',
        scrollbarWidth: 'none',
        touchAction: 'pan-y pinch-zoom',
      }}
    >
      {items.map((item, index) => (
        <div
          key={keyExtractor?.(item, index) ?? item.id}
          style={{ height: pageHeight, scrollSnapAlign: 'start', scrollSnapStop: 'always' }}
        >
          {renderItem?.({ item, index, separators })}
        </div>
      ))}
    </div>
  )
}
