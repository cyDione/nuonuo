import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Memory } from './memory'

describe('Memory', () => {
  it('keeps three layers as editable Markdown, dedupes, searches and forgets', () => {
    const home = mkdtempSync(join(tmpdir(), 'sa-mem-'))
    const m = new Memory(home)
    expect(m.remember('user', '主人习惯用简体中文，回答要简短', 'trg_1')).toBe('added')
    expect(m.remember('user', '主人习惯用简体中文，回答要简短', 'trg_2')).toBe('exists')
    m.remember('agent', '这台机器上 pnpm 构建需要先 pnpm install --frozen-lockfile', 'tkt_1')
    m.remember('project', '提交信息用英文，PR 描述用中文', 'tkt_2', 'cyDione/super-assistant')
    expect(readFileSync(join(home, 'memory', 'user.md'), 'utf8')).toMatch(/^# 关于主人[\s\S]*- 主人习惯用简体中文，回答要简短 <!-- trg_1 \d{4}-\d\d-\d\d -->/)
    expect(m.projects()).toEqual(['cydione-super-assistant'])
    expect(m.search('PR 描述用什么语言')[0]).toMatchObject({ layer: 'project', text: '提交信息用英文，PR 描述用中文' })
    const prompt = m.prompt('cyDione/super-assistant')
    expect(prompt).toContain('- 主人习惯用简体中文，回答要简短')
    expect(prompt).not.toContain('<!--')
    expect(prompt).toContain('### Project cyDione/super-assistant\n- 提交信息用英文')
    expect(() => m.remember('agent', 'token 是 ghp_abcdefghijklmnopqrstuvwxyz123456', 'x')).toThrow(/凭据/)
    expect(m.forget('user', '简体中文')).toBe(1)
    expect(m.prompt()).toContain('### About the owner\n（空）')
  })
})
