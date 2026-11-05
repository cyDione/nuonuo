// A tiny stdio MCP server for tests: `add` and `whoami` (echoes an environment variable).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
const server = new McpServer({ name: 'calc', version: '1.0.0' })
server.registerTool('add', { description: 'Add two numbers', inputSchema: { a: z.number(), b: z.number() } },
  async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] }))
server.registerTool('whoami', { description: 'Report the configured user', inputSchema: {} },
  async () => ({ content: [{ type: 'text', text: `user=${process.env.CALC_USER ?? ''}; secret_visible=${process.env.OPENAI_API_KEY ? 'yes' : 'no'}` }] }))
await server.connect(new StdioServerTransport())
