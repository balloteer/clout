const { withAndroidManifest, withDangerousMod } = require('expo/config-plugins')
const { mkdir, writeFile, rm } = require('node:fs/promises')
const path = require('node:path')

const RESOURCE = '@xml/clout_preview_network_security'
const ATTRIBUTE = 'android:networkSecurityConfig'
const XML = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <base-config cleartextTrafficPermitted="false" />
  <domain-config cleartextTrafficPermitted="true">
    <domain includeSubdomains="false">127.0.0.1</domain>
  </domain-config>
</network-security-config>
`

module.exports = function withPreviewApi(config) {
  const enabled = process.env.CLOUT_PREVIEW_USB === '1'
  if (enabled && process.env.EXPO_PUBLIC_API_URL !== 'http://127.0.0.1:8787')
    throw new Error('USB preview requires EXPO_PUBLIC_API_URL exactly http://127.0.0.1:8787.')

  config = withAndroidManifest(config, (mod) => {
    const application = mod.modResults.manifest.application?.[0]
    if (!application) throw new Error('Android application manifest is missing.')
    const attributes = (application.$ ??= {})
    const previous = attributes[ATTRIBUTE]
    if (enabled) {
      if (previous && previous !== RESOURCE)
        throw new Error('USB preview cannot replace an existing Android network security configuration.')
      attributes[ATTRIBUTE] = RESOURCE
    } else if (previous === RESOURCE) {
      delete attributes[ATTRIBUTE]
    }
    return mod
  })

  return withDangerousMod(config, [
    'android',
    async (mod) => {
      const file = path.join(
        mod.modRequest.platformProjectRoot,
        'app/src/main/res/xml/clout_preview_network_security.xml',
      )
      if (enabled) {
        await mkdir(path.dirname(file), { recursive: true })
        await writeFile(file, XML, 'utf8')
      } else {
        await rm(file, { force: true })
      }
      return mod
    },
  ])
}
