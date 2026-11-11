import { openStore } from '@nuonuo/db'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Blobs } from './blobs'
import { McpManager, mcpToolName, type McpServerConfig } from './mcp'

const calc = (extra: Partial<McpServerConfig> = {}): McpServerConfig => ({
  name: 'calc', enabled: true, transport: 'stdio', command: process.execPath, args: [join(__dirname, 'testing-mcp-server.mjs')],
  env: { CALC_USER: '${TEST_CALC_USER}' }, roles: ['worker'], review: false, ...extra,
})

describe('McpManager', () => {
  it('connects a stdio server, exposes its tools, resolves ${ENV} and keeps other variables out', async () => {
    const store = openStore(':memory:')
    let servers = [calc()]
    const mcp = new McpManager(() => servers, new Blobs(store), { TEST_CALC_USER: 'owner', OPENAI_API_KEY: 'sk-x', PATH: process.env.PATH })
    try {
      const [status] = await mcp.sync()
      expect(status).toMatchObject({ name: 'calc', state: 'connected' })
      expect(status!.tools.map(t => t.name).sort()).toEqual(['add', 'whoami'])
      const tools = mcp.tools('worker')
      expect(Object.keys(tools).sort()).toEqual([mcpToolName('calc', 'add'), mcpToolName('calc', 'whoami')])
      expect(mcp.tools('router')).toEqual({})
      const run = (name: string, input: unknown) => (tools[name] as any).execute(input, { toolCallId: 'x', messages: [] })
      expect(await run('mcp_calc_add', { a: 2, b: 40 })).toBe('42')
      expect(await run('mcp_calc_whoami', {})).toBe('user=owner; secret_visible=no')

      let gated: unknown
      servers = [calc({ review: true })]
      await mcp.sync()
      const reviewed = mcp.tools('worker', async (_server, tool, args) => { gated = { tool, args }; return { action: 'escalate', approvalId: 'apv_1', reason: '外部工具' } })
      expect(await (reviewed.mcp_calc_add as any).execute({ a: 1, b: 1 }, { toolCallId: 'y', messages: [] })).toContain('apv_1')
      expect(gated).toEqual({ tool: 'add', args: { a: 1, b: 1 } })

      servers = [calc({ command: '/nonexistent/server' })]
      expect((await mcp.sync())[0]).toMatchObject({ state: 'error' })
    } finally {
      await mcp.close()
      store.close()
    }
  }, 30_000)
})
