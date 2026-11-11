/** Operating a task's browser tab from the web: a live screenshot to click on, a text box to type, then hand it back. */
import { useMutation } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, CornerDownLeft, Globe, Hand } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api } from './api'
import { Button, Input, Modal } from './ui'
import { tx } from './i18n'

const VIEWPORT = { width: 1280, height: 800 }

export function HandoffModal({ ticketId, reason, onClose }: { ticketId: string; reason: string; onClose(): void }) {
  const [tick, setTick] = useState(0)
  const [text, setText] = useState('')
  const [url, setUrl] = useState('')
  const [error, setError] = useState<string | null>(null)
  const img = useRef<HTMLImageElement>(null)
  const start = useMutation({ mutationFn: () => api.post(`/browser/${ticketId}/handoff`), onError: e => setError((e as Error).message) })
  useEffect(() => { start.mutate() }, [])
  useEffect(() => {
    const timer = setInterval(() => setTick(t => t + 1), 900)
    return () => clearInterval(timer)
  }, [])
  const send = async (body: Record<string, unknown>) => {
    try { setError(null); const r = await api.post<{ url: string }>(`/browser/${ticketId}/input`, body); setUrl(r.url); setTick(t => t + 1) }
    catch (e) { setError((e as Error).message) }
  }
  const finish = useMutation({ mutationFn: () => api.post(`/browser/${ticketId}/return`, {}), onSuccess: onClose })
  return <Modal title={tx('接管浏览器')} onClose={onClose} footer={<>
    <span className="mr-auto text-xs text-faint">{tx('操作的是任务正在用的那个页面；登录信息会保存在智能体的浏览器配置里。')}</span>
    <Button variant="primary" onClick={() => finish.mutate()} disabled={finish.isPending}><Hand size={14} />{tx('完成，交还给智能体')}</Button>
  </>}>
    <div className="rounded-lg bg-accent-soft px-3 py-2 text-sm">{reason}</div>
    <form className="flex gap-2" onSubmit={e => { e.preventDefault(); if (url) void send({ type: 'goto', url }) }}>
      <Globe size={16} className="mt-2.5 shrink-0 text-faint" />
      <Input value={url} onChange={e => setUrl(e.target.value)} placeholder={tx('地址（回车跳转）')} className="h-9 font-mono text-xs" />
    </form>
    {start.isSuccess ? <img ref={img} alt={tx('浏览器画面')} src={`/api/browser/${ticketId}/screenshot?t=${tick}`}
      className="w-full cursor-crosshair rounded-lg border border-line"
      onClick={e => {
        const rect = e.currentTarget.getBoundingClientRect()
        void send({ type: 'click', x: Math.round((e.clientX - rect.left) / rect.width * VIEWPORT.width), y: Math.round((e.clientY - rect.top) / rect.height * VIEWPORT.height) })
      }} /> : <div className="py-10 text-center text-sm text-faint">{error ?? tx('正在连接浏览器…')}</div>}
    <form className="flex gap-2" onSubmit={e => { e.preventDefault(); if (text) { void send({ type: 'type', text }); setText('') } }}>
      <Input value={text} onChange={e => setText(e.target.value)} placeholder={tx('先点一下输入框，再在这里打字（输入密码不会被智能体看到文字记录）')} type="text" />
      <Button type="submit" size="md">{tx('输入')}</Button>
    </form>
    <div className="flex flex-wrap gap-1.5">
      <Button size="sm" onClick={() => send({ type: 'key', key: 'Enter' })}><CornerDownLeft size={13} />{tx('回车')}</Button>
      <Button size="sm" onClick={() => send({ type: 'key', key: 'Tab' })}>Tab</Button>
      <Button size="sm" onClick={() => send({ type: 'key', key: 'Backspace' })}>{tx('退格')}</Button>
      <Button size="sm" onClick={() => send({ type: 'scroll', dy: -500 })}><ArrowUp size={13} />{tx('上翻')}</Button>
      <Button size="sm" onClick={() => send({ type: 'scroll', dy: 500 })}><ArrowDown size={13} />{tx('下翻')}</Button>
    </div>
    {error && <p className="text-xs text-danger">{error}</p>}
  </Modal>
}
