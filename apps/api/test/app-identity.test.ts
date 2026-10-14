import assert from 'node:assert/strict'
import test from 'node:test'
import { androidAssetLinks, parseAndroidAppIdentity } from '../src/app-identity.js'

test('Android app identity is absent until a certificate is configured', () => {
  assert.equal(parseAndroidAppIdentity(undefined), undefined)
})

test('Android app identity validates and normalizes the signing certificate', () => {
  const identity = parseAndroidAppIdentity(
    'fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c',
  )!
  assert.equal(identity.packageName, 'app.clout.mobile')
  assert.equal(
    identity.sha256CertFingerprint,
    'FA:C6:17:45:DC:09:03:78:6F:B9:ED:E6:2A:96:2B:39:9F:73:48:F0:BB:6F:89:9B:83:32:66:75:91:03:3B:9C',
  )
  assert.deepEqual(androidAssetLinks(identity)[0].target, {
    namespace: 'android_app',
    package_name: 'app.clout.mobile',
    sha256_cert_fingerprints: [identity.sha256CertFingerprint],
  })
})

test('Android app identity rejects malformed package and certificate values', () => {
  assert.throws(() => parseAndroidAppIdentity('ff', 'app.clout.mobile'), /32 hexadecimal bytes/)
  assert.throws(() => parseAndroidAppIdentity('ab'.repeat(32), 'invalid'), /application ID/)
})
