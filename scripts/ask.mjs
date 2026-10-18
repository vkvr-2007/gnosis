// Asks the running bridge questions over its WebSocket, like the face does, and prints what comes back.
//   node scripts/ask.mjs "what time is it?" "what's my battery level?"
import WebSocket from 'ws'

const port = Number(process.env.AYRA_BRIDGE_PORT ?? 8787)
const questions = process.argv.slice(2)
if (!questions.length) {
  console.log('usage: node scripts/ask.mjs "question" ["another" …]')
  process.exit(1)
}

const ws = new WebSocket(`ws://localhost:${port}`, { headers: { Origin: 'http://localhost:5173' } })
const opened = new Promise((resolve, reject) => {
  ws.once('open', resolve)
  ws.once('error', reject)
})
await opened

for (const [n, text] of questions.entries()) {
  const id = `ask-${Date.now()}-${n}`
  const t0 = Date.now()
  let first = null
  let answer = ''
  const tools = []
  await new Promise((resolve) => {
    const onMessage = (raw) => {
      const msg = JSON.parse(raw.toString())
      if (msg.ask && msg.ask !== id) return
      if (msg.type === 'text') {
        first ??= Date.now() - t0
        answer += msg.delta
      } else if (msg.type === 'tool') tools.push(msg.name)
      else if (msg.type === 'done' || msg.type === 'error') {
        ws.off('message', onMessage)
        const text = msg.type === 'done' ? (msg.text || answer) : `ERROR: ${msg.message}`
        console.log(`\nQ: ${text === '' ? '' : ''}${questions[n]}\nA: ${text.trim()}\n   tools: ${tools.join(', ') || '-'} · first words ${first ?? '-'} ms · done ${Date.now() - t0} ms`)
        resolve()
      }
    }
    ws.on('message', onMessage)
    ws.send(JSON.stringify({ type: 'ask', text, id }))
  })
}
ws.close()
