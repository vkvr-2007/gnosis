// Unit tests for bridge/telegram.mjs — the parts that decide who and how much. `npm test`
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chunk, fromOwner, startTelegram } from '../bridge/telegram.mjs'
import { SYSTEM_PROMPT, TEXT_PROMPT } from '../bridge/persona.mjs'
import { rankQuery } from '../bridge/triage.mjs'

const OWNER = '1300190813'

test('only the owner, in a private chat, gets through', () => {
  assert.equal(fromOwner({ chat: { type: 'private' }, from: { id: 1300190813 } }, OWNER), true)
  assert.equal(fromOwner({ chat: { type: 'private' }, from: { id: 42 } }, OWNER), false)
  assert.equal(fromOwner({ chat: { type: 'group' }, from: { id: 1300190813 } }, OWNER), false)
  assert.equal(fromOwner({ chat: { type: 'private' } }, OWNER), false)
  assert.equal(fromOwner(undefined, OWNER), false)
})

test('short replies go as one message', () => {
  assert.deepEqual(chunk('Hey boss!'), ['Hey boss!'])
  assert.deepEqual(chunk('   '), [])
})

test('long replies split under the limit, at line breaks when possible', () => {
  const line = 'x'.repeat(60)
  const long = Array.from({ length: 200 }, () => line).join('\n') // ~12k chars
  const pieces = chunk(long)
  assert.ok(pieces.length >= 3)
  for (const p of pieces) {
    assert.ok(p.length <= 4096)
    assert.ok(/^x+(\nx+)*$/.test(p), 'split only at line breaks')
  }
  assert.equal(pieces.join('\n'), long)
})

/** A fake Telegram + brain: one burst of updates, replies recorded, nothing on the network. */
function harness(updates, options = {}) {
  const asks = []
  const sent = []
  const logged = []
  let served = false
  const brain = {
    open({ emit }) {
      let current = null
      return {
        ask(text, id, meta) {
          asks.push({ text, id, meta })
          current = { ask: id, rank: meta?.rank ?? null, text: meta?.text ?? text }
          setTimeout(() => emit({ type: 'done', text: `reply ${asks.length}`, ask: id }), 5)
        },
        turn: () => current,
        close() {},
      }
    },
  }
  const request = async (method, body) => {
    if (method === 'getMe') return { username: 'test_bot' }
    if (method === 'sendChatAction') return true
    if (method === 'sendMessage') return sent.push(body)
    if (method === 'getUpdates') {
      if (!served) { served = true; return updates }
      await new Promise((r) => setTimeout(r, 20))
      return []
    }
    throw new Error(`unexpected ${method}`)
  }
  const tg = startTelegram({
    token: 'test', ownerId: OWNER, brain, systemPrompt: 'test', request,
    audit: { log: (e) => logged.push(e) },
    ...options,
  })
  return { asks, sent, logged, tg, stop: () => tg.stop() }
}

const msg = (id, text, from = 1300190813, date = Math.floor(Date.now() / 1000)) => ({
  update_id: id,
  message: { message_id: id, date, chat: { id: 77, type: 'private' }, from: { id: from }, text },
})

test('each message of a burst is ranked, and the deepest rank goes with the question', async () => {
  const warmed = []
  const h = harness(
    [msg(1, 'hey'), msg(2, 'research the impact of AI on jobs in India'), msg(3, 'thanks')],
    { onComplex: (rank) => warmed.push(rank) },
  )
  await new Promise((r) => setTimeout(r, 120))
  h.stop()
  assert.equal(h.asks.length, 1)
  const { meta } = h.asks[0]
  assert.deepEqual(meta.rank, rankQuery('research the impact of AI on jobs in India'))
  assert.equal(meta.rank.level, 'complex')
  assert.equal(meta.text, 'hey\nresearch the impact of AI on jobs in India\nthanks')
  // The research planner is started while the brain reads the question.
  assert.equal(warmed.length, 1)
})

test('small talk stays simple however many lines it takes, and nothing is warmed', async () => {
  const warmed = []
  const h = harness(
    [msg(1, 'hey ayra'), msg(2, "how's your day going"), msg(3, "lol I'm so bored")],
    { onComplex: (rank) => warmed.push(rank) },
  )
  await new Promise((r) => setTimeout(r, 120))
  h.stop()
  assert.equal(h.asks[0].meta.rank.level, 'simple')
  assert.equal(warmed.length, 0)
})

