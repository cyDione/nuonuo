// electron-builder never copies node_modules through extraResources, so the daemon's
// production dependencies (staged by stage-daemon.sh) are copied in here, before the
// installer targets (AppImage, dmg, ...) are made from the packed app.
const { cpSync, existsSync } = require('node:fs')
const { join } = require('node:path')

exports.default = async function afterPack(context) {
  const from = join(__dirname, '..', '.stage', 'daemon', 'node_modules')
  if (!existsSync(from)) throw new Error('daemon dependencies are not staged; run `pnpm stage` in apps/desktop first')
  const resources = context.electronPlatformName === 'darwin'
    ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : join(context.appOutDir, 'resources')
  cpSync(from, join(resources, 'daemon', 'node_modules'), { recursive: true })
}
