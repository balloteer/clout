import { useCallback, useEffect, useState } from 'react'
import { useFocusEffect, useLocalSearchParams } from 'expo-router'
import {
  Image,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import Head from 'expo-router/head'
import { colors as c, SLOGAN } from '../lib/theme'
import { useApp } from '../lib/store'
import { useWallet } from '../lib/wallet'
import type { Post } from '../lib/data'
import type { FeedFilter } from '../lib/catalog'
import { Avatar, Button, Icon, Txt, type IconName } from '../components/ui'
import { CommentsSheet, ConnectSheet, MarketSheet, Sheet } from '../components/sheets'
import { Feed } from '../screens/feed'
import { Discover } from '../screens/discover'
import { Create } from '../screens/create'
import { Collection } from '../screens/collection'
import { Profile } from '../screens/profile'
import { DevnetFaucet } from '../screens/devnet-faucet'
type Tab = 'Feed' | 'Discover' | 'Create' | 'Collection' | 'Profile' | 'Mint mock SKR'
const tabs: { name: Tab; icon: IconName; active: IconName }[] = [
  { name: 'Feed', icon: 'play-circle-outline', active: 'play-circle' },
  { name: 'Discover', icon: 'compass-outline', active: 'compass' },
  { name: 'Create', icon: 'add-circle-outline', active: 'add-circle' },
  { name: 'Collection', icon: 'layers-outline', active: 'layers' },
  { name: 'Profile', icon: 'person-outline', active: 'person' },
]
export default function App() {
  const { width, height } = useWindowDimensions()
  const desktop = width >= 1000
  const wide = width >= 1250
  const { destination } = useLocalSearchParams<{ destination?: string }>()
  const [tab, setTab] = useState<Tab>(destination === 'Profile' ? 'Profile' : 'Feed')
  useFocusEffect(
    useCallback(() => {
      if (destination === 'Profile') setTab('Profile')
    }, [destination]),
  )
  const [menu, setMenu] = useState(false)
  const insets = useSafeAreaInsets()
  const immersiveFeed = !desktop && tab === 'Feed'
  const [keyboardVisible, setKeyboardVisible] = useState(false)
  useEffect(() => {
    if (Platform.OS === 'web') return
    const shown = Keyboard.addListener('keyboardDidShow', () => setKeyboardVisible(true))
    const hidden = Keyboard.addListener('keyboardDidHide', () => setKeyboardVisible(false))
    return () => {
      shown.remove()
      hidden.remove()
    }
  }, [])
  const [market, setMarket] = useState<Post | null>(null)
  const [portfolioRevision, setPortfolioRevision] = useState(0)
  const [marketChanged, setMarketChanged] = useState(false)
  const [discovery, setDiscovery] = useState<Post>()
  const [feedPostId, setFeedPostId] = useState<string>()
  const [feedFilter, setFeedFilter] = useState<FeedFilter>('for-you')
  function watchPost(post: Post) {
    setDiscovery(post)
    setFeedPostId(post.id)
    setFeedFilter('for-you')
    setTab('Feed')
  }
  const [marketSide, setMarketSide] = useState<'buy' | 'sell'>('buy')
  function showMarket(post: Post, side: 'buy' | 'sell' = 'buy') {
    setMarketChanged(false)
    setMarketSide(side)
    setMarket(post)
  }
  function closeMarket() {
    setMarket(null)
    if (marketChanged) setPortfolioRevision((value) => value + 1)
    setMarketChanged(false)
  }
  const [comments, setComments] = useState<Post | null>(null)
  const [connect, setConnect] = useState(false)
  const { message, posts, following, toggleFollow } = useApp()
  const wallet = useWallet()
  const openConnect = () => {
    if (marketChanged) setPortfolioRevision((value) => value + 1)
    setMarketChanged(false)
    setMarket(null)
    setComments(null)
    setConnect(true)
  }
  function nav(item: Tab) {
    setMenu(false)
    setTab(item)
  }
  return (
    <SafeAreaView
      testID="app-viewport"
      style={[s.safe, Platform.OS === 'web' && { height, maxHeight: height }]}
      edges={immersiveFeed ? [] : ['top', 'bottom']}
    >
      <Head>
        <title>Clout — {SLOGAN}</title>
        <meta name="description" content={SLOGAN} />
        <meta name="theme-color" content={c.ink} />
        <meta name="referrer" content="no-referrer" />
      </Head>
      <View style={s.app}>
        {desktop && (
          <View style={s.sidebar}>
            <Image source={require('../../assets/brand/wordmark.png')} style={s.logo} resizeMode="contain" />
            <Txt style={s.slogan}>{SLOGAN}</Txt>
            <View style={s.nav}>
              {tabs.map((item) => (
                <Pressable
                  accessibilityRole="tab"
                  accessibilityLabel={item.name}
                  accessibilityState={{ selected: tab === item.name }}
                  aria-selected={tab === item.name}
                  key={item.name}
                  onPress={() => nav(item.name)}
                  style={[s.navItem, tab === item.name && s.navActive]}
                >
                  <Icon
                    name={tab === item.name ? item.active : item.icon}
                    color={tab === item.name ? c.pink : c.muted}
                    size={23}
                  />
                  <Txt style={[s.navText, tab === item.name && { color: c.cream }]}>{item.name}</Txt>
                  {tab === item.name && <View style={s.navDot} />}
                </Pressable>
              ))}
            </View>
            <View style={s.devnetSection}>
              <Txt style={{ fontSize: 11, color: c.muted, marginBottom: 6 }}>Devnet tools</Txt>
              <Pressable
                accessibilityRole="tab"
                accessibilityLabel="Mint mock SKR"
                aria-selected={tab === 'Mint mock SKR'}
                accessibilityState={{ selected: tab === 'Mint mock SKR' }}
                onPress={() => nav('Mint mock SKR')}
                style={[s.navItem, tab === 'Mint mock SKR' && s.navActive]}
              >
                <Icon name="water-outline" color={c.lime} size={23} />
                <Txt style={{ fontWeight: '700', flexShrink: 1 }}>Mint mock SKR</Txt>
              </Pressable>
            </View>
            <View style={s.seekerCard}>
              <Icon name="flash-outline" size={23} color={c.lime} />
              <Txt style={{ fontWeight: '700', marginTop: 12 }}>Built for Seeker.</Txt>
              <Txt style={{ color: c.muted, fontSize: 12, lineHeight: 19, marginTop: 5 }}>
                Your next good find is{'\n'}just a scroll away.
              </Txt>
              <Button
                secondary
                onPress={openConnect}
                style={{ marginTop: 16, minHeight: 41, paddingVertical: 7, paddingHorizontal: 10 }}
              >
                {wallet.address ? 'Wallet connected' : 'Connect wallet'}
              </Button>
            </View>
            <View style={{ flex: 1 }} />
            <View style={s.status}>
              <View style={s.statusDot} />
              <Txt style={{ fontSize: 11, color: c.muted }}>Early alpha · Devnet only</Txt>
            </View>
            <Txt style={s.sidebarFooter}>Good content. Better instincts.</Txt>
          </View>
        )}
        <View style={s.main}>
          <KeyboardAvoidingView
            key={immersiveFeed ? 'immersive' : 'screens'}
            style={s.keyboardMain}
            enabled={Platform.OS !== 'web' && !immersiveFeed}
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            keyboardVerticalOffset={insets.top}
          >
            <View
              pointerEvents={immersiveFeed ? 'box-none' : 'auto'}
              style={[
                s.header,
                !desktop && { paddingHorizontal: 12, height: 52 },
                immersiveFeed && [s.feedHeader, { top: insets.top }],
              ]}
            >
              {!desktop ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Open menu"
                  onPress={() => setMenu(true)}
                  style={{
                    minWidth: 48,
                    height: 48,
                    justifyContent: 'center',
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 9,
                  }}
                >
                  <Icon name="menu-outline" size={24} />
                  {!immersiveFeed && (
                    <Image
                      source={require('../../assets/brand/wordmark.png')}
                      style={{ width: 90, height: 40 }}
                      resizeMode="contain"
                    />
                  )}
                </Pressable>
              ) : (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <Txt style={{ fontSize: 13, color: c.muted }}>The good side of your feed</Txt>
                  <Icon name="sparkles-outline" size={15} color={c.pink} />
                </View>
              )}
              <View pointerEvents="none" style={{ flex: 1 }} />
              {!immersiveFeed && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Mint mock SKR"
                  onPress={() => nav('Mint mock SKR')}
                  style={s.alphaBadge}
                >
                  <View style={s.statusDot} />
                  <Txt style={{ fontSize: 10, lineHeight: 14, color: c.cream }}>Early alpha · Devnet</Txt>
                </Pressable>
              )}
              {desktop && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Open your profile"
                  onPress={() => setTab('Profile')}
                  style={s.profileButton}
                >
                  <Avatar letter={wallet.address ? 'S' : '?'} size={32} color={c.pink} />
                </Pressable>
              )}
            </View>
            <View style={s.body}>
              <View
                style={[
                  s.screen,
                  tab === 'Feed' && { paddingHorizontal: desktop ? 28 : 0, paddingBottom: desktop ? 14 : 0 },
                ]}
              >
                {tab === 'Feed' ? (
                  <Feed
                    key={discovery?.id ?? 'feed'}
                    initialPost={discovery}
                    activePostId={feedPostId}
                    onPostChange={setFeedPostId}
                    filter={feedFilter}
                    onFilterChange={setFeedFilter}
                    onBack={showMarket}
                    onComments={setComments}
                    topInset={immersiveFeed ? insets.top : 0}
                    bottomInset={immersiveFeed ? insets.bottom + 60 : 0}
                    immersive={immersiveFeed}
                    obscured={!!market || !!comments || connect || menu}
                  />
                ) : tab === 'Discover' ? (
                  <Discover onPost={watchPost} />
                ) : tab === 'Create' ? (
                  <Create onConnect={openConnect} />
                ) : tab === 'Collection' ? (
                  <Collection
                    onConnect={openConnect}
                    onPost={(post, side) => (side ? showMarket(post, side) : watchPost(post))}
                    onExplore={() => setTab('Feed')}
                    portfolioRevision={portfolioRevision}
                  />
                ) : tab === 'Mint mock SKR' ? (
                  <DevnetFaucet onConnect={openConnect} />
                ) : (
                  <Profile
                    onConnect={openConnect}
                    onFaucet={() => nav('Mint mock SKR')}
                    onPost={showMarket}
                    portfolioRevision={portfolioRevision}
                  />
                )}
              </View>
              {wide && tab === 'Feed' && (
                <ScrollView style={s.rail} contentContainerStyle={{ padding: 24, paddingTop: 30 }}>
                  <View style={s.manifesto}>
                    <Image
                      source={require('../../assets/brand/eye.png')}
                      style={{ width: 43, height: 43, marginBottom: 15 }}
                    />
                    <Txt display style={{ fontSize: 31, lineHeight: 37, color: c.ink }}>
                      You have{'\n'}good taste.
                    </Txt>
                    <Txt style={{ fontSize: 13, lineHeight: 21, color: c.ink, marginTop: 13 }}>
                      Find the next thing.{'\n'}Back it with SKR.{'\n'}Keep the receipt.
                    </Txt>
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => setTab('Discover')}
                      style={s.railCta}
                    >
                      <Txt style={{ color: c.ink, fontWeight: '800', fontSize: 12 }}>
                        See what’s out there
                      </Txt>
                      <Icon name="arrow-forward" color={c.ink} size={17} />
                    </Pressable>
                  </View>
                  <View style={s.railHeading}>
                    <Txt style={{ fontWeight: '700' }}>On our radar</Txt>
                    <Icon name="radio-outline" color={c.pink} size={18} />
                  </View>
                  {posts.slice(0, 3).map((post) => (
                    <View key={post.id} style={s.creatorRow}>
                      <Avatar letter={post.avatar} color={post.color} size={34} />
                      <View style={{ flex: 1 }}>
                        <Txt style={{ fontSize: 12, fontWeight: '700' }}>{post.creator}</Txt>
                        <Txt style={{ fontSize: 10, color: c.muted }}>{post.tag}</Txt>
                      </View>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`${following.includes(post.creator) ? 'Unfollow' : 'Follow'} ${post.creator}`}
                        onPress={() => toggleFollow(post.creator)}
                      >
                        <Icon
                          name={following.includes(post.creator) ? 'checkmark-circle' : 'add-circle-outline'}
                          color={c.lime}
                          size={22}
                        />
                      </Pressable>
                    </View>
                  ))}
                  <View style={s.reward}>
                    <Icon name="gift-outline" color={c.yellow} size={25} />
                    <Txt style={{ fontSize: 14, fontWeight: '700', marginTop: 13 }}>
                      Try backing your favorites.
                    </Txt>
                    <Txt style={{ fontSize: 12, lineHeight: 19, color: c.muted, marginTop: 8 }}>
                      Mint mock SKR to explore post markets on devnet.
                    </Txt>
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => nav('Mint mock SKR')}
                      style={{ marginTop: 15 }}
                    >
                      <Txt style={{ color: c.yellow, fontSize: 12, fontWeight: '700' }}>Mint mock SKR</Txt>
                    </Pressable>
                  </View>
                  <Txt style={s.railFooter}>
                    Clout is for the early ones.{'\n'}
                    {posts.some((post) => post.market)
                      ? `${posts.filter((post) => post.market).length} devnet markets · Mock SKR`
                      : 'Licensed sample content'}
                  </Txt>
                </ScrollView>
              )}
            </View>
            {!desktop && (!keyboardVisible || immersiveFeed) && (
              <View
                style={[
                  s.bottomNav,
                  immersiveFeed && [s.feedNav, { height: 60 + insets.bottom, paddingBottom: insets.bottom }],
                ]}
              >
                {tabs.map((item) => (
                  <Pressable
                    accessibilityRole="tab"
                    accessibilityLabel={item.name}
                    accessibilityState={{ selected: tab === item.name }}
                    aria-selected={tab === item.name}
                    key={item.name}
                    onPress={() => nav(item.name)}
                    style={s.bottomItem}
                  >
                    <View style={item.name === 'Create' ? s.createIcon : undefined}>
                      <Icon
                        name={tab === item.name ? item.active : item.icon}
                        size={item.name === 'Create' ? 30 : 23}
                        color={item.name === 'Create' ? c.ink : tab === item.name ? c.pink : c.muted}
                      />
                    </View>
                    <Txt
                      style={{
                        fontSize: 10,
                        lineHeight: 14,
                        color: tab === item.name ? c.pink : c.muted,
                        fontWeight: '700',
                      }}
                    >
                      {item.name}
                    </Txt>
                  </Pressable>
                ))}
              </View>
            )}
          </KeyboardAvoidingView>
        </View>
        {!!message && (
          <View accessibilityRole="alert" pointerEvents="none" style={s.toast}>
            <Icon name="information-circle" size={18} color={c.lime} />
            <Txt style={{ fontSize: 13, flex: 1 }}>{message}</Txt>
          </View>
        )}
      </View>
      {market && (
        <MarketSheet
          initialSide={marketSide}
          post={market}
          onClose={closeMarket}
          onConnect={openConnect}
          onConfirmed={() => setMarketChanged(true)}
        />
      )}
      {comments && (
        <CommentsSheet post={comments} onClose={() => setComments(null)} onConnect={openConnect} />
      )}
      {connect && <ConnectSheet onClose={() => setConnect(false)} />}
      {menu && (
        <Sheet title="Your Clout" onClose={() => setMenu(false)}>
          <Txt style={{ color: c.muted, fontSize: 13, marginBottom: 18 }}>{SLOGAN}</Txt>
          {[
            ...tabs,
            { name: 'Mint mock SKR' as Tab, icon: 'water-outline' as IconName, active: 'water' as IconName },
          ].map((item) => (
            <Pressable
              key={item.name}
              accessibilityRole="button"
              accessibilityLabel={`Go to ${item.name}`}
              onPress={() => nav(item.name)}
              style={[s.navItem, tab === item.name && s.navActive]}
            >
              <Icon name={item.icon} color={item.name === 'Mint mock SKR' ? c.lime : c.pink} />
              <Txt style={{ fontWeight: '700' }}>{item.name}</Txt>
            </Pressable>
          ))}
          <Txt style={{ color: c.muted, fontSize: 11, marginTop: 20 }}>
            Early alpha · Devnet only. Mock SKR has no monetary value.
          </Txt>
        </Sheet>
      )}
    </SafeAreaView>
  )
}
const s = StyleSheet.create({
  safe: { flex: 1, minHeight: 0, overflow: 'hidden', backgroundColor: c.ink },
  app: {
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
    flexDirection: 'row',
    maxWidth: 1600,
    width: '100%',
    alignSelf: 'center',
  },
  sidebar: { width: 244, borderRightWidth: 1, borderColor: c.line, padding: 26, paddingTop: 32 },
  logo: { width: 150, height: 65, alignSelf: 'flex-start' },
  slogan: { color: c.muted, fontSize: 12, lineHeight: 18, marginTop: 16, maxWidth: 170 },
  nav: { gap: 8, marginTop: 36 },
  navItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 13,
    paddingVertical: 15,
    paddingHorizontal: 14,
    borderRadius: 14,
  },
  navActive: { backgroundColor: c.surface },
  navText: { fontWeight: '700', color: c.muted },
  navDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: c.pink, marginLeft: 'auto' },
  devnetSection: { borderTopWidth: 1, borderColor: c.line, marginTop: 20, paddingTop: 16 },
  alphaBadge: { minHeight: 48, paddingHorizontal: 8, flexDirection: 'row', alignItems: 'center', gap: 6 },
  seekerCard: {
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.line,
    borderRadius: 19,
    padding: 17,
    marginTop: 36,
  },
  status: { flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 25 },
  statusDot: { height: 5, width: 5, borderRadius: 3, backgroundColor: c.lime },
  sidebarFooter: { fontSize: 10, color: c.muted, marginTop: 8 },
  main: { flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden' },
  keyboardMain: { flex: 1, minHeight: 0, width: '100%', overflow: 'hidden' },
  header: {
    height: 70,
    flexShrink: 0,
    paddingHorizontal: 32,
    borderBottomWidth: 1,
    borderColor: c.line,
    flexDirection: 'row',
    alignItems: 'center',
  },
  feedHeader: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 52,
    borderBottomWidth: 0,
    zIndex: 2,
  },
  profileButton: { marginLeft: 6, width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  body: { flex: 1, flexDirection: 'row', minHeight: 0 },
  screen: { flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden' },
  rail: { width: 290, flexGrow: 0, borderLeftWidth: 1, borderColor: c.line },
  manifesto: { backgroundColor: c.lime, borderRadius: 22, padding: 24 },
  railCta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 21,
    borderTopWidth: 1,
    borderColor: 'rgba(21,18,28,.2)',
    paddingTop: 17,
  },
  railHeading: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 28, marginBottom: 19 },
  creatorRow: { flexDirection: 'row', alignItems: 'center', gap: 9, marginBottom: 20 },
  reward: {
    backgroundColor: c.surface,
    padding: 20,
    borderRadius: 19,
    marginTop: 10,
    borderWidth: 1,
    borderColor: c.line,
  },
  railFooter: { color: c.muted, fontSize: 10, lineHeight: 18, marginTop: 22 },
  bottomNav: {
    height: 60,
    flexShrink: 0,
    flexDirection: 'row',
    borderTopWidth: 1,
    borderColor: c.line,
    alignItems: 'center',
  },
  feedNav: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    zIndex: 2,
    backgroundColor: 'rgba(21,18,28,.88)',
  },
  bottomItem: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 3, height: 56 },
  createIcon: {
    backgroundColor: c.pink,
    width: 42,
    height: 31,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  toast: {
    position: 'absolute',
    bottom: 80,
    alignSelf: 'center',
    left: '10%',
    right: '10%',
    maxWidth: 600,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.line,
    borderRadius: 15,
    padding: 15,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
})
