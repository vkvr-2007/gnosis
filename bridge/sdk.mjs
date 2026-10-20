/**
 * Gnosis's brain engine: Nemotron, behind the Claude Agent SDK's interface.
 *
 * AYRA ran on Claude Code through the Claude Agent SDK. Gnosis runs on NVIDIA
 * Nemotron (the project's model), so this module stands in for the three
 * things the bridge imported from the SDK:
 *
 *   tool(name, description, zodShape, handler)  — a tool definition (unchanged shape)
 *   createSdkMcpServer({ name, tools })           — a named group of tools
 *   query({ prompt, options })                    — one conversation: an agent loop
 *
 * query() speaks the SDK's message protocol (system init, stream_event text and
 * tool_use starts, assistant, user tool_result, result), so brain.mjs, the
 * gate, the approvals and every tool work exactly as they did. Underneath, it
 * calls an OpenAI-compatible chat API with function tools, streams the answer,
 * asks `canUseTool` before every call (the gate and the owner's approvals),
 * runs the tool here, and loops until the model answers without a tool.
 *
 * The built-ins Claude Code used to provide (PowerShell, files, web search and
 * pages) are in builtins.mjs; the model is configured in models.mjs.
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { z } from 'zod'
import { BUILTINS } from './builtins.mjs'
import { loadModels, modelFor } from './models.mjs'
import { IDENTITY } from './identity.mjs'
import { createMemory } from './memory.mjs'
import { createPrivateMemory, findPII, privateAnswer, privateStatement, sensitiveRequest } from './privacy.mjs'
import { dataDir } from './paths.mjs'

// ---- tools -------------------------------------------------------------------------

/** Same signature as the SDK's tool(). */
export function tool(name, description, inputSchema, handler, extras = {}) {
  return { name, description, inputSchema, handler, ...extras }
}

/** Same signature as the SDK's createSdkMcpServer(); the tools stay in-process. */
export function createSdkMcpServer({ name, version = '1.0.0', instructions, tools = [] }) {
  // `instance._registeredTools` is where the SDK's own server kept them; tests read it there.
  return { type: 'sdk', name, version, instructions, tools,
           instance: { _registeredTools: Object.fromEntries(tools.map((t) => [t.name, t])) } }
}

const jsonSchemaOf = (shape) => {
  try {
    const { $schema, ...schema } = z.toJSONSchema(z.object(shape ?? {}), { io: 'input', unrepresentable: 'any' })
    return schema
  } catch {
    return { type: 'object', properties: {} }
  }
}

/**
 * How a picture a tool brought back is put into words for the brain (vision.mjs describeImages, set by
 * server.mjs): (result, request, { signal }) → result. Without it a picture stays a note.
 */
let describeImages = null
export function useImageDescriber(fn) {
  describeImages = fn
}

/** A CallToolResult's content as text for the model; images become a note (Nemotron reads text). */
function contentText(result) {
  if (result == null) return ''
  if (typeof result === 'string') return result
  const blocks = Array.isArray(result.content) ? result.content : []
  return blocks.map((b) => (b?.type === 'text' ? b.text : b?.type === 'image' ? '[an image, shown on screen]' : ''))
    .filter(Boolean).join('\n')
}

/**
 * Everything the model can call in one conversation: { name → { description, parameters, call } }.
 * MCP tools are named mcp__<server key>__<tool>, exactly as Claude Code named them, which is what
 * gate.mjs and the rest of the bridge expect.
 */
export function collectTools({ mcpServers = {}, tools: builtins = [], disallowedTools = [] }) {
  const out = new Map()
  const blocked = new Set(disallowedTools)
  for (const name of builtins) {
    const b = BUILTINS[name]
    if (b && !blocked.has(name)) {
      out.set(name, { description: b.description, parameters: b.schema, call: (input, ctx) => b.run(input, ctx) })
    }
  }
  for (const [key, server] of Object.entries(mcpServers)) {
    if (server?.type !== 'sdk' || !Array.isArray(server.tools)) {
      console.warn(`[gnosis] MCP server "${key}" isn't an in-process one; its tools are not available`)
      continue
    }
    if (blocked.has(`mcp__${key}`)) continue
    for (const t of server.tools) {
      const name = `mcp__${key}__${t.name}`
      if (blocked.has(name)) continue
      const parse = z.object(t.inputSchema ?? {})
      out.set(name, {
        description: t.description,
        parameters: jsonSchemaOf(t.inputSchema),
        call: async (input) => {
          const args = parse.safeParse(input ?? {})
          if (!args.success) return { text: `Invalid arguments: ${args.error.message}`, isError: true }
          const result = await t.handler(args.data, {})
          return { text: contentText(result), isError: result?.isError === true, raw: result }
        },
      })
    }
  }
  return out
}

