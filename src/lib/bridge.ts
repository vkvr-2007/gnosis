import { askFrame, bladeIsCurrent, useStore, type Approval, type Blade, type Mode } from '../store'
import { BRIDGE_WS_URL } from '../config'
import { withHonorific } from '../identity'

/**
 * Client for the local bridge (see bridge/server.mjs) — the face's only way to
 * reach the brain.
 *
 * The socket is the session. The bridge holds one Claude Agent SDK query per
 * connection and the whole conversation lives inside it, so a dropped socket
 * silently wipes JARVIS's memory of the exchange while the transcript on screen
 * still shows it. That is why the reconnect below is loud rather than
 * invisible: `watchConnection` exists so the HUD can say so.
 */

export type AskHandlers = {
  /**
   * Fires for each chunk of the answer. `quiet`: shown in her log, never spoken
   * — details, or a task's answer past its first lines (bridge/spoken.mjs).
   */
  onText: (delta: string, quiet: boolean) => void
  /** Fires when Claude starts running a tool. */
  onTool: (name: string) => void
}

/** Anything the bridge sends. Deliberately loose — a frame from a future
 *  bridge build should be ignored, not crash the turn. */
type Frame = {
  type?: string
  delta?: string
  name?: string
  text?: string
  message?: string
  blade?: Blade
  ask?: string
  id?: string
  reason?: string
  detail?: string
  tool?: string
  always?: string
  ok?: boolean
  by?: string
  /** `hearing` frames: how she listens — 'push' or 'hands-free'. */
  mode?: string
  /** `text` frames: shown, not spoken. */
  quiet?: boolean
  servers?: Array<string | { name?: string }>
}

/** Every question gets an id so its answer can be told from anyone else's. */
let askSeq = 0

let socket: WebSocket | null = null
let connecting: Promise<WebSocket> | null = null

/** Server names reported by the bridge, for the HUD readout. */
let servers: string[] = []
export const bridgeServers = () => servers

/** The list arrives twice — once from config, once with live status — so the
 *  HUD subscribes rather than reading it a single time at boot. */
let onServers: ((s: string[]) => void) | null = null
export function watchServers(fn: (s: string[]) => void) {
  onServers = fn
}

/**
 * The owner's Approve, from the bridge: a request to show, a request settled
 * (here, on Telegram, or by the clock), or the kill switch thrown somewhere.
 */
export type ApprovalEvent =
  | { type: 'approve'; approval: Approval }
  | { type: 'approved'; id: string; ok: boolean; by: string }
  | { type: 'halt'; by: string }
let onApproval: ((e: ApprovalEvent) => void) | null = null
export function watchApprovals(fn: (e: ApprovalEvent) => void) {
  onApproval = fn
}

/** The owner's answer to an Approve card; `always`: yes, and from now on here. */
export function answerApproval(id: string, ok: boolean, always = false): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'approval', id, ok, always }))
}

/** The kill switch: decline everything waiting and stop every answer in flight. */
export function haltAll(): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'halt' }))
}

/** Blades arrive out of band — pushed mid-turn by the `display` and `blade`
 *  tools, so the result is already open as she starts the sentence about it. */
let onBlade: ((blade: Blade) => void) | null = null
export function watchBlades(fn: (blade: Blade) => void) {
  onBlade = fn
}

/**
 * The id of the turn this page asked last — the one in flight, or the one just
 * answered. Not cleared at `done`: a turn's sources card may be sent as it
 * ends, a moment after its last word. Only a newer question makes it stale:
 * blade frames stamped with an older turn are dropped (`bladeIsCurrent`).
 */
let currentAsk: string | null = null

/**
 * Connection state, for the UI.
 *
 *   'open'        — first connection of the page.
 *   'lost'        — the socket died. The agent session died with it, so
 *                   everything said so far is gone as far as JARVIS knows.
 *   'reconnected' — we're back, on a fresh session with no memory of the above.
 */
