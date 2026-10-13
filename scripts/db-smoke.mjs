import assert from 'node:assert/strict'
const base = new URL(process.argv[2] ?? 'http://127.0.0.1:8787')
assert.ok(
  ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname),
  'This read-only smoke targets a local API only.',
)
async function get(path, status = 200) {
  const response = await fetch(new URL(path, base), { signal: AbortSignal.timeout(10000) })
  assert.equal(response.status, status, path)
  return response.json()
}
const config = await get('/v1/config')
assert.equal(config.slogan, 'Seek the best content, win SKR')
assert.equal(config.network, 'devnet')
assert.equal(config.rewardSymbol, 'SKR')
const feed = await get('/v1/feed')
assert.ok(Array.isArray(feed.posts))
const campaign = await get('/v1/rewards/campaign')
assert.equal(typeof campaign.available, 'boolean')
assert.ok('campaign' in campaign)
assert.equal(campaign.claim ?? null, null, 'Guest must not receive an owner claim.')
let activityChecked = false
if (feed.posts[0]) {
  const activity = await get(`/v1/posts/${encodeURIComponent(feed.posts[0].id)}/activity`)
  assert.equal(activity.source, 'clout-transactions')
  assert.equal(activity.baseDecimals, 6)
  assert.ok(Number.isInteger(activity.quoteDecimals))
  assert.ok(Array.isArray(activity.events))
  for (const event of activity.events) {
    assert.equal(typeof event.signature, 'string')
    assert.ok(['buy', 'sell'].includes(event.kind))
    assert.match(event.baseAmount, /^\d+$/)
    assert.match(event.quoteAmount, /^\d+$/)
    assert.ok(['confirmed', 'finalized'].includes(event.finality))
  }
  activityChecked = true
}
assert.equal((await get('/v1/claims/00000000-0000-4000-8000-000000000000', 401)).error.code, 'AUTH_REQUIRED')
console.log(
  JSON.stringify(
    {
      api: base.origin,
      readOnly: true,
      mode: config.mode,
      posts: feed.posts.length,
      rewardContract: 'pass',
      activityContract: activityChecked ? 'pass' : 'no posts',
      ownerClaimProtection: 'pass',
      slogan: 'pass',
    },
    null,
    2,
  ),
)
