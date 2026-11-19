/**
 * Real-time step summaries for Worker tickets and virtual Ticket-compatible Action Runs
 * extracted from the Router session (`ROUTER_SESSION`) for Figma Section 38:
 * - Right-pane 3-line chronological activity stream (`GET /api/tickets`)
 * - Split-Pane Step Inspector modal (`GET /api/tickets/:id`, supporting both `tkt_*` and `act_*`)
 */
import type { AgentRuntime } from '@nuonuo/agent-runtime'
import { ROUTER_SESSION, STAGE_LABEL, type Engine } from '@nuonuo/core'
import { partialString } from './events'
import { transcript, type TicketView } from './views'

export type StepIconKind = 'file' | 'terminal' | 'web' | 'settings' | 'memory' | 'error' | 'check'

export interface CurrentStep {
  tool: string
  label: string
  status: 'running' | 'done' | 'failed'
}

/** Whitelist of substantive Router tools that should appear as activity items in the RightPane Activity tab. */
export const ROUTER_ACTION_TOOLS = new Set([
  'update_my_settings',
  'update_instructions',
  'update_proactive',
  'schedule_routine',
  'update_routine',
  'remember',
  'propose_skill',
])

export function isRouterActionTool(tool: unknown): boolean {
  return typeof tool === 'string' && ROUTER_ACTION_TOOLS.has(tool)
}

const TONE_LABELS: Record<string, string> = {
  natural: '自然',
  warm: '温和',
  witty: '风趣',
  calm: '沉静',
  sharp: '犀利',
}

const THEME_LABELS: Record<string, string> = {
  light: '浅色',
  dark: '深色',
  system: '跟随系统',
}

const ACCENT_LABELS: Record<string, string> = {
  berry: '莓红',
  ink: '墨色',
  mint: '薄荷',
  sea: '海蓝',
  grape: '葡萄',
  slate: '石板',
}

const ROLE_LABELS: Record<string, string> = {
  router: '主 Agent',
  voice: '声带层',
  worker: '执行层',
  subagent: '子任务层',
  filter: '过滤层',
  watchdog: '看护层',
  summarizer: '整理层',
  embedding: '向量层',
  vision: '视觉层',
  transcribe: '听写层',
  speech: '朗读层',
}

function shortText(value: unknown, max = 64): string {
  const clean = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (!clean) return ''
  return clean.length > max ? `${clean.slice(0, max)}…` : clean
}

export function relativeDisplayPath(rawPath: unknown, workDir?: string): string {
  const raw = String(rawPath ?? '').trim()
  if (!raw) return ''
  if (workDir) {
    const cleanDir = workDir.replace(/\/+$/, '')
    if (raw === cleanDir) return '.'
    if (raw.startsWith(`${cleanDir}/`)) return raw.slice(cleanDir.length + 1)
  }
  return shortText(raw, 64)
}

/** Parses a `tool-start` marker's `input` string (which may be clipped at 300 chars). */
export function parseMarkerInput(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>
  }
  if (typeof raw !== 'string' || !raw.trim()) return {}
  const trimmed = raw.trim()
  try {
    const parsed = JSON.parse(trimmed.endsWith('…') ? trimmed.slice(0, -1) : trimmed)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  } catch {
    const jsonSlice = trimmed.endsWith('…') ? trimmed.slice(0, -1) : trimmed
    const out: Record<string, unknown> = {}
    for (const field of ['command', 'path', 'url', 'job', 'query', 'name', 'text', 'from', 'to']) {
      const val = partialString(jsonSlice, field)
      if (val !== undefined) out[field] = val
    }
    return out
  }
  return {}
}

