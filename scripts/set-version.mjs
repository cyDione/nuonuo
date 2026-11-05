#!/usr/bin/env node
// Sets one version on every package in the workspace, so the app, the release tag and the plugins agree.
// Usage: pnpm set-version 0.1.4   (then commit, and tag v0.1.4)
//        pnpm set-version --check v0.1.4   (exits 1 unless every package is at that version; used by the release workflow)
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(import.meta.url), '../..')
const args = process.argv.slice(2)
const check = args[0] === '--check'
const version = (check ? args[1] : args[0])?.replace(/^v/, '')
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error('usage: pnpm set-version <x.y.z>   or   pnpm set-version --check <x.y.z>')
  process.exit(2)
}

const files = ['apps', 'packages'].flatMap(dir => readdirSync(join(root, dir)).map(name => join(root, dir, name, 'package.json')))
  .filter(existsSync)
let wrong = 0
for (const file of files) {
  const text = readFileSync(file, 'utf8')
  const current = JSON.parse(text).version
  if (current === version) continue
  if (check) { console.error(`${relative(root, file)}: ${current}, expected ${version}`); wrong++; continue }
  // Only the version line changes, so the rest of the file keeps its formatting.
  writeFileSync(file, text.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`))
  console.log(`${relative(root, file)}: ${current} → ${version}`)
}
if (check && wrong) process.exit(1)
if (check) console.log(`all ${files.length} packages are at ${version}`)
