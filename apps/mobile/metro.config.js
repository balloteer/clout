const { getDefaultConfig } = require('expo/metro-config')
const path = require('node:path')
const config = getDefaultConfig(__dirname)
config.maxWorkers = 2
// The monorepo contains SDK caches and generated APKs that Metro must not scan.
const workspaceRoot = path.resolve(__dirname, '../..')
const excludedDirectories = ['.tooling', 'artifacts', 'Clout-Brand-Kit', 'research', 'apps/mobile/android']
const existingBlockList = config.resolver.blockList ?? []
config.resolver.blockList = [
  ...(Array.isArray(existingBlockList) ? existingBlockList : [existingBlockList]),
  ...excludedDirectories.map((directory) => {
    const absolutePath = path.resolve(workspaceRoot, directory).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`^${absolutePath}(?:[/\\\\]|$)`)
  }),
]
module.exports = config
