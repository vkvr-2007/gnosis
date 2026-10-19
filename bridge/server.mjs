/**
 * AYRA local bridge (forked from the JARVIS bridge, adewaskar/jarvis).
 *
 * Runs the Claude Agent SDK — Claude Code as a library — and exposes one turn
 * of conversation over a WebSocket. The browser stays the face and the voice;
 * this process is the brain and the hands.
 *
 * No API key: it authenticates exactly the way `claude` does, off the owner's
 * existing login. AYRA's tools today are web search, reading web pages and the
 * HUD's display; everything else arrives one tool at a time (PLAN.md).
 *
 *   node bridge/server.mjs
 */

// First, so .env.local is loaded before anything below reads the environment.
import { IDENTITY, env } from './identity.mjs'
import { SYSTEM_PROMPT, TEXT_PROMPT } from './persona.mjs'
import { createGate } from './gate.mjs'
import { WebSocket, WebSocketServer } from 'ws'
import { createBrain } from './brain.mjs'
import { createOriginCheck } from './origin.mjs'
import { clip, createAudit } from './audit.mjs'
import { startTelegram } from './telegram.mjs'
import { checkData, displayServer } from './panels.mjs'
import { createTagFilter, parseCard, stripTags } from './datatag.mjs'
import { createSpokenFilter, isQuestion, unwrapMore } from './spoken.mjs'
import { createTurnCards } from './sources.mjs'
import { rankQuery } from './triage.mjs'
import { relayListening } from './listen.mjs'
import { PER_HOUR, relayWake } from './wake.mjs'
import { createMedia } from './media.mjs'
import { elevenRequest, preconnect, readAll } from './eleven.mjs'
import { serveFace } from './face.mjs'
import { createApprovals } from './approvals.mjs'
import { createAllowances } from './allowances.mjs'
import { rulesServer } from './rules.mjs'
import { watchPresence } from './presence.mjs'
import { JOB_LIMITS, createJobs, jobsServer } from './jobs.mjs'
import { createStore } from './state.mjs'
import { browserServer, openInChrome } from './browser.mjs'
import { appsCall, appsServer, warmApps } from './apps.mjs'
import { createResearch, researchServer } from './research.mjs'
import { createDeepResearch } from './deep.mjs'
import { createSpeakerMeter } from './echo.mjs'
import { createHands, noteFor, parseFast, runFast } from './fastpath.mjs'
import { homedir } from 'node:os'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openRemote, proxyError, vetTarget, PROXY_UA } from './net.mjs'
import { renderPage } from './page.mjs'
import { modelFor } from './models.mjs'
import { createMemory, memoryServer } from './memory.mjs'
import { describeImages, visionServer } from './vision.mjs'
import { musicServer } from './spotify.mjs'
import { adbRunner, createAppPhone, createPhone, createPhoneRouter, findAdb, phoneServer } from './phone.mjs'
import { createDeviceHub } from './devices.mjs'
import QRCode from 'qrcode'
import { useImageDescriber } from './sdk.mjs'
import { createJobStore, createNotifier, createWatchers, scheduleServer, setBriefing, startSchedule } from './schedule.mjs'

const MEMORY = createMemory()
/** Reminders, routines, the briefing and the laptop watchers (schedule.mjs). Set up below the brain. */
const SCHEDULE = createJobStore()
let NOTIFIER = null
let WATCHERS = null

const PORT = Number(env('BRIDGE_PORT', 8787))

/**
 * A crash here takes the whole assistant down mid-sentence, and most of what
 * can reject is out of our hands — a socket dying under a write, an upstream
 * fetch aborting. Log it and keep serving; the turn that failed will surface
 * its own error to the browser.
 */
process.on('unhandledRejection', (err) => {
  console.error('[gnosis] unhandled rejection:', err)
})

/** Who may talk to this bridge — local dev pages by default; see origin.mjs. */
const ORIGINS = createOriginCheck({
  extraOrigins: env('ALLOWED_ORIGINS', ''),
  allowNoOrigin: env('ALLOW_NO_ORIGIN') === '1',
})

/**
 * Laptop control is on — the owner's decision (2026-10-03, answer "a"): AYRA
 * runs PowerShell and edits files herself, every call reviewed by the gate, and
 * the four things the owner chose (spending money, sending as them, deleting for
 * good, passwords and security) wait for their Approve. AYRA_ALLOW_WRITES=0
 * turns it off for this process — reading only, like before Phase 5.
 */
const ALLOW_WRITES = env('ALLOW_WRITES', '1') !== '0'
/** Her Windows apps work through UI Automation, which only Windows has. */
const WINDOWS = process.platform === 'win32'

/**
 * The orchestrator model. Override with AYRA_MODEL to trade quality for pace
 * — claude-sonnet-5-5 is noticeably snappier, and lighter on the plan's usage
 * limits, if Opus feels slow.
 */
const MODEL = env('MODEL', 'claude-opus-5-5')

/**
 * How hard the model thinks before answering.
 *
 * 'low', measured (PROGRESS.md, task 4.4): on a search question 'medium' spent
 * about four and a half seconds thinking before it said a word, and the answers
 * were no better for a spoken reply of two sentences. The owner wants no lag,
 * so the default is the fastest setting that still answers well; raise it with
 * AYRA_EFFORT when a task genuinely needs the depth.
 */
const EFFORT = env('EFFORT', 'low')

/**
 * The research agent's workers — the planner that splits a question, and each
 * part's searcher and reporter (research.mjs). Narrow, structured jobs, so the
 * lighter model does them well and keeps a run inside the Pro limits; the
 * review and the answer itself are written by MODEL.
 */
const RESEARCH_MODEL = env('RESEARCH_MODEL', 'claude-sonnet-5-5')

/**
 * Every tool loaded up front, none deferred behind ToolSearch.
 *
 * Claude Code defers built-ins like WebSearch and WebFetch behind a search step
 * to save context on big tool lists. AYRA's list is five tools, so the saving
 * is nothing and the cost is a whole extra model round trip — measured at 1–3
 * seconds — before her first search of a conversation. The SDK hands this
 * process's environment to Claude Code, so setting it here is enough.
 */
process.env.ENABLE_TOOL_SEARCH ??= 'false'

/**
 * Every claude.ai connector on the owner's account, as Claude Code itself
 * records them ("claude.ai Gmail", …). The gate uses this to remove the ones
 * AYRA may not use before a session starts — the session's own server list
 * only arrives after the first question, which is too late.
 */
function everConnected() {
  try {
    const cfg = JSON.parse(
      readFileSync(join(homedir(), '.claude.json'), 'utf8'),
    )
    return Array.isArray(cfg.claudeAiMcpEverConnected)
      ? cfg.claudeAiMcpEverConnected
      : []
  } catch {
    return []
  }
}

/**
 * What AYRA may run — the whole policy lives in gate.mjs. AYRA_CONNECTORS
 * lists the claude.ai connectors it may read (comma separated). Default
 * "none": the clean interface is web search only, and each connector comes
 * back as its own step. The rest are removed from the session by the gate.
 */
const CONNECTORS = env('CONNECTORS', 'none')
const GATE = createGate({
  allowWrites: ALLOW_WRITES,
  // The laptop's files and shell (Phase 5); writes add PowerShell and edits.
  laptop: true,
  connectors: CONNECTORS.toLowerCase() === 'none' ? [] : CONNECTORS.split(','),
  everConnected: everConnected(),
})

