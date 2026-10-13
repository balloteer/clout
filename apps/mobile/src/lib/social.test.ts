import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readPreferences, savedKey, toggleItem } from './social'

test('saved community preferences are isolated for guest and each wallet', () => {
  assert.notEqual(savedKey(), savedKey('wallet-a'))
  assert.notEqual(savedKey('wallet-a'), savedKey('wallet-b'))
})
test('stored preferences reject malformed field types and deduplicate identifiers', () => {
  assert.deepEqual(
    readPreferences(JSON.stringify({ liked: ['post', 'post', 10], saved: {}, following: null })),
    { liked: ['post'], saved: [], following: [] },
  )
  assert.deepEqual(readPreferences('null'), { liked: [], saved: [], following: [] })
  assert.throws(() => readPreferences('{invalid'))
})
test('a local sample toggle is reversible without changing other preferences', () => {
  assert.deepEqual(toggleItem(toggleItem(['one'], 'two'), 'two'), ['one'])
})