/** Detects whether a tool result output represents a failed execution. */
export function isToolOutputError(output: unknown): boolean {
  if (!output) return false
  if (typeof output === 'object') {
    const o = output as Record<string, unknown>
    if (o.ok === false) return true
    if (typeof o.error === 'string' && o.ok !== true) return true
    if (typeof o.exitCode === 'number' && o.exitCode !== 0) return true
  }
  const s = String(output).trim()
  if (!s) return false
  if (s.startsWith('{')) {
    try {
      const parsed = JSON.parse(s) as Record<string, unknown>
      if (parsed.ok === false) return true
      if (typeof parsed.error === 'string' && parsed.ok !== true) return true
      if (typeof parsed.exitCode === 'number' && parsed.exitCode !== 0) return true
    } catch {
      if (/"ok"\s*:\s*false/.test(s) || /^\{\s*"error"\s*:/.test(s)) return true
    }
  }
  if (/\[[^\]]*(?:退出码\s+(?!0\b)-?\d+|超时被终止)/.test(s)) return true
  if (/\b(?:exit(?:\s+_?code)?|exitCode)\s*[:=]\s*(?!0\b)-?\d+/i.test(s)) return true
  if (/^(?:Error:|Failed\b|Result:\s*Failed\b)/i.test(s) || /\bResult:\s*Failed\b/i.test(s)) return true
  if (/old_text 在文件中不存在|不在工作目录内|审核拦截了这条命令|命令 .* 在这个执行环境中被禁止/.test(s)) return true
  return false
}

function inferToneLabel(mood: Record<string, unknown>): string | undefined {
  if (typeof mood.tone_preset === 'string' && TONE_LABELS[mood.tone_preset]) {
    return TONE_LABELS[mood.tone_preset]
  }
  const xy = (mood.tone_xy ?? mood.tone) as { x?: number; y?: number } | undefined
  if (xy && typeof xy.x === 'number' && typeof xy.y === 'number') {
    if (Math.hypot(xy.x, xy.y) < 0.06) return '自然'
    if (xy.x <= 0 && xy.y >= 0) return '温和'
    if (xy.x > 0 && xy.y >= 0) return '风趣'
    if (xy.x <= 0 && xy.y < 0) return '沉静'
    return '犀利'
  }
  return undefined
}

/** Generates human-readable Chinese `title` and one-line `summary` for a Router substantive tool call. */
export function describeRouterAction(
  tool: string,
  rawInput: unknown,
  rawOutput?: unknown,
): { title: string; summary: string; iconKind: StepIconKind } {
  const input = (rawInput && typeof rawInput === 'object' ? rawInput : {}) as Record<string, any>
  const isError = rawOutput !== undefined && isToolOutputError(rawOutput)

  if (tool === 'update_my_settings') {
    const p = input.persona as Record<string, any> | undefined
    const m = input.mood as Record<string, any> | undefined
    const models = input.models
    const prefs = input.preferences as Record<string, any> | undefined
    const notif = input.notifications as Record<string, any> | undefined
    const ideas = input.ideas as Record<string, any> | undefined
    const proactiveBudget = input.proactive_budget as Record<string, any> | undefined
    const skillToggle = input.skill_toggle as Record<string, any> | undefined
    const sourceProactive = input.source_proactive as Record<string, any> | undefined

    const toneLabel = m ? inferToneLabel(m) : undefined

    // Combined persona.name + mood change (e.g. Section 38 A1: 修改助理名字与语调)
    if (p?.name && m) {
      const title = '修改助理名字与语调'
      const summary = toneLabel
        ? `已将名字改为「${p.name}」，语调切换至${toneLabel}`
        : `已将名字改为「${p.name}」，并更新心境与语调设置`
      return { title, summary: isError ? `${title}失败` : summary, iconKind: isError ? 'error' : 'check' }
    }

    const titles: string[] = []
    const summaries: string[] = []

    if (p) {
      if (p.name && Object.keys(p).length === 1) {
        titles.push('修改助理名字')
        summaries.push(`已将名字改为「${p.name}」`)
      } else if (p.name) {
        titles.push('修改助理名字与人设')
        summaries.push(`已将名字改为「${p.name}」`)
      } else if (p.avatar) {
        titles.push('更换助理形象')
        summaries.push(`已将形象更新为 ${p.avatar === 'mascot' ? '糯糯' : p.avatar}`)
      } else {
        titles.push('更新助理人设')
        summaries.push('已更新助理性格与边界设定')
      }
    }

    if (m) {
      if (toneLabel) {
        titles.push('调整说话语调')
        summaries.push(`已将语调切换至${toneLabel}`)
      } else if (m.reset) {
        titles.push('重置心境状态')
        summaries.push('已将心境、精力与耐心恢复至平时基准')
      } else {
        titles.push('更新心境设置')
        summaries.push('已更新动态心境与敏感度配置')
      }
    }

    if (prefs) {
      titles.push('切换界面外观与偏好')
      const parts: string[] = []
      if (typeof prefs.theme === 'string' && THEME_LABELS[prefs.theme]) {
        parts.push(`外观切换至${THEME_LABELS[prefs.theme]}模式`)
      }
      if (typeof prefs.accent === 'string' && ACCENT_LABELS[prefs.accent]) {
        parts.push(`主题色设为${ACCENT_LABELS[prefs.accent]}`)
      }
      if (typeof prefs.read_aloud === 'boolean') {
        parts.push(`${prefs.read_aloud ? '开启' : '关闭'}回复朗读`)
      }
      if (typeof prefs.text_size === 'string') {
        parts.push(`字号设为 ${prefs.text_size}`)
      }
      summaries.push(parts.length ? `已将${parts.join('，')}` : '已更新界面外观与偏好设置')
    }

    if (models) {
      titles.push('更新分层模型配置')
      const list = Array.isArray(models) ? models : [models]
      const first = (list[0] ?? {}) as Record<string, any>
      const roleLabel = ROLE_LABELS[first.role ?? 'router'] ?? (first.role || '主 Agent')
      const details: string[] = []
      if (first.model) details.push(`模型设为 ${first.model === 'inherit' ? '跟随主模型' : first.model}`)
      if (first.reasoning) details.push(`思考强度设为 ${first.reasoning}`)
      if (first.temperature !== undefined) details.push(`温度设为 ${first.temperature}`)
      if (first.voice_temperature !== undefined) details.push(`声带温度设为 ${first.voice_temperature}`)
      summaries.push(details.length ? `已将${roleLabel}${details.join('，')}` : `已更新${roleLabel}等分层模型配置`)
    }

    if (notif) {
      titles.push('更新通知与免打扰设置')
      const qFrom = notif.quiet_from ?? notif.quiet?.from
      const qTo = notif.quiet_to ?? notif.quiet?.to
      summaries.push(qFrom && qTo ? `已设置免打扰时段 ${qFrom}–${qTo}` : '已更新消息通知与提醒设置')
    }

    if (ideas) {
      titles.push('更新点子推送频率')
      summaries.push(`已将点子推送设为 ${ideas.cadence ?? '每日'}`)
    }

    if (proactiveBudget || sourceProactive) {
      titles.push('更新主动留意配额')
      summaries.push('已更新主动处理配额与来源留意配置')
    }

    if (skillToggle) {
      titles.push(`${skillToggle.enabled ? '启用' : '停用'}技能：${skillToggle.id_or_name ?? ''}`)
      summaries.push(`已${skillToggle.enabled ? '开启' : '关闭'}技能「${skillToggle.id_or_name ?? ''}」`)
    }

    const finalTitle = titles[0] ?? '修改助理设置'
    const finalSummary = summaries.join('；') || '已更新助理设置'
    return {
      title: finalTitle,
      summary: isError ? `${finalTitle}失败` : finalSummary,
      iconKind: isError ? 'error' : 'check',
    }
  }

  if (tool === 'update_instructions') {
    const title = '更新灵魂指令'
    const snippet = shortText(input.text ?? '', 44)
    const summary = input.heading
      ? `已在「${input.heading}」下更新指令${snippet ? `：${snippet}` : ''}`
      : `已${input.mode === 'append' ? '追加' : '更新'}灵魂指令${snippet ? `：${snippet}` : ''}`
    return { title, summary: isError ? '更新灵魂指令失败' : summary, iconKind: isError ? 'error' : 'check' }
  }

  if (tool === 'update_proactive') {
    const title = '更新主动处理策略'
    const summary = input.mode
      ? `已将主动处理模式设为「${input.mode}」`
      : '已更新主动处理过滤规则与策略'
    return { title, summary: isError ? '更新主动处理策略失败' : summary, iconKind: isError ? 'error' : 'check' }
  }

  if (tool === 'schedule_routine' || tool === 'update_routine') {
    const name = shortText(input.name || input.routine_id || '定时任务', 32)
    if (tool === 'update_routine' && input.delete) {
      const title = `删除定时任务：${name}`
      return { title, summary: isError ? `${title}失败` : `已删除定时任务「${name}」`, iconKind: isError ? 'error' : 'check' }
    }
    const title = `设置定时任务：${name}`
    const summary = input.schedule
      ? `已按计划（${input.schedule}）设置「${name}」`
      : `已更新定时任务「${name}」`
    return { title, summary: isError ? `${title}失败` : summary, iconKind: isError ? 'error' : 'check' }
  }

  if (tool === 'remember') {
    const title = '记下新记忆'
    const snippet = shortText(input.text ?? '', 56)
    const summary = snippet ? `已记住：${snippet}` : '已写入长期记忆'
    return { title, summary: isError ? '记下新记忆失败' : summary, iconKind: isError ? 'error' : 'check' }
  }

  if (tool === 'propose_skill') {
    const name = shortText(input.name || '会做的事', 24)
    const title = `新增技能：${name}`
    const when = shortText(input.when ?? '', 40)
    const summary = when ? `已记录技能「${name}」（${when}）` : `已记录技能「${name}」`
    return { title, summary: isError ? `${title}失败` : summary, iconKind: isError ? 'error' : 'check' }
  }

  const fallback = tool.replace(/^mcp_/, '').replace(/_/g, ' ')
  return {
    title: `执行 ${fallback}`,
    summary: isError ? `执行 ${fallback} 失败` : `已完成 ${fallback}`,
    iconKind: isError ? 'error' : 'check',
  }
}

/** Generates a single-line human-readable Chinese step label for a tool call and its status. */
export function describeStepLabel(
  tool: string,
  rawInput: unknown,
  status: 'running' | 'done' | 'failed',
  workDir?: string,
): string {
  const i = (rawInput && typeof rawInput === 'object' ? rawInput : {}) as Record<string, any>
  switch (tool) {
    case 'shell':
    case 'local_shell':
    case 'computer': {
      const cmd = shortText(i.command ?? i.cmd ?? '', 72)
      if (!cmd) return status === 'running' ? '正在运行命令' : status === 'failed' ? '运行命令失败' : '已运行命令'
      return status === 'running' ? `正在运行 ${cmd}` : status === 'failed' ? `运行 ${cmd} 失败` : `已运行 ${cmd}`
    }
    case 'edit_file': {
      const p = relativeDisplayPath(i.path, workDir) || '文件'
      return status === 'running' ? `正在编辑 ${p}` : status === 'failed' ? `编辑 ${p} 失败` : `已编辑 ${p}`
    }
    case 'write_file': {
      const p = relativeDisplayPath(i.path, workDir) || '文件'
      return status === 'running' ? `正在写入 ${p}` : status === 'failed' ? `写入 ${p} 失败` : `写入 ${p}`
    }
    case 'read_file': {
      const p = relativeDisplayPath(i.path, workDir) || '文件'
      return status === 'running' ? `正在读取 ${p}` : status === 'failed' ? `读取 ${p} 失败` : `读取 ${p}`
    }
    case 'list_dir':
    case 'find_files': {
      const p = relativeDisplayPath(i.path ?? '.', workDir) || '.'
      return status === 'running' ? `正在浏览 ${p}` : status === 'failed' ? `浏览 ${p} 失败` : `浏览 ${p}`
    }
    case 'move_path': {
      const from = relativeDisplayPath(i.from, workDir) || '文件'
      const to = relativeDisplayPath(i.to, workDir) || '目标'
      return status === 'running' ? `正在移动 ${from} → ${to}` : status === 'failed' ? `移动 ${from} 失败` : `已移动 ${from} → ${to}`
    }
    case 'web_fetch':
    case 'browser_open': {
      const url = shortText(i.url ?? '', 64) || '网页'
      return status === 'running' ? `正在访问 ${url}` : status === 'failed' ? `访问 ${url} 失败` : `访问 ${url}`
    }
    case 'browser_click':
    case 'browser_type':
    case 'browser_snapshot':
    case 'browser_screenshot':
      return status === 'running' ? '正在操作浏览器' : status === 'failed' ? '操作浏览器失败' : '在浏览器里操作'
    case 'request_handoff':
      return '请你接管浏览器'
    case 'subagent_start': {
      const job = shortText(i.job ?? '', 56)
      return job ? `派生子任务：${job}` : '派生子任务'
    }
    case 'subagent_stop':
      return '停下子任务'
    case 'job_status':
    case 'local_job_status':
      return status === 'running' ? '正在检查后台日志进程' : status === 'failed' ? '检查后台日志进程失败' : '已检查后台日志进程'
    case 'job_stop':
    case 'local_job_stop':
      return '终止后台进程'
    case 'remember':
      return status === 'failed' ? '记下新记忆失败' : '记下新记忆'
    case 'forget':
      return `忘记记忆：${shortText(i.match ?? '', 40)}`
    case 'search_memory':
      return `检索记忆：${shortText(i.query ?? '', 40)}`
    case 'report':
      return i.status === 'ready'
        ? '整理好结果'
        : i.status === 'waiting'
          ? '有问题要问你'
          : i.status === 'failed'
            ? '说明遇到的问题'
            : '汇报阶段进展'
    default: {
      if (isRouterActionTool(tool)) {
        const desc = describeRouterAction(tool, i, status === 'failed' ? { ok: false } : undefined)
        return desc.title
      }
      const clean = tool.replace(/^mcp_/, '').replace(/_/g, ' ')
      return status === 'running' ? `正在执行 ${clean}` : status === 'failed' ? `执行 ${clean} 失败` : `已执行 ${clean}`
    }
  }
}

export function classifyToolIcon(tool: string): StepIconKind {
  switch (tool) {
    case 'edit_file':
    case 'write_file':
    case 'read_file':
    case 'list_dir':
    case 'find_files':
    case 'move_path':
      return 'file'
    case 'shell':
    case 'local_shell':
    case 'computer':
    case 'job_status':
    case 'job_stop':
    case 'local_job_status':
    case 'local_job_stop':
      return 'terminal'
    case 'web_fetch':
    case 'browser_open':
    case 'browser_click':
    case 'browser_type':
    case 'browser_snapshot':
    case 'browser_screenshot':
      return 'web'
    case 'update_my_settings':
    case 'update_instructions':
    case 'update_proactive':
    case 'schedule_routine':
    case 'update_routine':
    case 'propose_skill':
      return 'settings'
    case 'remember':
    case 'forget':
    case 'search_memory':
      return 'memory'
    default:
      return 'terminal'
  }
}

/** Computes `stepCount`, `currentStep`, and `iconKind` from a session's transcript items. */
export function summarizeTranscriptSteps(
  items: { id: string; kind: string; [k: string]: unknown }[],
  opts: {
    workDir?: string | undefined
    stage: string
    endedOutcome?: string | null | undefined
    isSessionRunning?: boolean | undefined
  },
): {
  stepCount: number
  currentStep: CurrentStep | null
  iconKind: StepIconKind
} {
  const toolCalls = items.filter(i => i.kind === 'tool-call') as {
    id: string
    kind: 'tool-call'
    callId: string
    tool: string
    input: unknown
    at: number
  }[]
  const resultsByCallId = new Map<string, { output: unknown; at: number }>()
  for (const item of items) {
    if (item.kind === 'tool-result' && typeof item.callId === 'string') {
      resultsByCallId.set(item.callId, { output: item.output, at: Number(item.at ?? 0) })
    }
  }

  const stepCount = toolCalls.length
  if (stepCount === 0) {
    const isFailed =
      opts.stage === 'person/failed' || Boolean(opts.endedOutcome && opts.endedOutcome !== 'completed')
    return {
      stepCount: 0,
      currentStep: null,
      iconKind: isFailed ? 'error' : opts.endedOutcome === 'completed' ? 'check' : 'terminal',
    }
  }

  // Pick the latest in-flight tool call if any, else the latest non-report/non-handback tool call, else the last tool call
  const inFlight = [...toolCalls].reverse().find(c => !resultsByCallId.has(c.callId))
  const nonReport = [...toolCalls].reverse().find(c => c.tool !== 'report' && c.tool !== 'handback')
  const target = inFlight ?? nonReport ?? toolCalls.at(-1)!

  const targetRes = resultsByCallId.get(target.callId)
  let status: 'running' | 'done' | 'failed'
  if (!targetRes) {
    if (!opts.endedOutcome && opts.stage !== 'ended' && opts.stage !== 'person/failed') {
      status = 'running'
    } else if (opts.endedOutcome === 'completed') {
      status = 'done'
    } else {
      status = 'failed'
    }
  } else {
    status = isToolOutputError(targetRes.output) ? 'failed' : 'done'
  }

  const currentStep: CurrentStep = {
    tool: target.tool,
    label: describeStepLabel(target.tool, target.input, status, opts.workDir),
    status,
  }

  const isTaskFailed =
    opts.stage === 'person/failed' || Boolean(opts.endedOutcome && opts.endedOutcome !== 'completed')
  let iconKind: StepIconKind
  if (isTaskFailed) {
    iconKind = 'error'
  } else if (opts.endedOutcome === 'completed' || opts.stage === 'ended') {
    const editedFile = toolCalls.some(c =>
      c.tool === 'edit_file' || c.tool === 'write_file' || c.tool === 'move_path',
    )
    const substantiveCalls = toolCalls.filter(c => c.tool !== 'report' && c.tool !== 'handback')
    const onlyFileReads =
      substantiveCalls.length > 0 && substantiveCalls.every(c => c.tool === 'read_file')
    iconKind = editedFile || onlyFileReads ? 'file' : 'check'
  } else {
    iconKind = status === 'failed' ? 'error' : classifyToolIcon(target.tool)
  }

  return {
    stepCount,
    currentStep,
    iconKind,
  }
}

export interface RouterActionRunDetail {
  ticket: TicketView
  transcript: { id: string; kind: string; [k: string]: unknown }[]
  reports: {
    id: number
    ticketId: string
    status: 'ready' | 'failed'
    summary: string
    humanAction: null
    at: number
  }[]
  running: false
  jobs: []
  approvals: []
  browser: false
  project: null
  usage: { tokens: number; costUsd: number }
  files: []
}

function cleanRouterInputText(raw: string): string {
  const match = /<message\b[^>]*>[\s\S]*?\ntext:\n([\s\S]*?)<\/message>/.exec(raw)
  if (match?.[1]) return match[1].trim()
  return raw.replace(/<now>[\s\S]*?<\/now>/g, '').trim()
}

/**
 * Scans `transcript(agents, ROUTER_SESSION)` and extracts virtual Ticket-compatible `act_<callId>` records
 * for substantive Router actions (`update_my_settings`, `update_instructions`, `update_proactive`,
 * `schedule_routine`, `update_routine`, `remember`, `propose_skill`).
 */
export function extractRouterActionRuns(
  engine: Engine,
  agents: AgentRuntime,
  opts: { conversationId?: string; limit?: number } = {},
): { runs: TicketView[]; detailsById: Map<string, RouterActionRunDetail> } {
  const items = transcript(agents, ROUTER_SESSION)
  const defaultConversationId = (() => {
    try {
      return engine.mainConversation()
    } catch {
      return null
    }
  })()

  // Split items into turns bounded by `input` items
  interface TurnBucket {
    inputItem?: { id: string; kind: 'input'; text: string; at: number }
    conversationId: string | null
    items: { id: string; kind: string; [k: string]: unknown }[]
  }

  const turns: TurnBucket[] = []
  let current: TurnBucket = { conversationId: defaultConversationId, items: [] }
  turns.push(current)

  for (const item of items) {
    if (item.kind === 'input') {
      const rawText = String(item.text ?? '')
      const cnvMatch = /conversation_id="([a-zA-Z0-9_-]+)"/.exec(rawText)?.[1]
      current = {
        inputItem: {
          id: item.id,
          kind: 'input',
          text: cleanRouterInputText(rawText),
          at: Number(item.at ?? Date.now()),
        },
        conversationId: cnvMatch || defaultConversationId,
        items: [],
      }
      turns.push(current)
      continue
    }
    if (
      item.kind === 'tool-call' &&
      item.tool === 'reply' &&
      item.input &&
      typeof (item.input as Record<string, unknown>).conversation_id === 'string'
    ) {
      current.conversationId = String((item.input as Record<string, unknown>).conversation_id)
    }
    current.items.push(item)
  }

  const runs: TicketView[] = []
  const detailsById = new Map<string, RouterActionRunDetail>()

  for (const turn of turns) {
    const resultsByCallId = new Map<string, { id: string; kind: string; [k: string]: unknown }>()
    for (const item of turn.items) {
      if (item.kind === 'tool-result' && typeof item.callId === 'string') {
        resultsByCallId.set(item.callId, item)
      }
    }

    // Collect read/ inspect calls in the same turn (like `get_my_settings`) so the inspector can show context if desired,
    // and create an ActionRun for each substantive action call in the turn.
    const inspectCalls = turn.items.filter(
      i => i.kind === 'tool-call' && i.tool === 'get_my_settings',
    )

    for (const item of turn.items) {
      if (item.kind !== 'tool-call' || !isRouterActionTool(item.tool)) continue
      const toolName = String(item.tool)
      const callId = String(item.callId ?? item.id)
      const actId = `act_${callId}`
      const resultItem = resultsByCallId.get(callId)
      const startedAt = Number(item.at ?? turn.inputItem?.at ?? Date.now())
      const endedAt = Number(resultItem?.at ?? startedAt)
      const isError = resultItem ? isToolOutputError(resultItem.output) : false
      const { title, summary, iconKind } = describeRouterAction(
        toolName,
        item.input,
        resultItem?.output,
      )

      const sliceTranscript: { id: string; kind: string; [k: string]: unknown }[] = []
      if (turn.inputItem) sliceTranscript.push(turn.inputItem)
      for (const ic of inspectCalls) {
        sliceTranscript.push(ic)
        const icRes = resultsByCallId.get(String(ic.callId ?? ''))
        if (icRes) sliceTranscript.push(icRes)
      }
      sliceTranscript.push(item)
      if (resultItem) sliceTranscript.push(resultItem)

      const stepCalls = inspectCalls.length + 1
      const stepStatus: 'done' | 'failed' = isError ? 'failed' : 'done'

      const ticket: TicketView = {
        approvals: [],
        id: actId,
        kind: 'action',
        title,
        name: toolName,
        note: null,
        stage: 'ended',
        stageLabel: STAGE_LABEL.ended,
        conversationId: turn.conversationId,
        source: 'webchat',
        directory: '',
        latestReport: {
          status: isError ? 'failed' : 'ready',
          summary,
          at: endedAt,
        },
        attention: null,
        ended: {
          at: endedAt,
          by: 'router',
          outcome: isError ? 'stopped' : 'completed',
        },
        createdAt: startedAt,
        updatedAt: endedAt,
        proactive: false,
        why: null,
        stepCount: stepCalls,
        currentStep: {
          tool: toolName,
          label: describeStepLabel(toolName, item.input, stepStatus),
          status: stepStatus,
        },
        iconKind,
        runningJobs: 0,
      }

      const detail: RouterActionRunDetail = {
        ticket,
        reports: [
          {
            id: 1,
            ticketId: actId,
            status: isError ? 'failed' : 'ready',
            summary,
            humanAction: null,
            at: endedAt,
          },
        ],
        transcript: sliceTranscript,
        running: false,
        jobs: [],
        approvals: [],
        browser: false,
        project: null,
        usage: { tokens: 0, costUsd: 0 },
        files: [],
      }

      detailsById.set(actId, detail)
      if (!opts.conversationId || turn.conversationId === opts.conversationId) {
        runs.push(ticket)
      }
    }
  }

  runs.sort((a, b) => (b.ended?.at ?? b.updatedAt) - (a.ended?.at ?? a.updatedAt))
  const max = opts.limit ?? 50
  return {
    runs: runs.slice(0, max),
    detailsById,
  }
}