/**
 * ElevenLabs credentials, borrowed from the MCP server config.
 *
 * If you've set up the elevenlabs MCP server, the key is already on this
 * machine — no reason to make you paste it into a second .env file. The browser
 * never sees it: it POSTs text to /tts here and gets audio back.
 */
function elevenKey() {
  if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY
  try {
    const cfg = JSON.parse(
      readFileSync(join(homedir(), '.claude.json'), 'utf8'),
    )
    return cfg.mcpServers?.elevenlabs?.env?.ELEVENLABS_API_KEY ?? null
  } catch {
    return null
  }
}

// The owner's chosen ElevenLabs voice (config/identity.json); AYRA_VOICE_ID overrides it.
const VOICE_ID = env('VOICE_ID', IDENTITY.voice.elevenLabsId || 'JBFqnCBsd6RMkjVDRZzb')

// ---------------------------------------------------------------------------

/**
 * Remote media, fetched by the bridge instead of by the page.
 *
 * JARVIS used to refuse to show anything he found on the web, and the refusal
 * was not squeamishness — a bare <img src="https://some-cdn/..."> in a panel
 * genuinely did not work. Three reasons, and all three are fixed by moving the
 * fetch to this side of the wire:
 *
 *   1. Hotlink blocking. News sites and image CDNs check Referer and User-Agent
 *      and hand a browser-that-isn't-their-page a 403 or a placeholder. That is
 *      why thumbnails rendered as empty rectangles. A server-side fetch that
 *      looks like an ordinary browser and sends no referrer gets the bytes.
 *   2. Privacy. Panel HTML is authored by a model that has just been reading
 *      untrusted web pages, so a remote URL in it is a prompt-injection beacon:
 *      load it directly and the user's IP, and the fact they asked, go to a host
 *      the page chose. Proxying means the browser only ever talks to localhost
 *      and the page CSP can stay tight.
 *   3. One place to cap size, set timeouts and insist the bytes really are the
 *      media type they claim.
 *
 * The cost is that this process — unlike a browser tab — can reach the user's
 * LAN, their router's admin page, and cloud metadata endpoints. So everything
 * below is an SSRF gate first and a proxy second.
 */

const MAX_IMG_BYTES = 15 * 1024 * 1024
const MAX_MEDIA_BYTES = 200 * 1024 * 1024
const IMG_TIMEOUT_MS = 10_000
const MEDIA_TIMEOUT_MS = 30_000

// The SSRF gate and the guarded outbound clients now live in ./net.mjs, so the
// media proxy below and the page proxy share one implementation of the rules
// rather than two that can drift apart.

/**
 * The shared body of /img and /media.
 *
 * `kinds` is the list of content-type prefixes we are willing to hand back.
 * That check is load-bearing: without it this is an open proxy that will serve
 * an attacker's HTML from the bridge's own origin — the one origin allowed to
 * open the agent socket — which is the same reason IMAGE_TYPES has no .svg.
 */