export type ConnectionState = 'open' | 'lost' | 'reconnected'
let onConnection: ((state: ConnectionState) => void) | null = null
export function watchConnection(fn: (state: ConnectionState) => void) {
  onConnection = fn
}

export function isConnected(): boolean {
  return socket?.readyState === WebSocket.OPEN
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** Resolved by the socket-level dispatcher on the first `ready` of the current
 *  connection. Re-armed per connection so a reconnect re-announces. */
let firstReady = deferred()

let everConnected = false

/** Backoff for the automatic re-dial, then every 8 s for as long as it takes. It used to give up
 *  after half a minute, but in Gnosis.exe the bridge always comes back (after Settings restarts it,
 *  a crash, or the laptop waking up) and takes about that long to start: the window was left
 *  disconnected for good (2026-10-20). One quiet request every 8 s costs nothing. */
const RECONNECT_DELAYS = [500, 1000, 2000, 4000, 8000]
let attempt = 0
let reconnectTimer = 0

function scheduleReconnect() {
  const delay = RECONNECT_DELAYS[Math.min(attempt, RECONNECT_DELAYS.length - 1)]
  attempt += 1
  clearTimeout(reconnectTimer)
  reconnectTimer = window.setTimeout(() => {
    // A dial that fails (the bridge still starting) tries again; only a lost open session called
    // this before, so one miss ended the chain.
    void connect().catch(() => scheduleReconnect())
  }, delay)
}

/**
 * One message listener per socket, owning everything that isn't part of a
 * turn. It used to live inside warmBridge, bound to that one socket: after any
 * reconnect the SYSTEM rail froze for the life of the page, and every extra
 * warmBridge() call leaked another listener onto the same socket.
 */
function dispatch(ws: WebSocket) {
  ws.addEventListener('message', (e: MessageEvent) => {
    let msg: Frame
    try {
      msg = JSON.parse(e.data as string)
    } catch {
      return
    }

    if (msg.type === 'ready') {
      // The bridge announces immediately on connect from Claude Code's config,
      // then again with live status once the agent initialises. Keep listening
      // so the later, more accurate list wins.
      servers = (msg.servers ?? [])
        .map((s) => (typeof s === 'string' ? s : (s.name ?? '')))
        .filter(Boolean)
      onServers?.(servers)
      firstReady.resolve()
    } else if (msg.type === 'blade' && msg.blade) {
      if (bladeIsCurrent(msg.ask, currentAsk)) onBlade?.(msg.blade)
    } else if (msg.type === 'approve' && msg.id) {
      onApproval?.({
        type: 'approve',
        approval: {
          id: msg.id,
          reason: msg.reason ?? '',
          detail: msg.detail ?? '',
          tool: msg.tool ?? '',
          always: typeof msg.always === 'string' ? msg.always : '',
        },
      })
    } else if (msg.type === 'approved' && msg.id) {
      onApproval?.({ type: 'approved', id: msg.id, ok: msg.ok === true, by: msg.by ?? '' })
    } else if (msg.type === 'halt') {
      onApproval?.({ type: 'halt', by: msg.by ?? '' })
    } else if (msg.type === 'hearing' && (msg.mode === 'push' || msg.mode === 'hands-free')) {
      onHearing?.(msg.mode)
    } else if (msg.type === 'talk') {
      onTalk?.()
    } else if (msg.type === 'notice' && typeof msg.text === 'string') {
      // A reminder, a routine's answer, a battery warning (bridge/schedule.mjs): say it now.
      onNotice?.(msg.text)
    } else if (msg.type === 'settings') {
      // The tray's Settings item.
      onSettings?.()
    } else if (msg.type === 'yourdata') {
      // The tray's Your data item.
      onYourData?.()
    } else if (msg.type === 'camera' && typeof msg.id === 'string') {
      // look_through_camera (bridge/vision.mjs): one webcam frame, sent back as a JPEG.
      const id = msg.id
      void cameraFrame().then(
        (jpeg) => socket?.send(JSON.stringify({ type: 'camera_frame', id, jpeg })),
        (err) => socket?.send(JSON.stringify({ type: 'camera_frame', id, error: String(err?.message ?? err) })),
      )
    }
  })
}

/** One frame from the webcam as base64 JPEG; the camera is on only for this moment. */
async function cameraFrame(): Promise<string> {
  const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 } })
  try {
    const video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    video.srcObject = stream
    await video.play()
    // The first frames are dark while the camera sets its exposure.
    await new Promise((r) => setTimeout(r, 700))
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth || 1280
    canvas.height = video.videoHeight || 720
    canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height)
    video.pause()
    return canvas.toDataURL('image/jpeg', 0.8).split(',')[1] ?? ''
  } finally {
    for (const t of stream.getTracks()) t.stop()
  }
}

