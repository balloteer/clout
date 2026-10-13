import { useRef, useState } from 'react'
import { Image, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native'
import { useApp } from '../lib/store'
import { colors as c, fonts } from '../lib/theme'
import { Avatar, Badge, Icon, Section, Txt } from '../components/ui'
import { imageSource, type Post } from '../lib/data'
export function Discover({ onPost }: { onPost: (post: Post) => void }) {
  const { posts, following, toggleFollow } = useApp()
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('All')
  const results = useRef<ScrollView>(null)
  function search(value: string) {
    setQuery(value)
    results.current?.scrollTo({ y: 0, animated: false })
  }
  const filtered = posts.filter(
    (p) =>
      (category === 'All' || p.tag === category) &&
      `${p.caption} ${p.creator} ${p.tag}`.toLowerCase().includes(query.toLowerCase()),
  )
  return (
    <View style={s.root} testID="discover-screen">
      <View style={s.controls} testID="discover-search-controls">
        <View style={s.search}>
          <Icon name="search-outline" color={c.muted} />
          <TextInput
            accessibilityLabel="Search posts or creators"
            placeholder="Search posts or creators"
            placeholderTextColor={c.muted}
            value={query}
            onChangeText={search}
            returnKeyType="search"
            autoCapitalize="none"
            autoCorrect={false}
            style={s.input}
          />
          {query.length > 0 && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Clear search"
              onPress={() => search('')}
              style={s.clear}
            >
              <Icon name="close" size={19} />
            </Pressable>
          )}
        </View>
        <ScrollView
          horizontal
          testID="discover-categories"
          style={s.categoryRow}
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={s.filters}
        >
          {['All', ...new Set(posts.map((post) => post.tag))].map((tag) => (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: category === tag }}
              aria-pressed={category === tag}
              key={tag}
              onPress={() => {
                setCategory(tag)
                results.current?.scrollTo({ y: 0, animated: false })
              }}
              style={[s.filter, category === tag && { backgroundColor: c.cream }]}
            >
              <Txt style={{ color: category === tag ? c.ink : c.muted, fontWeight: '600', fontSize: 13 }}>
                {tag}
              </Txt>
            </Pressable>
          ))}
        </ScrollView>
      </View>
      <ScrollView
        ref={results}
        testID="discover-results"
        style={s.results}
        contentContainerStyle={s.content}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
      >
        <Section title="Fresh finds" aside={<Badge color={c.pink}>{filtered.length} posts</Badge>}>
          <View style={s.grid}>
            {filtered.map((post) => (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`View ${post.creator} post`}
                key={post.id}
                style={s.card}
                onPress={() => onPost(post)}
              >
                <View style={s.poster}>
                  <Image
                    source={imageSource(post.poster)}
                    style={StyleSheet.absoluteFill}
                    resizeMode="cover"
                  />
                </View>
                <View style={s.cardInfo}>
                  <Badge color={post.color}>{post.tag}</Badge>
                  <Txt numberOfLines={2} style={{ fontWeight: '700', lineHeight: 20 }}>
                    {post.caption}
                  </Txt>
                  <Txt style={{ fontSize: 12, color: c.muted }}>{post.creator}</Txt>
                </View>
              </Pressable>
            ))}
          </View>
          {filtered.length === 0 && (
            <Txt style={{ color: c.muted }}>No finds yet. Try another creator or topic.</Txt>
          )}
        </Section>
        <Section title="People with taste">
          {posts
            .filter((post, index, all) => all.findIndex((item) => item.creator === post.creator) === index)
            .map((post) => (
              <View key={post.id} style={s.person}>
                <Avatar letter={post.avatar} color={post.color} size={44} />
                <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
                  <Txt style={{ fontWeight: '700' }}>{post.creator}</Txt>
                  <Txt style={{ fontSize: 12, color: c.muted }}>
                    {post.tag}
                    {post.source ? ' · Curated from X' : post.sample ? ' · Sample creator' : ''}
                  </Txt>
                </View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${following.includes(post.creator) ? 'Unfollow' : 'Follow'} ${post.creator}`}
                  onPress={() => toggleFollow(post.creator)}
                  style={[s.follow, following.includes(post.creator) && { backgroundColor: c.surface }]}
                >
                  <Txt
                    style={{
                      fontSize: 12,
                      fontWeight: '800',
                      color: following.includes(post.creator) ? c.cream : c.ink,
                    }}
                  >
                    {following.includes(post.creator) ? 'Following' : '+ Follow'}
                  </Txt>
                </Pressable>
              </View>
            ))}
        </Section>
      </ScrollView>
    </View>
  )
}
const s = StyleSheet.create({
  root: { flex: 1, minHeight: 0, maxWidth: 820, width: '100%', alignSelf: 'center' },
  controls: {
    flexShrink: 0,
    paddingHorizontal: 16,
    paddingTop: 12,
    backgroundColor: c.ink,
    borderBottomWidth: 1,
    borderColor: c.line,
  },
  results: { flex: 1, minHeight: 0 },
  content: { padding: 16, paddingTop: 12, paddingBottom: 24 },
  search: {
    borderWidth: 1,
    borderColor: c.line,
    borderRadius: 16,
    backgroundColor: c.surface,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  input: { fontFamily: fonts.body, color: c.cream, flex: 1, minWidth: 0, minHeight: 52, fontSize: 14 },
  clear: { minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  categoryRow: { flexGrow: 0, flexShrink: 0 },
  filters: { gap: 8, paddingVertical: 8 },
  filter: {
    minHeight: 48,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: c.surface,
    justifyContent: 'center',
  },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  card: {
    flexBasis: '46%',
    flexGrow: 1,
    minWidth: 0,
    maxWidth: '49%',
    backgroundColor: c.surface,
    borderRadius: 14,
    overflow: 'hidden',
  },
  poster: { aspectRatio: 3 / 4, width: '100%', overflow: 'hidden' },
  cardInfo: { padding: 10, gap: 7, backgroundColor: c.surface },
  person: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  follow: {
    minHeight: 48,
    justifyContent: 'center',
    paddingHorizontal: 15,
    paddingVertical: 8,
    backgroundColor: c.lime,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: c.line,
  },
})