async function proxyRemote(req, res, cors, { kinds, maxBytes, timeoutMs, ranged }) {
  const asked = new URL(req.url, 'http://x').searchParams.get('url') ?? ''
  const target = vetTarget(asked)

  const headers = {
    'user-agent': PROXY_UA,
    accept: ranged ? '*/*' : 'image/*,*/*;q=0.8',
    // Identity encoding so the byte cap counts the bytes we actually stream and
    // content-length means what it says. Media is already compressed anyway.
    'accept-encoding': 'identity',
  }
  // Range is the difference between a <video> that seeks and one Safari refuses
  // to play at all, so the browser's request is passed through verbatim.
  if (ranged && typeof req.headers.range === 'string') {
    headers.range = req.headers.range
  }

  const { res: upstream } = await openRemote(target, headers, timeoutMs)
  const status = upstream.statusCode ?? 0

  if (status !== 200 && status !== 206) {
    upstream.resume()
    throw proxyError(status === 404 ? 404 : 502, `upstream said ${status}`)
  }

  const type = String(upstream.headers['content-type'] ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase()
  if (!kinds.some((kind) => type.startsWith(kind))) {
    upstream.resume()
    throw proxyError(415, `not ${kinds.join(' or ')} (got ${type || 'nothing'})`)
  }

  const declared = Number(upstream.headers['content-length'])
  if (Number.isFinite(declared) && declared > maxBytes) {
    upstream.resume()
    throw proxyError(413, 'too large')
  }

  const out = {
    ...cors,
    'content-type': type,
    'x-content-type-options': 'nosniff',
    // Thumbnails get looked at, panelled again, and re-rendered on every HUD
    // repaint; re-fetching from the CDN each time is slow and rude.
    'cache-control': 'private, max-age=600',
  }
  if (Number.isFinite(declared)) out['content-length'] = String(declared)
  if (ranged) {
    // Only claim range support when the origin actually demonstrated it — a
    // 206, or an explicit accept-ranges of its own. Plenty of hosts ignore the
    // Range header and hand back the whole file with a 200; advertising
    // accept-ranges on top of that tells the video element it may seek by
    // issuing byte requests that will never be honoured, and the scrub bar
    // then misbehaves in a way that looks like our bug rather than theirs.
    if (status === 206 || upstream.headers['accept-ranges'] === 'bytes') {
      out['accept-ranges'] = 'bytes'
    }
    if (upstream.headers['content-range']) {
      out['content-range'] = upstream.headers['content-range']
    }
  }
  res.writeHead(status, out)

  // Stream with a running cap. Buffering a 200 MB video into this process
  // would stall the token stream the voice is riding on, and trusting
  // content-length would let a host that lies about it eat the heap.
  let sent = 0
  upstream.on('data', (chunk) => {
    sent += chunk.length
    if (sent > maxBytes) {
      // Headers went out long ago, so a truncated body is the only way left to
      // say no. The player sees a short read; we see this line in the log.
      console.warn(`[gnosis] proxy cut ${target.href} at ${maxBytes} bytes`)
      upstream.destroy()
      res.destroy()
      return
    }
    if (!res.write(chunk)) {
      upstream.pause()
      res.once('drain', () => upstream.resume())
    }
  })
  upstream.on('end', () => res.end())
  upstream.on('error', () => res.destroy())
  req.on('close', () => upstream.destroy())
}

// ---------------------------------------------------------------------------

/**
 * CORS, reflected rather than wildcarded.
 *
 * `*` on this origin means any page on the internet can read whatever the
 * bridge serves, so the same allowlist that guards the socket picks the
 * header. A request carrying an Origin we don't know is refused outright —
 * but a request with no Origin at all is served, because an <img src> load
 * (which is how blades fetch pictures) never sends one.
 */
function corsFor(req) {
  const origin = req.headers.origin
  const headers = { vary: 'origin' }
  if (origin) {
    headers['access-control-allow-origin'] = origin
    headers['access-control-allow-headers'] = 'content-type'
  }
  return headers
}

// One HTTP server for both the speech proxy and the WebSocket upgrade.
const http = await import('node:http')

const handleRequest = async (req, res) => {
  const origin = req.headers.origin
  if (origin && !ORIGINS.allowed(origin)) {
    console.warn(`[gnosis] refused http request from origin ${origin}`)
    res.writeHead(403, { vary: 'origin' })
    return res.end('forbidden')
  }
  const cors = corsFor(req)

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors)
    return res.end()
  }

  // Push-to-talk or hands-free, switched from the tray (AYRA.exe) in any app.
  // Only AYRA.exe: it sends this header and no Origin. A web page always sends
  // an Origin, and could not add the header without a preflight the bridge
  // never grants — so no page can turn the microphone on.
  const trayCall =
    ((req.url === '/hearing' || req.url === '/face') && req.method === 'GET') ||
    ((req.url === '/hearing' || req.url === '/talk') && req.method === 'POST')
  if (trayCall) {
    if (origin || req.headers['x-ayra'] !== 'tray') {
      res.writeHead(403)
      return res.end('forbidden')
    }
    const reply = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    // The bubble (AYRA.exe): how her window is doing — phase and one line of
    // caption — polled a few times a second. Loopback and tray-only like the rest.
    if (req.url === '/face') return reply(200, { ...FACE, faces: HEARING.faces.size, hearing: HEARING.mode, age: Date.now() - FACE.at })
    if (req.method === 'GET') return reply(200, { mode: HEARING.mode, faces: HEARING.faces.size })
    // The talk hotkey (AYRA.exe, Alt+Space by default) and the bubble: what Space does in
    // her window — listen, then send — from any app, without bringing her forward.
    if (req.url === '/talk') {
      if (!HEARING.faces.size) return reply(409, { error: "her window isn't open" })
      for (const send of HEARING.faces) send({ type: 'talk', by: 'tray' })
      return reply(200, { ok: true })
    }
    let body = ''
    for await (const chunk of req) {
      body += chunk
      if (body.length > 200) return reply(413, { error: 'too long' })
    }
    let want
    try {
      want = JSON.parse(body || '{}').mode
    } catch {
      return reply(400, { error: 'bad json' })
    }
    const mode = want === 'toggle' ? (HEARING.mode === 'hands-free' ? 'push' : 'hands-free') : want
    if (!HEARING_MODES.has(mode)) return reply(400, { error: 'mode is push, hands-free or toggle' })
    if (!HEARING.faces.size) return reply(409, { error: "her window isn't open", mode: HEARING.mode })
    for (const send of HEARING.faces) send({ type: 'hearing', mode, by: 'tray' })
    HEARING.mode = mode
    return reply(200, { mode })
  }

  if (req.method === 'GET' && req.url === '/health') {
    // The browser reads this once at boot to decide which voice engine to use.
    // Both premium paths ride the same ElevenLabs key, so both flags track it:
    // with a key the app transcribes with Scribe and speaks with ElevenLabs;
    // without one it falls back to the browser's own recogniser and voice, so a
    // student with nothing configured still has a working assistant.
    const eleven = Boolean(elevenKey())
    res.writeHead(200, { ...cors, 'content-type': 'application/json' })
    return res.end(JSON.stringify({ ok: true, tts: eleven, stt: eleven }))
  }

  // Remote images, fetched here so the page never talks to the wider web. The
  // renderer rewrites every http(s) <img src> in a panel to this endpoint.
  if (req.method === 'GET' && req.url?.startsWith('/img?')) {
    try {
      await proxyRemote(req, res, cors, {
        kinds: ['image/'],
        maxBytes: MAX_IMG_BYTES,
        timeoutMs: IMG_TIMEOUT_MS,
        ranged: false,
      })
    } catch (err) {
      if (res.headersSent) return res.destroy()
      res.writeHead(err.status ?? 502, cors)
      return res.end(err.message ?? 'proxy failed')
    }
    return
  }

  // The same, for video and audio. Separate from /img because the limits and
  // the Range handling are genuinely different, not because the code is.
  if (req.method === 'GET' && req.url?.startsWith('/media?')) {
    try {
      await proxyRemote(req, res, cors, {
        kinds: ['video/', 'audio/'],
        maxBytes: MAX_MEDIA_BYTES,
        timeoutMs: MEDIA_TIMEOUT_MS,
        ranged: true,
      })
    } catch (err) {
      if (res.headersSent) return res.destroy()
      res.writeHead(err.status ?? 502, cors)
      return res.end(err.message ?? 'proxy failed')
    }
    return
  }

  // A whole web page, fetched here and served from this origin so it can be
  // framed. The publisher's X-Frame-Options and CORS rules are enforced against
  // the browser, and from the browser's point of view this document is ours —
  // so an article that refuses to be embedded anywhere still opens on the
  // display. See page.mjs for what each mode does to the markup.
  //
  // No Origin header arrives on an iframe navigation, so this rides the same
  // path as an <img> load through the check at the top of this handler.
  if (req.method === 'GET' && req.url?.startsWith('/page?')) {
    const asked = new URL(req.url, 'http://x')
    const target = asked.searchParams.get('url') ?? ''
    const mode = asked.searchParams.get('mode') === 'live' ? 'live' : 'reader'
    try {
      const page = await renderPage(target, mode, `http://localhost:${PORT}`)
      res.writeHead(200, { ...cors, ...page.headers })
      return res.end(page.body)
    } catch (err) {
      // Rendered as a page rather than returned as a status, because this lands
      // inside an iframe: a bare 502 body is a blank rectangle on the display,
      // which reads as the interface being broken rather than as the article
      // being unavailable.
      res.writeHead(err.status ?? 502, {
        ...cors,
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
      })
      return res.end(
        `<!doctype html><meta charset="utf-8"><style>
           body{margin:0;padding:26px;background:transparent;color:#7fb6bf;
                font:400 13px/1.6 ui-monospace,monospace}
           b{color:#cfe9ee;font-weight:500;display:block;margin-bottom:6px}
         </style><b>This page could not be opened.</b>${
           String(err?.message ?? 'unknown error').replace(/[<&]/g, '')
         }`,
      )
    }
  }

  if (req.method === 'POST' && req.url === '/tts') {
    const key = elevenKey()
    if (!key) {
      res.writeHead(503, cors)
      return res.end('no elevenlabs key')
    }
    // A spoken line is a few hundred bytes. Anything approaching this is not a
    // sentence, and buffering it unbounded would let one request eat the heap.
    let body = ''
    let overflowed = false
    for await (const chunk of req) {
      body += chunk
      if (body.length > 64 * 1024) {
        overflowed = true
        break
      }
    }
    if (overflowed) {
      req.destroy()
      res.writeHead(400, cors)
      return res.end('body too large')
    }
    // Inside a try: this handler is async with nothing catching its rejection,
    // so a malformed body used to take the entire bridge down with it.
    let text
    try {
      ;({ text } = JSON.parse(body || '{}'))
    } catch {
      res.writeHead(400, cors)
      return res.end('bad json')
    }
    if (!text) {
      res.writeHead(400, cors)
      return res.end('no text')
    }
    try {
      const speak = () =>
        elevenRequest(
          `/v1/text-to-speech/${VOICE_ID}/stream` +
            // 22kHz mono is half the bytes of 44kHz and indistinguishable through
            // a laptop speaker; optimize_streaming_latency=3 trades a little
            // prosody for a much earlier first byte.
            `?output_format=mp3_22050_32&optimize_streaming_latency=3`,
          {
            // Through the warm keep-alive socket (eleven.mjs), not a new handshake per answer.
            headers: { 'xi-api-key': key, 'content-type': 'application/json' },
            body: JSON.stringify({
              text,
              // Flash is the low-latency model — a conversation needs speed more
              // than it needs the last few percent of quality.
              model_id: 'eleven_flash_v2_5',
              voice_settings: {
                stability: 0.4,
                similarity_boost: 0.75,
                speed: 1.05,
              },
            }),
          },
        )
      // A kept socket the server has meanwhile closed fails at once; one fresh try.
      const upstream = await speak().catch((err) => (err?.code === 'ECONNRESET' ? speak() : Promise.reject(err)))
      if (upstream.statusCode !== 200) {
        res.writeHead(upstream.statusCode ?? 502, cors)
        return res.end(await readAll(upstream))
      }

      // Pipe it through rather than buffering. Waiting for the whole file here
      // would throw away everything the streaming endpoint just bought us.
      res.writeHead(200, {
        ...cors,
        'content-type': 'audio/mpeg',
        'cache-control': 'no-cache',
      })
      for await (const chunk of upstream) res.write(chunk)
      return res.end()
    } catch (err) {
      // Cut off mid-stream: break the response, so the face's fetch fails and a
      // half sentence is neither played as whole nor kept in its line cache.
      if (res.headersSent) return res.destroy(err)
      res.writeHead(502, cors)
      return res.end(String(err?.message ?? err))
    }
  }

  // Speech to text. The browser captures one spoken segment as a compressed
  // audio blob and posts the raw bytes here; the bridge hands them to
  // ElevenLabs Scribe and returns the transcript. This is what replaced the
  // browser's own SpeechRecognition — that API dies silently under always-on
  // use, and a server-side transcriber cannot. Detecting that the user is
  // speaking at all is done locally with voice-activity detection, which never
  // touches this endpoint; this is only for the words.
  if (req.method === 'POST' && req.url === '/stt') {
    const key = elevenKey()
    if (!key) {
      res.writeHead(503, cors)
      return res.end('no elevenlabs key')
    }

    const type = req.headers['content-type'] || 'audio/webm'
    const chunks = []
    let size = 0
    let overflowed = false
    // A few seconds of Opus is well under a megabyte; 25 MB is a generous
    // ceiling that still refuses a runaway stream before it eats the heap.
    for await (const chunk of req) {
      chunks.push(chunk)
      size += chunk.length
      if (size > 25 * 1024 * 1024) {
        overflowed = true
        break
      }
    }
    if (overflowed) {
      req.destroy()
      res.writeHead(413, cors)
      return res.end('audio too large')
    }
    // Silence, or a click. Nothing to transcribe, and calling out to the API
    // for it would only add latency to a non-answer.
    if (size < 1200) {
      res.writeHead(200, { ...cors, 'content-type': 'application/json' })
      return res.end(JSON.stringify({ text: '' }))
    }

    try {
      // The filename extension is the only hint Scribe gets about the codec, so
      // derive it from the content-type the MediaRecorder reported rather than
      // hard-coding one.
      const ext = type.includes('ogg')
        ? 'ogg'
        : type.includes('mp4') || type.includes('mpeg')
          ? 'mp4'
          : type.includes('wav')
            ? 'wav'
            : 'webm'
      const form = new FormData()
      form.append('model_id', 'scribe_v1')
      // The owner's language, not a guess per clip. Left to detect it, Scribe
      // heard the owner's accent as Hindi and wrote "Hey AYRA" in Devanagari
      // ("ए आएरा"), which no wake phrase matches — so on standby AYRA silently
      // ignored everything (2026-10-03).
      form.append('language_code', IDENTITY.language.split('-')[0] || 'en')
      form.append(
        'file',
        new Blob([Buffer.concat(chunks)], { type }),
        `speech.${ext}`,
      )

      const upstream = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
        method: 'POST',
        headers: { 'xi-api-key': key },
        body: form,
      })
      if (!upstream.ok) {
        res.writeHead(upstream.status, cors)
        return res.end(await upstream.text())
      }
      const data = await upstream.json()
      res.writeHead(200, { ...cors, 'content-type': 'application/json' })
      return res.end(JSON.stringify({ text: (data.text ?? '').trim() }))
    } catch (err) {
      res.writeHead(502, cors)
      return res.end(String(err?.message ?? err))
    }
  }

  res.writeHead(404, cors)
  res.end()
}

