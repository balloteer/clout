import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergePreviewFeed } from './catalog'

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
      { id: 'x-1', market: false },
      { id: 'sample-001', market: true },
      { id: 'community-1', market: false },
    ],
  )
})
