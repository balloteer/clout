/* global __dirname */
const {
  withAndroidManifest,
  withMainActivity,
  withMainApplication,
  withDangerousMod,
} = require('expo/config-plugins')
const { mkdir, readFile, writeFile } = require('node:fs/promises')
const path = require('node:path')

const PACKAGES = ['com.solanamobile.wallet', 'com.solanamobile.seekerwallet']
const BEGIN = '  // @clout/seeker-wallet begin'
const END = '  // @clout/seeker-wallet end'
const BLOCK = `${BEGIN}
  override fun startActivityForResult(intent: Intent, requestCode: Int, options: Bundle?) {
    super.startActivityForResult(SeekerWalletRouter.route(this, intent), requestCode, options)
  }
${END}`

function transformMainActivity(source) {
  const starts = source.split(BEGIN).length - 1
  const ends = source.split(END).length - 1
  if (starts !== ends || starts > 1) throw new Error('Seeker wallet routing markers conflict.')
  if (starts === 1) {
    const start = source.indexOf(BEGIN)
    const end = source.indexOf(END)
    if (end < start) throw new Error('Seeker wallet routing markers conflict.')
    source = source.slice(0, start) + source.slice(end + END.length).replace(/^\r?\n/, '')
  }
  if (/\bfun\s+startActivityForResult\s*\(/.test(source))
    throw new Error('Seeker wallet routing cannot replace an existing startActivityForResult override.')
  const packageLine = /^package\s+[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*\s*$/m
  if (!packageLine.test(source)) throw new Error('Expected a Kotlin MainActivity package declaration.')
  const imports = ['android.content.Intent', 'android.os.Bundle'].filter(
    (name) => !source.split(/\r?\n/).some((line) => line.trim() === `import ${name}`),
  )
  if (imports.length)
    source = source.replace(
      packageLine,
      (line) => `${line}\n${imports.map((name) => `import ${name}`).join('\n')}`,
    )
  const declaration = /class\s+MainActivity\s*:\s*ReactActivity\s*\(\s*\)\s*\{/
  if (!declaration.test(source)) throw new Error('Expected the Expo Kotlin ReactActivity declaration.')
  return source.replace(declaration, (line) => `${line}\n${BLOCK}`)
}

function addPackageQueries(manifest) {
  const queries = (manifest.queries ??= [])
  if (!queries.length) queries.push({})
  for (const name of PACKAGES) {
    const exists = queries.some((query) => query.package?.some((item) => item.$?.['android:name'] === name))
    if (!exists) (queries[0].package ??= []).push({ $: { 'android:name': name } })
  }
  return manifest
}

function transformMainApplication(source) {
  const begin = '          // @clout/seeker-package begin'
  const end = '          // @clout/seeker-package end'
  const starts = source.split(begin).length - 1
  const ends = source.split(end).length - 1
  if (starts !== ends || starts > 1) throw new Error('Seeker package registration markers conflict.')
  if (starts === 1) {
    const start = source.indexOf(begin),
      finish = source.indexOf(end)
    if (finish < start) throw new Error('Seeker package registration markers conflict.')
    source = source.slice(0, start) + source.slice(finish + end.length).replace(/^\r?\n/, '')
  }
  if (/\bCloutSeekerWalletPackage\s*\(/.test(source))
    throw new Error('Seeker package registration already exists outside the managed block.')
  const declaration = /PackageList\(this\)\.packages\.apply\s*\{/g
  if ([...source.matchAll(declaration)].length !== 1)
    throw new Error('Expected one Expo PackageList application block.')
  return source.replace(
    declaration,
    (line) => `${line}\n${begin}\n          add(CloutSeekerWalletPackage())\n${end}`,
  )
}

function withSeekerWallet(config) {
  const namespace = config.android?.package
  if (!namespace || !/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+$/.test(namespace))
    throw new Error('Seeker wallet routing requires an Android package name.')
  config = withAndroidManifest(config, (mod) => {
    addPackageQueries(mod.modResults.manifest)
    return mod
  })
  config = withMainActivity(config, (mod) => {
    if (mod.modResults.language !== 'kt')
      throw new Error('Seeker wallet routing requires Kotlin MainActivity.')
    const declared = mod.modResults.contents.match(/^package\s+([\w.]+)\s*$/m)?.[1]
    if (declared !== namespace)
      throw new Error('MainActivity package differs from the configured Android package.')
    mod.modResults.contents = transformMainActivity(mod.modResults.contents)
    return mod
  })
  config = withMainApplication(config, (mod) => {
    if (mod.modResults.language !== 'kt')
      throw new Error('Seeker wallet routing requires Kotlin MainApplication.')
    const declared = mod.modResults.contents.match(/^package\s+([\w.]+)\s*$/m)?.[1]
    if (declared !== namespace)
      throw new Error('MainApplication package differs from the configured Android package.')
    mod.modResults.contents = transformMainApplication(mod.modResults.contents)
    return mod
  })
  return withDangerousMod(config, [
    'android',
    async (mod) => {
      const directory = path.join(
        mod.modRequest.platformProjectRoot,
        'app/src/main/java',
        ...namespace.split('.'),
      )
      await mkdir(directory, { recursive: true })
      for (const name of ['SeekerWalletRouter', 'CloutSeekerWalletPackage']) {
        const template = await readFile(path.join(__dirname, `${name}.kt.template`), 'utf8')
        await writeFile(
          path.join(directory, `${name}.kt`),
          template.replace('__CLOUT_PACKAGE__', namespace),
          'utf8',
        )
      }
      return mod
    },
  ])
}

module.exports = withSeekerWallet
module.exports.transformMainActivity = transformMainActivity
module.exports.addPackageQueries = addPackageQueries
module.exports.transformMainApplication = transformMainApplication
