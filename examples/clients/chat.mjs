// A terminal chat client built on @nuonuo/client (unified /v1 protocol with auto-rotating refresh tokens).
//   pnpm dlx tsx examples/clients/chat.mjs pair http://127.0.0.1:7420 K7QF-2M9D
//   pnpm dlx tsx examples/clients/chat.mjs
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { NuonuoClient } from '../../packages/client/src/index.ts'

const FILE = '.nuonuo-device.json'
const [cmd, url, code] = process.argv.slice(2)

if (cmd === 'pair') {
  const bundle = await NuonuoClient.pair(url, code, { name: `终端 ${process.env.USER ?? ''}`.trim(), kind: 'cli', platform: process.platform })
  writeFileSync(FILE, JSON.stringify({ baseUrl: url, accessToken: bundle.accessToken, refreshToken: bundle.refreshToken }), { mode: 0o600 })
  console.log(`已配对：${bundle.device.name}（${bundle.device.id}）`)
  process.exit(0)
}
if (!existsSync(FILE)) { console.log('先运行：tsx examples/clients/chat.mjs pair <地址> <配对码>'); process.exit(2) }

const saved = JSON.parse(readFileSync(FILE, 'utf8'))
const nuonuo = new NuonuoClient({
  ...saved,
  onTokensUpdated: bundle => {
    writeFileSync(FILE, JSON.stringify({ baseUrl: saved.baseUrl, accessToken: bundle.accessToken, refreshToken: bundle.refreshToken }), { mode: 0o600 })
  },
})
const hello = await nuonuo.hello()
console.log(`已连上 ${hello.assistant.name}（服务 ${hello.server.version}，协议 ${hello.protocol}）。输入消息，Ctrl+C 退出。`)

let shown = ''
;(async () => {
  for await (const e of nuonuo.events({ conversation: 'main' })) {
    if (e.type === 'reply.delta') { process.stdout.write(e.text.slice(shown.length)); shown = e.text }
    if (e.type === 'message' && e.op === 'created' && e.message?.role === 'assistant') {
      process.stdout.write(shown ? '\n' : `${e.message.text}\n`)
      shown = ''
    }
    if (e.type === 'notice') console.log(`\n🔔 ${e.notice.title}：${e.notice.body}`)
  }
})()

const rl = createInterface({ input: process.stdin, output: process.stdout })
for (;;) {
  const line = (await rl.question('')).trim()
  if (line) await nuonuo.send(line).catch(err => console.error(err.message))
}
