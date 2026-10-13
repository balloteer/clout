import { useImperativeHandle, useRef, useState, type RefObject } from 'react'
import { FlatList, type FlatListProps } from 'react-native'
import type { Post } from '../lib/data'

export type PostPagerHandle = Pick<FlatList<Post>, 'scrollToOffset'>
export type PostPagerProps = FlatListProps<Post> & {
  listRef: RefObject<PostPagerHandle | null>
  onPageSettled: (offset: number) => void
}

export function PostPager({ listRef, onPageSettled, onMomentumScrollEnd, ...props }: PostPagerProps) {
  const nativeList = useRef<FlatList<Post>>(null)
  // The initial index is a mount hint, never a controlled selection.
  const [initialScrollIndex] = useState(props.initialScrollIndex)
  useImperativeHandle(listRef, () => ({
    scrollToOffset: (options) => nativeList.current?.scrollToOffset(options),
  }))
  return (
    <FlatList
      {...props}
      ref={nativeList}
      initialScrollIndex={initialScrollIndex}
      onMomentumScrollEnd={(event) => {
        onPageSettled(event.nativeEvent.contentOffset.y)
        onMomentumScrollEnd?.(event)
      }}
    />
  )
}