const server = http.createServer((req, res) => {
  // The handler is async, so anything it throws would otherwise become an
  // unhandled rejection and leave the browser waiting on a socket that is
  // never going to answer.
  handleRequest(req, res).catch((err) => {
    console.error('[gnosis] request failed:', err)
    if (!res.headersSent) res.writeHead(500)
    res.end()
  })
})

const wss = new WebSocketServer({
  server,
  // The handshake is the only place a page can be turned away, so it happens
  // here rather than after the socket is open. Rejections are logged loudly:
  // the likeliest cause is a dev server on an unexpected port, and a silent
  // 403 would look like the bridge simply isn't running.
  verifyClient: ({ origin, req }, done) => {
    const path = (req.url ?? '/').split('?')[0]
    if (path !== '/' && path !== '/ws' && path !== '/listen' && path !== '/wake') {
      console.warn(`[gnosis] rejected websocket on path ${path}`)
      return done(false, 403, 'Forbidden')
    }
    if (!ORIGINS.allowed(origin)) {
      console.warn(
        `[gnosis] rejected websocket from origin ${origin ?? '(none)'}` +
          ' — set AYRA_ALLOWED_ORIGINS to permit it',
      )
      return done(false, 403, 'Forbidden')
    }
    done(true)
  },
})
/**
 * Loopback only. Listening on every interface (the old default) let any device
 * on the same Wi-Fi reach the brain — and a forged Origin header is one line in
 * a script, so the origin check alone does not stop that. With laptop control
 * on, that would be remote control of the laptop. Nothing outside it needs in:
 * Telegram is outbound polling, and the face is on this machine.
 */
server.listen(PORT, '127.0.0.1')

/**
 * Daily use: the bridge serves the built face itself (face.mjs), so no dev
 * server runs. `npm start` passes --face; `npm run dev` uses Vite instead.
 */
if (process.argv.includes('--face') || env('SERVE_FACE') === '1') {
  serveFace({
    dir: join(dirname(fileURLToPath(import.meta.url)), '..', 'dist'),
    port: Number(env('FACE_PORT', 5173)),
  })
}

console.log(`[gnosis] ${IDENTITY.name} bridge listening on ws://localhost:${PORT}`)
console.log(
  `[gnosis] speech ${elevenKey() ? `via ElevenLabs, voice ${VOICE_ID}` : 'using browser fallback voice'}`,
)
console.log(`[gnosis] thinking with ${modelFor(MODEL).model} (${modelFor(MODEL).provider}) · research workers ${modelFor(RESEARCH_MODEL).model}`)
console.log(
  ALLOW_WRITES
    ? '[gnosis] tools: web, the HUD display, the laptop (PowerShell, files, its own Chrome, Windows apps) · asks first: money, sending as you, deleting for good, passwords/security'
    : '[gnosis] tools: web, the HUD display, reading the laptop\'s files · writes off (AYRA_ALLOW_WRITES=0)',
)
console.log(
  `[gnosis] connectors (read-only): ${GATE.allowedConnectors.join(', ') || 'none'}` +
    (GATE.excludedConnectors.length
      ? ` · removed: ${GATE.excludedConnectors.join(', ')}`
      : ''),
)
console.log(
  '[gnosis] accepting local dev origins' +
    (ORIGINS.extra.size ? ` plus ${[...ORIGINS.extra].join(', ')}` : '') +
    (ORIGINS.allowNoOrigin ? ' and clients that send no origin' : ''),
)

/**
 * The brain every channel shares — see brain.mjs. Two channels: the HUD's
 * WebSocket below, and Telegram.
 */
// One audit log for every channel, so lines from the HUD and Telegram stay in order.
const AUDIT = createAudit()

