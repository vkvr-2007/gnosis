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
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { BUILTINS } from './builtins.mjs'
import { modelFor } from './models.mjs'

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

const SESSIONS = fileURLToPath(new URL('../data/sessions/', import.meta.url))

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
export async function streamChat({ route, messages, tools, signal, onText, onToolStart, fetchImpl = fetch }) {
  const body = {
    model: route.model,
    messages,
    stream: true,
    ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
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
  let text = ''
  let raw = ''
  const calls = []
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let usage = null
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
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
 * again with Nemotron in v2's acceptance runs, 2026-10-17/18). Not "remember": memory works by itself.
 */
export const ASKS_ACTION = new RegExp(
  String.raw`^\W*(?:(?:hey\s+|ok(?:ay)?\s+)?g?nosis\W+)?(?:(?:please|can you|could you|would you|will you|now)\W+)*` +
  String.raw`(?:open|close|type|play|pause|resume|launch|remind|set|send|save|delete|remove|schedule|cancel|turn|` +
  String.raw`click|press|switch|focus|minimi[sz]e|maximi[sz]e|go to|search|find|run|start|stop|mute|unmute)\b`,
  'i')

export const CLAIM_CHECK = (request) =>
  '[Gnosis check] Your reply says or implies the request was done, but no tool has run in this turn, so ' +
  `nothing was done. The request is: ${request}\nIf it asks for an action, call the tool for it now. ` +
  "Otherwise answer it without claiming an action. Don't reply to this check itself."

/** The owner's own words in a message: without the bridge's [Now: …] stamp and [Depth …] line. */
export const requestText = (content) =>
  String(content ?? '').split('\n').filter((l) => !/^\[(?:Now|Depth)\b/.test(l)).join('\n').trim()

// ---- query() ----------------------------------------------------------------------------

/** The SDK's query(): an async iterable of SDK messages, plus interrupt() and close(). */
export function query({ prompt, options = {} }) {
  const {
    systemPrompt = '', model, maxTurns = 24, includePartialMessages = false, canUseTool,
    resume, persistSession = true, abortController, outputFormat, cwd = homedir(),
  } = options
  const route = modelFor(model)
  const toolset = collectTools(options)
  const toolDefs = [...toolset].map(([name, t]) => ({
    type: 'function', function: { name, description: String(t.description ?? '').slice(0, 1024), parameters: t.parameters },
  }))
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
    const asksAction = toolDefs.length > 0 && ASKS_ACTION.test(request)
    let acted = false
    let checked = false
    try {
      for (;;) {
        if (++turns > maxTurns) {
          push({ type: 'result', subtype: 'error_max_turns', session_id: sessionId, is_error: true })
          return
        }
        let text = ''
        // An action asked for and nothing done yet: the reply is held back until it's clear a tool runs,
        // because what streams is spoken at once and a false "Done!" can't be taken back.
        const hold = asksAction && !acted && !checked
        const { toolCalls } = await streamChat({
          route,
          messages: [{ role: 'system', content: system }, ...history],
          tools: toolDefs,
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
        })
        const inputs = toolCalls.map((c) => {
          try {
            return JSON.parse(c.arguments || '{}')
          } catch {
            return null
          }
        })
        if (hold && !toolCalls.length) {
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
          const result = await runTool(call, inputs[i], signal)
          history.push({ role: 'tool', tool_call_id: call.id, content: result.text || '(no output)' })
          push({
            type: 'user',
            message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: result.text, is_error: result.isError === true }] },
            ...(result.structured ? { tool_use_result: result.structured } : {}),
            session_id: sessionId,
          })
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
    push({ type: 'system', subtype: 'init', session_id: sessionId, model: route.model,
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
