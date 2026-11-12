/**
 * 便签: an example of a plugin with its own settings and window (package.json `nuonuo.settings` / `nuonuo.window`).
 * The window page (ui/index.html) asks for things through `nuonuo.call(name, input)`, answered by `windowCalls` below.
 */
const list = ctx => ctx.state.get('notes') ?? []
const limit = ctx => ctx.settings.get('limit') || 20

export default ({ definePlugin }) => definePlugin({
  id: 'notes',
  name: '便签',
  windowCalls: {
    list: ctx => ({ notes: list(ctx), limit: limit(ctx) }),
    add: (ctx, input) => {
      const text = String(input?.text ?? '').trim().slice(0, 500)
      if (!text) throw new Error('便签是空的')
      const notes = [{ id: Date.now().toString(36), text, at: Date.now() }, ...list(ctx)].slice(0, limit(ctx))
      ctx.state.set('notes', notes)
      return { notes, limit: limit(ctx) }
    },
    remove: (ctx, input) => {
      const notes = list(ctx).filter(n => n.id !== input?.id)
      ctx.state.set('notes', notes)
      return { notes, limit: limit(ctx) }
    },
  },
  routerPrompt: ctx => {
    if (!ctx.settings.get('shareWithAgent')) return undefined
    const notes = list(ctx)
    return notes.length ? `The owner's sticky notes (便签), newest first:\n${notes.map(n => `- ${n.text}`).join('\n')}` : undefined
  },
})
