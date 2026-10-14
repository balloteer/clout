import assert from 'node:assert/strict'
import test from 'node:test'
import { profileName } from './profile-name'

test('profile names hide the shared .skr suffix only', () => {
  assert.equal(profileName('vcnzoct.skr'), 'vcnzoct')
  assert.equal(profileName('Vcnzoct.SKR'), 'Vcnzoct')
  assert.equal(profileName('creator'), 'creator')
  assert.equal(profileName(undefined), undefined)
})