function connect(): Promise<WebSocket> {
  if (socket?.readyState === WebSocket.OPEN) return Promise.resolve(socket)
  if (connecting) return connecting

  firstReady = deferred()

  connecting = new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(BRIDGE_WS_URL)
    let settled = false

    /**
     * Every terminal path runs through here, and clearing `connecting` is the
     * whole point. The timeout used to reject without clearing it, which
     * bricked the client: the fast path above hands that same dead promise to
     * every later caller, so one slow start cost you a page reload.
     */
    const settle = (err: Error | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      connecting = null
      if (err) reject(err)
      else resolve(ws)
    }

    const timer = setTimeout(() => {
      ws.close()
      settle(new Error('Bridge not responding — is `npm run bridge` running?'))
    }, 6000)

    ws.onopen = () => {
      socket = ws
      attempt = 0
      dispatch(ws)
      settle(null)
      onConnection?.(everConnected ? 'reconnected' : 'open')
      everConnected = true
    }
    ws.onerror = () => {
      /**
       * The browser will not tell us why.
       *
       * A refused handshake and a rejected Origin arrive here identically — no
       * status, no reason, just `error` — and the two have completely different
       * fixes. The old message named only one of them, and confidently: it said
       * to start the bridge. When the real cause was the page being served on a
       * port outside the range the bridge trusts, that advice sent everyone to
       * inspect a process that was running perfectly the whole time.
       *
       * So say both, and put the actual port in front of them, since that is
       * the fact that distinguishes the two cases at a glance.
       */
      settle(
        new Error(
          `Cannot reach the bridge at ${BRIDGE_WS_URL}. Either it is not ` +
            'running (start it with `npm start`), or this page is on a port it ' +
            `refuses — it accepts localhost:5173-5199 and 4173-4199, and this ` +
            `page is on ${location.port || '80'}.`,
        ),
      )
    }
    ws.onclose = () => {
      // A close before open is just a failed dial; after open it's a lost
      // session, and the two want different handling.
      settle(new Error('The bridge closed the connection.'))
      if (socket === ws) {
        socket = null
        onConnection?.('lost')
        scheduleReconnect()
      }
    }
  })

  return connecting
}

/** Open the socket early so the first "Hey Jarvis" isn't waiting on a handshake. */
export async function warmBridge(): Promise<void> {
  await connect()
  // Don't block startup if the bridge never announces — the dispatcher fills
  // the rail in whenever the list does turn up.
  await Promise.race([
    firstReady.promise,
    new Promise<void>((resolve) => setTimeout(resolve, 2500)),
  ])
}

// ---------------------------------------------------------------------------
// Turns
// ---------------------------------------------------------------------------

/**
 * No frame of any kind for two minutes means the turn is never coming back.
 * Generous on purpose: a long agent run can sit silent through a slow tool,
 * and cutting a real answer off is worse than waiting. What this catches is
 * the case that used to hang forever — the bridge alive but the turn lost.
 */
const IDLE_TIMEOUT_MS = 120_000

/** Tools that only draw on the HUD — see the 'tool' case below. */
const QUIET_TOOLS: ReadonlySet<string> = new Set(['mcp__ayra__display', 'mcp__ayra__show_data'])

/** The turn in flight, so a barge-in can settle it locally. */
let pending: { finish: (fallback?: string) => void } | null = null

