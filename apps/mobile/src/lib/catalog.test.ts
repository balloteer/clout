import { test } from 'node:test'
import assert from 'node:assert/strict'
import { filterFeedPosts, interleaveMarkets, mergePreviewFeed } from './catalog'
import curatedContent from './curated-content.json'
import { sampleContent } from '../../../../packages/shared/src/sample-content'
import { sampleMarkets } from '../../../../packages/shared/src/sample-markets'

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

test('the full catalog retains all 68 markets and curated videos after API refresh', () => {
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
  assert.equal(initial.length, 68)
  assert.equal(initial[0].market, true)
  assert.equal(initial[0].id, curatedContent[0].id)
  assert.deepEqual(refreshed, initial, 'API hydration preserves catalog order without duplicate posts')
  assert.equal(new Set(refreshed.map((post) => post.id)).size, 68)
  const markets = filterFeedPosts(refreshed, 'markets', [])
  assert.equal(markets.length, 68)
  assert.ok(markets.every((post) => post.market && sampleMarkets[post.id]))
  assert.deepEqual(filterFeedPosts(refreshed, 'for-you', []), refreshed)
  assert.deepEqual(
    filterFeedPosts(refreshed, 'following', [curatedContent[0].creator]),
    refreshed.filter((post) => post.creator === curatedContent[0].creator),
  )
})

test('each catalog post has a distinct registered market and launch receipt', () => {
  const ids = [...curatedContent, ...sampleContent].map((post) => post.id)
  assert.equal(ids.length, 68)
  assert.equal(new Set(ids).size, ids.length)
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