/**
 * The owner's Approve, shared by every channel: an ask from any conversation
 * shows on every HUD and on Telegram, and the first answer wins. See approvals.mjs.
 */
/** "Always allow here" — the owner's standing allowances (allowances.mjs). */
const ALLOWANCES = createAllowances()
const APPROVALS = createApprovals({ audit: AUDIT, allowances: ALLOWANCES })

/** Every open conversation, so the kill switch can stop them all at once. */
const CONVERSATIONS = new Set()

/**
 * The kill switch — Esc on the HUD, `/stop` on Telegram. Everything waiting for
 * an Approve is declined and every answer in flight is stopped.
 */
function halt(by) {
  const declined = APPROVALS.halt(by)
  for (const c of CONVERSATIONS) c.interrupt()
  console.log(`[gnosis] stopped by ${by}${declined ? ` — ${declined} waiting action(s) declined` : ''}`)
}

/**
 * The research agent (research.mjs): for a question ranked complex only, three
 * or four parts searched and read at once, then a review that scores, removes
 * duplicates and answers with citations. One engine for every channel, so only
 * one run happens at a time and its Claude calls stay capped. It joins the
 * kill switch like a conversation — Esc or /stop ends a run in flight.
 */
const RESEARCH = createResearch({
  model: MODEL,
  workerModel: RESEARCH_MODEL,
  effort: EFFORT,
  audit: AUDIT,
  // A planner stays started after each run, so the next one skips its ~2.6 s start-up.
  keepPlanner: true,
})
CONVERSATIONS.add({ interrupt: () => RESEARCH.interrupt() })

/**
 * Researcher mode (deep.mjs, the owner's R key): a reasoning planner, one agent
 * per platform — Reddit, Quora, GitHub, Stack Overflow, Hacker News, arXiv,
 * the web — relevance-ranked results and a final cited answer. One engine,
 * one run at a time, on the kill switch like the research agent.
 */
const DEEP = createDeepResearch({ model: MODEL, workerModel: RESEARCH_MODEL, audit: AUDIT })
CONVERSATIONS.add({ interrupt: () => DEEP.interrupt() })

/** How a researcher-mode question is put to the brain (the face sends `mode: 'research'`). */
const RESEARCHER_ASK =
  '[Researcher mode is on: answer this with deep_research, passing the question made self-contained ' +
  '(resolve "it" or "that" from our conversation). Then say the verdict in one or two sentences.]'

/**
 * The webcam, through the face: its window asks the browser for one frame (src/lib/bridge.ts) and
 * sends it back. Pending asks by id; ten seconds for the first-time camera prompt.
 */
const CAMERA_ASKS = new Map()
function cameraFrame() {
  const [send] = HEARING.faces
  if (!send) return Promise.reject(new Error('my window is not open'))
  const id = `cam-${Date.now().toString(36)}`
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      CAMERA_ASKS.delete(id)
      reject(new Error('no picture came back in time'))
    }, 15_000)
    CAMERA_ASKS.set(id, (frame) => {
      clearTimeout(timer)
      CAMERA_ASKS.delete(id)
      if (frame.jpeg) resolve(frame.jpeg)
      else reject(new Error(frame.error || 'no picture'))
    })
    send({ type: 'camera', id })
  })
}

// Pictures from apps_screenshot and browser_screenshot are described to the brain (vision.mjs).
useImageDescriber(describeImages)

/**
 * The owner's devices over Wi-Fi (devices.mjs): the Gnosis phone app. Its questions are answered in
 * one conversation of their own, one at a time; reminders and notices reach it too.
 */
const DEVICE_ASKS = []
let deviceConversation = null
let deviceAnswer = null
function askFromDevice(device, text, reply) {
  DEVICE_ASKS.push({ text, reply })
  if (!deviceAnswer) nextDeviceAsk()
}
function nextDeviceAsk() {
  const next = DEVICE_ASKS.shift()
  if (!next) return
  let said = ''
  const timer = setTimeout(() => finish("That took too long, so I stopped."), 180_000)
  const finish = (t) => {
    if (deviceAnswer !== next) return
    clearTimeout(timer)
    next.reply(stripTags(String(t ?? said)).trim() || 'Done.', true)
    deviceAnswer = null
    nextDeviceAsk()
  }
  deviceAnswer = next
  next.finish = finish
  deviceConversation ??= BRAIN.open({
    channel: 'phone',
    systemPrompt: TEXT_PROMPT,
    emit: (ev) => {
      const cur = deviceAnswer
      if (!cur) return
      if (ev.type === 'text') said += ev.delta
      else if (ev.type === 'done') cur.finish(ev.text || said)
      else if (ev.type === 'error') cur.finish(ev.message)
    },
    onEnd: () => {
      deviceConversation = null
      deviceAnswer?.finish(said)
    },
  })
  deviceConversation.ask(next.text, `phone-${Date.now()}`)
}
const DEVICES = createDeviceHub({ onAsk: askFromDevice })
DEVICES.start()

/** A QR code in every open window of his (set_up_phone), kept up for two minutes. */
async function showQr(url, title) {
  if (!HEARING.faces.size) return false
  const image = await QRCode.toDataURL(url, { margin: 2, width: 360, color: { dark: '#141414', light: '#ffffff' } })
  for (const send of HEARING.faces) {
    send({ type: 'blade', blade: { id: `qr-${Date.now().toString(36)}`, title: title.toUpperCase(), kind: 'image', url: image, size: 'wide', hold: 'sticky' } })
  }
  return true
}

const BRAIN = createBrain({
  model: MODEL,
  effort: EFFORT,
  gate: GATE,
  // Shared by every conversation (the window, Telegram, jobs): Gnosis's long-term memory (memory.mjs).
  mcpServers: {
    ayra_memory: memoryServer(MEMORY),
    ayra_vision: visionServer({ camera: cameraFrame }),
    ayra_music: musicServer(),
    ayra_phone: phoneServer(createPhoneRouter({
      app: createAppPhone(DEVICES),
      adb: createPhone({ run: findAdb() ? adbRunner(findAdb()) : null }),
    }), { hub: DEVICES, showQr }),
    ayra_schedule: scheduleServer({
      store: SCHEDULE,
      get notifier() { return NOTIFIER },
      get watchers() { return WATCHERS },
      setBriefingAt: (at) => {
        BRIEFING_STATE.set('briefing', at ?? 'off')
        return setBriefing(SCHEDULE, at)
      },
    }),
  },
  audit: AUDIT,
  // How long an idle conversation is worth continuing after a reload.
  resumeHours: Number(env('RESUME_HOURS', 6)),
  // An idle conversation's Claude process closes after this long and wakes on
  // the next question — light on the owner's laptop (the owner's "3 yes").
  sleepMinutes: Number(env('SLEEP_MINUTES', 10)),
  approve: (request) => APPROVALS.ask(request),
})

/**
 * Background jobs (jobs.mjs, PLAN.md 6.2): a long task done start to finish in
 * its own conversation, with her hands but no jobs server of its own, reported
 * on Telegram. The kill switch stops it like any conversation.
 */
/** The Telegram channel once started — "show me" pictures and job notes go to the phone through it. */
let phone = null
/** Notes from before Telegram was up (a job cut off by the last restart), sent once it is. */
const early = []

