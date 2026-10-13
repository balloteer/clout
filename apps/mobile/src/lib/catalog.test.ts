import { test } from 'node:test'
import assert from 'node:assert/strict'
import { filterFeedPosts, interleaveMarkets, mergePreviewFeed } from './catalog'
import curatedContent from './curated-content.json'
import archivedContent from '../../../../packages/shared/src/archived-curated-content.json'
import { sampleContent } from '../../../../packages/shared/src/sample-content'
import { sampleMarkets } from '../../../../packages/shared/src/sample-markets'

test('featured videos have reviewed portrait dimensions and original attribution', () => {
  assert.ok(curatedContent.length >= 12)
  for (const post of curatedContent) {
    assert.ok(post.width > 0 && post.height >= 720, post.id)
    assert.ok(post.width / post.height <= 0.65, `${post.id} must be a native portrait source`)
    assert.ok(post.durationSeconds > 0 && post.durationSeconds <= 90, post.id)
    assert.equal(post.source.url, `https://x.com/${post.source.handle}/status/${post.id.slice(2)}`)
  }
})

test('API refresh preserves curated videos and bundled samples alongside community posts', () => {
  const preview = [
    { id: 'x-1', market: false },
    { id: 'sample-001', market: false },
  ]
  assert.deepEqual(mergePreviewFeed(preview, []), preview)
  assert.deepEqual(
    mergePreviewFeed(preview, [
      { id: 'sample-001', market: true },
      { id: 'community-1', market: false },
      { id: 'community-1', market: false },
    ]),
    [
      { id: 'sample-001', market: true },
      { id: 'x-1', market: false },
      { id: 'community-1', market: false },
    ],
  )
})

test('the active portrait catalog retains its markets and order after API refresh', () => {
  const preview = [
    ...curatedContent.map((post) => ({
      id: post.id,
      creator: post.creator,
      market: !!sampleMarkets[post.id],
    })),
    ...sampleContent.map((post) => ({
      id: post.id,
      creator: post.creator,
      market: !!sampleMarkets[post.id],
    })),
  ]
  const initial = interleaveMarkets(preview)
  const refreshed = mergePreviewFeed(initial, [...preview].reverse())
  const expectedCount = sampleContent.length + curatedContent.length
  assert.ok(expectedCount >= 50)
  assert.equal(initial.length, expectedCount)
  assert.equal(initial[0].market, true)
  assert.equal(initial[0].id, curatedContent[0].id)
  assert.deepEqual(refreshed, initial, 'API hydration preserves catalog order without duplicate posts')
  assert.equal(new Set(refreshed.map((post) => post.id)).size, expectedCount)
  const markets = filterFeedPosts(refreshed, 'markets', [])
  assert.equal(markets.length, expectedCount)
  assert.ok(markets.every((post) => post.market && sampleMarkets[post.id]))
  assert.deepEqual(filterFeedPosts(refreshed, 'for-you', []), refreshed)
  assert.deepEqual(
    filterFeedPosts(refreshed, 'following', [curatedContent[0].creator]),
    refreshed.filter((post) => post.creator === curatedContent[0].creator),
  )
})

test('active and retired catalog posts retain distinct registered markets and launch receipts', () => {
  const ids = [...new Set([...curatedContent, ...archivedContent, ...sampleContent].map((post) => post.id))]
  assert.ok(ids.length >= 68, 'all original market registrations remain available')
  assert.deepEqual(Object.keys(sampleMarkets).sort(), [...ids].sort())
  const registrations = ids.map((id) => {
    const market = sampleMarkets[id]
    assert.ok(market, `Missing verified market for ${id}`)
    assert.equal(market.postId, id)
    assert.ok(market.creatorWallet)
    assert.ok(market.baseMint)
    assert.ok(market.dbcPool)
    assert.ok(market.signature)
    return market
  })
  for (const field of ['baseMint', 'dbcPool', 'signature'] as const)
    assert.equal(new Set(registrations.map((market) => market[field])).size, ids.length, field)
})

test('market availability updates remove unavailable posts from the Markets filter', () => {
  const refreshed = mergePreviewFeed(
    [{ id: 'market', creator: 'creator', market: true }],
    [{ id: 'market', creator: 'creator', market: false }],
  )
  assert.deepEqual(filterFeedPosts(refreshed, 'markets', []), [])
  assert.equal(refreshed.length, 1, 'the video remains available in For you')
})
