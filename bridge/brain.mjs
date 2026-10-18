/**
 * AYRA's brain, independent of how the owner is talking to it.
 *
 * One conversation is one Claude Agent SDK session: a long-lived query() fed
 * by an input generator, so the model keeps the whole exchange in context.
 * A channel — the HUD's WebSocket today, Telegram next — opens a
 * conversation, pushes questions in, and receives a small set of events:
 *
 *   { type: 'ready', servers }            servers this session can use
 *   { type: 'text', delta, ask }          answer text, as it streams
 *   { type: 'tool', name, ask }           a tool that actually ran
 *   { type: 'sources', query, links, text, ask }  a web search's links and result text
 *   { type: 'fetched', url, text, ask }   a page WebFetch read
 *   { type: 'done', text, costUsd, ask }  the turn finished
 *   { type: 'error', message, ask }       a plain sentence, safe to speak
 *
 * `ask` echoes the id the channel gave the question. Everything a channel
 * adds of its own — the HUD's display tools — comes in through `servers` when
 * the conversation is opened.
 *
 * The channel ranks each question from the owner's own words (triage.mjs) and
 * passes the rank with it; a complex one gets the ranker's depth line in front,
 * and `turn()` tells the research tool which question, in whose words, it is
 * working for.
 *
 * A conversation sleeps when idle: after `sleepMinutes` with no question its
 * Claude process is closed (a few hundred MB back on the owner's laptop) and
 * the next question wakes it on the same conversation — the SDK keeps the
 * transcript on disk — for a second or two once.
 */

import { query } from './sdk.mjs'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { IDENTITY, env } from './identity.mjs'
import { stamp } from './context.mjs'
import { createStore } from './state.mjs'
import { clip, createAudit } from './audit.mjs'
import { searchSources } from './sources.mjs'
import { depthHint } from './triage.mjs'

/**
 * The user message for one question: the local-time stamp (context.mjs) and,
 * only for a question the channel ranked complex, the ranker's depth line in
 * front of it. Anything else is sent exactly as it was before ranking existed,
 * so the simple path costs nothing new — not even tokens.
 */
export function composeMessage(text, rank, now = new Date()) {
  const hint = depthHint(rank)
  return hint ? `${hint}\n${stamp(text, now)}` : stamp(text, now)
}

/**
 * How much of a web tool's result the channel is handed. Enough for the server
 * to check a figure on screen against what the search or page really said
 * (show_data), small enough that a long page doesn't sit in memory per turn.
 */
export const RESULT_TEXT_MAX = 20_000

/** A tool_result's content as one string: it comes as a string or as blocks. */
export function resultText(content) {
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((b) => (typeof b?.text === 'string' ? b.text : '')).filter(Boolean).join('\n')
      : ''
  return text.length > RESULT_TEXT_MAX ? text.slice(0, RESULT_TEXT_MAX) : text
}

/**
 * What a finished web tool tells the channel, or null.
 *
 *   WebSearch → { type: 'sources', query, links, text } — links from the
 *               result itself (sources.mjs), never from the model's prose
 *   WebFetch  → { type: 'fetched', url, text } — only a page that really came
 *               back: a refusal, an error or a redirect to another host is not
 *               a source
 *
 * The page's URL is the one the model asked for (the tool_use input), which is
 * what it will name again later; the SDK's structured result is the fallback.
 *
 * @param {{ name?: string, input?: object, block: object, structured?: object | null }} result
 */