// ---- sessions ------------------------------------------------------------------------

const SESSIONS = dataDir('sessions')

function loadSession(id) {
  const file = `${SESSIONS}${id}.json`
  if (!/^[\w-]+$/.test(id) || !existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function saveSession(id, messages) {
  mkdirSync(SESSIONS, { recursive: true })
  // The last 40 messages: enough to carry the conversation on, not an ever-growing prompt.
  writeFileSync(`${SESSIONS}${id}.json`, JSON.stringify(messages.slice(-40)))
}

// ---- the model -------------------------------------------------------------------------

/**
 * The answer without reasoning: some models still wrap thinking in <think>…</think> even with it
 * turned off, and it must never be spoken. An unclosed block hides everything after it, and a tag
 * that has only half arrived ("<thi") is held back until it's complete.
 */
export function visibleText(raw) {
  let out = raw.replace(/<think>[\s\S]*?<\/think>\s*/g, '')
  const open = out.indexOf('<think>')
  if (open >= 0) out = out.slice(0, open)
  const partial = /<(?:t(?:h(?:i(?:n(?:k)?)?)?)?)?$/.exec(out)
  return partial ? out.slice(0, partial.index) : out
}

/**
 * One streamed chat completion. Calls onText for each piece of answer text and onToolStart the first
 * time each tool call appears, and resolves with { text, toolCalls, usage }.
 */
export async function streamChat(opts) {
  // A network blip (Wi-Fi dropping, the laptop just woken) or a busy server: tried again, a few
  // seconds apart, but only while nothing has been said or started, so no reply is ever doubled.
  // Seen 2026-10-19: the laptop slept mid-request and the turn ended in "fetch failed".
  let started = false
  const onText = opts.onText && ((piece) => ((started = true), opts.onText(piece)))
  const onToolStart = opts.onToolStart && ((call) => ((started = true), opts.onToolStart(call)))
  const waits = opts.retryWaits ?? RETRY_WAITS
  // The model itself, then its backups (config/models.json "fallbacks") when it is unavailable.
  const models = [opts.route.model, ...(opts.route.fallbacks ?? [])]
  for (const [i, model] of models.entries()) {
    const route = i ? { ...opts.route, model } : opts.route
    for (let attempt = 0; ; attempt++) {
      try {
        const out = await streamOnce({ ...opts, route, onText, onToolStart })
        if (i) console.warn(`[gnosis] answered with the backup model ${model}`)
        return out
      } catch (err) {
        if (started || opts.signal?.aborted) throw err
        // Not there at all (404, 410): straight to the next model. Busy or down: a couple of retries first.
        const gone = err?.status === 404 || err?.status === 410
        const last = i === models.length - 1
        if (!gone && attempt < waits.length && retryable(err)) {
          console.warn(`[gnosis] model call failed (${err?.message ?? err}); trying again in ${waits[attempt] / 1000} s`)
          await new Promise((r) => setTimeout(r, waits[attempt]))
          continue
        }
        if (last || !(gone || retryable(err))) throw err
        console.warn(`[gnosis] ${model} is unavailable (${String(err?.message ?? err).slice(0, 80)}); trying ${models[i + 1]}`)
        break
      }
    }
  }
}

const RETRY_WAITS = [2000, 6000]
/** How long to wait for the model to start answering, and for the next piece once it has. */
export const STREAM_TIMEOUTS = { connect: 45_000, stall: 60_000 }

/** Worth another try: no connection, a dropped one, a stall, or the server busy or briefly down. */
export function retryable(err) {
  if ([408, 429, 500, 502, 503, 504].includes(err?.status)) return true
  const text = `${err?.name ?? ''} ${err?.message ?? ''} ${err?.cause?.code ?? ''}`
  return /fetch failed|network|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|terminated|stalled|didn't start answering/i.test(text)
}

async function streamOnce({ route, messages, tools, signal, onText, onToolStart, toolChoice = 'auto', fetchImpl = fetch, timeouts = STREAM_TIMEOUTS }) {
  // Our own stop for a stall, alongside the owner's (Esc).
  const watchdog = new AbortController()
  let why = null
  let timer = setTimeout(() => {
    why = "The model didn't start answering in time."
    watchdog.abort()
  }, timeouts.connect)
  const both = signal ? AbortSignal.any([signal, watchdog.signal]) : watchdog.signal
  const failed = (err) => {
    if (why && !signal?.aborted) return Object.assign(new Error(why), { stalled: true })
    return err
  }
  try {
    return await streamWith({ route, messages, tools, signal: both, onText, onToolStart, toolChoice, fetchImpl,
      // Each piece that arrives resets the clock.
      alive: () => {
        clearTimeout(timer)
        timer = setTimeout(() => {
          why = 'The model stalled mid-answer.'
          watchdog.abort()
        }, timeouts.stall)
      } })
  } catch (err) {
    throw failed(err)
  } finally {
    clearTimeout(timer)
  }
}

async function streamWith({ route, messages, tools, signal, onText, onToolStart, toolChoice, fetchImpl, alive }) {
  const body = {
    model: route.model,
    messages,
    stream: true,
    ...(tools.length ? { tools, tool_choice: toolChoice } : {}),
    ...(route.temperature != null ? { temperature: route.temperature } : {}),
    ...(route.extraBody ?? {}),
  }
  const res = await fetchImpl(`${route.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(route.apiKey ? { Authorization: `Bearer ${route.apiKey}` } : {}) },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    const err = new Error(`API Error: ${res.status} ${detail.slice(0, 300)}`)
    err.status = res.status
    throw err
  }
  alive()
  let text = ''
  let raw = ''
  const calls = []
  const reader = res.body.getReader()
  // A stop (Esc, or the stall watchdog) ends a read that is waiting, whatever the stream does.
  const stop = () => reader.cancel().catch(() => {})
  signal?.addEventListener('abort', stop, { once: true })
  const decoder = new TextDecoder()
  let buffer = ''
  let usage = null
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    alive()
    buffer += decoder.decode(value, { stream: true })
    let nl
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') continue
      let chunk
      try {
        chunk = JSON.parse(data)
      } catch {
        continue
      }
      if (chunk.usage) usage = chunk.usage
      const delta = chunk.choices?.[0]?.delta
      if (!delta) continue
      if (typeof delta.content === 'string' && delta.content) {
        raw += delta.content
        const visible = visibleText(raw)
        if (visible.length > text.length && visible.startsWith(text)) {
          const piece = visible.slice(text.length)
          text = visible
          onText?.(piece)
        }
      }
      for (const tc of delta.tool_calls ?? []) {
        const i = tc.index ?? 0
        const call = (calls[i] ??= { id: '', name: '', arguments: '' })
        if (tc.id) call.id = tc.id
        if (tc.function?.name) call.name += tc.function.name
        if (tc.function?.arguments) call.arguments += tc.function.arguments
        if (call.name && call.id && !call.announced) {
          call.announced = true
          onToolStart?.(call)
        }
      }
    }
  }
  signal?.removeEventListener('abort', stop)
  if (signal?.aborted) throw Object.assign(new Error('The model call was stopped.'), { name: 'AbortError' })
  calls.forEach((c, i) => {
    c.id ||= `call_${i}_${randomUUID().slice(0, 8)}`
    if (!c.announced && c.name) onToolStart?.(c)
  })
  return { text, toolCalls: calls.filter((c) => c.name), usage }
}

// ---- the claim check (from Gnosis v2) -------------------------------------------------------

/**
 * A request that asks Gnosis to do something. Answered with no tool run — "Opening Notepad now…",
 * "Notepad closed.", "Playing now. Enjoy!" — nothing was done, whatever the wording (seen again and
 * again with Nemotron in v2's acceptance runs, 2026-10-17/18). "remember" too: memory.mjs saves only through its tool.
 */
export const ASKS_ACTION = new RegExp(
  String.raw`^\W*(?:(?:hey\s+|ok(?:ay)?\s+)?g?nosis\W+)?(?:(?:please|can you|could you|would you|will you|now)\W+)*` +
  String.raw`(?:open|close|type|play|pause|resume|launch|remind|set|send|save|delete|remove|schedule|cancel|turn|` +
  String.raw`click|press|switch|focus|minimi[sz]e|maximi[sz]e|go to|search|find|run|start|stop|mute|unmute|remember|forget|note down|look|watch me|learn|teach|let me show)\b`,
  'i')

/**
 * A question only a tool can answer: the owner's phone, their reminders, what's on the screen. Asked
 * "is my phone connected?" with no phone ever paired, Nemotron answered "It is connected. Battery is
 * 36%." with no tool run, and "what's my laptop battery?" got a made-up 73% (it was 100%), 2026-10-19:
 * these are held for a tool like an action is.
 */
export const ASKS_LIVE = /\b(?:my|the) phone(?:'s)?\b|\bphone (?:battery|notifications?)\b|\bwhat(?:'s| is) on (?:my|the) screen\b|\b(?:my|any) reminders?\b|\b(?:battery|charging|disk space|free space|storage|cpu|ram|memory usage|wi-?fi|volume|brightness)\b/i

/**
 * More requests that need a tool, depending on what is going on: a tool server adds one (teach.mjs:
 * "done" while it is watching). Asked "watch me" and then "done", Nemotron said it was watching and
 * then that it had stopped, with no tool run either time (2026-10-19).
 */
export const ACTION_HINTS = []

/**
 * What the owner actually said, without the notes the bridge puts in front of a request for the brain
 * ("[Voice ID: …]", "[The owner attached …]", a finished job's note): only that is kept in their history.
 */
export function ownWords(request) {
  const text = String(request)
  if (!text.startsWith('[')) return text
  const end = text.lastIndexOf(']\n')
  return end >= 0 ? text.slice(end + 2).trim() || text : text
}

/** A reply that says it is about to do something rather than doing it. */
export const PROMISES = /^\W*(?:(?:sure|okay|ok|got it|on it)\W+)?(?:i['’]?ll|i will|let me|i['’]?m going to|fetching|checking|looking (?:that )?up|one moment|give me a (?:sec|second|moment))\b/i

export const CLAIM_CHECK = (request) =>
  '[Gnosis check] Your reply says or implies the request was done, but no tool has run in this turn, so ' +
  `nothing was done. The request is: ${request}\nIf it asks for an action, call the tool for it now. ` +
  "Otherwise answer it without claiming an action. Don't reply to this check itself."

/** The owner's own words in a message: without the bridge's [Now: …] stamp and [Depth …] line. */
export const requestText = (content) =>
  String(content ?? '').split('\n').filter((l) => !/^\[(?:Now|Depth)\b/.test(l)).join('\n').trim()

// ---- private work ------------------------------------------------------------------------

/**
 * What counts as private, from config/models.json "private": words in a request that ask for it, and
 * tools whose output is the owner's own data (their files, the text of their windows). Private work
 * runs on the on-device model ("local" role) with its short list of tools.
 */
export function privacyRules(cfg = loadModels(), memory = createPrivateMemory()) {
  const p = cfg.private ?? {}
  return {
    // Why a request is private (privacy.mjs: sensitive words, personal data, "private"), or null.
    why: (request) => sensitiveRequest(request),
    // Tools that read the owner's own data: what they bring back is checked for personal data.
    tools: new Set(p.tools ?? []),
    memory,
    localTools: new Set(cfg.roles.local?.tools ?? []),
    localRoute: modelFor('local', cfg),
    localSystem: localSystemPrompt(IDENTITY.name, cfg.roles.local?.systemPrefix),
  }
}

export const PRIVATE_NOTE = '[private, kept on the laptop]'

/**
 * The on-device model's own short system prompt. The full persona is about 3,000 words; with the tools
 * it made a 5,163-token prompt that the laptop's integrated GPU gave up on ("Vulkan device lost",
 * 2026-10-18). Nemotron Nano also needs "detailed thinking off" first, or it reasons at length.
 */
export function localSystemPrompt(name, prefix = 'detailed thinking off') {
  return `${prefix}\nYou are ${name}, a personal assistant speaking out loud to the one person you work for, ` +
    'on their Windows laptop. This request is private, so you are running on the laptop itself. ' +
    'Answer in one or two short spoken sentences, plain words, no markdown. Use a tool for anything about ' +
    "the laptop or their files; never guess and never say you did something you didn't. " +
    "Each message starts with [Now: …], the local time: use it, don't read it out.\n" +
    // A 4B model uses tools far more reliably with the exact command in front of it: without these it
    // told the owner how to check the battery instead of checking it (2026-10-18).
    'You CAN run commands on this laptop with the PowerShell tool. Examples:\n' +
    '- battery: (Get-CimInstance Win32_Battery).EstimatedChargeRemaining\n' +
    '- free disk space: Get-PSDrive C | Select-Object Used,Free\n' +
    '- running apps: Get-Process | Where-Object MainWindowTitle | Select-Object Name,MainWindowTitle\n' +
    '- open an app: Start-Process notepad\n' +
    'Run the command, then say the result in a sentence.'
}

/**
 * After a private turn, what the cloud model could later see of it is blanked: the owner's words (they
 * may hold the secret itself), tool output, and Gnosis's own replies (which may quote it).
 */
export function redactTurn(history, from) {
  for (let i = Math.max(from, 0); i < history.length; i++) {
    const m = history[i]
    if (m.role === 'tool' || m.role === 'user' || (m.role === 'assistant' && m.content)) history[i] = { ...m, content: PRIVATE_NOTE }
  }
}

/** The on-device model's prompt for one private turn: its own short prompt, and what it may recall. */
export function privateSystem(privacy, request) {
  const memories = privacy.memory.relevant(request)
  if (!memories.length) return privacy.localSystem
  return `${privacy.localSystem}\nWhat the owner told you privately (it is on this laptop only; use it to answer, ` +
    `and say it only when they ask for it):\n${memories.map((m) => `- ${m.text}`).join('\n')}`
}

// ---- memory -----------------------------------------------------------------------------

let sharedMemory = null
const defaultMemory = () => (sharedMemory ??= createMemory())

/** The system prompt with what Gnosis remembers that bears on this request, if anything. */
export const withMemory = (system, recall) => (recall ? `${system}\n\n${recall}` : system)

// ---- query() ----------------------------------------------------------------------------

/** The SDK's query(): an async iterable of SDK messages, plus interrupt() and close(). */
export function query({ prompt, options = {} }) {
  const {
    systemPrompt = '', model, maxTurns = 24, includePartialMessages = false, canUseTool,
    resume, persistSession = true, abortController, outputFormat, cwd = homedir(),
  } = options
  const cloudRoute = modelFor(model)
  const privacy = options.privacy ?? privacyRules() // options.privacy: tests give their own memory
  // Long-term memory (memory.mjs) for the owner's own conversations: the brain gives them the memory
  // server. Research agents and other one-off sessions don't recall or record anything.
  const memory = options.memory ?? (options.mcpServers?.ayra_memory ? defaultMemory() : null)
  const toolset = collectTools(options)
  const defOf = ([name, t]) => ({
    type: 'function', function: { name, description: String(t.description ?? '').slice(0, 1024), parameters: t.parameters },
  })
  const toolDefs = [...toolset].map(defOf)
  // The small on-device model gets only the everyday tools: every schema costs it time and accuracy.
  const localToolDefs = [...toolset].filter(([name]) => privacy.localTools.has(name)).map(defOf)
  const sessionId = resume && loadSession(resume) ? resume : randomUUID()
  let history = (resume && loadSession(resume)) || []
  const system = outputFormat?.type === 'json_schema'
    ? `${systemPrompt}\n\nReply with only a JSON value matching this schema, no other text:\n${JSON.stringify(outputFormat.schema)}`
    : systemPrompt

  const queue = []
  let wake = null
  let finished = false
  let turnAbort = null
  const push = (msg) => {
    queue.push(msg)
    wake?.()
    wake = null
  }
  const outerAbort = abortController?.signal

  async function runTurn(userContent) {
    history.push({ role: 'user', content: userContent })
    turnAbort = new AbortController()
    const signal = AbortSignal.any([turnAbort.signal, ...(outerAbort ? [outerAbort] : [])])
    let answer = ''
    let turns = 0
    const request = requestText(userContent)
    const asksAction = toolDefs.length > 0 && (ASKS_ACTION.test(request) || ASKS_LIVE.test(request) || ACTION_HINTS.some((h) => h(request)))
    let acted = false
    let checked = false
    // Private (privacy.mjs): a sensitive request, or once a tool has brought back the owner's personal
    // data. From then on this turn thinks on the laptop, and nothing from it is sent to the cloud later.
    const why = privacy.why(request)
    let isPrivate = Boolean(why)
    const turnStart = history.length - 1
    const goPrivate = (reason) => {
      if (!isPrivate) console.log(`[gnosis] private from here on (${reason}): thinking on the laptop`)
      isPrivate = true
    }
    if (isPrivate) console.log(`[gnosis] a private request (${why}): thinking on the laptop`)
    try {
      // "Private: my wifi password is …" — kept by code, never shown to any model, and said back plainly.
      const keep = isPrivate ? privateStatement(request) : null
      // …and a question it answers is answered from there, by code, whether or not it looked sensitive.
      const recalled = keep ? null : privateAnswer(request, privacy.memory.all())
      if (keep) {
        privacy.memory.add(keep)
        console.log('[gnosis] kept a private memory on the laptop')
        answer = "Got it. That's saved privately, on this laptop only."
      } else if (recalled) {
        goPrivate('answered from the private memory')
        answer = recalled
      }
      if (keep || recalled) {
        if (includePartialMessages) {
          push({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: answer } } })
        }
        history.push({ role: 'assistant', content: answer })
      }
      for (; !keep && !recalled;) {
        if (++turns > maxTurns) {
          push({ type: 'result', subtype: 'error_max_turns', session_id: sessionId, is_error: true })
          return
        }
        const route = isPrivate ? privacy.localRoute : cloudRoute
        const tools = isPrivate ? localToolDefs : toolDefs
        let text = ''
        // An action asked for and nothing done yet: the reply is held back until it's clear a tool runs,
        // because what streams is spoken at once and a false "Done!" can't be taken back.
        const hold = asksAction && !acted && !checked
        let toolCalls
        try {
          ({ toolCalls } = await streamChat({
          route,
          messages: [{ role: 'system', content: withMemory(route.onDevice ? privateSystem(privacy, request) : system,
            memory?.recallText(request, { includeSensitive: route.onDevice, actionRequest: asksAction })) }, ...history],
          tools,
          // After the claim check's nudge the model must call a tool: with the full persona and some
          // fifty tools, Nemotron answered "Remind me in 1 minute…" in words twice (2026-10-18).
          toolChoice: checked && !acted ? 'required' : 'auto',
          signal,
          onText: (delta) => {
            text += delta
            if (includePartialMessages && !hold) {
              push({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: delta } } })
            }
          },
          onToolStart: (call) => {
            if (includePartialMessages) {
              push({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} } } })
            }
          },
          }))
        } catch (err) {
          if (!route.onDevice || err?.name === 'AbortError' || signal.aborted) throw err
          // Never the cloud instead: private stays private, so the owner is told plainly.
          console.warn(`[gnosis] the private model isn't reachable: ${err?.message ?? err}`)
          answer = "That one's private, so I'd think about it on the laptop, but my private model isn't running. " +
            'Nothing was sent to the cloud.'
          if (includePartialMessages) {
            push({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: answer } } })
          }
          history.push({ role: 'assistant', content: answer })
          break
        }
        const inputs = toolCalls.map((c) => {
          try {
            return JSON.parse(c.arguments || '{}')
          } catch {
            return null
          }
        })
        // A reply that only promises ("I'll check your reminders. Fetching…") with nothing run, to any
        // request: the same nudge. (Its words were already shown; the real answer follows.)
        const promised = !hold && !toolCalls.length && !acted && !checked && tools.length > 0 && PROMISES.test(text)
        if ((hold || promised) && !toolCalls.length) {
          // Answered an action with words alone: one nudge, and the held reply is never shown or spoken.
          checked = true
          console.log(`[gnosis] claim check: "${request.slice(0, 80)}" was answered without a tool`)
          history.push({ role: 'assistant', content: text || '(no reply)' },
            { role: 'user', content: CLAIM_CHECK(request) })
          continue
        }
        if (hold && text && includePartialMessages) {
          // Held text that came with a tool call: the tool is running, so it can go out now.
          push({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } })
        }
        if (toolCalls.length) acted = true
        push({ type: 'assistant', message: { role: 'assistant', content: [
          ...(text ? [{ type: 'text', text }] : []),
          ...toolCalls.map((c, i) => ({ type: 'tool_use', id: c.id, name: c.name, input: inputs[i] ?? {} })),
        ] }, session_id: sessionId })
        history.push({ role: 'assistant', content: text || null,
          ...(toolCalls.length ? { tool_calls: toolCalls.map((c) => ({ id: c.id, type: 'function',
            function: { name: c.name, arguments: c.arguments || '{}' } })) } : {}) })
        if (!toolCalls.length) {
          answer = text
          break
        }
        for (const [i, call] of toolCalls.entries()) {
          if (signal.aborted) throw new DOMException('Interrupted', 'AbortError')
          let result = await runTool(call, inputs[i], signal)
          // A picture goes to the vision model and comes back as words, never on a private turn.
          if (describeImages && !isPrivate && !result.isError) result = await describeImages(result, request, { signal })
          history.push({ role: 'tool', tool_call_id: call.id, content: result.text || '(no output)' })
          if (privacy.tools.has(call.name) && !result.isError) {
            const found = findPII(result.text)
            if (found.length) goPrivate(`${call.name} brought back ${found.join(' and ')}`)
          }
          push({
            type: 'user',
            message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: result.text, is_error: result.isError === true }] },
            ...(result.structured ? { tool_use_result: result.structured } : {}),
            session_id: sessionId,
          })
        }
      }
      if (isPrivate) redactTurn(history, turnStart)
      // The exchange, as a line of history for later recall: never a private one.
      else if (memory && answer && !keep && !recalled) {
        try {
          memory.addEpisode(ownWords(request), answer)
        } catch (err) {
          console.warn('[gnosis] could not save the exchange to memory:', err?.message ?? err)
        }
      }
      if (persistSession) saveSession(sessionId, history)
      const done = { type: 'result', subtype: 'success', is_error: false, result: answer, session_id: sessionId,
                     total_cost_usd: null }
      if (outputFormat?.type === 'json_schema') {
        const json = /[[{][\s\S]*[\]}]/.exec(answer)?.[0]
        try {
          done.structured_output = JSON.parse(json)
        } catch {
          done.subtype = 'error_max_structured_output_retries'
          done.is_error = true
        }
      }
      push(done)
    } catch (err) {
      if (err?.name === 'AbortError' || signal.aborted) {
        // Interrupted: what was said so far stays in the conversation, the turn ends.
        if (isPrivate) redactTurn(history, turnStart)
        if (persistSession) saveSession(sessionId, history)
        push({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: sessionId })
        return
      }
      console.error('[gnosis] model call failed:', err?.message ?? err)
      // brain.mjs reads an API failure as a 'success' result with is_error set and the error as text.
      push({ type: 'result', subtype: 'success', is_error: true, result: String(err?.message ?? err), session_id: sessionId })
    } finally {
      turnAbort = null
    }
  }

  async function runTool(call, input, signal) {
    const t = toolset.get(call.name)
    if (!t) return { text: `There is no tool called ${call.name}.`, isError: true }
    if (input == null) return { text: 'The arguments were not valid JSON. Try again.', isError: true }
    if (canUseTool) {
      const verdict = await canUseTool(call.name, input, { signal })
      if (verdict?.behavior !== 'allow') return { text: verdict?.message ?? 'Not allowed.', isError: true }
      input = verdict.updatedInput ?? input
    }
    try {
      return await t.call(input, { signal, cwd })
    } catch (err) {
      if (err?.name === 'AbortError') throw err
      return { text: `${err?.name ?? 'Error'}: ${err?.message ?? err}`, isError: true }
    }
  }

  async function main() {
    push({ type: 'system', subtype: 'init', session_id: sessionId, model: cloudRoute.model,
           tools: [...toolset.keys()],
           mcp_servers: Object.keys(options.mcpServers ?? {}).map((name) => ({ name, status: 'connected' })) })
    try {
      if (typeof prompt === 'string') {
        await runTurn(prompt)
      } else {
        for await (const msg of prompt) {
          if (finished) break
          const content = msg?.message?.content
          await runTurn(typeof content === 'string' ? content
            : Array.isArray(content) ? content.map((b) => b?.text ?? '').join('\n') : String(content ?? ''))
        }
      }
    } finally {
      finished = true
      wake?.()
    }
  }
  void main()

  return {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (queue.length) {
          yield queue.shift()
          continue
        }
        if (finished) return
        await new Promise((r) => (wake = r))
      }
    },
    async interrupt() {
      turnAbort?.abort()
    },
    close() {
      finished = true
      turnAbort?.abort()
      wake?.()
    },
  }
}
