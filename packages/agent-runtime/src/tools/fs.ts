/**
 * File tools. Relative paths stay inside the task's working directory; absolute and ~ paths reach the owner's folders,
 * each one checked by `access` (权限 → 文件夹: allowed folders, never-touch folders). Without `access` only the working
 * directory is reachable. (The shell is not confined; tiers and review are the real boundary.)
 */
import { tool } from 'ai'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
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

/** Why an absolute path may not be read or written, or undefined when it may. */
export type FsAccess = (path: string, mode: 'read' | 'write') => string | undefined

const expand = (path: string) => path.replace(/^~(?=$|[/\\])/, process.env.HOME ?? homedir())

/** Resolves a tool's path: relative ones inside the workspace, absolute and ~ ones through the owner's folder rules. */
export function resolvePath(root: string, path: string, mode: 'read' | 'write', access?: FsAccess): string {
  const expanded = expand(path)
  if (!isAbsolute(expanded)) return resolveInside(root, path)
  const base = realpathSync(root)
  const target = resolve(expanded)
  let check = target
  while (!existsSync(check)) check = dirname(check)
  const real = join(realpathSync(check), relative(check, target))
  if (real === base || real.startsWith(base + sep)) return real
  if (!access) throw new Error(`路径 ${path} 不在工作目录内（${base}）`)
  // Both the path as written and where its links lead must pass, so a link cannot smuggle a never-touch folder in.
  const why = access(target, mode) ?? (real !== target ? access(real, mode) : undefined)
  if (why) throw new Error(why)
  return real
}

const shown = (root: string, file: string) => {
  const rel = relative(realpathSync(root), file)
  return rel.startsWith('..') || isAbsolute(rel) ? file : rel
}

const IMAGE: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }

/** `describeImage`: set when the model running the tools cannot take images; view_image then returns a description instead. */
export interface FsToolOptions { describeImage?: (data: string, mediaType: string) => Promise<string> }

export function fsTools(root: string, blobs: Blobs, access?: FsAccess, opts: FsToolOptions = {}) {
  const at = (path: string, mode: 'read' | 'write') => resolvePath(root, path, mode, access)
  return {
    read_file: tool({
      description: 'Read a text file (relative to the workspace, or an absolute/~ path in a folder the owner allowed). Returns numbered lines. Use offset/limit (1-based lines) for long files.',
      inputSchema: z.object({ path: z.string(), offset: z.number().int().min(1).optional(), limit: z.number().int().min(1).max(MAX_READ).optional() }),
      execute: async ({ path, offset = 1, limit = MAX_READ }) => {
        const file = at(path, 'read')
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
        const file = at(path, 'write')
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, content)
        return `已写入 ${shown(root, file)}（${content.length} 字符）`
      },
    }),
    edit_file: tool({
      description: 'Replace exact text in a workspace file. old_text must match exactly once unless replace_all is true.',
      inputSchema: z.object({ path: z.string(), old_text: z.string().min(1), new_text: z.string(), replace_all: z.boolean().optional() }),
      execute: async ({ path, old_text, new_text, replace_all }) => {
        const file = at(path, 'write')
        const content = readFileSync(file, 'utf8')
        const count = content.split(old_text).length - 1
        if (count === 0) throw new Error('old_text 在文件中不存在')
        if (count > 1 && !replace_all) throw new Error(`old_text 出现了 ${count} 次；请提供更多上下文使其唯一，或设置 replace_all`)
        writeFileSync(file, replace_all ? content.split(old_text).join(new_text) : content.replace(old_text, () => new_text))
        return `已修改 ${shown(root, file)}（替换 ${replace_all ? count : 1} 处）`
      },
    }),
    list_dir: tool({
      description: 'List a directory (non-recursive). Directories end with /. Relative to the workspace, or an absolute/~ path in an allowed folder.',
      inputSchema: z.object({ path: z.string().default('.') }),
      execute: async ({ path }) => {
        const dir = at(path, 'read')
        const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
        if (!entries.length) return '（空目录）'
        return blobs.spill('listing', entries.slice(0, 1000).map(e => {
          if (e.isDirectory()) return `${e.name}/`
          try { return `${e.name}  ${statSync(join(dir, e.name)).size}B` } catch { return e.name }
        }).join('\n'))
      },
    }),
    find_files: tool({
      description: 'Find files by name under a directory (recursive, case-insensitive substring or *.ext glob). Use for "where is my …" questions in allowed folders.',
      inputSchema: z.object({ path: z.string().default('.'), pattern: z.string().min(1), limit: z.number().int().min(1).max(500).optional() }),
      execute: async ({ path, pattern, limit = 100 }) => {
        const dir = at(path, 'read')
        const base = realpathSync(root)
        const glob = pattern.startsWith('*.') ? pattern.slice(1).toLowerCase() : null
        const needle = pattern.toLowerCase()
        const found: string[] = []
        const walk = (d: string, depth: number) => {
          if (found.length >= limit || depth > 8) return
          let entries
          try { entries = readdirSync(d, { withFileTypes: true }) } catch { return }
          for (const e of entries) {
            if (found.length >= limit) return
            if (e.name.startsWith('.') || e.name === 'node_modules') continue
            const full = join(d, e.name)
            if (access && !full.startsWith(base) && access(full, 'read')) continue
            const name = e.name.toLowerCase()
            if (glob ? name.endsWith(glob) : name.includes(needle)) found.push(e.isDirectory() ? `${full}/` : full)
            if (e.isDirectory()) walk(full, depth + 1)
          }
        }
        walk(dir, 0)
        return found.length ? blobs.spill('listing', found.join('\n')) : '（没找到）'
      },
    }),
    move_path: tool({
      description: 'Move or rename a file or folder. Both places must be writable (the workspace, or a folder the owner allowed to change). Never overwrites.',
      inputSchema: z.object({ from: z.string(), to: z.string() }),
      execute: async ({ from, to }) => {
        const src = at(from, 'write')
        let dest = at(to, 'write')
        if (existsSync(dest) && statSync(dest).isDirectory()) dest = at(join(dest, basename(src)), 'write')
        if (existsSync(dest)) throw new Error(`${to} 已存在，不覆盖`)
        mkdirSync(dirname(dest), { recursive: true })
        renameSync(src, dest)
        return `已移动 ${shown(root, src)} → ${shown(root, dest)}`
      },
    }),
    view_image: tool({
      description: 'Look at an image file (png, jpg, gif, webp), such as one the owner attached. Returns the picture itself.',
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }) => {
        const file = at(path, 'read')
        const mediaType = IMAGE[extname(file).toLowerCase()]
        if (!mediaType) throw new Error('只支持 png、jpg、gif、webp 图片')
        if (statSync(file).size > 8 * 1024 * 1024) throw new Error('图片超过 8MB')
        const data = readFileSync(file).toString('base64')
        if (opts.describeImage) return { mediaType, data: '', description: await opts.describeImage(data, mediaType) }
        return { mediaType, data, description: undefined as string | undefined }
      },
      toModelOutput: ({ output }) => output.description !== undefined
        ? { type: 'text', value: `（这个模型看不了图片，下面是视觉层模型的描述）\n${output.description}` }
        : { type: 'content', value: [{ type: 'image-data', data: output.data, mediaType: output.mediaType }] },
    }),
  }
}
