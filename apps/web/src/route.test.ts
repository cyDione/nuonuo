import { describe, expect, it } from 'vitest'
import { parseRoute, SETTINGS_TABS } from './route'

describe('web hash router (parseRoute)', () => {
  it('defaults empty or unknown hashes to the main conversation', () => {
    expect(parseRoute('')).toEqual({ page: 'chat', main: true })
    expect(parseRoute('#/')).toEqual({ page: 'chat', main: true })
    expect(parseRoute('#/unknown/path')).toEqual({ page: 'chat', main: true })
  })

  it('parses chat, new chat, and top-level views', () => {
    expect(parseRoute('#/c/cnv_abc123')).toEqual({ page: 'chat', id: 'cnv_abc123' })
    expect(parseRoute('#/new')).toEqual({ page: 'chat' })
    expect(parseRoute('#/activity')).toEqual({ page: 'activity' })
    expect(parseRoute('#/library')).toEqual({ page: 'library' })
    expect(parseRoute('#/goals')).toEqual({ page: 'goals' })
    expect(parseRoute('#/ideas')).toEqual({ page: 'ideas' })
    expect(parseRoute('#/me')).toEqual({ page: 'me' })
    expect(parseRoute('#/quick')).toEqual({ page: 'quick' })
    expect(parseRoute('#/waiting')).toEqual({ page: 'waiting' })
  })

  it('redirects legacy settings routes to their current homes', () => {
    expect(parseRoute('#/settings/instructions')).toEqual({ page: 'me' })
    expect(parseRoute('#/settings/memory')).toEqual({ page: 'me' })
    expect(parseRoute('#/settings/review')).toEqual({ page: 'settings', tab: 'execution' })
  })

  it('parses every settings tab and decodes optional item slugs', () => {
    for (const tab of SETTINGS_TABS) {
      expect(parseRoute(`#/settings/${tab}`)).toEqual({ page: 'settings', tab })
    }
    expect(parseRoute('#/settings/plugins/my%20plugin')).toEqual({ page: 'settings', tab: 'plugins', item: 'my plugin' })
    expect(parseRoute('#/settings/nonexistent')).toEqual({ page: 'settings', tab: 'persona' })
  })
})