const JOBS = createJobs({
  open: ({ emit, onEnd }) => {
    let conversation = null
    conversation = BRAIN.open({
      channel: 'job',
      systemPrompt: TEXT_PROMPT,
      // The job's own step budget (jobs.mjs) is the limit, not the SDK's default.
      maxTurns: JOB_LIMITS.steps + 20,
      servers: {
        ayra_browser: browserServer({
          allowWrites: ALLOW_WRITES,
          channel: 'job',
          approve: (request) => APPROVALS.ask(request),
          sendPhoto: (jpeg, caption) => phone?.photo(jpeg, caption),
        }),
        ...(WINDOWS && {
          ayra_apps: appsServer({
            allowWrites: ALLOW_WRITES,
            channel: 'job',
            approve: (request) => APPROVALS.ask(request),
            sendPhoto: (jpeg, caption) => phone?.photo(jpeg, caption),
          }),
        }),
        ayra_rules: rulesServer({ allowances: ALLOWANCES }),
        // No screen in a job: the tool returns the report as text. `turn` is
        // the job's task in the owner's words, which the research tool ranks.
        ayra_research: researchServer({
          research: RESEARCH,
          deep: DEEP,
          channel: 'job',
          turn: () => conversation?.turn?.() ?? null,
        }),
      },
      emit,
      onEnd,
    })
    return conversation
  },
  tell: (text) => {
    if (phone) return phone.notify(text)
    early.push(text)
    console.log(`[gnosis] job: ${text.split('\n')[0]}`)
  },
  audit: AUDIT,
  // A job cut off by a restart is reported on the next start.
  store: createStore(),
  // A stopped job's waiting Approve asks are declined, so a late Yes can't make it act.
  onFinish: () => APPROVALS.cancel((request) => request.channel === 'job', 'job ended'),
})
CONVERSATIONS.add(JOBS)

/**
 * The Telegram channel (PLAN.md 3.2) — on when the bot token and the owner's
 * Telegram id are both set. AYRA_TELEGRAM=off keeps it off for this process,
 * which a second bridge started for testing needs: two processes reading the
 * same bot make Telegram refuse one of them.
 */
const TELEGRAM_TOKEN = env('TELEGRAM_TOKEN')
const TELEGRAM_OWNER = env('TELEGRAM_OWNER_ID')
if (env('TELEGRAM', 'on') === 'off') {
  console.log('[gnosis] telegram: off for this process (AYRA_TELEGRAM=off)')
} else if (TELEGRAM_TOKEN && TELEGRAM_OWNER) {
  const telegram = startTelegram({
    token: TELEGRAM_TOKEN,
    ownerId: TELEGRAM_OWNER,
    brain: BRAIN,
    systemPrompt: TEXT_PROMPT,
    // No screen on the phone, so no display tool; the laptop's shell and files
    // come with the brain itself, and her Chrome is here too.
    servers: {
      ayra_browser: browserServer({
        allowWrites: ALLOW_WRITES,
        channel: 'telegram',
        approve: (request) => APPROVALS.ask(request),
        sendPhoto: (jpeg, caption) => phone?.photo(jpeg, caption),
      }),
      ...(WINDOWS && {
        ayra_apps: appsServer({
          allowWrites: ALLOW_WRITES,
          channel: 'telegram',
          approve: (request) => APPROVALS.ask(request),
          sendPhoto: (jpeg, caption) => phone?.photo(jpeg, caption),
        }),
      }),
      ayra_rules: rulesServer({ allowances: ALLOWANCES }),
      ayra_jobs: jobsServer({ jobs: JOBS, allowWrites: ALLOW_WRITES }),
      // Research answers as a text report with numbered sources — no cards on a
      // phone. `turn` is the owner's own words and their rank (telegram.mjs),
      // which admit a run and are the reviewer's original question.
      ayra_research: researchServer({
        research: RESEARCH,
        deep: DEEP,
        channel: 'telegram',
        turn: () => phone?.turn?.() ?? null,
      }),
    },
    allowances: ALLOWANCES,
    jobs: JOBS,
    audit: AUDIT,
    // Approve buttons on the phone, and /stop.
    approvals: APPROVALS,
    onHalt: () => halt('telegram'),
    // A question ranked complex: start the research planner while the brain
    // reads it, so the run skips the planner's start-up.
    onComplex: () => RESEARCH.ready(),
  })
  CONVERSATIONS.add(telegram)
  phone = telegram
  for (const text of early.splice(0)) telegram.notify(text)
  // "I'm back" after the laptop was off or asleep for a while (presence.mjs).
  watchPresence({ store: createStore(), notify: (text) => telegram.notify(text) })
} else if (TELEGRAM_TOKEN) {
  console.log('[gnosis] telegram: token set but AYRA_TELEGRAM_OWNER_ID is missing — channel off')
}

/**
 * Live hearing: the face streams the microphone on `/listen` and the bridge
 * relays it to ElevenLabs Scribe Realtime — see listen.mjs. The key stays here.
 */
function listen(socket) {
  const key = elevenKey()
  if (!key) {
    socket.send(JSON.stringify({ type: 'error', code: 'no_key', message: 'no ElevenLabs key' }))
    return socket.close()
  }
  relayListening(socket, {
    key,
    language: IDENTITY.language.split('-')[0] || 'en',
    // Spelled the way AYRA's name should come back, so the wake phrase matches.
    keyterms: [IDENTITY.name],
    connect: (url, k) => new WebSocket(url, { headers: { 'xi-api-key': k } }),
    log: (msg) => console.warn(msg),
  })
}

/**
 * Hands-free: the face sends short bursts of speech on `/wake` and the bridge
 * has ElevenLabs say what was said (wake.mjs); the face decides if it was her
 * name. One hourly cap for every open face.
 */
const WAKE_CHECKS = []
const WAKE_PER_HOUR = Number(env('WAKE_CHECKS_PER_HOUR', PER_HOUR)) || PER_HOUR

/** Whatever is playing pauses while she listens (media.mjs). */
const MEDIA = createMedia({ log: (msg) => console.log(msg) })

/** The fast path's hands (fastpath.mjs): her apps worker, her Chrome, the music. */
const HANDS = createHands({ appsCall, openInChrome, media: MEDIA })

/**
 * Sound from the laptop's own speakers is not the owner (echo.mjs): while any
 * face streams for hands-free, a meter watches what the speakers play, and a
 * burst that matches it is dropped before the name check. Measured 2026-10-12,
 * before this: "Hey AYRA" played by a laptop app, by another Chrome, and even
 * the owner's own recording through the speakers all woke her.
 */
const SPEAKERS = createSpeakerMeter({ log: (msg) => console.log(msg) })
const WAKE_SOCKETS = new Set()

/**
 * How the face is listening — 'push' (Space) or 'hands-free' (her name) — as it
 * last reported, and every open face, so AYRA.exe (tray menu, Ctrl+Alt+W) can
 * switch it from any app through POST /hearing.
 */
const HEARING = { mode: 'push', faces: new Set() }
const HEARING_MODES = new Set(['push', 'hands-free'])

/**
 * Her window as the bubble shows it (AYRA.exe, GET /face): the phase, one line
 * of caption (what she heard, or what she is saying), whose words they are,
 * and whether the last listen began with her name. Reported by the face.
 */
const FACE = { phase: 'offline', text: '', who: '', by: '', at: 0 }
const FACE_PHASES = new Set(['offline', 'boot', 'dormant', 'waking', 'listening', 'thinking', 'tooling', 'speaking'])