export function webResultEvent({ name, input, block, structured = null }) {
  if (!block || block.is_error === true) return null
  if (name === 'WebSearch') {
    const sources = searchSources(structured, block.content)
    return sources ? { type: 'sources', ...sources, text: resultText(block.content) } : null
  }
  if (name === 'WebFetch') {
    const code = Number(structured?.code)
    if (structured?.code != null && !(code >= 200 && code < 300)) return null
    const url = typeof input?.url === 'string' && input.url.trim()
      ? input.url.trim()
      : typeof structured?.url === 'string' ? structured.url.trim() : ''
    if (!/^https?:\/\//i.test(url)) return null
    const text = resultText(block.content) || resultText(typeof structured?.result === 'string' ? structured.result : '')
    return { type: 'fetched', url, text }
  }
  return null
}

/**
 * What to tell the channel when a turn ends badly. Plain sentences, because
 * whatever reaches the client is liable to be spoken.
 */
/**
 * The owner's Claude limit, said plainly. AYRA runs on the owner's own Pro
 * login, so a long working session elsewhere can use it up; "the model could not
 * be reached" (2026-10-11) sent them looking for a fault that wasn't there.
 */
export function usageLimit(result) {
  const text = String(result ?? '')
  if (!/(?:session|weekly|usage|rate) limit/i.test(text)) return null
  const when = /resets +([^(\n]+?) *(?:\(|$|\n)/i.exec(text)?.[1]?.trim()
  return when ? `${RESULT_FAILURES.limit} It resets at ${when}.` : RESULT_FAILURES.limit
}

const RESULT_FAILURES = {
  error_during_execution: 'The turn failed part way through.',
  error_max_turns: 'The turn ran too long and was stopped.',
  error_max_budget_usd: 'The budget for this turn ran out.',
  error_max_structured_output_retries: 'The answer could not be assembled.',
  api_error: 'The model could not be reached. The details are in the bridge log.',
  limit: 'My Claude usage limit is reached, so I can hear you but not think right now.',
  resume_failed: 'The previous conversation could not be restored. Ask me again.',
  interrupted: 'Stopped.',
  default: 'The turn ended without an answer.',
}

/**
 * A brief pause so the abandoned turn's frames are tagged with the OLD id
 * before the new one is adopted. Short, because correctness now comes from
 * the tag rather than from the wait — this only has to cover the gap, not
 * outlast the whole turn.
 */
const SETTLE_CAP_MS = 400

/**
 * @param {{ model: string, effort: string, gate: ReturnType<import('./gate.mjs').createGate>,
 *           mcpServers: Record<string, object>, store?: ReturnType<typeof createStore>,
 *           audit?: ReturnType<typeof createAudit>, resumeHours?: number,
 *           sleepMinutes?: number,
 *           approve?: (request: { channel: string, tool: string, reason: string, detail: string }) => Promise<boolean> }} config
 *   mcpServers   — the owner's own MCP servers, shared by every conversation
 *   store        — where each channel's last session id is kept (data/state.json)
 *   audit        — where every question, tool decision and answer is logged
 *   resumeHours  — a conversation idle longer than this starts fresh
 *   sleepMinutes — close an idle conversation's Claude process after this long
 *                  (0 = never); the next question wakes it
 *   approve      — asks the owner about a call the gate marked "ask" (approvals.mjs);
 *                  without one, every such call is declined
 *   run          — starts a Claude session; the SDK's query(), and a fake in tests
 */
export function createBrain({
  model, effort, gate, mcpServers,
  store = createStore(), audit = createAudit(), resumeHours = 6, sleepMinutes = 10,
  approve = async () => false,
  run = query,
}) {
  /**
   * Open one conversation.
   *
   * @param {{ systemPrompt: string, servers?: Record<string, object>,
   *           emit: (event: object) => void, onEnd?: () => void,
   *           channel?: string, resume?: boolean }} options
   *   servers — the channel's own tool servers, merged over the shared ones
   *   emit    — receives the events listed at the top of this file
   *   onEnd   — called once if the session dies and can take no more turns
   *   channel — the channel's name ("hud", "telegram"), for logs and state
   *   resume  — pick up where this channel's last conversation left off
   */
  function open({ systemPrompt, servers = {}, emit, onEnd, channel = 'default', resume: wantResume = false, maxTurns = 24 }) {
    /**
     * Carrying on the last conversation, so a page reload doesn't wipe what
     * was just said. The SDK keeps each session on disk; all we keep is its id
     * and when it was last used. A conversation idle for longer than
     * resumeHours starts fresh — yesterday's half-finished topic is noise, and
     * an ever-growing history costs time and usage on every turn.
     */
    const stateKey = wantResume ? `session.${channel}` : null
    const saved = stateKey ? store.get(stateKey) : null
    /**
     * What this conversation can do and who she is in it. A conversation saved
     * under different tools or instructions is not resumed: the model trusts
     * its own history over a new system prompt, so after laptop control was
     * switched on she kept answering "the laptop isn't connected to me" from
     * an old session (measured, 2026-10-04).
     */
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([systemPrompt, gate.builtins, Object.keys(servers).sort()]))
      .digest('hex')
      .slice(0, 16)
    const recent = saved?.id && Date.now() - Date.parse(saved.updatedAt) < resumeHours * 3_600_000
    const resume = recent && saved.fingerprint === fingerprint ? saved.id : undefined
    if (resume) console.log(`[ayra] resuming the ${channel} conversation (${resume.slice(0, 8)}…)`)
    else if (recent) console.log(`[ayra] ${channel}: her tools or instructions changed — starting a fresh conversation`)
    audit.log({ type: 'session', channel, event: resume ? 'resume' : 'open', session: resume ?? null })
    const remember = (sessionId) => {
      if (stateKey && sessionId) {
        store.set(stateKey, { id: sessionId, updatedAt: new Date().toISOString(), fingerprint })
      }
    }
    /**
     * A saved session that cannot be resumed — its transcript deleted,
     * unreadable or expired — must be forgotten, or every reconnect would try
     * the same id and fail the same way.
     */
    const forget = () => {
      if (!stateKey) return
      store.delete(stateKey)
      console.warn(`[ayra] could not resume the ${channel} conversation; the next one starts fresh`)
      audit.log({ type: 'session', channel, event: 'resume_failed', session: resume })
    }

    /**
     * The live Claude process for this conversation, or null while it sleeps.
     * Each process has its own input queue, so ending one for a nap can never
     * swallow a question meant for the next.
     */
    let live = null
    let closed = false
    /** The conversation to carry on when waking; the SDK keeps it on disk. */
    let lastSession = resume ?? null
    /** A question is being answered — never nap in the middle of one. */
    let busy = false
    let napTimer = null

    /** The input generator for one process: questions ({ text, rank }) in, one at a time. */
    async function* userMessages(proc) {
      while (!closed && !proc.done) {
        const question =
          proc.inbox.shift() ??
          (await new Promise((resolve) => {
            proc.deliver = resolve
          }))
        if (closed || proc.done || question == null) return
        yield {
          type: 'user',
          // Stamped with the local time as it is sent — see context.mjs — and,
          // for a complex rank only, the ranker's depth line in front.
          message: { role: 'user', content: composeMessage(question.text, question.rank) },
          parent_tool_use_id: null,
        }
      }
    }

    /**
     * Which question the agent is currently answering.
     *
     * The stream carries no notion of a turn, so without this the client cannot
     * tell the tail of an abandoned answer from the start of the new one — it
     * attaches a listener and receives whatever is on the socket. Echoing the
     * id the client sent lets it ignore anything that is not its own, which is
     * the only reliable fix: no amount of waiting on this side changes what a
     * listener over there has already heard.
     */
    let answering = null
    let askedAt = 0
    /**
     * The question being answered, in the owner's words, with the channel's
     * rank of it: { ask, rank, text }, null before the first. The research tool
     * reads it to admit a run on the owner's words rather than the model's
     * restatement, and the HUD tags its cards with `ask`.
     */
    let current = null
    const emitTurn = (event) => {
      emit({ ...event, ask: answering })
      if (event.type === 'tool') audit.log({ type: 'tool', channel, ask: answering, name: event.name })
      if (event.type === 'done') {
        audit.log({
          type: 'answer', channel, ask: answering, text: clip(event.text),
          ms: askedAt ? Date.now() - askedAt : null, costUsd: event.costUsd,
        })
      }
      if (event.type === 'error') audit.log({ type: 'error', channel, ask: answering, message: event.message })
    }

    /**
     * Announcing a tool, once, and only if it actually runs.
     *
     * A tool_use block surfaces twice — as a partial stream event and again on
     * the completed assistant message — so ids are remembered. The harder part
     * is timing, because a refused tool that lights the badge, plays the sound
     * and provokes a "working on it" line, for work that never happens, reads as
     * a bug on camera.
     *
     * The SDK's order is: the block starts streaming, then canUseTool is asked,
     * then the tool runs. So nothing is known at content_block_start. Announcing
     * from inside canUseTool would know the verdict but miss tools entirely —
     * measured on this SDK, the callback is consulted only for calls the CLI
     * hasn't already settled, so a `Bash: echo` its own classifier waves through
     * never reaches us at all.
     *
     * So: announce immediately for anything the gate permits, since those run.
     * Hold the rest, and let the tool_result settle it — a refusal comes back as
     * is_error, anything else really did execute and has earned its badge, a
     * beat late. Nothing is ever announced for work that didn't happen.
     */
    const seenTools = new Set()
    const heldTools = new Map()
    // Every tool call's name by id, so a result can be told apart (sources).
    const toolNames = new Map()
    // Every tool call's input by id, from the completed assistant message — a
    // page's result does not always say which URL was asked for.
    const toolInputs = new Map()

    const announceTool = (id, name) => {
      if (!name || (id && seenTools.has(id))) return
      if (id) seenTools.add(id)
      if (id) toolNames.set(id, name)
      // The display tool isn't work being done, it's the HUD drawing itself —
      // announcing it would put "ayra · display" in the tool badge and trigger
      // a "working on it" filler for something already on screen. show_data is
      // the same: the answer's card, drawn after she has said it.
      if (name === 'mcp__ayra__display' || name === 'mcp__ayra__show_data') return
      // The ui_* tools are the same case one step further: retinting the
      // interface is the interface talking about itself, not work being done
      // for the user, and the badge would be describing what they can see.
      if (name.startsWith('mcp__ayra_ui__')) return
      if (gate.decide(name)) return emitTurn({ type: 'tool', name })
      if (id) heldTools.set(id, name)
    }

    const settleTool = (id, failed) => {
      const name = heldTools.get(id)
      if (name === undefined) return
      heldTools.delete(id)
      if (!failed) emitTurn({ type: 'tool', name })
    }

    /**
     * Resolves when the turn in flight has actually finished.
     *
     * Waiting on session.interrupt() alone is not enough. It resolves when the
     * agent has been *told* to stop, not when it has, so the last tokens of the
     * abandoned answer are still on their way — and since nothing on the wire
     * identifies which question a delta belongs to, they land on the next turn's
     * listener. Measured: ask for ALPHA, interrupt, ask for BRAVO, and BRAVO's
     * answer arrives as "ALPHA\nBRAVO".
     *
     * The SDK emits exactly one `result` per turn, so that is the boundary worth
     * waiting for. Raced against a timeout because a turn that never reports one
     * must not wedge the conversation for ever — a stray word is a blemish, a
     * deadlocked assistant is not.
     */
    let settling = Promise.resolve()
    /** The turn in flight was stopped on purpose — its end is not a failure. */
    let interrupted = false
    let finishTurn = null

    const turnFinished = () =>
      new Promise((resolve) => {
        finishTurn = resolve
      })

    /** Start a Claude process — at open, and again when a question wakes a nap. */
    const wake = (resumeId) => {
      const proc = { inbox: [], deliver: null, done: false, napping: false, started: false, resumeId }
      proc.session = run({
        prompt: userMessages(proc),
        options: {
          // Continue the channel's last conversation, when there is a recent one.
          ...(resumeId ? { resume: resumeId } : {}),
          // The owner's MCP servers plus the channel's own, which close over
          // the channel (the HUD's `display` lands on that socket) — which is
          // why this object is built per conversation rather than once.
          mcpServers: { ...mcpServers, ...servers },
          // A plain system prompt, not the claude_code preset. The preset is
          // tuned for a coding agent — verbose, file-oriented, and a large chunk
          // of input tokens on every turn. Replacing it makes the persona stick,
          // keeps answers short enough to speak, and cuts cost per turn.
          systemPrompt,
          // Run from the home directory so project-scoped MCP servers don't
          // shadow the global ones, and so file tools have a sane root.
          cwd: homedir(),
          // No filesystem settings at all. Left to its default the SDK loads
          // ~/.claude/settings.json and settings.local.json exactly as the CLI
          // does — which on a working machine means a bypassPermissions default
          // and a pile of allow-rules for Bash. Allow-rules are matched before the
          // permission callback, so the gate would never even be asked about the
          // tools it most needs to refuse. Empty makes this bridge the only
          // authority. It also stops the global CLAUDE.md riding along on every
          // voice turn, carrying instructions written for a coding agent into a
          // conversation that is meant to be two sentences long.
          //
          // The cost is that MCP servers stop being discovered too, which is why
          // mcpServers above passes them in by hand.
          settingSources: [],
          // Stated explicitly, and it has to be: with no `model` the SDK falls
          // back to its own default, and the owner's `/model` preference lives in
          // the settings files `settingSources: []` deliberately stops loading.
          model,
          effort,
          // Only the built-ins AYRA needs, and none of the owner's claude.ai
          // connectors they haven't allowed — both decided in gate.mjs.
          tools: gate.builtins,
          disallowedTools: gate.disallowed,
          // With no connector allowed (AYRA_CONNECTORS=none, the default) the
          // claude.ai ones are not even started: without this the bundled CLI
          // connects to every one at each brain start and wake — remote MCP
          // handshakes the owner waits through — only for the gate to remove
          // them (latency audit, 2026-10-12). research.mjs does the same.
          ...(gate.allowedConnectors?.length ? {} : { strictMcpConfig: true }),
          maxTurns,
          permissionMode: 'default',
          // Without this the SDK only emits whole assistant messages, and AYRA
          // would sit silent until the entire answer was written. Partial events
          // are what let speech start on the first finished sentence.
          includePartialMessages: true,
          // Signature is (toolName, input, options) and it must return a
          // PermissionResult object. Returning a bare boolean silently denies
          // everything, with the tool name arriving undefined.
          //
          // Worth knowing: this is a last gate, not the only one. Calls the CLI
          // has already settled never arrive here — its own classifier waves
          // through a `Bash: echo hello` without asking, and only reaches us for
          // something with a consequence, like a `touch`. So a deny here is
          // reliable; an absence of a call here is not proof nothing ran.
          //
          // Each call is reviewed with its input (gate.review): most just run; the
          // four kinds the owner chose to be asked about wait here for their yes.
          canUseTool: async (toolName, input) => {
            const review = gate.review(toolName, input)
            let ok = review.verdict === 'allow'
            if (review.verdict === 'ask') {
              console.log(`[ayra] tool ${toolName} -> asking the owner (${review.reason})`)
              ok = await approve({ channel, tool: toolName, reason: review.reason, detail: review.detail })
            }
            audit.log({
              type: 'decision', channel, tool: toolName, allowed: ok,
              ...(review.verdict === 'ask' ? { asked: review.reason } : {}),
            })
            console.log(`[ayra] tool ${toolName} -> ${ok ? 'allow' : 'deny'}`)
            if (ok) return { behavior: 'allow', updatedInput: input }
            return {
              behavior: 'deny',
              // Every word of this can end up spoken, so it carries no command
              // to read out — the persona never says one aloud.
              message:
                review.verdict === 'ask'
                  ? `The owner did not approve this (it ${review.reason}). Tell them in one ` +
                    'short sentence that you left it, and do not try to do it another way.'
                  : review.reason
                    ? `Refused: that file ${review.reason}, which ${IDENTITY.name} never reads or ` +
                      'changes. Say so in one short sentence and do not try another way.'
                    : `${IDENTITY.name} is not allowed to use this tool. Tell the user in one ` +
                      'short sentence that it is not available.',
            }
          },
        },
      })

      live = proc
      void pump(proc)
      return proc
    }

    /** Stop one process: no more input, and let it exit. */
    const stop = (proc) => {
      proc.done = true
      proc.deliver?.(null)
      proc.session.close?.()
    }

    /** The conversation can take no more turns: stop feeding it and tell the channel. */
    const end = () => {
      if (closed) return
      closed = true
      clearTimeout(napTimer)
      if (live) stop(live)
      live = null
      audit.log({ type: 'session', channel, event: 'ended' })
      onEnd?.()
    }

    /** Close the idle process; the conversation itself stays open. */
    const nap = () => {
      if (!live || busy || closed) return
      const proc = live
      live = null
      proc.napping = true
      stop(proc)
      audit.log({ type: 'session', channel, event: 'asleep' })
      console.log(`[ayra] ${channel}: idle — the brain sleeps until the next question`)
    }

    const napLater = () => {
      clearTimeout(napTimer)
      if (sleepMinutes > 0) {
        napTimer = setTimeout(nap, sleepMinutes * 60_000)
        napTimer.unref?.()
      }
    }

    // Pump one process's output to the channel for as long as it lives.
    async function pump(proc) {
      const session = proc.session
      try {
        for await (const msg of session) {
          if (env('DEBUG') === '1') {
            console.log('[msg]', msg.type, msg.event?.type ?? '')
          }

          switch (msg.type) {
            // Raw Anthropic stream events, surfaced by includePartialMessages.
            // This is the ONLY place spoken text arrives: there is no top-level
            // text_delta message in the SDK union and the 'assistant' message
            // carries no deltas either. Turn includePartialMessages off and
            // AYRA goes completely mute.
            case 'stream_event': {
              const ev = msg.event
              if (
                ev?.type === 'content_block_delta' &&
                ev.delta?.type === 'text_delta' &&
                ev.delta.text
              ) {
                emitTurn({ type: 'text', delta: ev.delta.text })
              }
              if (
                ev?.type === 'content_block_start' &&
                ev.content_block?.type === 'tool_use'
              ) {
                announceTool(ev.content_block.id, ev.content_block.name)
              }
              break
            }

            case 'assistant': {
              // Fallback for builds that emit whole assistant messages rather
              // than partial events. Deduped against the stream_event path.
              for (const block of msg.content ?? msg.message?.content ?? []) {
                if (block.type === 'tool_use') {
                  // Only the completed message carries the whole input; the
                  // stream's block start has it empty.
                  if (block.id && block.input && typeof block.input === 'object') toolInputs.set(block.id, block.input)
                  announceTool(block.id, block.name)
                }
              }
              break
            }

            case 'user': {
              // Tool results come back as a user message. This is the only
              // place a held announcement can be resolved: a refused tool
              // arrives with is_error set and stays off the HUD, anything else
              // ran.
              const blocks = msg.message?.content
              if (!Array.isArray(blocks)) break
              // The SDK's structured result describes the message, so it can
              // only be trusted for a block when that block is the only result.
              const results = blocks.filter((b) => b?.type === 'tool_result')
              for (const block of results) {
                settleTool(block.tool_use_id, block.is_error === true)
                // A web search's links and text, or a page that was read, for
                // the channel's sources card and its number check
                // (server.mjs). Channels that can't show them ignore them.
                const event = webResultEvent({
                  name: toolNames.get(block.tool_use_id),
                  input: toolInputs.get(block.tool_use_id),
                  block,
                  structured: results.length === 1 ? msg.tool_use_result : null,
                })
                if (event) emitTurn(event)
              }
              break
            }

            case 'result': {
              // A resume whose session is gone fails here, before the session
              // ever starts — "No conversation found with session ID" — as an
              // error result, not an exception.
              const resumeFailed = Boolean(proc.resumeId) && !proc.started && msg.subtype !== 'success'
              const wasInterrupted = interrupted
              interrupted = false
              // A result is not automatically a success. The error subtypes
              // carry no `result` field at all, so reporting them as 'done'
              // with empty text is indistinguishable from a turn that simply
              // had nothing to say — the HUD stops spinning and AYRA stands
              // there silent. Say what happened instead.
              //
              // Nor is 'success' on its own. An API failure — a model the
              // bundled Claude Code doesn't know, an expired login, a rate
              // limit — arrives as subtype 'success' with is_error set and the
              // raw error as the result: "API Error: 400 …", which would be
              // read aloud as the answer. The detail goes to the log instead.
              if (wasInterrupted && !(msg.subtype === 'success' && !msg.is_error)) {
                // Stopped by a barge-in or the kill switch: logged as what it
                // was, not as a failure, and said as one word.
                audit.log({ type: 'interrupted', channel, ask: answering })
                emitTurn({ type: 'error', message: RESULT_FAILURES.interrupted })
              } else if (msg.subtype === 'success' && !msg.is_error) {
                emitTurn({
                  type: 'done',
                  text: msg.result ?? '',
                  costUsd: msg.total_cost_usd ?? null,
                })
              } else {
                const apiError = msg.subtype === 'success'
                console.error(
                  `[ayra] turn failed: ${apiError ? 'api error' : msg.subtype}`,
                  apiError ? (msg.result ?? '') : (msg.errors ?? ''),
                )
                audit.log({
                  type: 'failure', channel, ask: answering,
                  subtype: apiError ? 'api_error' : msg.subtype,
                  detail: clip(apiError ? msg.result : JSON.stringify(msg.errors ?? '')),
                })
                emitTurn({
                  type: 'error',
                  message: resumeFailed
                    ? RESULT_FAILURES.resume_failed
                    : apiError
                      ? usageLimit(msg.result)
                      ?? RESULT_FAILURES.api_error
                      : (RESULT_FAILURES[msg.subtype] ?? RESULT_FAILURES.default),
                })
              }
              // Whatever was waiting on this turn to finish can go now. This is
              // the only place a turn is genuinely over.
              finishTurn?.()
              finishTurn = null
              // One turn's tool ids are never referred to again, and these
              // otherwise grow for as long as the conversation is open.
              seenTools.clear()
              heldTools.clear()
              toolNames.clear()
              toolInputs.clear()
              busy = false
              if (resumeFailed) {
                // Nothing more can happen in this session. Forget it and end,
                // so the channel reconnects into a fresh conversation.
                forget()
                end()
              } else {
                if (msg.session_id) lastSession = msg.session_id
                remember(msg.session_id)
                napLater()
              }
              break
            }

            case 'system':
              if (msg.subtype === 'init') {
                proc.started = true
                audit.log({ type: 'session', channel, event: 'started', session: msg.session_id ?? null, model })
                if (msg.session_id) lastSession = msg.session_id
                remember(msg.session_id)
                // Servers report 'pending' until first use — they connect
                // lazily — so only drop the ones that are actually unusable.
                const usable = (msg.mcp_servers ?? [])
                  .filter((s) => s.status !== 'needs-auth' && s.status !== 'failed')
                  .map((s) => s.name)
                emit({ type: 'ready', servers: usable })
                console.log(`[ayra] ${usable.length} MCP servers available`)
                // What the model can actually reach, by exact name — the only
                // reliable way to write gate rules for servers this bridge did
                // not configure itself, such as the owner's claude.ai connectors.
                if (env('DEBUG') === '1') {
                  console.log(`[ayra] tools (${msg.tools?.length ?? 0}): ${(msg.tools ?? []).join(', ')}`)
                }
              }
              break
          }
        }
        // Put to sleep on purpose: the conversation carries on at the next question.
        if (proc.napping) return
        // The stream ended on its own. Same as a crash, as far as the channel
        // is concerned: this conversation can take no more questions.
        end()
      } catch (err) {
        if (proc.napping) return
        console.error('[ayra] session error:', err)
        audit.log({ type: 'error', channel, message: 'session error', detail: clip(err?.message ?? err) })
        // Died before it ever started: most likely the resume itself.
        if (proc.resumeId && !proc.started) forget()
        emit({ type: 'error', message: String(err?.message ?? err) })
        // The stream is finished either way — nothing will ever be read from
        // it again. Leaving the channel open would leave the client believing
        // it has a working brain, and every later question would hang for ever
        // waiting on a pump that has already stopped.
        end()
      }
    }

    // Started at once, so the first question doesn't wait for a process.
    wake(resume)
    napLater()

    return {
      /**
       * Ask a question. Queued behind any interrupt that is still settling.
       *
       * A barge-in is two messages in quick succession — interrupt, then the
       * new question — and session.interrupt() is asynchronous. Delivering the
       * question the instant it arrives means the agent can still be winding
       * down the previous turn, so its last tokens are emitted after the new
       * one has begun and land on the new turn's listener. Measured: ask "one",
       * interrupt, ask "two", and the answer to "two" comes back as "One."
       *
       * Waiting costs nothing when nothing is interrupting — the chain is an
       * already-resolved promise — and removes the cross-talk when there is.
       *
       * `meta.rank` is the channel's rankQuery of the owner's own words
       * (triage.mjs): a complex one puts the depth line in front of the
       * question. `meta.text` is those words when `text` is not them — a job
       * asks with its whole brief — so turn() names what the owner asked.
       */
      ask(text, id = null, meta = {}) {
        const rank = meta?.rank ?? null
        const words = typeof meta?.text === 'string' ? meta.text : text
        void settling.then(() => {
          if (closed) return
          answering = id
          current = { ask: id, rank, text: words }
          askedAt = Date.now()
          audit.log({
            type: 'question', channel, ask: id, text: clip(text),
            ...(rank ? { depth: rank.score, level: rank.level } : {}),
          })
          busy = true
          clearTimeout(napTimer)
          // Asleep: wake on the same conversation.
          const proc = live ?? wake(lastSession)
          const question = { text, rank }
          if (proc.deliver) {
            const resolve = proc.deliver
            proc.deliver = null
            resolve(question)
          } else {
            proc.inbox.push(question)
          }
        })
      },

      /** The question being answered: { ask, rank, text } (the owner's words), or null before the first. */
      turn() {
        return current
      },

      /**
       * Someone is about to ask: wake now if asleep, so the start-up overlaps
       * their talking instead of their waiting. Measured, a nap costs ~3.7 s on
       * the first answer otherwise; the face calls this the moment it hears
       * speech begin.
       */
      warm() {
        if (closed) return
        if (!live) {
          console.log(`[ayra] ${channel}: someone is talking — waking the brain`)
          wake(lastSession)
        }
        napLater()
      },

      /** Stop the answer in flight. Held so the next question can wait for it. */
      interrupt() {
        if (busy) interrupted = true
        const stopped = turnFinished()
        settling = Promise.resolve(live?.session.interrupt?.())
          .catch(() => {})
          .then(() =>
            Promise.race([
              stopped,
              new Promise((r) => setTimeout(r, SETTLE_CAP_MS)),
            ]),
          )
      },

      /** The channel has gone; end the session without calling onEnd. */
      close() {
        if (closed) return
        closed = true
        clearTimeout(napTimer)
        audit.log({ type: 'session', channel, event: 'closed' })
        if (live) stop(live)
        live = null
      },
    }
  }

  return { open }
}