/**
 * One question. `mode` 'research' (the R key) sends it to the researcher
 * (bridge/deep.mjs) instead of her usual brain; the frame names the mode only
 * then, so a normal question goes out exactly as it always did (askFrame).
 */
export async function ask(
  prompt: string,
  handlers: AskHandlers,
  mode: Mode = 'normal',
): Promise<{ text: string; tools: string[] }> {
  /**
   * A new question supersedes the one in flight.
   *
   * Two concurrent turns genuinely would corrupt each other — both listeners
   * see every delta, and the first 'done' resolves both with the other's text —
   * but refusing the new one was the wrong way to prevent that. It surfaced as
   * "JARVIS is already answering", which is a sentence about this module's
   * bookkeeping rather than about anything the user did, and it contradicts the
   * premise the whole app is built on: say something and it becomes the turn.
   *
   * It fired far more than it looked like it should, because the only thing
   * that cleared the slot was a barge-in — and a barge-in only fires in guard
   * mode. A transcript can arrive well after the speech that produced it: the
   * segment queue means several can be waiting, and their onsets happened while
   * the machine was still listening, when nothing interrupts. So the second
   * utterance of a normal sentence could land on a turn that was already
   * running and simply be refused.
   *
   * Cancelling settles the old promise synchronously, so by the time the code
   * below claims the slot there is nothing left to collide with. The abandoned
   * turn's caller sees its own `stale()` check and stands down quietly.
   */
  if (pending) cancel()

  // Claim the slot in this same tick. connect() below awaits, and two calls
  // made before it settles would otherwise both sail past the check above.
  let cancelledWhileDialling = false
  pending = {
    finish: () => {
      cancelledWhileDialling = true
    },
  }

  let ws: WebSocket
  try {
    ws = await connect()
  } catch (err) {
    pending = null
    throw err
  }

  // Barged in on before the socket was even up. Nothing was ever asked.
  if (cancelledWhileDialling) {
    pending = null
    return { text: '', tools: [] }
  }

  const id = `a${++askSeq}`
  // From here on, cards stamped with an older turn are stale (bladeIsCurrent).
  currentAsk = id
  const tools: string[] = []
  let text = ''

  return new Promise((resolve, reject) => {
    let done = false
    let timer = 0

    const cleanup = () => {
      done = true
      pending = null
      clearTimeout(timer)
      ws.removeEventListener('message', onMessage)
      ws.removeEventListener('close', onClose)
      ws.removeEventListener('error', onError)
    }

    const finish = (fallback = '') => {
      if (done) return
      cleanup()
      // Prefer the streamed text; fall back to the final result if this build
      // didn't emit deltas.
      resolve({ text: (text || fallback).trim(), tools })
    }

    const fail = (err: Error) => {
      if (done) return
      cleanup()
      reject(err)
    }

    const arm = () => {
      clearTimeout(timer)
      timer = window.setTimeout(() => {
        fail(new Error(withHonorific('The bridge went quiet — that turn was lost.')))
      }, IDLE_TIMEOUT_MS)
    }

    const onMessage = (e: MessageEvent) => {
      // Any frame at all is proof of life, including ones this turn ignores.
      arm()

      let msg: Frame
      try {
        msg = JSON.parse(e.data as string)
      } catch {
        // A frame we can't read is not a reason to abandon the turn. It used
        // to be: the parse threw inside the listener, nothing settled the
        // promise, and App's `busy` flag stayed true for the life of the page.
        return
      }

      /**
       * Somebody else's answer.
       *
       * A superseded turn keeps streaming for a moment after it is abandoned,
       * and this listener is attached to the socket rather than to a turn — so
       * without this check the tail of the old answer is read as the beginning
       * of the new one. Measured before it existed: ask for ALPHA, barge in,
       * ask for BRAVO, and BRAVO's answer came back as "ALPHA".
       */
      if (msg.ask && msg.ask !== id) return

      try {
        switch (msg.type) {
          case 'text':
            text += msg.delta ?? ''
            handlers.onText(msg.delta ?? '', msg.quiet === true)
            break

          case 'tool':
            // Putting a card on screen is not work the owner waits on: no
            // badge, no sound, no "on it" (the bridge skips these too).
            if (!msg.name || QUIET_TOOLS.has(msg.name)) break
            tools.push(msg.name)
            handlers.onTool(prettyToolName(msg.name))
            break

          case 'done':
            finish(msg.text ?? '')
            break

          case 'error':
            fail(new Error(msg.message ?? 'The bridge reported an error.'))
            break
        }
      } catch (err) {
        fail(err instanceof Error ? err : new Error(String(err)))
      }
    }

    const onClose = () => {
      fail(new Error('The bridge disconnected mid-answer — that session is gone.'))
    }
    const onError = () => {
      fail(new Error('The connection to the bridge failed.'))
    }

    pending = { finish }
    ws.addEventListener('message', onMessage)
    ws.addEventListener('close', onClose)
    ws.addEventListener('error', onError)
    arm()

    try {
      ws.send(JSON.stringify(askFrame(prompt, id, mode, useStore.getState().takeAttachments())))
    } catch (err) {
      // The socket can go into CLOSING between connect() resolving and here.
      fail(err instanceof Error ? err : new Error(String(err)))
    }
  })
}

