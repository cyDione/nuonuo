// Against a real Instabox machine (skipped by default):
//   NUONUO_LIVE_INSTABOX=1 INSTABOX_API_KEY=ibk_... npx vitest run packages/sources/src/computer-instabox.live.test.ts
// It wakes the machine, sets up nuonuo's account there and opens two browsers. It leaves them for the idle reaper.
import { describe, expect, it } from 'vitest'
// @ts-expect-error: the plugin is plain JavaScript
import plugin from '../../../plugins/instabox/index.mjs'
import { Computers, type BoundComputer } from './computer'
import { sdk } from './plugins'

const key = process.env.INSTABOX_API_KEY ?? process.env.instabox_key

describe.skipIf(!process.env.NUONUO_LIVE_INSTABOX || !key)('Instabox, live', () => {
  it('wakes, sets up, runs commands and browsers in nuonuo\'s own account', async () => {
    const p = await plugin(sdk)
    const kind = p.computers[0]
    const ctx = { id: 'instabox', dir: '', log: console.log, state: { get: () => undefined, set: () => {} }, settings: { get: (k: string) => (k === 'apiKey' ? key : undefined) } }
    const bound: BoundComputer = { id: kind.id, title: kind.title, pluginId: 'instabox', capabilities: kind.capabilities,
      status: () => kind.status(ctx), wake: () => kind.wake(ctx), exec: r => kind.exec(ctx, r), keepAwake: r => kind.keepAwake(ctx, r) }
    const computers = new Computers(() => [bound])
    console.log('before', await bound.status())
    let t = Date.now()
    await computers.ready(bound)
    console.log('ready in', Date.now() - t, 'ms')
    computers.touch(bound, 'livetest')
    const r = await computers.start(bound, 'whoami; pwd; sudo -n true 2>/dev/null && echo CAN_SUDO || echo no_sudo; touch /data/home/.nuonuo-probe 2>/dev/null && echo CAN_WRITE_OWNER || echo owner_untouched; docker ps -q >/dev/null && echo DOCKER_OK',
      { cwd: computers.taskDir(bound, 'tkt_live'), waitSeconds: 20, timeoutSeconds: 120 })
    console.log(r.output)
    expect(r.output).toContain('nuonuo\n/data/nuonuo/tasks/tkt_live\nno_sudo\nowner_untouched\nDOCKER_OK')
    t = Date.now()
    const a = await computers.browser<any>(bound, { op: 'open', browser: 'main', tab: 'live', url: 'https://example.com' })
    console.log('open', Date.now() - t, 'ms', a.page.title)
    expect(a.page.title).toContain('Example')
    const b = await computers.browser<any>(bound, { op: 'open', browser: 'second', tab: 'x', url: 'https://news.ycombinator.com' })
    expect(b.page.url).toContain('ycombinator')
    const list = await computers.browser<any>(bound, { op: 'list' })
    console.log(JSON.stringify(list))
    expect(list.browsers.map((x: any) => x.name).sort()).toEqual(expect.arrayContaining(['main', 'second']))
    const shot = await computers.browser<any>(bound, { op: 'screenshot', browser: 'main', tab: 'live' })
    expect(shot.image.length).toBeGreaterThan(1000)
  }, 300_000)
})
