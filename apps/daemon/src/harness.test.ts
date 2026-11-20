/**
 * Repository harness guardrails: catches silent drift in i18n coverage, monorepo layer dependencies,
 * web/router route parity, Router structural tool boundaries, and prompt-to-tool consistency.
 */
import { AgentRuntime, Bus, type AgentDefinition } from '@nuonuo/agent-runtime'
import {
  combineExtensions,
  Engine,
  Goals,
  Ideas,
  Instructions,
  LocalAccess,
  OpenLink,
  proactiveExtension,
  registerAgents,
  Reviewer,
  ROUTER_PROMPT,
  ROUTER_SESSION,
  Skills,
  skillsExtension,
  WORKER_PROMPT,
  instructionsExtension,
} from '@nuonuo/core'
import { Effects, openStore } from '@nuonuo/db'
import { MemorySecrets, ModelHub } from '@nuonuo/models'
import { PluginManager, SourceRegistry } from '@nuonuo/sources'
import { McpManager } from '@nuonuo/agent-runtime'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { settingsExtension } from './settings-tools'

const REPO_ROOT = join(import.meta.dirname, '../../..')
const WEB_SRC = join(REPO_ROOT, 'apps/web/src')

function walkSourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkSourceFiles(full))
    else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.test.ts') && entry.name !== 'i18n.ts' && entry.name !== 'i18n.en.ts') {
      out.push(full)
    }
  }
  return out
}

function unquoteJsString(raw: string): string {
  if (raw.startsWith('`')) return raw.slice(1, -1)
  if (raw.startsWith("'")) return JSON.parse(`"${raw.slice(1, -1).replace(/\\'/g, "'").replace(/"/g, '\\"')}"`) as string
  return JSON.parse(raw) as string
}

function parseEnDictionary(): Map<string, string> {
  const src = readFileSync(join(WEB_SRC, 'i18n.en.ts'), 'utf8')
  const entries = new Map<string, string>()
  const re = /^\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\s*:\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) entries.set(unquoteJsString(m[1]!), unquoteJsString(m[2]!))
  return entries
}

function placeholders(text: string): string[] {
  return [...new Set([...text.matchAll(/\{(\d+)\}/g)].map(m => m[1]!))].sort()
}