test('a message sent while offline is ranked and remembered in the owner\'s words', async () => {
  const h = harness([msg(1, 'research it', OWNER, Math.floor(Date.now() / 1000) - 3600)])
  await new Promise((r) => setTimeout(r, 120))
  h.stop()
  assert.match(h.asks[0].text, /^\[Sent at .+, while you were offline\]\nresearch it$/)
  assert.equal(h.asks[0].meta.text, 'research it')
  assert.equal(h.asks[0].meta.rank.level, 'complex')
})

test('turn() names the question being answered in the owner\'s words, for the research tool', async () => {
  const h = harness([msg(1, 'hey'), msg(2, 'research it')])
  // Nothing asked yet: no turn, and no throw.
  assert.equal(h.tg.turn(), null)
  await new Promise((r) => setTimeout(r, 120))
  h.stop()
  const t = h.tg.turn()
  assert.equal(t.text, 'hey\nresearch it')
  assert.equal(t.rank.level, 'complex')
  assert.equal(t.ask, h.asks[0].id)
})

test('a warm-up that throws never keeps the question from the brain', async () => {
  const h = harness([msg(1, 'research it')], { onComplex: () => { throw new Error('boom') } })
  await new Promise((r) => setTimeout(r, 120))
  h.stop()
  assert.equal(h.asks.length, 1)
  assert.equal(h.sent.length, 1)
})

test('a burst of messages becomes one question and one reply', async () => {
  const h = harness([msg(1, 'Yooo'), msg(2, 'Hiiiii'), msg(3, 'what is up')])
  await new Promise((r) => setTimeout(r, 120))
  h.stop()
  assert.equal(h.asks.length, 1)
  assert.equal(h.asks[0].text, 'Yooo\nHiiiii\nwhat is up')
  assert.equal(h.sent.length, 1)
  assert.equal(h.sent[0].text, 'reply 1')
  assert.equal(h.sent[0].chat_id, 77)
})

test('strangers are ignored and logged, never asked', async () => {
  const h = harness([msg(1, 'let me in', 42)])
  await new Promise((r) => setTimeout(r, 80))
  h.stop()
  assert.equal(h.asks.length, 0)
  assert.equal(h.sent.length, 0)
  assert.deepEqual(h.logged.map((e) => e.type), ['telegram_ignored'])
})

test('the text persona is for chat, not the HUD', () => {
  assert.ok(TEXT_PROMPT.includes('Telegram'))
  assert.ok(!/\bblade\b/.test(TEXT_PROMPT))
  assert.ok(TEXT_PROMPT.includes('ROASTING AND BANTER'))
  assert.ok(TEXT_PROMPT.includes('Always kind and PG'))
  // No cards on a phone, so no show_data either.
  assert.ok(!TEXT_PROMPT.includes('show_data'))
})

test('a web answer on the phone: the figure first, then at most two sources it used', () => {
  assert.ok(TEXT_PROMPT.includes('WEB ANSWERS.'))
  assert.ok(TEXT_PROMPT.includes('the key\nfigure with its unit and as-of'))
  assert.ok(TEXT_PROMPT.includes('one line for each source you actually used, at most 2:\nSource: <domain> — <url>'))
})

test('research on the phone: only when the ranker says so, and its report sent as it is', () => {
  assert.ok(TEXT_PROMPT.includes('[Depth'))
  assert.ok(TEXT_PROMPT.includes('Without that line, never use research'))
  assert.ok(TEXT_PROMPT.includes('Send its report as it is'))
  assert.ok(!/\bstandard\b|\bdeep\b/i.test(TEXT_PROMPT))
})

test('emoji when texting, never when speaking', () => {
  assert.ok(TEXT_PROMPT.includes('EMOJI.'), 'the owner asked for emoji on Telegram')
  assert.ok(!/no emoji/i.test(TEXT_PROMPT))
  assert.ok(/no emoji/i.test(SYSTEM_PROMPT), 'the voice would read them out loud')
})
