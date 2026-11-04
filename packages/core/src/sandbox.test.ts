import { execSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Ticket } from './model'
import { sandboxApplies, sandboxCommand, type SandboxSettings } from './sandbox'

const ticket = (threadId: string, directory = '/tmp/x'): Ticket => ({ id: 'tkt_t', name: 'n', title: 't', note: null, threadId, origin: { triggerIds: [] },
  mandate: { by: 'owner', strength: 'explicit', triggerIds: [], at: 0 }, directory, sessionId: 's', latestReport: null, attention: null, ended: null, createdAt: 0, updatedAt: 0 })

const IMAGE = 'mirror.gcr.io/library/node:22-bookworm-slim'
const dockerReady = spawnSync('docker', ['image', 'inspect', IMAGE], { stdio: 'ignore' }).status === 0

describe('sandbox', () => {
  it('applies by mode and source', () => {
    const s: SandboxSettings = { mode: 'external', image: 'x', network: 'none' }
    expect(sandboxApplies(s, ticket('webchat:cnv_1'))).toBe(false)
    expect(sandboxApplies(s, ticket('github:o/r#1'))).toBe(true)
    expect(sandboxApplies({ ...s, mode: 'all' }, ticket('webchat:cnv_1'))).toBe(true)
    expect(sandboxApplies({ ...s, mode: 'off' }, ticket('github:o/r#1'))).toBe(false)
  })

  it('quotes commands safely', () => {
    const cmd = sandboxCommand({ mode: 'all', image: 'img', network: 'none' }, ticket('webchat:c', "/tmp/it's here"), `echo 'a' && echo "b"`, 1000, 1000)
    expect(cmd).toContain(`-v '/tmp/it'\\''s here:/tmp/it'\\''s here'`)
    expect(cmd).toContain(`bash -lc 'echo '\\''a'\\'' && echo "b"'`)
  })

  it.skipIf(!dockerReady)('runs in a container that sees only the working directory, as the owner, without network when asked', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sa-box-'))
    const t = ticket('github:o/r#1', dir)
    const run = (command: string, network: 'none' | 'bridge' = 'none') =>
      spawnSync('bash', ['-lc', sandboxCommand({ mode: 'all', image: IMAGE, network }, t, command)], { encoding: 'utf8', timeout: 120_000 })
    const r = run('node -e "require(\'fs\').writeFileSync(\'made.txt\', process.version)" && ls / | grep -c home && test ! -e /root/.superagent && echo isolated')
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('isolated')
    expect(readFileSync(join(dir, 'made.txt'), 'utf8')).toMatch(/^v22\./)
    expect(statSync(join(dir, 'made.txt')).uid).toBe(Number(execSync('id -u').toString()))
    const offline = run(`node -e "require('dns').lookup('example.com', e => { console.log(e ? 'offline' : 'online') })"`)
    expect(offline.stdout.trim()).toBe('offline')
    expect(existsSync(join(dir, 'made.txt'))).toBe(true)
  }, 180_000)
})
