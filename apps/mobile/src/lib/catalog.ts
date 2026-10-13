export type FeedFilter = 'for-you' | 'following' | 'markets'

/** Keep both kinds of content discoverable, beginning with an existing market. */
export function interleaveMarkets<T extends { market: boolean }>(posts: readonly T[]): T[] {
  const markets = posts.filter((post) => post.market)
  const videos = posts.filter((post) => !post.market)
  const result: T[] = []
  for (let index = 0; index < Math.max(markets.length, videos.length); index++) {
    if (markets[index]) result.push(markets[index])
    if (videos[index]) result.push(videos[index])
  }
  return result
}

export function filterFeedPosts<T extends { market: boolean; creator: string }>(
  posts: readonly T[],
  filter: FeedFilter,
  following: readonly string[],
): T[] {
  return posts.filter((post) =>
    filter === 'markets' ? post.market : filter === 'following' ? following.includes(post.creator) : true,
  )
}

/** Keep the preview catalog available when the API returns only hosted posts. */
export function mergePreviewFeed<T extends { id: string; market: boolean }>(
  preview: readonly T[],
  live: readonly T[],
): T[] {
  const liveById = new Map(live.map((post) => [post.id, post]))
  const result = preview.map((post) => liveById.get(post.id) ?? post)
  const seen = new Set(result.map((post) => post.id))
  for (const post of live) {
    if (seen.has(post.id)) continue
    seen.add(post.id)
    result.push(post)
  }
  return interleaveMarkets(result)
}