describe('harness guardrails', () => {
  describe('web i18n coverage', () => {
    const en = parseEnDictionary()

    it('translates every literal tx(...) key in apps/web/src', () => {
      const txRe = /\btx\(\s*('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`$\\])*`)/g
      const missing: string[] = []
      for (const file of walkSourceFiles(WEB_SRC)) {
        const src = readFileSync(file, 'utf8')
        let m: RegExpExecArray | null
        while ((m = txRe.exec(src))) {
          const key = unquoteJsString(m[1]!)
          if (!en.has(key)) missing.push(`${file.slice(REPO_ROOT.length + 1)}: ${JSON.stringify(key)}`)
        }
      }
      expect(missing).toEqual([])
    })

    it('keeps placeholder indices ({0}, {1}...) aligned between zh keys and en values', () => {
      const mismatches: string[] = []
      for (const [zh, translation] of en) {
        if (placeholders(zh).join(',') !== placeholders(translation).join(',')) {
          mismatches.push(`${JSON.stringify(zh)} => ${JSON.stringify(translation)}`)
        }
      }
      expect(mismatches).toEqual([])
    })
  })

  describe('monorepo dependency direction', () => {
    const allowed: Record<string, readonly string[]> = {
      'packages/db': [],
      'packages/models': ['@nuonuo/db'],
      'packages/agent-runtime': ['@nuonuo/db', '@nuonuo/models'],
      'packages/core': ['@nuonuo/db', '@nuonuo/models', '@nuonuo/agent-runtime'],
      'packages/sources': ['@nuonuo/db', '@nuonuo/models', '@nuonuo/agent-runtime', '@nuonuo/core'],
      'packages/plugin-sdk': ['@nuonuo/core', '@nuonuo/sources'],
      'packages/plugins': ['@nuonuo/db', '@nuonuo/models', '@nuonuo/agent-runtime', '@nuonuo/core', '@nuonuo/sources', '@nuonuo/plugin-sdk'],
      'packages/client': [],
      'apps/web': [],
      'apps/desktop': [],
      'apps/daemon': [
        '@nuonuo/db',
        '@nuonuo/models',
        '@nuonuo/agent-runtime',
        '@nuonuo/core',
        '@nuonuo/sources',
        '@nuonuo/plugin-sdk',
        '@nuonuo/plugins',
        '@nuonuo/client',
      ],
    }

    it.each(Object.entries(allowed))('%s only depends on allowed @nuonuo/* layers', (workspace, okDeps) => {
      const pkg = JSON.parse(readFileSync(join(REPO_ROOT, workspace, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>
        devDependencies?: Record<string, string>
        peerDependencies?: Record<string, string>
      }
      const actual = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies })
        .filter(name => name.startsWith('@nuonuo/'))
      const forbidden = actual.filter(dep => !okDeps.includes(dep))
      expect(forbidden).toEqual([])
    })
  })

  describe('web routes and OpenLink parity', () => {
    it('accepts every SETTINGS_TABS entry in OpenLink and documents it for the router', () => {
      const routeSrc = readFileSync(join(WEB_SRC, 'route.ts'), 'utf8')
      const m = routeSrc.match(/export const SETTINGS_TABS = \[([\s\S]*?)\] as const/)
      expect(m).toBeTruthy()
      const tabs = [...m![1]!.matchAll(/'([^']+)'/g)].map(x => x[1]!)
      expect(tabs.length).toBeGreaterThan(0)
      const desc = OpenLink.shape.route.description ?? ''
      for (const tab of tabs) {
        expect(OpenLink.safeParse({ route: `settings/${tab}`, label: '打开' }).success, tab).toBe(true)
        expect(desc, `OpenLink route description missing tab "${tab}"`).toContain(tab)
      }
    })
  })

  describe('decoupled client-server architecture guardrails', () => {
    it('forbids legacy /api/ paths and native EventSource in apps/web/src', () => {
      const legacyApi = /['"`]\/api\//
      const nativeEventSource = /\bnew\s+EventSource\s*\(/
      const violations: string[] = []
      for (const file of walkSourceFiles(WEB_SRC)) {
        const src = readFileSync(file, 'utf8')
        if (legacyApi.test(src)) violations.push(`${file.slice(REPO_ROOT.length + 1)}: legacy /api/ path`)
        if (nativeEventSource.test(src)) violations.push(`${file.slice(REPO_ROOT.length + 1)}: native EventSource (use streamAuthedSSE)`)
      }
      expect(violations).toEqual([])
    })

    it('keeps apps/desktop as a thin client without bundled daemon or node runtimes', () => {
      const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'apps/desktop/package.json'), 'utf8')) as {
        build?: { extraResources?: { from?: string; to?: string }[] }
      }
      const resources = pkg.build?.extraResources ?? []
      expect(resources.some(r => r.to === 'daemon' || r.to === 'node')).toBe(false)
      expect(resources.some(r => r.to === 'web')).toBe(true)
    })
  })

  describe('agent tool boundaries and prompt consistency', () => {
    it('enforces no shell/fs/web execution tools on router and aligns core prompt tool names', async () => {
      const store = openStore(':memory:')
      const home = mkdtempSync(join(tmpdir(), 'nuonuo-harness-'))
      const secrets = new MemorySecrets()
      const hub = new ModelHub(store, secrets)
      const bus = new Bus()
      const runtime = new AgentRuntime(store, hub, bus)
      const defs = new Map<string, AgentDefinition>()
      const origRegister = runtime.register.bind(runtime)
      runtime.register = def => {
        defs.set(def.role, def)
        origRegister(def)
      }

      try {
        const effects = new Effects(store)
        const sources = new SourceRegistry(store, effects, secrets)
        const plugins = new PluginManager(join(home, 'plugins'), sources, store)
        const mcp = new McpManager(() => [], runtime.blobs)
        const engine = new Engine(store, runtime, bus, { home, sources })
        const access = new LocalAccess(store)
        const reviewer = new Reviewer(store, hub, engine, runtime, bus)
        const skills = new Skills(store)
        const instructions = new Instructions(store)
        const goals = new Goals(store)
        const ideas = new Ideas(store, hub, () => '')

        registerAgents(
          store,
          runtime,
          engine,
          combineExtensions(
            instructionsExtension(instructions),
            proactiveExtension(store, engine),
            skillsExtension(skills),
            settingsExtension({ store, hub: () => hub, bus, engine, access, reviewer, skills, instructions, ideas, plugins, sources, mcp }),
          ),
        )

        const routerDef = defs.get('router')
        const workerDef = defs.get('worker')
        expect(routerDef).toBeDefined()
        expect(workerDef).toBeDefined()

        const controller = new AbortController()
        const routerSession = runtime.session(ROUTER_SESSION)!
        const routerTools = Object.keys(routerDef!.tools({ session: routerSession, signal: controller.signal, runtime }))

        // Structural invariant: router never gets execution / fs / shell / web tools.
        const forbiddenOnRouter = [
          'shell',
          'job_status',
          'job_stop',
          'local_shell',
          'read_file',
          'write_file',
          'edit_file',
          'list_dir',
          'search_files',
          'view_image',
          'web_fetch',
          'web_search',
        ]
        for (const toolName of forbiddenOnRouter) {
          expect(routerTools, `router must never expose ${toolName}`).not.toContain(toolName)
        }

        // Core tools referenced in ROUTER_PROMPT must actually be registered.
        const expectedRouterTools = [
          'reply',
          'react',
          'message_owner',
          'start_task',
          'start_silent_task',
          'attach',
          'stop_task',
          'ignore',
          'update_instructions',
          'update_proactive',
          'get_my_settings',
          'update_my_settings',
        ]
        for (const toolName of expectedRouterTools) {
          expect(ROUTER_PROMPT, `ROUTER_PROMPT should reference ${toolName}`).toContain(toolName)
          expect(routerTools, `router should register ${toolName}`).toContain(toolName)
        }

        // Verify worker registers the core reporting/delegation tools referenced in WORKER_PROMPT.
        const cnv = engine.mainConversation()
        const trg = engine.receiveMessage(cnv, 'test harness')
        const ticket = engine.startTask({ conversationId: cnv, triggerIds: [trg.triggerId], title: 'harness check' })
        const workerSession = runtime.session(ticket.sessionId)!
        const workerTools = Object.keys(workerDef!.tools({ session: workerSession, signal: controller.signal, runtime }))
        for (const toolName of ['report', 'subagent_start', 'handback']) {
          expect(WORKER_PROMPT, `WORKER_PROMPT should reference ${toolName}`).toContain(toolName)
          expect(workerTools, `worker should register ${toolName}`).toContain(toolName)
        }
        // Keep goals referenced so typecheck knows it's clean; no runtime side effects needed.
        expect(goals.list()).toEqual([])
      } finally {
        await runtime.shutdown()
        store.close()
      }
    })
  })
})
