export interface AndroidAppIdentity {
  packageName: string
  sha256CertFingerprint: string
}

/** Build the public Android Digital Asset Links record from an explicit signing certificate. */
export function parseAndroidAppIdentity(
  fingerprint: string | undefined,
  packageName = 'app.clout.mobile',
): AndroidAppIdentity | undefined {
  if (fingerprint === undefined) return undefined
  if (!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(packageName))
    throw new Error('ANDROID_APP_PACKAGE must be a valid Android application ID.')
  const compact = fingerprint.replaceAll(':', '')
  if (!/^[a-f0-9]{64}$/i.test(compact))
    throw new Error('ANDROID_APP_SHA256_CERT_FINGERPRINT must contain exactly 32 hexadecimal bytes.')
  return {
    packageName,
    sha256CertFingerprint: compact.toUpperCase().match(/.{2}/g)!.join(':'),
  }
}

export function androidAssetLinks(identity: AndroidAppIdentity) {
  return [
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: identity.packageName,
        sha256_cert_fingerprints: [identity.sha256CertFingerprint],
      },
    },
  ]
}