// The HUD channel: one WebSocket, one conversation.
wss.on('connection', (socket, req) => {
  const path = (req.url ?? '/').split('?')[0]
  if (path === '/listen') return listen(socket)
  if (path === '/wake') {
    // The meter runs exactly while some face is streaming for hands-free.
    WAKE_SOCKETS.add(socket)
    SPEAKERS.start()
    socket.on('close', () => {
      WAKE_SOCKETS.delete(socket)
      if (!WAKE_SOCKETS.size) SPEAKERS.stop()
    })
    return relayWake(socket, {
      key: elevenKey(),
      keyterms: [IDENTITY.name],
      language: IDENTITY.language.split('-')[0] || 'en',
      perHour: WAKE_PER_HOUR,
      checks: WAKE_CHECKS,
      speakers: SPEAKERS,
      // Every burst and why it was or wasn't her name, in the day's audit log
      // ("hearing" lines) — tuning hands-free from evidence (2026-10-13).
      record: (entry) => AUDIT.log({ type: 'hearing', ...entry }),
      log: (msg) => console.warn(msg),
    })
  }
  console.log('[gnosis] client connected')

  const send = (msg) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg))
  }

  /** Set once the brain is open; tools and events only reach for it after that. */
  let conversation = null
  /** The question being answered: { ask, rank, text } (brain.mjs), or null. */
  const turnOf = () => conversation?.turn?.() ?? null

  /**
   * Every blade carries the turn it belongs to — the brain's own `ask` at the
   * moment it is sent — so the face can drop a card that arrives after the
   * owner has moved on to the next question.
   */
  const sendBlade = (blade) => send({ type: 'blade', blade, ask: turnOf()?.ask ?? undefined })

  /**
   * This screen's cards, turn by turn (sources.mjs): what each turn's web
   * search and pages brought back, the one data card and the one sources card.
   */
  const cards = createTurnCards({ send: sendBlade, turn: turnOf })

  // The session still names the connectors the gate removed, and the HUD's own
  // display server. Neither is something the owner can use, so the SYSTEMS rail
  // shows only what is really live.
  const removed = new Set(GATE.excludedConnectors.map((n) => `claude.ai ${n}`))

  /**
   * The answer's data card arrives as a <data>{…}</data> tag at the end of her
   * text (datatag.mjs): cut out of what is spoken, checked like show_data
   * (panels.mjs checkData) against this turn's results, and drawn.
   */
  let tags = null
  const tagsFor = (ask) => {
    if (tags?.ask !== ask) {
      tags = {
        ask,
        // How much of it is said out loud (spoken.mjs): a task in a line or two,
        // a question in full; <more> details are shown, never spoken.
        spoken: createSpokenFilter({ question: isQuestion(turnOf()?.text ?? '') }),
        filter: createTagFilter((json) => {
          const args = parseCard(json)
          const verdict = args ? checkData(args, cards.evidence()) : { ok: false, error: 'the card was not JSON' }
          if (verdict.ok) cards.showData(verdict.data, verdict.urls)
          else if (!verdict.already) console.warn(`[gnosis] data card not shown: ${verdict.error}`)
        }),
      }
    }
    return tags.filter
  }

  const emit = (msg) => {
    if (msg.type === 'ready' && Array.isArray(msg.servers)) {
      return send({ ...msg, servers: msg.servers.filter((n) => n !== 'ayra' && !removed.has(n)) })
    }
    // Her words: shown in her log, spoken only where `quiet` isn't set.
    const words = (ask, parts) => {
      for (const p of parts) if (p.text) send({ type: 'text', delta: p.text, ask, ...(p.quiet ? { quiet: true } : {}) })
    }
    if (msg.type === 'text' && typeof msg.delta === 'string') {
      const delta = tagsFor(msg.ask).push(msg.delta)
      if (delta) words(msg.ask, tags.spoken.push(delta))
      // Speech is about to be needed: keep her voice's socket open (eleven.mjs; at most every 10 s).
      if (process.env.ELEVENLABS_API_KEY) preconnect()
      return
    }
    if (msg.type === 'done' || msg.type === 'error') {
      if (tags?.ask === msg.ask) {
        const rest = tags.filter.end()
        words(msg.ask, [...(rest ? tags.spoken.push(rest) : []), ...tags.spoken.end()])
      }
      tags = null
      if (msg.type === 'done' && typeof msg.text === 'string') msg = { ...msg, text: unwrapMore(stripTags(msg.text)) }
    }
    // A web search's links and text, and the pages read, stay with the turn
    // for show_data and the sources card; the face never sees them. A turn's
    // end puts the sources card up when nothing else did — before the done
    // frame, so the card still belongs to the turn on the face.
    if (cards.observe(msg)) return
    // Speech is about to be needed: keep her voice's socket open (eleven.mjs; at most every 10 s).
    if ((msg.type === 'text' || msg.type === 'tool') && process.env.ELEVENLABS_API_KEY) preconnect()
    send(msg)
  }

  // Answer the HUD straight away rather than making it wait for the agent's
  // first turn. Refined later by the real init message.
  send({ type: 'ready', servers: [] })

  conversation = BRAIN.open({
    systemPrompt: SYSTEM_PROMPT,
    servers: {
      // The HUD as an in-process server. Its handler closes over this socket,
      // so a `display` call lands on screen directly; `show_data` checks its
      // figures against this turn's results and draws through `cards`.
      ayra: displayServer(sendBlade, { cards }),
      // Her Chrome — the owner's "Chrome (AYRA)" window (browser.mjs).
      ayra_browser: browserServer({
        allowWrites: ALLOW_WRITES,
        channel: 'hud',
        approve: (request) => APPROVALS.ask(request),
        emitBlade: sendBlade,
      }),
      // Her Windows apps (apps.mjs) — UI Automation, so Windows only.
      ...(WINDOWS && {
        ayra_apps: appsServer({
          allowWrites: ALLOW_WRITES,
          channel: 'hud',
          approve: (request) => APPROVALS.ask(request),
          emitBlade: sendBlade,
        }),
      }),
      // What she may do without asking (rules.mjs).
      ayra_rules: rulesServer({ allowances: ALLOWANCES }),
      // Long tasks in the background (jobs.mjs); their reports go to Telegram when it is on.
      ayra_jobs: jobsServer({ jobs: JOBS, allowWrites: ALLOW_WRITES, reportsTo: phone ? 'Telegram' : null }),
      // The research agent: a small progress card while it works, then the
      // turn's data and sources cards. They pass through `cards`, so show_data
      // and the turn's end know research has put them up. `turn` is the
      // owner's question and its rank, which admit a run.
      ayra_research: researchServer({
        research: RESEARCH,
        deep: DEEP,
        emitBlade: (blade) => cards.research(blade),
        channel: 'hud',
        turn: turnOf,
      }),
    },
    emit,
    // Reloading the page carries on the same conversation (see brain.mjs).
    channel: 'hud',
    resume: true,
    // A dead session can answer nothing more. Leaving the socket open would
    // leave the face believing it has a working brain; closing it makes the
    // face reconnect, which opens a fresh conversation.
    onEnd: () => socket.close(),
  })
  CONVERSATIONS.add(conversation)

  // Every Approve request reaches this screen too, and anything already
  // waiting is shown at once — a reload must not hide a question.
  const unsubscribe = APPROVALS.subscribe((event) => send(event))
  for (const request of APPROVALS.pending()) send({ type: 'approve', ...request })

  /** What the fast path did since the brain last heard from this screen (told on its next question). */
  const done = []
  /** The newest question from this screen — cleared by an interrupt — so a slow fast path knows it was overtaken. */
  let latest = null

  /**
   * A question for the brain. Ranked on the owner's own words (triage.mjs,
   * microseconds, no model): a complex question gets the depth line in front
   * of it, and the research planner is started while the brain reads it.
   */
  const askBrain = (text, id) => {
    const rank = rankQuery(text)
    if (rank.level === 'complex') {
      // A warm-up only: whatever goes wrong there, the question still goes.
      try {
        RESEARCH.ready()
      } catch (err) {
        console.warn(`[gnosis] research warm-up failed — ${err?.message ?? err}`)
      }
    }
    const note = noteFor(done.splice(0))
    conversation.ask(`${note}${text}`, id, note ? { rank, text } : { rank })
  }

  /** The fast path (fastpath.mjs): done and said in code, or the brain's after all. */
  const quick = async (intent, text, id) => {
    const t0 = Date.now()
    const did = await runFast(intent, HANDS)
    // The owner moved on while it ran (a new question, Esc): never hand the
    // old one to the brain now — its ask would relabel the newer turn's frames
    // and the face would drop them (review, 2026-10-12). What was done is told.
    if (latest !== id) {
      if (did) done.push(did.note)
      return
    }
    if (!did) return askBrain(text, id)
    done.push(did.note)
    send({ type: 'text', delta: did.said, ask: id ?? undefined })
    send({ type: 'done', text: did.said, ask: id ?? undefined })
    AUDIT.log({ type: 'fast', channel: 'hud', ask: id, text: clip(text), did: did.note, ms: Date.now() - t0 })
    console.log(`[gnosis] fast: ${did.note} (${Date.now() - t0} ms)`)
  }

  socket.on('message', (raw) => {
    let msg
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }

    if (msg.type === 'ask' && typeof msg.text === 'string') {
      const id = typeof msg.id === 'string' ? msg.id : null
      latest = id
      // Researcher mode (the R key): every question goes to deep_research.
      // The planner starts while the brain reads the question.
      if (msg.mode === 'research') {
        try {
          DEEP.ready()
        } catch (err) {
          console.warn(`[gnosis] researcher warm-up failed — ${err?.message ?? err}`)
        }
        conversation.ask(`${noteFor(done.splice(0))}${RESEARCHER_ASK}\n${msg.text}`, id, { text: msg.text })
        return
      }
      // "Open YouTube", "pause the music": done in code at once (fastpath.mjs),
      // or handed to the brain after all.
      const fast = ALLOW_WRITES && WINDOWS ? parseFast(msg.text) : null
      if (fast) {
        void quick(fast, msg.text, id)
        return
      }
      askBrain(msg.text, id)
    }

    if (msg.type === 'interrupt') {
      latest = null
      conversation.interrupt()
    }

    // The owner has started speaking: wake a sleeping brain while they talk.
    if (msg.type === 'warm') {
      conversation.warm()
      // Her voice's connection too, while they are still talking (eleven.mjs),
      // and her Windows apps worker, which takes ~1 s to start (apps.mjs).
      if (elevenKey()) preconnect()
      if (WINDOWS && ALLOW_WRITES) warmApps()
    }

    // The owner's answer to an Approve card, or the kill switch.
    if (msg.type === 'approval' && typeof msg.id === 'string') {
      APPROVALS.answer(msg.id, msg.ok === true, 'hud', msg.always === true)
    }
    if (msg.type === 'halt') halt('hud')

    // The face says how it is listening now (on connect and on every switch).
    if (msg.type === 'hearing' && HEARING_MODES.has(msg.mode)) HEARING.mode = msg.mode

    // Her phase and caption, for the bubble (GET /face).
    if (msg.type === 'face' && FACE_PHASES.has(msg.phase)) {
      FACE.phase = msg.phase
      FACE.text = typeof msg.text === 'string' ? msg.text.replace(/\s+/g, ' ').slice(-160) : ''
      FACE.who = msg.who === 'you' || msg.who === 'her' ? msg.who : ''
      FACE.by = msg.by === 'name' || msg.by === 'press' ? msg.by : ''
      FACE.at = Date.now()
    }

    // A webcam frame the face took for look_through_camera.
    if (msg.type === 'camera_frame' && typeof msg.id === 'string') {
      CAMERA_ASKS.get(msg.id)?.({ jpeg: typeof msg.jpeg === 'string' ? msg.jpeg : '', error: String(msg.error ?? '') })
    }

    // She has started listening (pause what's playing) or gone back to standby (resume it).
    if (msg.type === 'media' && msg.action === 'pause') void MEDIA.pause()
    if (msg.type === 'media' && msg.action === 'resume') void MEDIA.resume()
  })
  HEARING.faces.add(send)

  socket.on('close', () => {
    console.log('[gnosis] client disconnected')
    HEARING.faces.delete(send)
    // The last window gone: the bubble shows her as closed, not frozen mid-phase.
    if (!HEARING.faces.size) Object.assign(FACE, { phase: 'offline', text: '', who: '', by: '', at: Date.now() })
    unsubscribe()
    CONVERSATIONS.delete(conversation)
    conversation.close()
  })
})

