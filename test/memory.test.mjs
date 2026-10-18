/** Gnosis's long-term memory (bridge/memory.mjs), ported from v1, and how the brain uses it. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemory, memoryServer } from '../bridge/memory.mjs'
import { ASKS_ACTION, query } from '../bridge/sdk.mjs'
import { createGate } from '../bridge/gate.mjs'

const fresh = () => createMemory(join(mkdtempSync(join(tmpdir(), 'gnosis-mem-')), 'memory.json'))

test('a fact is remembered, replaced by a newer one, searched and forgotten', () => {
  const m = fresh()
  const a = m.remember({ subject: 'owner', predicate: 'favourite_food', value: 'dosa' })
  m.remember({ subject: 'Asha', predicate: 'birthday', value: '12 March' })
  const b = m.remember({ subject: 'Owner', predicate: 'favourite food', value: 'biryani' })
  assert.equal(b.id, a.id) // the same fact, updated
  assert.deepEqual(m.facts().map((f) => f.value), ['biryani', '12 March'])
  assert.deepEqual(m.search("what's my favourite food?").facts.map((f) => f.value), ['biryani'])
  assert.deepEqual(m.search("when is Asha's birthday").facts.map((f) => f.subject), ['Asha'])
  assert.equal(m.forget(a.id), true)
  assert.equal(m.forget(a.id), false)
  assert.deepEqual(m.facts().map((f) => f.value), ['12 March'])
})

test('sensitive facts are only recalled for the on-device model', () => {
  const m = fresh()
  m.remember({ subject: 'owner', predicate: 'blood group', value: 'O+', sensitive: true })
  assert.equal(m.recallText("what's my blood group?"), '')
  assert.match(m.recallText("what's my blood group?", { includeSensitive: true }), /blood group = O\+/)
})

test('past exchanges are recalled as history, and never for an action request', () => {
  const m = fresh()
  m.addEpisode('Open Notepad', 'Notepad is open.')
  const asked = m.recallText('open notepad again')
  assert.match(asked, /history: never repeat their answers/)
  assert.match(asked, /"Open Notepad" -> "Notepad is open\."/)
  assert.equal(m.recallText('open notepad again', { actionRequest: true }), '')
})

test('the memory tools: remember, search_memory (all when empty), forget', async () => {
  const m = fresh()
  const tools = Object.fromEntries(memoryServer(m).tools.map((t) => [t.name, t.handler]))
  const said = async (name, args) => (await tools[name](args)).content[0].text
  assert.match(await said('remember', { subject: 'owner', predicate: 'favourite colour', value: 'green' }), /Remembered \[#1\]/)
  assert.match(await said('search_memory', {}), /\[#1\] The owner: favourite colour = green/)
  assert.match(await said('search_memory', { query: 'colour' }), /green/)
  assert.equal(await said('forget', { id: 1 }), 'Forgot fact #1.')
  assert.equal(await said('search_memory', {}), 'Nothing remembered yet.')
})

test("the gate lets Gnosis's memory tools run", () => {
  const gate = createGate({ allowWrites: false })
  for (const t of ['remember', 'search_memory', 'forget']) assert.equal(gate.decide(`mcp__ayra_memory__${t}`), true, t)
})

test('"remember…" counts as an action, so a "Got it" without saving is nudged', () => {
  assert.ok(ASKS_ACTION.test('remember that my favourite colour is green'))
  assert.ok(ASKS_ACTION.test('forget my favourite colour'))
  assert.ok(!ASKS_ACTION.test('do you remember my favourite colour?'))
})

test('the brain recalls what bears on a question, and records the exchange', async () => {
  const m = fresh()
  m.remember({ subject: 'owner', predicate: 'favourite colour', value: 'green' })
  const sent = []
  const real = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    sent.push(JSON.parse(init.body))
    const body = `data: ${JSON.stringify({ choices: [{ delta: { content: 'Green.' } }] })}\n\ndata: [DONE]\n\n`
    return new Response(body)
  }
  try {
    const session = query({ prompt: "what's my favourite colour?", options: { memory: m, persistSession: false } })
    for await (const msg of session) if (msg.type === 'result') break
    session.close()
  } finally {
    globalThis.fetch = real
  }
  assert.match(sent[0].messages[0].content, /What you remember about the owner[\s\S]*favourite colour = green/)
  assert.equal(m.search('favourite colour').episodes[0].answer, 'Green.')
})

test('one-off sessions (research agents) neither recall nor record', async () => {
  const sent = []
  const real = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    sent.push(JSON.parse(init.body))
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\ndata: [DONE]\n\n`)
  }
  try {
    const session = query({ prompt: 'favourite colour?', options: { systemPrompt: 'Worker.', persistSession: false, mcpServers: {} } })
    for await (const msg of session) if (msg.type === 'result') break
    session.close()
  } finally {
    globalThis.fetch = real
  }
  assert.equal(sent[0].messages[0].content, 'Worker.')
})
