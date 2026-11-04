/** File tools confined to a workspace directory. (The shell is not confined; tiers and review are the real boundary.) */
import { tool } from 'ai'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import type { Blobs } from '../blobs'

export function resolveInside(root: string, path: string): string {
  const base = realpathSync(root)
  const target = resolve(base, path)
  let check = target
  // Resolve symlinks of the deepest existing ancestor so a link cannot point outside.
  while (!existsSync(check)) check = dirname(check)
  const real = join(realpathSync(check), relative(check, target))
  if (real !== base && !real.startsWith(base + sep)) throw new Error(`路径 ${path} 不在工作目录内（${base}）`)
  return real
}

const MAX_READ = 2_000

export function fsTools(root: string, blobs: Blobs) {
  return {
    read_file: tool({
      description: 'Read a text file in the workspace. Returns numbered lines. Use offset/limit (1-based lines) for long files.',
      inputSchema: z.object({ path: z.string(), offset: z.number().int().min(1).optional(), limit: z.number().int().min(1).max(MAX_READ).optional() }),
      execute: async ({ path, offset = 1, limit = MAX_READ }) => {
        const file = resolveInside(root, path)
        const lines = readFileSync(file, 'utf8').split('\n')
        const slice = lines.slice(offset - 1, offset - 1 + limit)
        const body = slice.map((l, i) => `${String(offset + i).padStart(5)}\t${l}`).join('\n')
        const more = offset - 1 + limit < lines.length ? `\n…（共 ${lines.length} 行，用 offset=${offset + limit} 继续读）` : ''
        return blobs.spill('file', body + more)
      },
    }),
    write_file: tool({
      description: 'Create or overwrite a file in the workspace with the given content. Parent directories are created.',
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      execute: async ({ path, content }) => {
        const file = resolveInside(root, path)
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, content)
        return `已写入 ${relative(realpathSync(root), file)}（${content.length} 字符）`
      },
    }),
    edit_file: tool({
      description: 'Replace exact text in a workspace file. old_text must match exactly once unless replace_all is true.',
      inputSchema: z.object({ path: z.string(), old_text: z.string().min(1), new_text: z.string(), replace_all: z.boolean().optional() }),
      execute: async ({ path, old_text, new_text, replace_all }) => {
        const file = resolveInside(root, path)
        const content = readFileSync(file, 'utf8')
        const count = content.split(old_text).length - 1
        if (count === 0) throw new Error('old_text 在文件中不存在')
        if (count > 1 && !replace_all) throw new Error(`old_text 出现了 ${count} 次；请提供更多上下文使其唯一，或设置 replace_all`)
        writeFileSync(file, replace_all ? content.split(old_text).join(new_text) : content.replace(old_text, () => new_text))
        return `已修改 ${relative(realpathSync(root), file)}（替换 ${replace_all ? count : 1} 处）`
      },
    }),
    list_dir: tool({
      description: 'List a workspace directory (non-recursive). Directories end with /.',
      inputSchema: z.object({ path: z.string().default('.') }),
      execute: async ({ path }) => {
        const dir = resolveInside(root, path)
        const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
        if (!entries.length) return '（空目录）'
        return blobs.spill('listing', entries.slice(0, 1000).map(e => {
          if (e.isDirectory()) return `${e.name}/`
          try { return `${e.name}  ${statSync(join(dir, e.name)).size}B` } catch { return e.name }
        }).join('\n'))
      },
    }),
  }
}