/* ------------------------------------------- reminders, routines and the briefing (schedule.mjs) */

/** Where the owner's choice of briefing time (or "off") is kept, so a restart never overrides it. */
const BRIEFING_STATE = createStore()

NOTIFIER = createNotifier({
  // Said aloud in every open window of his (the face shows it and speaks it); false with none open.
  speak: (text) => {
    let told = 0
    for (const send of HEARING.faces) {
      send({ type: 'notice', text })
      told++
    }
    return told > 0
  },
  // Telegram when it's set up, and the Gnosis app on the owner's phone when it's connected.
  phone: (text) => {
    const apps = DEVICES.notice(text)
    return phone?.notify(text) || apps > 0
  },
  log: (entry) => AUDIT.log(entry),
})
WATCHERS = createWatchers({ notifier: NOTIFIER, memo: BRIEFING_STATE })

/** A routine or the briefing, carried out as an ordinary request; resolves with the answer. */
function runRequest(text) {
  return new Promise((resolve) => {
    let answer = ''
    let settled = false
    let conversation = null
    const finish = (t) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(stripTags(String(t ?? '')).trim() || 'Done.')
      try {
        conversation?.close()
      } catch { /* already closed */ }
    }
    const timer = setTimeout(() => finish(answer || `"${text}" took too long, so I stopped it.`), 180_000)
    conversation = BRAIN.open({
      channel: 'routine',
      systemPrompt: TEXT_PROMPT,
      emit: (ev) => {
        if (ev.type === 'text') answer += ev.delta
        else if (ev.type === 'done') finish(ev.text || answer)
        else if (ev.type === 'error') finish(ev.message)
      },
      onEnd: () => finish(answer),
    })
    conversation.ask(text, `routine-${Date.now()}`)
  })
}

{
  // The daily briefing, 08:00 unless the owner changed it or turned it off (morning_briefing_time).
  const saved = BRIEFING_STATE.get('briefing')
  if (saved !== 'off' && !SCHEDULE.upcoming().some((j) => j.key === 'morning-briefing')) {
    setBriefing(SCHEDULE, saved || env('BRIEFING', '08:00'))
  }
  startSchedule({ store: SCHEDULE, notifier: NOTIFIER, watchers: WATCHERS, runRequest })
  console.log(`[gnosis] reminders and routines on: ${SCHEDULE.upcoming().length} scheduled`)
}
