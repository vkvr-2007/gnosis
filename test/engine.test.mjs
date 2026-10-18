/**
 * Gnosis's own brain engine (bridge/sdk.mjs): Nemotron behind the Claude Agent SDK's interface,
 * its built-in tools, web search and the model settings.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { collectTools, createSdkMcpServer, query, streamChat, tool, visibleText } from '../bridge/sdk.mjs'
import { BUILTINS } from '../bridge/builtins.mjs'
import { modelFor } from '../bridge/models.mjs'
import { decodeEntities, htmlToText, parseBrave, parseDuckDuckGo, webSearch } from '../bridge/web.mjs'

// -- a fake chat API: each call plays back the next scripted reply as a stream ----------

function sse(chunks) {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n'
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
}
const say = (...parts) => parts.map((p) => ({ choices: [{ delta: { content: p } }] }))
const call = (id, name, args) => [
  { choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: '' } }] } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] } }] },
]

function fakeApi(...replies) {
  const sent = []
  const fetchImpl = async (url, init) => {
    sent.push(JSON.parse(init.body))
    return sse(replies.shift() ?? say('(no more replies)'))
  }
  return { fetchImpl, sent }
}

async function collect(session) {
  const out = []
  for await (const m of session) {
    out.push(m)
    if (m.type === 'result') break
  }
  session.close()
  return out
}

const route = { baseUrl: 'http://model.test/v1', model: 'm', apiKey: 'k' }

test('streamChat streams text and gathers a tool call split across chunks', async () => {
  const { fetchImpl, sent } = fakeApi([...say('Hel', 'lo'), ...call('c1', 'mcp__x__add', { a: 1, b: 2 })])
  const texts = []
  const started = []
  const r = await streamChat({ route, messages: [], tools: [{ type: 'function' }], fetchImpl,
    onText: (t) => texts.push(t), onToolStart: (c) => started.push(c.name) })
  assert.deepEqual(texts, ['Hel', 'lo'])
  assert.equal(r.text, 'Hello')
  assert.deepEqual(r.toolCalls.map((c) => [c.id, c.name, JSON.parse(c.arguments)]), [['c1', 'mcp__x__add', { a: 1, b: 2 }]])
  assert.deepEqual(started, ['mcp__x__add'])
  assert.equal(sent[0].stream, true)
  assert.equal(sent[0].tool_choice, 'auto')
})

test('reasoning in <think> tags is never spoken, even split across chunks', () => {
  assert.equal(visibleText('<think>plan it</think>Hi there.'), 'Hi there.')
  assert.equal(visibleText('Hi <think>still thinking'), 'Hi ')
  assert.equal(visibleText('Hi <thi'), 'Hi ')
  assert.equal(visibleText('3 < 4'), '3 < 4')
})

test('MCP tools are named mcp__<server>__<tool>, validated, and disallowed ones left out', async () => {
  const server = createSdkMcpServer({ name: 'x', tools: [
    tool('add', 'Add.', { a: z.number(), b: z.number() }, async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] })),
    tool('secret', 'No.', {}, async () => ({ content: [] })),
  ] })
  const tools = collectTools({ mcpServers: { calc: server }, tools: ['WebSearch', 'Nope'], disallowedTools: ['mcp__calc__secret'] })
  assert.deepEqual([...tools.keys()], ['WebSearch', 'mcp__calc__add'])
  const add = tools.get('mcp__calc__add')
  assert.equal(add.parameters.type, 'object')
  assert.deepEqual(add.parameters.required, ['a', 'b'])
  assert.equal((await add.call({ a: 2, b: 3 })).text, '5')
  assert.match((await add.call({ a: 'two' })).text, /Invalid arguments/)
})

test('query() runs the agent loop in the SDK message protocol, asking the gate before each tool', async () => {
  const { fetchImpl, sent } = fakeApi(call('c1', 'mcp__calc__add', { a: 17, b: 25 }), say('It is ', '42.'))
  globalThis.__fetch = globalThis.fetch
  globalThis.fetch = fetchImpl
  try {
    const asked = []
    const calc = createSdkMcpServer({ name: 'calc', tools: [
      tool('add', 'Add.', { a: z.number(), b: z.number() }, async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] })),
    ] })
    const msgs = await collect(query({ prompt: 'what is 17 plus 25?', options: {
      model: 'nvidia/test-model', systemPrompt: 'Be brief.', mcpServers: { calc }, includePartialMessages: true,
      persistSession: false,
      canUseTool: async (name, input) => (asked.push([name, input]), { behavior: 'allow', updatedInput: input }),
    } }))
    const kinds = msgs.map((m) => m.type + (m.event ? `:${m.event.type}` : ''))
    assert.deepEqual(kinds, ['system', 'stream_event:content_block_start', 'assistant', 'user',
      'stream_event:content_block_delta', 'stream_event:content_block_delta', 'assistant', 'result'])
    assert.deepEqual(asked, [['mcp__calc__add', { a: 17, b: 25 }]])
    assert.equal(msgs.find((m) => m.type === 'user').message.content[0].content, '42')
    const result = msgs.at(-1)
    assert.equal(result.subtype, 'success')
    assert.equal(result.is_error, false)
    assert.equal(result.result, 'It is 42.')
    // The second call carries the tool call and its result back to the model
    assert.equal(sent[1].model, 'nvidia/test-model')
    assert.deepEqual(sent[1].messages.slice(-2).map((m) => m.role), ['assistant', 'tool'])
    assert.equal(sent[1].messages[0].content, 'Be brief.')
  } finally {
    globalThis.fetch = globalThis.__fetch
  }
})

test('a tool the gate refuses is not run, and the refusal goes back to the model', async () => {
  const { fetchImpl } = fakeApi(call('c1', 'mcp__calc__wipe', {}), say('I left it.'))
  globalThis.__fetch = globalThis.fetch
  globalThis.fetch = fetchImpl
  try {
    let ran = false
    const calc = createSdkMcpServer({ name: 'calc', tools: [tool('wipe', 'Wipe.', {}, async () => ((ran = true), { content: [] }))] })
    const msgs = await collect(query({ prompt: 'wipe it', options: { mcpServers: { calc }, persistSession: false,
      canUseTool: async () => ({ behavior: 'deny', message: 'The owner did not approve this.' }) } }))
    const result = msgs.find((m) => m.type === 'user').message.content[0]
    assert.equal(ran, false)
    assert.equal(result.is_error, true)
    assert.equal(result.content, 'The owner did not approve this.')
    assert.equal(msgs.at(-1).result, 'I left it.')
  } finally {
    globalThis.fetch = globalThis.__fetch
  }
})

test('an API failure ends the turn the way brain.mjs expects (success subtype, is_error, the error as text)', async () => {
  globalThis.__fetch = globalThis.fetch
  globalThis.fetch = async () => new Response('{"detail":"Authentication failed"}', { status: 401 })
  try {
    const msgs = await collect(query({ prompt: 'hi', options: { persistSession: false } }))
    const result = msgs.at(-1)
    assert.equal(result.subtype, 'success')
    assert.equal(result.is_error, true)
    assert.match(result.result, /API Error: 401/)
  } finally {
    globalThis.fetch = globalThis.__fetch
  }
})

test('too many tool rounds stop with error_max_turns', async () => {
  const { fetchImpl } = fakeApi(...Array.from({ length: 5 }, (_, i) => call(`c${i}`, 'WebSearch', { query: 'x' })))
  globalThis.__fetch = globalThis.fetch
  globalThis.fetch = fetchImpl
  try {
    const msgs = await collect(query({ prompt: 'loop', options: { maxTurns: 2, persistSession: false,
      tools: ['TodoWrite'], canUseTool: async () => ({ behavior: 'deny', message: 'no' }) } }))
    assert.equal(msgs.at(-1).subtype, 'error_max_turns')
  } finally {
    globalThis.fetch = globalThis.__fetch
  }
})

test('model names: roles, provider model ids, and leftover Claude names get the default', () => {
  const env = { NVIDIA_API_KEY: 'nv' }
  assert.equal(modelFor('claude-opus-5-5', undefined, env).model, 'nvidia/nemotron-3-super-120b-a12b')
  assert.equal(modelFor('claude-opus-5-5', undefined, env).apiKey, 'nv')
  assert.deepEqual(modelFor('planner', undefined, env).extraBody, { chat_template_kwargs: { enable_thinking: false } })
  assert.equal(modelFor('nvidia/other', undefined, env).model, 'nvidia/other')
  const local = modelFor('local', undefined, env)
  assert.equal(local.onDevice, true)
  assert.equal(local.apiKey, undefined)
})

// -- built-ins --------------------------------------------------------------------------

test('Read numbers lines; Write and Edit change files; Edit refuses ambiguous text', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gnosis-'))
  const f = join(dir, 'a.txt')
  await BUILTINS.Write.run({ file_path: f, content: 'one\ntwo\ntwo\n' }, { cwd: dir })
  assert.match((await BUILTINS.Read.run({ file_path: 'a.txt' }, { cwd: dir })).text, /^\s+1\tone\n\s+2\ttwo/)
  assert.equal((await BUILTINS.Edit.run({ file_path: f, old_string: 'two', new_string: '2' }, { cwd: dir })).isError, true)
  await BUILTINS.Edit.run({ file_path: f, old_string: 'one', new_string: '1' }, { cwd: dir })
  assert.equal(readFileSync(f, 'utf8'), '1\ntwo\ntwo\n')
  writeFileSync(join(dir, 'b.md'), 'needle here')
  assert.match((await BUILTINS.Grep.run({ pattern: 'needle', glob: '*.md' }, { cwd: dir })).text, /b\.md:1: needle here/)
  assert.match((await BUILTINS.Glob.run({ pattern: '*.md' }, { cwd: dir })).text, /b\.md/)
})

test('PowerShell runs a command and reports a failure with its exit code', { skip: process.platform !== 'win32' }, async () => {
  assert.equal((await BUILTINS.PowerShell.run({ command: 'Write-Output hello' }, {})).text, 'hello')
  const bad = await BUILTINS.PowerShell.run({ command: 'exit 3' }, {})
  assert.equal(bad.isError, true)
  assert.match(bad.text, /Exit code 3/)
})

// -- the web ------------------------------------------------------------------------------

const DDG = `<div class="result results_links web-result "><a rel="nofollow" class="result__a"
  href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&amp;rut=x">Example &amp; Co</a>
  <a class="result__snippet" href="x">The <b>best</b> page.</a></div>
  <div class="result result--ad"><a class="result__a" href="https://ads.example">Ad</a></div>`

const BRAVE = `<div class="snippet" data-type="web"><a href="https://brave.example/1" class="svelte-x l1">
  <div class="title search-snippet-title line-clamp-1" title="One &amp; only">One</div></a>
  <div class="content desktop-default-regular t-primary">First <strong>result</strong>.</div></div>`

test('search result pages are read into titles, real links and snippets', () => {
  assert.deepEqual(parseDuckDuckGo(DDG), [{ title: 'Example & Co', url: 'https://example.com/a', snippet: 'The best page.' }])
  assert.deepEqual(parseBrave(BRAVE), [{ title: 'One & only', url: 'https://brave.example/1', snippet: 'First result.' }])
  assert.equal(decodeEntities('&#39;a&#x27; &amp;'), "'a' &")
  assert.equal(htmlToText('<title>T</title><script>x()</script><p>Hello <b>you</b></p><p>Bye</p>'), 'T\n\nHello you\nBye')
})

test('web search tries engines in order and answers in the shape sources.mjs reads', async () => {
  const engines = [
    { name: 'off', enabled: () => false, search: async () => assert.fail('a disabled engine was used') },
    { name: 'blocked', search: async () => { throw new Error('HTTP 429') } },
    { name: 'good', search: async () => [{ title: 'A', url: 'https://a.example', snippet: 'about a' }] },
  ]
  const r = await webSearch('a thing', { engines })
  assert.deepEqual(r.structured, { query: 'a thing', results: [{ content: [{ title: 'A', url: 'https://a.example' }] }] })
  assert.match(r.text, /^Web search results for query: "a thing"\n\nLinks: \[\{"title":"A","url":"https:\/\/a.example"\}\]/)
  const none = await webSearch('x', { engines: [engines[1]] })
  assert.equal(none.text, 'No results found for "x".')
})

// -- the claim check ------------------------------------------------------------------------

test('an action answered without a tool is nudged once, and the false claim is never streamed', async () => {
  const { fetchImpl, sent } = fakeApi(say('Playing now. Enjoy!'), call('c1', 'mcp__m__play', {}), say('Playing "Cats".'))
  globalThis.__fetch = globalThis.fetch
  globalThis.fetch = fetchImpl
  try {
    const m = createSdkMcpServer({ name: 'm', tools: [tool('play', 'Play.', {}, async () => ({ content: [{ type: 'text', text: 'ok' }] }))] })
    const msgs = await collect(query({ prompt: '[Now: Sun 18 Oct, 10:30]\nOpen YouTube and play a cat video', options: {
      mcpServers: { m }, includePartialMessages: true, persistSession: false,
      canUseTool: async (n, input) => ({ behavior: 'allow', updatedInput: input }) } }))
    const streamed = msgs.filter((x) => x.event?.type === 'content_block_delta').map((x) => x.event.delta.text).join('')
    assert.equal(streamed, 'Playing "Cats".')
    assert.equal(msgs.at(-1).result, 'Playing "Cats".')
    assert.match(sent[1].messages.at(-1).content, /^\[Gnosis check\][\s\S]*The request is: Open YouTube and play a cat video/)
  } finally {
    globalThis.fetch = globalThis.__fetch
  }
})

test('questions stream at once, and are never held or nudged', async () => {
  const { fetchImpl, sent } = fakeApi(say('It is ', 'ninety-six.'))
  globalThis.__fetch = globalThis.fetch
  globalThis.fetch = fetchImpl
  try {
    const msgs = await collect(query({ prompt: 'What is 12 times 8?', options: { tools: ['WebSearch'],
      includePartialMessages: true, persistSession: false } }))
    assert.equal(msgs.filter((x) => x.event?.type === 'content_block_delta').length, 2)
    assert.equal(sent.length, 1)
  } finally {
    globalThis.fetch = globalThis.__fetch
  }
})

test('which requests ask for an action', async () => {
  const { ASKS_ACTION, requestText } = await import('../bridge/sdk.mjs')
  for (const s of ['Open YouTube and play a cat video', 'hey gnosis, close notepad', 'Can you set a reminder',
    'please turn the volume down', 'search the web for the IPL score']) assert.ok(ASKS_ACTION.test(s), s)
  for (const s of ['What time is it?', 'Is Notepad open?', 'Write me a poem', 'Tell me a joke', 'What does open source mean?'])
    assert.ok(!ASKS_ACTION.test(s), s)
  assert.equal(requestText('[Depth 8/10 · complex]\n[Now: Sun]\nopen it'), 'open it')
})

// -- private work stays on the laptop --------------------------------------------------------

function routedApi(...replies) {
  const calls = []
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push({ local: url.startsWith('http://127.0.0.1:8081'), body })
    return sse(replies.shift() ?? say('(no more replies)'))
  }
  return { fetchImpl, calls }
}

async function withFetch(fetchImpl, fn) {
  globalThis.__fetch = globalThis.fetch
  globalThis.fetch = fetchImpl
  try {
    return await fn()
  } finally {
    globalThis.fetch = globalThis.__fetch
  }
}

const allow = async (n, input) => ({ behavior: 'allow', updatedInput: input })

test('a request that says it is private thinks on the laptop, with the short tool list', async () => {
  const { fetchImpl, calls } = routedApi(say('Done privately.'))
  await withFetch(fetchImpl, async () => {
    const msgs = await collect(query({ prompt: 'Privately, what is in my diary?', options: {
      tools: ['Read', 'WebSearch'], persistSession: false, canUseTool: allow } }))
    assert.equal(msgs.at(-1).result, 'Done privately.')
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].local, true)
  assert.equal(calls[0].body.model, 'nemotron-nano-local')
  assert.deepEqual(calls[0].body.tools.map((t) => t.function.name), ['Read'])
})

test("once a tool brings back the owner's personal data, the rest of the turn is local, and the cloud never sees it later", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gnosis-'))
  writeFileSync(join(dir, 'note.txt'), 'call Asha on 98450 12345 about the launch')
  const { fetchImpl, calls } = routedApi(call('c1', 'Read', { file_path: join(dir, 'note.txt') }),
    say('Your note says to call Asha about the launch.'), say('You are welcome.'))
  await withFetch(fetchImpl, async () => {
    const session = query({ prompt: (async function* () {
      yield { message: { content: 'read my note.txt' } }
      yield { message: { content: 'thanks' } }
    })(), options: { tools: ['Read'], persistSession: false, canUseTool: allow } })
    const msgs = []
    for await (const m of session) {
      msgs.push(m)
      if (msgs.filter((x) => x.type === 'result').length === 2) break
    }
    session.close()
  })
  assert.deepEqual(calls.map((c) => c.local), [false, true, false])
  const later = JSON.stringify(calls[2].body.messages)
  assert.ok(!later.includes('98450'), 'the phone number reached the cloud')
  assert.ok(!later.includes('call Asha'), 'the private answer reached the cloud')
  assert.ok(later.includes('[private, kept on the laptop]'))
})

test('a file without personal data stays in the cloud (the owner: "rest all use cloud")', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gnosis-'))
  writeFileSync(join(dir, 'plan.txt'), 'launch on Friday')
  const { fetchImpl, calls } = routedApi(call('c1', 'Read', { file_path: join(dir, 'plan.txt') }), say('Friday.'))
  await withFetch(fetchImpl, async () => {
    await collect(query({ prompt: 'when is the launch in plan.txt?', options: { tools: ['Read'],
      persistSession: false, canUseTool: allow } }))
  })
  assert.deepEqual(calls.map((c) => c.local), [false, false])
})

// -- the owner's privacy rules (privacy.mjs) --------------------------------------------------

test('sensitive requests are local; everything else is cloud', async () => {
  const { sensitiveRequest } = await import('../bridge/privacy.mjs')
  for (const s of ["what's my wifi password?", "what's mom's number?", 'check my email', 'read my inbox',
    'what is my bank account number', 'my Aadhaar card', 'send it to asha@example.com', 'call 98450 12345',
    'keep this private', 'my PAN number', 'what medicines do I take', 'show my contacts'])
    assert.ok(sensitiveRequest(s), s)
  for (const s of ['what time is it?', 'play a cat video', 'weather in Hyderabad', 'open notepad',
    'what is 12 times 8', 'tell me a joke', 'pin this tab'])
    assert.equal(sensitiveRequest(s), null, s)
})

test('"private" sentences are kept; questions about private things are not', async () => {
  const { privateStatement } = await import('../bridge/privacy.mjs')
  assert.equal(privateStatement('Private: my wifi password is sunflower42'), 'my wifi password is sunflower42')
  assert.equal(privateStatement('my bank PIN is 4321, keep it private'), 'my bank PIN is 4321')
  assert.equal(privateStatement('Hey Gnosis, remember privately that Asha is 98450 12345'), 'that Asha is 98450 12345')
  assert.equal(privateStatement("what's my wifi password? it's private"), null)
  assert.equal(privateStatement('privately, what is my PIN?'), null)
  assert.equal(privateStatement('my wifi password is x'), null) // no "private": not kept by this rule
})

test('a private sentence is saved and recalled by code, with no model call; the cloud never sees it', async () => {
  const { createPrivateMemory } = await import('../bridge/privacy.mjs')
  const { privacyRules } = await import('../bridge/sdk.mjs')
  const memory = createPrivateMemory(join(mkdtempSync(join(tmpdir(), 'gnosis-')), 'private.json'))
  const privacy = privacyRules(undefined, memory)
  const { fetchImpl, calls } = routedApi(say('Noon.'))
  await withFetch(fetchImpl, async () => {
    const session = query({ prompt: (async function* () {
      yield { message: { content: '[Now: Sun]\nPrivate: my wifi password is sunflower42' } }
      yield { message: { content: "what's my wifi password?" } }
      yield { message: { content: 'what time is it?' } }
    })(), options: { persistSession: false, privacy } })
    const results = []
    for await (const m of session) {
      if (m.type === 'result') results.push(m.result)
      if (results.length === 3) break
    }
    session.close()
    assert.equal(results[0], "Got it. That's saved privately, on this laptop only.")
    assert.equal(results[1], 'You told me privately: your wifi password is sunflower42.')
  })
  assert.deepEqual(memory.all().map((m) => m.text), ['my wifi password is sunflower42'])
  assert.deepEqual(calls.map((c) => c.local), [false]) // Saving and recalling needed no model at all
  const cloud = JSON.stringify(calls[0].body)
  assert.ok(!cloud.includes('sunflower42'), 'the secret reached the cloud')
})

test("if the private model isn't running, Gnosis says so and nothing goes to the cloud", async () => {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    throw new TypeError('fetch failed')
  }
  await withFetch(fetchImpl, async () => {
    const msgs = await collect(query({ prompt: 'keep this private: what is my salary?', options: {
      includePartialMessages: true, persistSession: false } }))
    const result = msgs.at(-1)
    assert.equal(result.is_error, false)
    assert.match(result.result, /private model isn't running\. Nothing was sent to the cloud\./)
  })
  assert.ok(calls.every((u) => u.startsWith('http://127.0.0.1:8081')))
})

test('the on-device model gets its own short prompt, starting with "detailed thinking off"', async () => {
  const { fetchImpl, calls } = routedApi(say('Ninety percent.'))
  await withFetch(fetchImpl, async () => {
    await collect(query({ prompt: 'Privately, how full is my battery?', options: {
      systemPrompt: 'THE FULL PERSONA '.repeat(500), tools: ['PowerShell'], persistSession: false, canUseTool: allow } }))
  })
  const system = calls[0].body.messages[0].content
  assert.match(system, /^detailed thinking off\nYou are Gnosis/)
  assert.ok(!system.includes('THE FULL PERSONA'))
  assert.ok(system.length < 1400)
  assert.match(system, /EstimatedChargeRemaining/)
})

test('private recall: a memory answers only when it holds every telling word of the question', async () => {
  const { privateAnswer, privateSystem } = await Promise.all([import('../bridge/privacy.mjs'), import('../bridge/sdk.mjs')])
    .then(([a, b]) => ({ ...a, ...b }))
  const memories = [{ id: 1, text: 'my wifi password is sunflower42' }, { id: 2, text: "Asha's number is 98450 12345" }]
  assert.equal(privateAnswer("what's my wifi password?", memories), 'You told me privately: your wifi password is sunflower42.')
  assert.equal(privateAnswer("what is Asha's number", memories), "You told me privately: Asha's number is 98450 12345.")
  assert.equal(privateAnswer("what's my bank password?", memories), null)
  assert.equal(privateAnswer('what time is it?', memories), null)
  assert.equal(privateAnswer('hey gnosis', memories), null)
  // A question the code can't answer still gets the memories, on the laptop only
  const system = privateSystem({ localSystem: 'LOCAL', memory: { relevant: () => memories } }, 'anything')
  assert.match(system, /^LOCAL\nWhat the owner told you privately[\s\S]*- my wifi password is sunflower42/)
})