/**
 * Cut JARVIS off mid-answer.
 *
 * Tells the bridge to stop, then settles the in-flight turn here rather than
 * waiting for a 'done' that a barge-in may never produce. Whatever he had
 * already said is returned, so the caller's await always comes back and the
 * transcript keeps the half-sentence the user actually heard.
 */
export function cancel(): void {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'interrupt' }))
  }
  pending?.finish()
}

/**
 * The owner has started talking: wake a sleeping brain now, so its start-up
 * overlaps the question instead of following it. At most every few seconds.
 */
let lastWarm = 0
/**
 * Hands-free on or off from the tray (AYRA.exe → the bridge → here), and the
 * face telling the bridge how it listens now, so the tray's tick is right.
 */
let onHearing: ((mode: 'push' | 'hands-free') => void) | null = null
export function watchHearing(fn: (mode: 'push' | 'hands-free') => void) {
  onHearing = fn
}
/** Her phase and one line of caption, for the bubble on top of every app (lib/glance.ts). */
export function reportFace(g: { phase: string; text: string; who: string; by: string }): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'face', ...g }))
}

export function reportHearing(mode: 'push' | 'hands-free'): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'hearing', mode }))
}

/** Something Gnosis says without being asked (a reminder, a routine's answer, a warning). */
let onNotice: ((text: string) => void) | null = null
let onSettings: (() => void) | null = null
let onYourData: (() => void) | null = null
/** The tray asks for the Your data screen. */
export function watchYourData(fn: () => void) {
  onYourData = fn
}
/** The tray asks for the Settings screen. */
export function watchSettings(fn: () => void) {
  onSettings = fn
}
export function watchNotice(fn: (text: string) => void) {
  onNotice = fn
}

/** The tray's talk hotkey (AYRA.exe → the bridge): what Space does, from any app. */
let onTalk: (() => void) | null = null
export function watchTalk(fn: () => void) {
  onTalk = fn
}

/** Pause whatever is playing while she listens, resume it after (bridge/media.mjs). */
export function media(action: 'pause' | 'resume'): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'media', action }))
}

export function warmBrain(): void {
  if (Date.now() - lastWarm < 5000) return
  lastWarm = Date.now()
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'warm' }))
}

/** The older name for `cancel()`. */
export function interrupt(): void {
  cancel()
}

/** `mcp__ayra_memory__remember` -> `memory · remember`: the bridge's ayra_ prefix is not shown. */
function prettyToolName(raw: string): string {
  if (!raw.startsWith('mcp__')) return raw
  const [, server, ...rest] = raw.split('__')
  return `${server.replace(/^ayra_?/, '') || 'gnosis'} · ${rest.join(' ').replace(/_/g, ' ')}`
}
