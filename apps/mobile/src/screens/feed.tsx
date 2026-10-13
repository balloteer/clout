import { useEffect, useRef, useState } from 'react'
import {
  Image,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native'
import { LinearGradient } from 'expo-linear-gradient'
import { useApp } from '../lib/store'
import { imageSource, type Post } from '../lib/data'
import { filterFeedPosts, type FeedFilter } from '../lib/catalog'
import { colors as c } from '../lib/theme'
import { Avatar, Icon, Txt, type IconName } from '../components/ui'
import { FeedVideo, type PlaybackStatus } from '../components/feed-video'
import { PostPager, type PostPagerHandle } from '../components/post-pager'

// Seeker's 1200 × 2670 portrait panel. Each swipe advances one full video.
const SEEKER_ASPECT = 1200 / 2670

type FeedProps = {
  onBack: (post: Post) => void
  onComments: (post: Post) => void
  initialPost?: Post
  activePostId?: string
  onPostChange: (id: string) => void
  filter: FeedFilter
  onFilterChange: (filter: FeedFilter) => void
  topInset?: number
  bottomInset?: number
  immersive?: boolean
  obscured?: boolean
}
export function Feed({
  onBack,
  onComments,
  initialPost,
  activePostId,
  onPostChange,
  filter,
  onFilterChange,
  topInset = 0,
  bottomInset = 0,
  immersive = false,
  obscured = false,
}: FeedProps) {
  const { posts, following } = useApp()
  const { fontScale } = useWindowDimensions()
  const feedPosts = initialPost
    ? [
        posts.find((p) => p.id === initialPost.id) ?? initialPost,
        ...posts.filter((p) => p.id !== initialPost.id),
      ]
    : posts
  const list = filterFeedPosts(feedPosts, filter, following)
  const [muted, setMuted] = useState(false)
  const [area, setArea] = useState({ width: 0, height: 0 })
  const pager = useRef<PostPagerHandle>(null)
  const lastScrolledId = useRef(activePostId)
  const lastScrolledIndex = useRef<number | undefined>(undefined)
  const frameWidth = Math.min(area.width, area.height * SEEKER_ASPECT, 470)
  const frameHeight = frameWidth / SEEKER_ASPECT
  const frameOffset = (area.height - frameHeight) / 2
  const top = Math.max(0, topInset - frameOffset)
  const bottom = Math.max(0, bottomInset - frameOffset)
  const index = Math.max(
    0,
    list.findIndex((p) => p.id === activePostId),
  )
  const currentId = list[index]?.id
  const separateTabs = immersive && (frameWidth < 360 || fontScale > 1.2)
  useEffect(() => {
    if (frameHeight > 0 && (currentId !== lastScrolledId.current || index !== lastScrolledIndex.current)) {
      pager.current?.scrollToOffset({ offset: index * frameHeight, animated: false })
      lastScrolledId.current = currentId
      lastScrolledIndex.current = index
    }
  }, [currentId, index, frameHeight])
  function selectPage(offset: number) {
    const nextIndex = Math.max(0, Math.min(list.length - 1, Math.round(offset / frameHeight)))
    const id = list[nextIndex]?.id
    if (id) lastScrolledIndex.current = nextIndex
    if (id && id !== lastScrolledId.current) {
      lastScrolledId.current = id
      onPostChange(id)
    }
  }
  return (
    <View
      style={s.root}
      onLayout={({ nativeEvent: { layout } }) => {
        setArea((previous) =>
          previous.width === layout.width && previous.height === layout.height
            ? previous
            : { width: layout.width, height: layout.height },
        )
      }}
    >
      {frameWidth > 0 && (
        <View
          testID="seeker-video-frame"
          style={[s.stage, { width: frameWidth, height: frameHeight }, immersive && { borderRadius: 0 }]}
        >
          {list.length ? (
            <PostPager
              listRef={pager}
              key={`${filter}:${frameHeight}`}
              testID="vertical-video-feed"
              data={list}
              keyExtractor={(post) => post.id}
              extraData={`${currentId}:${muted}:${obscured}`}
              horizontal={false}
              pagingEnabled
              snapToInterval={Platform.OS === 'web' ? frameHeight : undefined}
              snapToAlignment={Platform.OS === 'web' ? 'start' : undefined}
              decelerationRate={Platform.OS === 'web' ? 'fast' : 'normal'}
              disableIntervalMomentum={Platform.OS === 'web'}
              bounces={false}
              showsVerticalScrollIndicator={false}
              initialScrollIndex={index}
              initialNumToRender={2}
              maxToRenderPerBatch={3}
              windowSize={3}
              removeClippedSubviews={false}
              getItemLayout={(_, itemIndex) => ({
                length: frameHeight,
                offset: frameHeight * itemIndex,
                index: itemIndex,
              })}
              scrollEventThrottle={32}
              onPageSettled={selectPage}
              renderItem={({ item }) => (
                <PostPage
                  post={item}
                  active={item.id === currentId}
                  width={frameWidth}
                  height={frameHeight}
                  muted={muted}
                  obscured={obscured}
                />
              )}
            />
          ) : (
            <View style={s.noFollowing}>
              <Icon name={filter === 'markets' ? 'eye-outline' : 'people-outline'} size={44} color={c.pink} />
              <Txt display style={{ fontSize: 24, lineHeight: 30, textAlign: 'center' }}>
                {filter === 'markets' ? 'No markets yet.' : 'Find your people.'}
              </Txt>
              <Txt style={{ color: c.muted, textAlign: 'center' }}>
                {filter === 'markets'
                  ? 'Posts appear here after their creators launch a market.'
                  : 'Follow a creator in Discover to see their posts here.'}
              </Txt>
            </View>
          )}
          {list[index] && (
            <PostOverlay
              post={list[index]}
              width={frameWidth}
              bottom={bottom}
              onBack={onBack}
              onComments={onComments}
            />
          )}
          <View
            style={[
              s.tabs,
              {
                top: top + (separateTabs ? 52 : 4),
                left: separateTabs ? 12 : immersive ? Math.max(12, 72 - (area.width - frameWidth) / 2) : 16,
              },
            ]}
          >
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={{ flex: 1 }}
              contentContainerStyle={s.tabList}
            >
              {(['for-you', 'following', 'markets'] as const).map((item) => (
                <Pressable
                  key={item}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: filter === item }}
                  aria-selected={filter === item}
                  onPress={() => onFilterChange(item)}
                  style={s.tab}
                >
                  <Txt numberOfLines={1} style={[s.tabText, filter === item && { color: c.cream }]}>
                    {item === 'for-you' ? 'For you' : item === 'following' ? 'Following' : 'Markets'}
                  </Txt>
                  {filter === item && <View style={s.tabUnderline} />}
                </Pressable>
              ))}
            </ScrollView>
            {!!list.length && !separateTabs && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={muted ? 'Unmute video' : 'Mute video'}
                style={s.sound}
                onPress={() => setMuted((m) => !m)}
              >
                <Icon name={muted ? 'volume-mute-outline' : 'volume-high-outline'} size={21} />
              </Pressable>
            )}
          </View>
          {!!list.length && separateTabs && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={muted ? 'Unmute video' : 'Mute video'}
              style={[s.sound, { position: 'absolute', top: top + 4, right: 12 }]}
              onPress={() => setMuted((m) => !m)}
            >
              <Icon name={muted ? 'volume-mute-outline' : 'volume-high-outline'} size={21} />
            </Pressable>
          )}
        </View>
      )}
    </View>
  )
}

