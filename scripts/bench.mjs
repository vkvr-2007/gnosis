/**
 * Speed benchmark for the brain — how long AYRA makes the owner wait.
 *
 * Talks to a running bridge exactly the way the face does and asks a fixed set
 * of everyday questions, one after another in the same conversation, timing
 * each from the moment it is sent:
 *
 *   first word   — the first text delta (the HUD transcript starts moving)
 *   speech       — the first complete sentence (the voice starts here)
 *   done         — the whole answer
 *
 * plus which tools ran and how many cards went on screen. Run it before and
 * after a change that touches a turn, and put both tables in PROGRESS.md.
 *
 *   npm run bench                 (the bridge must already be running)
 *   npm run bench -- 2            (only the first two questions)
 *   npm run bench -- 5 --steps    (and when each tool and card happened)
 *
 * Every question is a real turn on the owner's Claude plan — run it once per
 * check, not in a loop. Use a test bridge with Telegram off:
 *   AYRA_BRIDGE_PORT=8788 AYRA_TELEGRAM=off node bridge/server.mjs
 *   AYRA_BRIDGE_PORT=8788 npm run bench
 */

import WebSocket from 'ws'
import { env } from '../bridge/identity.mjs'

const PORT = Number(env('BRIDGE_PORT', 8787))
const TURN_TIMEOUT_MS = 180_000

/** Everyday questions, cheapest first: plain chat, the clock, then the web. */
const QUESTIONS = [
  ['chat', "Hi Gnosis, how's your day going?"],
  ['time', 'What day of the week is it tomorrow?'],
  ['quick search', "What's the weather in Hyderabad right now?"],
  ['search + cards', 'Find the three biggest AI news stories this week and put them on screen.'],
  ['read a page', "What's the current LTS version of Node.js? Check the official site."],
]

const limit = Number(process.argv[2]) || QUESTIONS.length
const steps = process.argv.includes('--steps')
const secs = (ms) => (ms == null ? '—' : `${(ms / 1000).toFixed(1)} s`)

const ws = new WebSocket(`ws://localhost:${PORT}`, { origin: 'http://localhost:5173' })
ws.on('error', (err) => {
  console.error(`[bench] cannot reach the bridge on port ${PORT}: ${err.message}`)
  process.exit(1)
})

/** One turn: send, then time the frames that come back for it. */
const ask = (id, text) =>
  new Promise((resolve) => {
    const t0 = Date.now()
    const r = { firstTool: null, firstText: null, speech: null, done: null, tools: [], cards: 0, answer: '', steps: [] }
    const timer = setTimeout(() => finish('timeout'), TURN_TIMEOUT_MS)
    const finish = (error) => {
      clearTimeout(timer)
      ws.off('message', onMessage)
      resolve({ ...r, error })
    }
    const onMessage = (raw) => {
      let m
      try {
        m = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (m.ask && m.ask !== id) return
      const now = Date.now() - t0
      if (m.type === 'tool') {
        r.firstTool ??= now
        r.tools.push(m.name.replace(/^mcp__\w+?__/, ''))
        r.steps.push(`${secs(now)} ${m.name}`)
      } else if (m.type === 'blade') {
        r.cards++
        r.steps.push(`${secs(now)} card "${m.blade?.title ?? ''}"`)
      } else if (m.type === 'text') {
        if (r.firstText == null) r.steps.push(`${secs(now)} first word`)
        r.firstText ??= now
        r.answer += m.delta ?? ''
        if (r.speech == null && /[.!?](\s|$)/.test(r.answer)) r.speech = now
      } else if (m.type === 'done') {
        r.done = now
        r.speech ??= now
        if (!r.answer) r.answer = m.text ?? ''
        finish(null)
      } else if (m.type === 'error') {
        finish(m.message ?? 'error')
      }
    }
    ws.on('message', onMessage)
    ws.send(JSON.stringify({ type: 'ask', id, text }))
  })

ws.on('open', async () => {
  // The face opens its socket during the boot animation, well before the first
  // question; give the session the same head start so the numbers match use.
  await new Promise((r) => setTimeout(r, 3000))
  const rows = []
  for (const [i, [name, text]] of QUESTIONS.slice(0, limit).entries()) {
    process.stdout.write(`[bench] ${name}… `)
    const r = await ask(`bench${i}`, text)
    console.log(r.error ? `FAILED (${r.error})` : `${secs(r.done)}`)
    rows.push({ name, ...r })
  }
  console.log('\n| Question | First word | Speech starts | Done | Tools | Cards |')
  console.log('|---|---|---|---|---|---|')
  for (const r of rows) {
    console.log(
      `| ${r.name} | ${secs(r.firstText)} | ${secs(r.speech)} | ${secs(r.done)} | ` +
        `${r.tools.join(', ') || '—'} | ${r.cards} |`,
    )
  }
  console.log('\nAnswers:')
  for (const r of rows) console.log(`- ${r.name}: ${r.answer.replace(/\s+/g, ' ').slice(0, 160)}`)
  if (steps) {
    console.log('\nSteps:')
    for (const r of rows) console.log(`- ${r.name}: ${r.steps.join(' → ')} → ${secs(r.done)} done`)
  }
  ws.close()
  process.exit(rows.some((r) => r.error) ? 1 : 0)
})
