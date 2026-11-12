// A terminal chat client built on @nuonuo/client: streams the answer as it is written.
//   node chat.mjs pair http://192.168.1.5:7420 K7QF-2M9D      (saves the token to ./.nuonuo-device.json)
//   node chat.mjs
// Run from the repo with tsx (the SDK is TypeScript source): pnpm dlx tsx examples/clients/chat.mjs
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { NuonuoClient } from '../../packages/client/src/index.ts'

const FILE = '.nuonuo-device.json'
const [cmd, url, code] = process.argv.slice(2)

if (cmd === 'pair') {
  const { token, device } = await NuonuoClient.pair(url, code, { name: `终端 ${process.env.USER ?? ''}`.trim(), kind: 'desktop', platform: process.platform })
  writeFileSync(FILE, JSON.stringify({ baseUrl: url, token }), { mode: 0o600 })
  console.log(`已配对：${device.name}（${device.id}）`)
  process.exit(0)
}
if (!existsSync(FILE)) { console.log('先运行：node chat.mjs pair <地址> <配对码>'); process.exit(2) }

const nuonuo = new NuonuoClient(JSON.parse(readFileSync(FILE, 'utf8')))
const hello = await nuonuo.hello()
console.log(`已连上 ${hello.assistant.name}（服务 ${hello.server.version}，协议 ${hello.protocol}）。输入消息，Ctrl+C 退出。`)

let shown = ''
;(async () => {
  for await (const e of nuonuo.events({ conversation: 'main' })) {
    if (e.type === 'reply.delta') { process.stdout.write(e.text.slice(shown.length)); shown = e.text }
    if (e.type === 'message' && e.op === 'created' && e.message.role === 'assistant') {
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