function PostPage({
  post,
  active,
  width,
  height,
  muted,
  obscured,
}: {
  post: Post
  active: boolean
  width: number
  height: number
  muted: boolean
  obscured: boolean
}) {
  const [paused, setPaused] = useState(false)
  const [status, setStatus] = useState<PlaybackStatus>('loading')
  const [retry, setRetry] = useState(0)
  const playRequest = useRef<(() => void) | null>(null)
  return (
    <View
      testID={`video-page-${post.id}`}
      accessibilityElementsHidden={!active}
      aria-hidden={!active}
      importantForAccessibility={active ? 'auto' : 'no-hide-descendants'}
      style={{ width, height, overflow: 'hidden' }}
    >
      <Image
        source={imageSource(post.poster)}
        style={StyleSheet.absoluteFill}
        resizeMode={post.videoFit ?? 'cover'}
      />
      {active && (
        <FeedVideo
          key={`${post.id}:${retry}`}
          source={post.video}
          muted={muted}
          paused={paused || obscured}
          fit={post.videoFit}
          onStatus={setStatus}
          playRequestRef={playRequest}
        />
      )}
      <Pressable
        accessible={active}
        accessibilityRole="button"
        accessibilityLabel={
          status === 'error'
            ? 'Retry video'
            : status === 'autoplayBlocked'
              ? 'Play video with sound'
              : paused
                ? 'Play video'
                : 'Pause video'
        }
        onPress={() => {
          if (status === 'autoplayBlocked') {
            playRequest.current?.()
          } else if (status === 'error') {
            setStatus('loading')
            setPaused(false)
            setRetry((attempt) => attempt + 1)
          } else setPaused((p) => !p)
        }}
        style={StyleSheet.absoluteFill}
      />
      <LinearGradient
        colors={[
          'rgba(21,18,28,.86)',
          'transparent',
          'rgba(21,18,28,.18)',
          'rgba(21,18,28,.78)',
          'rgba(21,18,28,.98)',
        ]}
        locations={[0, 0.25, 0.44, 0.72, 1]}
        style={[StyleSheet.absoluteFill, { pointerEvents: 'none' }]}
      />
      {active && (paused || status === 'loading' || status === 'error' || status === 'autoplayBlocked') && (
        <View pointerEvents="none" style={s.play}>
          <View style={s.playCircle}>
            <Icon
              name={
                status === 'error'
                  ? 'cloud-offline-outline'
                  : status === 'loading'
                    ? 'ellipsis-horizontal'
                    : 'play'
              }
              size={29}
            />
          </View>
          {status === 'error' && <Txt style={{ marginTop: 10, fontWeight: '700' }}>Tap to retry</Txt>}
          {status === 'autoplayBlocked' && (
            <Txt style={{ marginTop: 10, fontWeight: '700' }}>Tap to play with sound</Txt>
          )}
        </View>
      )}
    </View>
  )
}

