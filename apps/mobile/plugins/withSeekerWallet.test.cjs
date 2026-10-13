const assert = require('node:assert/strict')
const { test } = require('node:test')
const {
  transformMainActivity,
  addPackageQueries,
  transformMainApplication,
} = require('./withSeekerWallet.cjs')

const source = `package app.clout.mobile

import android.os.Bundle
import com.facebook.react.ReactActivity

class MainActivity : ReactActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(null)
  }
}
`

test('routing insertion is repeatable and preserves existing activity methods and imports', () => {
  const once = transformMainActivity(source)
  assert.equal(transformMainActivity(once), once)
  assert.equal((once.match(/import android.content.Intent/g) ?? []).length, 1)
  assert.equal((once.match(/import android.os.Bundle/g) ?? []).length, 1)
  assert.equal((once.match(/override fun startActivityForResult/g) ?? []).length, 1)
  assert(
    once.includes(
      'super.startActivityForResult(SeekerWalletRouter.route(this, intent), requestCode, options)',
    ),
  )
  assert(once.includes('override fun onCreate(savedInstanceState: Bundle?) {\n    super.onCreate(null)'))
})

test('routing rejects conflicting overrides, malformed markers and unsupported activity templates', () => {
  assert.throws(
    () =>
      transformMainActivity(source.replace('override fun onCreate', 'override fun startActivityForResult')),
    /existing startActivityForResult/,
  )
  assert.throws(() => transformMainActivity(source + '  // @clout/seeker-wallet begin'), /markers conflict/)
  assert.throws(
    () => transformMainActivity(source.replace('ReactActivity()', 'OtherActivity()')),
    /ReactActivity declaration/,
  )
})

test('manifest adds only production wallet visibility and preserves existing queries without duplicates', () => {
  const manifest = {
    queries: [{ intent: [{ action: [{ $: { 'android:name': 'android.intent.action.VIEW' } }] }] }],
  }
  const result = addPackageQueries(manifest)
  assert.equal(addPackageQueries(result), result)
  assert.deepEqual(
    result.queries[0].package.map((row) => row.$['android:name']),
    ['com.solanamobile.wallet', 'com.solanamobile.seekerwallet'],
  )
  assert.equal(result.queries[0].intent[0].action[0].$['android:name'], 'android.intent.action.VIEW')
})

test('native availability module registration is idempotent and refuses conflicting registrations', () => {
  const source =
    'package app.clout.mobile\nclass MainApplication {\n val list = PackageList(this).packages.apply {\n  add(OtherPackage())\n }\n}'
  const result = transformMainApplication(source)
  assert.equal(transformMainApplication(result), result)
  assert.equal((result.match(/add\(CloutSeekerWalletPackage\(\)\)/g) ?? []).length, 1)
  assert(result.includes('add(OtherPackage())'))
  assert.throws(
    () => transformMainApplication(source.replace('OtherPackage()', 'CloutSeekerWalletPackage()')),
    /already exists/,
  )
  assert.throws(() => transformMainApplication('class MainApplication {}'), /PackageList/)
})
