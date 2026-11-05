/**
 * MCP: the owner's Model Context Protocol servers become tools for the agents. A stdio server is spawned with a minimal
 * environment (plus the variables its config names, `${NAME}` resolved from the daemon's environment, so keys need not be
 * written into settings); an HTTP server is reached by URL. Calls from workers to a server marked `review` pass the review
 * layer like a consequential shell command.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { jsonSchema, tool, type ToolSet } from 'ai'
import pkg from '../package.json' with { type: 'json' }
import type { Blobs } from './blobs'

export interface McpServerConfig {
  name: string
  enabled: boolean
  transport: 'stdio' | 'http'
  command?: string
  args?: string[]
  /** Values may reference the daemon's environment as `${NAME}`. */
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  /** Which agents get the tools. */
  roles: ('worker' | 'router')[]
  /** Worker calls go through the review layer. */
  review: boolean
}

export interface McpStatus { name: string; state: 'off' | 'connecting' | 'connected' | 'error'; tools: { name: string; description: string }[]; error?: string }

type Gate = (server: McpServerConfig, toolName: string, args: Record<string, unknown>) => Promise<{ action: 'allow' } | { action: 'block'; reason: string } | { action: 'escalate'; approvalId: string; reason: string }>

interface Connection { config: McpServerConfig; client?: Client; status: McpStatus; key: string }

export const mcpToolName = (server: string, name: string) => `mcp_${server}_${name}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)
const resolveEnv = (value: string, env: NodeJS.ProcessEnv) => value.replace(/\$\{(\w+)\}/g, (_, name) => env[name] ?? '')

export class McpManager {
  private connections = new Map<string, Connection>()

  constructor(private config: () => McpServerConfig[], private blobs: Blobs, private env: NodeJS.ProcessEnv = process.env) {}

  /** Connects enabled servers and drops the ones that were removed, disabled or changed. */
  async sync(): Promise<McpStatus[]> {
    const wanted = new Map(this.config().filter(c => c.enabled).map(c => [c.name, c]))
    for (const [name, conn] of this.connections) {
      const next = wanted.get(name)
      if (!next || JSON.stringify(next) !== conn.key) { await conn.client?.close().catch(() => {}); this.connections.delete(name) }
    }
    await Promise.all([...wanted.values()].filter(c => !this.connections.has(c.name)).map(c => this.connect(c)))
    return this.status()
  }

  status(): McpStatus[] {
    const statuses = new Map([...this.connections.values()].map(c => [c.config.name, c.status]))
    return this.config().map(c => statuses.get(c.name) ?? { name: c.name, state: 'off', tools: [] })
  }

  async call(serverName: string, toolName: string, args: Record<string, unknown>): Promise<string> {
    const conn = this.connections.get(serverName)
    if (!conn?.client) throw new Error(`MCP 服务 ${serverName} 未连接`)
    const result = await conn.client.callTool({ name: toolName, arguments: args }, undefined, { timeout: 120_000 }) as {
      content?: { type: string; text?: string; mimeType?: string }[]; isError?: boolean; structuredContent?: unknown }
    const text = (result.content ?? []).map(c => c.type === 'text' ? c.text ?? '' : `[${c.type}${c.mimeType ? ` ${c.mimeType}` : ''}]`).join('\n')
      || (result.structuredContent ? JSON.stringify(result.structuredContent) : '')
    if (result.isError) throw new Error(text || 'MCP 工具返回错误')
    return this.blobs.spill('mcp', text || '（无输出）')
  }

  /** AI SDK tools for one agent role; `gate` reviews worker calls to servers that ask for it. */
  tools(role: 'worker' | 'router', gate?: Gate): ToolSet {
    const out: ToolSet = {}
    for (const conn of this.connections.values()) {
      if (!conn.client || !conn.config.roles.includes(role)) continue
      for (const t of conn.status.tools as (McpStatus['tools'][number] & { inputSchema?: object })[]) {
        out[mcpToolName(conn.config.name, t.name)] = tool({
          description: `[MCP ${conn.config.name}] ${t.description}`.slice(0, 1_000),
          inputSchema: jsonSchema((t.inputSchema ?? { type: 'object', properties: {} }) as any),
          execute: async (args: Record<string, unknown>) => {
            if (gate && conn.config.review) {
              const decision = await gate(conn.config, t.name, args)
              if (decision.action === 'block') throw new Error(`审核拦截了这次调用：${decision.reason}`)
              if (decision.action === 'escalate') return `[需要主人批准（${decision.approvalId}）：${decision.reason}。批准后会自动调用，结果作为新消息送达。]`
            }
            return this.call(conn.config.name, t.name, args)
          },
        })
      }
    }
    return out
  }

  async close(): Promise<void> {
    await Promise.all([...this.connections.values()].map(c => c.client?.close().catch(() => {})))
    this.connections.clear()
  }

  private async connect(config: McpServerConfig): Promise<void> {
    const conn: Connection = { config, key: JSON.stringify(config), status: { name: config.name, state: 'connecting', tools: [] } }
    this.connections.set(config.name, conn)
    try {
      const client = new Client({ name: 'super-assistant', version: pkg.version })
      if (config.transport === 'stdio') {
        if (!config.command) throw new Error('stdio 服务需要 command')
        const env = { ...getDefaultEnvironment(), ...Object.fromEntries(Object.entries(config.env ?? {}).map(([k, v]) => [k, resolveEnv(v, this.env)])) }
        await client.connect(new StdioClientTransport({ command: config.command, args: config.args ?? [], env, stderr: 'ignore' }), { timeout: 30_000 })
      } else {
        if (!config.url) throw new Error('HTTP 服务需要 url')
        const headers = Object.fromEntries(Object.entries(config.headers ?? {}).map(([k, v]) => [k, resolveEnv(v, this.env)]))
        await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers } }), { timeout: 30_000 })
      }
      const { tools } = await client.listTools(undefined, { timeout: 30_000 })
      conn.client = client
      conn.status = { name: config.name, state: 'connected', tools: tools.map(t => ({ name: t.name, description: t.description ?? '', inputSchema: t.inputSchema })) as McpStatus['tools'] }
    } catch (error) {
      conn.status = { name: config.name, state: 'error', tools: [], error: error instanceof Error ? error.message : String(error) }
    }
  }
}