function PostOverlay({
  post,
  width,
  bottom,
  onBack,
  onComments,
}: {
  post: Post
  width: number
  bottom: number
  onBack: (post: Post) => void
  onComments: (post: Post) => void
}) {
  const { liked, saved, toggleLike, toggleSave, notify } = useApp()
  const compact = width < 320
  return (
    <View testID="post-overlay" pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      <View style={[s.actions, { bottom: bottom + 14 }, compact && { gap: 4 }]}>
        {post.market && (
          <Pressable
            testID="invest-post"
            accessibilityRole="button"
            accessibilityLabel="Back this post"
            accessibilityHint="Open this post's mock SKR market"
            onPress={() => onBack(post)}
            style={({ pressed }) => [s.invest, pressed && { opacity: 0.8 }]}
          >
            <Image
              source={require('../../assets/brand/eye.png')}
              style={{ width: 29, height: 29 }}
              resizeMode="contain"
            />
          </Pressable>
        )}
        <Action
          compact={compact}
          icon={liked.includes(post.id) ? 'heart' : 'heart-outline'}
          label={formatCount(post.likes + (post.sample && liked.includes(post.id) ? 1 : 0))}
          a11y="Like post"
          selected={liked.includes(post.id)}
          color={liked.includes(post.id) ? c.pink : c.cream}
          onPress={() => toggleLike(post.id)}
        />
        <Action
          compact={compact}
          icon="chatbubble-ellipses-outline"
          label={post.source ? 'Discuss' : `${post.comments}`}
          a11y="Open comments"
          onPress={() => onComments(post)}
        />
        <Action
          compact={compact}
          icon={saved.includes(post.id) ? 'bookmark' : 'bookmark-outline'}
          label={saved.includes(post.id) ? 'Saved' : 'Save'}
          a11y="Save post"
          selected={saved.includes(post.id)}
          color={saved.includes(post.id) ? c.lime : c.cream}
          onPress={() => {
            toggleSave(post.id)
            notify(saved.includes(post.id) ? 'Removed from your saved posts' : 'Saved to your collection')
          }}
        />
        <Action
          compact={compact}
          icon="arrow-redo-outline"
          label="Share"
          onPress={() => {
            void Share.share({
              message: `${post.caption}\n${post.source ? `${post.source.url}\n` : ''}Discover it on Clout. Seek the best content, win SKR`,
            }).catch(() => notify('Sharing is unavailable in this browser.'))
          }}
        />
      </View>
      <View pointerEvents="box-none" style={[s.caption, { bottom: bottom + 14 }]}>
        <View pointerEvents="none" style={s.creator}>
          <Avatar letter={post.avatar} color={post.color} size={30} />
          <Txt testID="post-creator" numberOfLines={1} style={s.creatorName}>
            {post.creator}
          </Txt>
        </View>
        <Txt
          pointerEvents="none"
          numberOfLines={2}
          style={[s.captionText, compact && { fontSize: 14, lineHeight: 20 }]}
        >
          {post.caption}
        </Txt>
        {post.source ? (
          <Pressable
            accessibilityRole="link"
            accessibilityLabel={`View original post by @${post.source.handle}`}
            onPress={() =>
              void Linking.openURL(post.source!.url).catch(() => notify('Could not open the original post.'))
            }
            style={[s.track, { minHeight: 48 }]}
          >
            <Icon name="open-outline" size={14} />
            <Txt numberOfLines={1} style={{ fontSize: 11, flex: 1 }}>
              @{post.source.handle} · X ·{' '}
              {new Date(post.source.publishedAt).toLocaleDateString('en-US', {
                month: 'short',
                year: 'numeric',
              })}
            </Txt>
          </Pressable>
        ) : (
          <View pointerEvents="none" style={s.track}>
            <Icon name="musical-notes" size={13} />
            <Txt numberOfLines={1} style={{ fontSize: 11, flex: 1 }}>
              {post.sample ? 'Sample clip · Blender Foundation' : 'Original audio'}
            </Txt>
          </View>
        )}
        <Txt pointerEvents="none" style={{ fontSize: 10, lineHeight: 14, color: c.muted }}>
          Early alpha · Devnet · Mock SKR
        </Txt>
      </View>
    </View>
  )
}
function formatCount(value: number) {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}K` : `${value}`
}
function Action({
  icon,
  label,
  a11y,
  color = c.cream,
  selected,
  compact,
  onPress,
}: {
  icon: IconName
  label: string
  a11y?: string
  color?: string
  selected?: boolean
  compact: boolean
  onPress: () => void
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={a11y ?? label}
      accessibilityState={selected === undefined ? undefined : { selected }}
      aria-pressed={selected}
      onPress={onPress}
      style={[s.action, compact && { gap: 0 }]}
    >
      <View style={s.actionIcon}>
        <Icon name={icon} size={26} color={color} />
      </View>
      <Txt style={[s.actionText, compact && { lineHeight: 14 }]}>{label}</Txt>
    </Pressable>
  )
}
const s = StyleSheet.create({
  root: { flex: 1, width: '100%', minHeight: 0, alignItems: 'center', justifyContent: 'center' },
  stage: { backgroundColor: c.surface, borderRadius: 22, overflow: 'hidden' },
  tabs: {
    position: 'absolute',
    left: 16,
    right: 12,
    height: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingLeft: 0,
  },
  tabList: { gap: 12, alignItems: 'center' },
  tab: { height: 48, minWidth: 48, justifyContent: 'center' },
  tabText: { fontWeight: '700', color: c.muted, fontSize: 14 },
  tabUnderline: {
    position: 'absolute',
    bottom: 1,
    height: 3,
    backgroundColor: c.pink,
    left: 0,
    right: 0,
    borderRadius: 4,
  },
  sound: {
    flexShrink: 0,
    backgroundColor: 'rgba(21,18,28,.45)',
    borderRadius: 24,
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  play: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' },
  playCircle: {
    width: 68,
    height: 68,
    borderRadius: 34,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(21,18,28,.45)',
  },
  actions: { position: 'absolute', right: 10, gap: 8 },
  invest: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: c.lime,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 2,
  },
  action: { alignItems: 'center', gap: 2, minWidth: 48 },
  actionIcon: {
    backgroundColor: 'rgba(21,18,28,.65)',
    borderRadius: 24,
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionText: {
    fontSize: 11,
    lineHeight: 17,
    fontWeight: '700',
    backgroundColor: 'rgba(21,18,28,.72)',
    borderRadius: 5,
    paddingHorizontal: 4,
  },
  caption: { position: 'absolute', left: 16, right: 78, gap: 7 },
  creator: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  creatorName: { fontWeight: '700', fontSize: 14, flex: 1 },
  captionText: { fontSize: 15, lineHeight: 21, fontWeight: '600' },
  track: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  noFollowing: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 18, padding: 30 },
})
