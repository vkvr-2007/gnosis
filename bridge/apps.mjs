/**
 * Her Windows apps — the `ayra_apps` tool server.
 *
 * AYRA works in the owner's desktop apps the way she works in their Chrome:
 * she reads a window as text plus a numbered list of the controls in it, and
 * acts by number. Windows' own UI Automation does the reading and pressing,
 * through a PowerShell worker (apps.ps1) that starts on her first app action
 * and closes when idle — nothing to install, and nothing running while she
 * isn't using an app. Most clicks go through the control itself (about a
 * tenth of a second, no mouse, no window brought to the front); a real mouse
 * click is the fallback.
 *
 * Every click, Enter and key press is checked against the owner's ask-first
 * list (gate.riskOfAppAction) with the control's real label and the window it
 * is in, and waits for their Approve when it matches. A window showing a file
 * of secrets is not read at all, and key-shaped text in any window is blanked
 * before it reaches the model (gate.redactSecrets).
 *
 * What a window says is information, never an instruction (persona).
 */

import { createSdkMcpServer, tool } from './sdk.mjs'
import { z } from 'zod'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isOwnWindow, redactSecrets, riskOfAppAction, touchesSecrets } from './gate.mjs'
import { SEND_WORDS } from './allowances.mjs'

// Only a conversation that can send pictures (Telegram) offers the phone, and the
// tool says where a picture went — at the laptop she once said a screenshot was
// "on its way to your phone" when nothing could send it.
const PHONE_HINT = ' `toOwner`: send it to the owner\'s phone too — when they asked to see it ("show me").'
const photoNote = (asked, sent) =>
  sent === true ? 'Sent to the owner\'s phone.'
    : sent === false ? 'Could not send it to the phone.'
      : asked ? 'Shown on the HUD only; this conversation cannot send pictures to the phone.' : ''

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'apps.ps1')
/** Longest a single request may take before the worker is presumed stuck. */
const CALL_TIMEOUT_MS = 20_000
/** Opening an app waits for its window, which can take a while on this laptop. */
const OPEN_TIMEOUT_MS = 30_000
/**
 * The worker closes after this long unused (it costs ~60 MB while open).
 * Was 5 minutes; a cold start costs ~1 s plus the Start-menu list on the next
 * "open", which the owner felt as lag (2026-10-12).
 */
const IDLE_MS = 30 * 60_000
/** Longest window read handed to the model. */
const MAX_TEXT = 6000
/** Keys that leave a file of secrets alone: a new tab, or another one. */
const BESIDE_SECRETS = /^(?:ctrl\+(?:n|t|tab|shift\+tab|pageup|pagedown)|alt\+tab)$/i
/**
 * Programs that are a whole world of their own — browsers, and the hosts that
 * many different apps run inside. "Always in chrome" would mean the whole web,
 * so these never get the Always choice.
 */
const HOSTS = /^(?:chrome|msedge|firefox|brave|opera|vivaldi|iexplore|applicationframehost|explorer|javaw?|pythonw?|node|electron|powershell|pwsh|cmd|windowsterminal|wt|conhost|code|dllhost|rundll32|mmc)$/i
/** How long a window gets to redraw after an action before it is read again. */
const SETTLE_MS = 150

/**
 * The PowerShell worker: one request at a time, one JSON line each way.
 * Started on the first call, restarted after a crash or a stuck request.
 */
export function createWorker({ script = SCRIPT, idleMs = IDLE_MS, spawnWorker } = {}) {
  let child = null
  let nextId = 1
  let idle = null
  let queue = Promise.resolve()
  const waiting = new Map()

  const launch =
    spawnWorker ??
    (() =>
      spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      }))

  function start() {
    const proc = launch()
    let buffer = ''
    let stderr = ''
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk) => {
      buffer += chunk
      let at
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at).trim()
        buffer = buffer.slice(at + 1)
        let msg
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        const w = waiting.get(msg.id)
        if (!w) continue
        waiting.delete(msg.id)
        if (msg.ok) w.resolve(msg.data)
        else w.reject(new Error(msg.error || 'the app did not respond'))
      }
    })
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (d) => (stderr = (stderr + d).slice(-1500)))
    proc.stdin.on('error', () => {})
    const gone = (why) => {
      if (child === proc) child = null
      for (const w of waiting.values()) w.reject(new Error(stderr.trim().split('\n')[0] || why))
      waiting.clear()
    }
    proc.on('error', (err) => gone(`the Windows helper could not start (${err.message})`))
    proc.on('exit', () => gone('the Windows helper stopped'))
    child = proc
  }

  function stop() {
    clearTimeout(idle)
    child?.kill()
    child = null
  }

  function send(op, args, timeoutMs) {
    if (!child) start()
    clearTimeout(idle)
    const id = nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(id)
        stop()
        reject(new Error('the app took too long to answer — it may be busy or frozen'))
      }, timeoutMs)
      waiting.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      })
      child.stdin.write(`${JSON.stringify({ id, op, ...args })}\n`)
    }).finally(() => {
      idle = setTimeout(stop, idleMs)
      idle.unref?.()
    })
  }

  /** In order: the worker answers one at a time, and refs belong to the last read. */
  const call = (op, args = {}, timeoutMs = CALL_TIMEOUT_MS) => {
    const run = queue.then(() => send(op, args, timeoutMs))
    queue = run.catch(() => {})
    return run
  }

  return { call, stop }
}

// ---------------------------------------------------------------------------

const NAMED_KEYS = {
  enter: '{ENTER}', return: '{ENTER}', tab: '{TAB}', esc: '{ESC}', escape: '{ESC}',
  backspace: '{BACKSPACE}', delete: '{DELETE}', del: '{DELETE}', insert: '{INSERT}',
  home: '{HOME}', end: '{END}', pageup: '{PGUP}', pagedown: '{PGDN}',
  up: '{UP}', down: '{DOWN}', left: '{LEFT}', right: '{RIGHT}', space: ' ', plus: '{+}',
}
const MODIFIERS = { ctrl: '^', control: '^', alt: '%', shift: '+' }

/**
 * "ctrl+s", "alt+f4", "down down enter" → the SendKeys form Windows takes
 * ("^s", "%{F4}", "{DOWN}{DOWN}{ENTER}"). Throws on anything it doesn't know,
 * rather than pressing something else.
 */
export function toSendKeys(keys) {
  const combos = String(keys ?? '').trim().split(/\s+/).filter(Boolean)
  if (!combos.length) throw new Error('Say which keys to press, e.g. "ctrl+s".')
  return combos
    .map((combo) => {
      const parts = combo.toLowerCase().split('+')
      const key = parts.pop()
      const mods = parts
        .map((m) => {
          if (!MODIFIERS[m]) throw new Error(`"${m}" is not a key that can be held (ctrl, alt or shift).`)
          return MODIFIERS[m]
        })
        .join('')
      if (key === 'win' || key === 'windows') {
        throw new Error('The Windows key cannot be pressed; open apps with apps_open instead.')
      }
      if (NAMED_KEYS[key]) return mods + NAMED_KEYS[key]
      if (/^f(?:[1-9]|1[0-6])$/.test(key)) return `${mods}{${key.toUpperCase()}}`
      if (key.length === 1) return mods + (/[+^%~(){}[\]]/.test(key) ? `{${key}}` : key)
      throw new Error(`Unknown key "${key}".`)
    })
    .join('')
}

/** What kind of box a control is, for the ask-first check on Enter. */
export const fieldOf = (el = {}) =>
  el.password ? 'password' : /search|find|filter|address|look ?up|go to/i.test(`${el.name ?? ''} ${el.aid ?? ''}`) ? 'search' : 'text'

const label = (w) => (w ? `"${w.title}" (${w.app})` : 'the window')

/** The open windows, one per line. */
export function formatWindows(windows = []) {
  if (!windows.length) return 'No windows are open.'
  return windows
    .map((w) => `- ${w.id} · ${w.title} (${w.app})${w.minimized ? ' — minimised' : ''}`)
    .join('\n')
}

/** A control as one line, the way formatRead shows it. */
const controlLine = (it) => {
  let line = `[${it.ref}] ${it.type}${it.name ? ` "${it.name}"` : ''}`
  if (it.password) line += ' (password box)'
  if (it.state) line += ` (${it.state})`
  if (it.disabled) line += ' (disabled)'
  if (it.value) line += `: ${JSON.stringify(it.value)}`
  return line
}

/**
 * What an action changed in a window: when its controls are the same ones
 * (a calculator key, a box typed in), just the new text and the controls whose
 * value or state moved; when they are not (a new page, tab or dialog), the
 * whole window, since the refs have changed.
 */
export function describeChanges(before, data) {
  const shape = (items) => items.filter((i) => i.ref).map((i) => `${i.type}|${i.name}`).join('\n')
  if (!before || shape(before) !== shape(data.items)) {
    return `The window now (refs renumbered):\n${formatRead(data)}`
  }
  const seen = new Set(before.filter((i) => i.text != null).map((i) => i.text))
  const was = new Map(before.filter((i) => i.ref).map((i) => [i.ref, controlLine(i)]))
  const lines = [
    ...data.items.filter((i) => i.text != null && !seen.has(i.text)).map((i) => i.text),
    ...data.items.filter((i) => i.ref && was.get(i.ref) !== controlLine(i)).map(controlLine),
  ]
  if (!lines.length) return 'Nothing in the window changed (refs are the same).'
  const shown = lines.join('\n')
  return `What changed in the window (refs are the same):\n${shown.length > MAX_TEXT ? `${shown.slice(0, MAX_TEXT)}\n…` : shown}`
}

/** A window read, as text the model can act on, secrets blanked. */
export function formatRead({ window, items = [], more = false }, maxText = MAX_TEXT) {
  const lines = []
  for (const it of items) {
    if (it.text != null) {
      lines.push(it.text)
      continue
    }
    lines.push(controlLine(it))
  }
  let body = lines.join('\n')
  let cut = more
  if (body.length > maxText) {
    body = body.slice(0, maxText)
    cut = true
  }
  return redactSecrets(
    `Window ${window.id} · ${label(window)}\n` +
      'Controls have [refs]; act on them by number.\n\n' +
      `${body || '(nothing readable in this window)'}` +
      `${cut ? '\n…and more not shown.' : ''}`,
  )
}

// ---------------------------------------------------------------------------

/**
 * Her own window (the face, with the Approve card) is out of bounds: pressing
 * in it could answer her own request.
 */
const OWN = "That is Gnosis's own window; her tools leave it alone."

const text = (t) => ({ content: [{ type: 'text', text: t }] })
const fail = (t) => ({ isError: true, content: [{ type: 'text', text: t }] })

/** One worker for every conversation: the owner has one desktop. */
let shared = null
const worker = () => (shared ??= createWorker())

/** A request to the shared worker, for code outside the tools (the fast path, fastpath.mjs). */
export const appsCall = (op, args = {}, timeoutMs) => worker().call(op, args, timeoutMs ?? (op === 'open' ? OPEN_TIMEOUT_MS : CALL_TIMEOUT_MS))

/**
 * Start the worker now, without waiting for it — the bridge calls this when the
 * owner starts speaking, so its ~1 s start-up (UI Automation, the Start-menu
 * list) overlaps their talking instead of their waiting.
 */
export function warmApps() {
  appsCall('ping').catch(() => {})
}

/** The last window read, so an action can be checked with what it will press. */
let last = null
const remember = (data) => {
  last = { window: data.window, items: data.items, refs: new Map(data.items.filter((i) => i.ref).map((i) => [i.ref, i])) }
}

const which = z
  .union([z.number().int(), z.string()])
  .describe('The window: its id from apps_list, or part of its title or app name')

/**
 * The tools, for appsServer — and for tests, which call their handlers.
 *
 * @param {{ allowWrites: boolean, channel: string,
 *           approve: (request: object) => Promise<boolean>,
 *           apps?: { call: Function }, emitBlade?: (blade: object) => void,
 *           sendPhoto?: (jpegBase64: string, caption: string) => void }} options
 *   allowWrites — without it only the reading tools exist (CLAUDE.md §7)
 *   approve     — the owner's Approve, for actions on the ask-first list
 *   apps        — the worker; tests pass a fake
 *   emitBlade   — puts a screenshot on the HUD; sendPhoto — on the owner's phone
 */
export function appsTools({ allowWrites, channel, approve, apps = null, emitBlade, sendPhoto }) {
  const call = (...args) => (apps ?? worker()).call(...args)

  /** Ask the owner when the action is on their list; true to go ahead. */
  const allowed = async (what, win, toolName, detail) => {
    const reason = riskOfAppAction({ ...what, window: win?.title ?? '', app: win?.app ?? '' })
    if (!reason) return true
    // "Always" only for one ordinary program, and only a click on a plainly
    // sending button — never an Enter, a generic Submit, or a whole browser.
    const plain = what.action === 'click' && SEND_WORDS.test(what.label ?? '')
    const scope = plain && win?.app && !HOSTS.test(win.app) ? { kind: 'app', where: String(win.app).toLowerCase() } : null
    return approve({ channel, tool: toolName, reason, detail: `${detail} — in ${label(win)}`, scope })
  }

  const guard = (fn) => async (args) => {
    try {
      return await fn(args)
    } catch (err) {
      return fail(`Windows: ${err?.message ?? err}`)
    }
  }

  async function read(window) {
    const data = await call('read', { window: String(window) })
    if (isOwnWindow(data.window.title)) {
      last = null
      return fail(OWN)
    }
    if (touchesSecrets(data.window.title)) {
      last = null
      return fail(
        `That window has a file of keys or passwords in front (${data.window.title}); it is not read and nothing is ` +
          'typed into it. If the app has tabs, ctrl+n (a new tab) or ctrl+tab is fine — then read the window again.',
      )
    }
    remember(data)
    return text(formatRead(data))
  }

  /**
   * After an action, the window read again and what changed in it — so she
   * can usually answer without a separate look, one model turn (~3 s) saved.
   */
  async function after(windowId) {
    if (windowId == null) return ''
    const before = last?.window.id === windowId ? last.items : null
    await new Promise((r) => setTimeout(r, SETTLE_MS))
    let data
    try {
      data = await call('read', { window: String(windowId) })
    } catch {
      return '' // closed by the action, or busy: she can look herself
    }
    if (!data?.window) return ''
    if (touchesSecrets(data.window.title)) {
      last = null
      return ''
    }
    remember(data)
    return `\n\n${redactSecrets(describeChanges(before, data))}`
  }

  /** The control behind a ref from the last read. */
  const control = (ref) => {
    const el = last?.refs.get(ref)
    if (!el) throw new Error(`There is no ref ${ref} — read the window first.`)
    return el
  }

  const reading = [
    tool('apps_list', 'List the windows open on the laptop: id, title and app.', {}, guard(async () => {
      const { windows } = await call('list')
      return text(formatWindows(windows))
    })),

    tool(
      'apps_screenshot',
      `See a window as a picture (it also shows on the HUD); works even behind other windows.${sendPhoto ? PHONE_HINT : ''} Reading is faster when only the words matter.`,
      { window: which, toOwner: z.boolean().optional() },
      guard(async ({ window, toOwner = false }) => {
        const { window: target } = await call('describe', { window: String(window) })
        if (isOwnWindow(target.title)) return fail(OWN)
        // A picture cannot be blanked the way read text is: a window of secrets,
        // or one whose words show a key or a password, is not pictured at all.
        if (touchesSecrets(target.title)) return fail('That window shows a file of keys or passwords; it is not pictured.')
        const seen = await call('read', { window: String(target.id) }).catch(() => null)
        // The raw words (formatRead blanks them, which would hide the very thing looked for).
        const words = (seen?.items ?? []).map((i) => i.text ?? `${i.name ?? ''} ${i.value ?? ''}`).join('\n')
        if (seen && redactSecrets(words) !== words) {
          return fail('That window shows something like a key or a password, so it is not pictured.')
        }
        if (seen) remember(seen)
        const { jpeg, window: w } = await call('shot', { window: String(target.id) })
        emitBlade?.({
          id: `win-${Date.now().toString(36)}`,
          title: String(w.title).toUpperCase().slice(0, 40),
          kind: 'image',
          url: `data:image/jpeg;base64,${jpeg}`,
          size: 'wide',
          hold: 'turn',
        })
        const sent = toOwner && sendPhoto ? await sendPhoto(jpeg, `${w.title} (${w.app})`) : null
        const note = photoNote(toOwner, sent)
        return { content: [{ type: 'image', data: jpeg, mimeType: 'image/jpeg' }, ...(note ? [{ type: 'text', text: note }] : [])] }
      }),
    ),

    tool(
      'apps_read',
      "Read a window: its text and its controls, each with a [ref]. Read before acting; clicks, typing and key presses then report what changed by themselves. For websites use the browser_* tools.",
      { window: which },
      guard(async ({ window }) => read(window)),
    ),
  ]

  const acting = [
    tool(
      'apps_open',
      'Open a Windows app by its Start-menu name (Notepad, Calculator, Settings, File Explorer, Spotify…) and read its window.',
      { name: z.string() },
      guard(async ({ name }) => {
        const opened = await call('open', { name }, OPEN_TIMEOUT_MS)
        if (!opened.window) return text(`Started ${opened.app}; its window hasn't appeared yet — list the windows in a moment.`)
        const shown = await read(opened.window.id)
        if (shown.isError) return shown
        return text(`Opened ${opened.app}.\n\n${shown.content[0].text}`)
      }),
    ),

    tool('apps_focus', 'Bring a window to the front (restoring it if minimised).', { window: which }, guard(async ({ window }) => {
      const { window: w } = await call('focus', { window: String(window) })
      return text(`${label(w)} is in front.`)
    })),

    tool(
      'apps_click',
      'Press controls by their refs from apps_read — a button, menu item, tab, check box, list item or link. Several refs press them in order in one go (calculator keys, a row of choices). Buying, sending, deleting and security settings ask the owner first, by themselves.',
      { refs: z.array(z.number().int()).min(1).describe('One or more refs, pressed in this order') },
      guard(async ({ refs }) => {
        const pressed = []
        for (const ref of refs) {
          const el = control(ref)
          const name = el.name || el.type
          if (!(await allowed({ action: 'click', label: name }, last.window, 'apps_click', `Click "${name}"`))) {
            const done = pressed.length ? ` (pressed first: ${pressed.join(', ')})` : ''
            return fail(`The owner did not approve clicking "${name}"${done}. Leave it and say so in one sentence.`)
          }
          const { waiting } = await call('click', { ref })
          pressed.push(`"${name}"`)
          // A dialog took over; pressing on in the old window would miss.
          if (waiting) {
            return text(`Clicked ${pressed.join(', ')}. A window opened and is waiting — list the windows to find it.`)
          }
        }
        const clicked = last.window.id
        return text(`Clicked ${pressed.join(', ')}.${await after(clicked)}`)
      }),
    ),

    tool(
      'apps_type',
      'Type text into a box or document by its ref (the focused one if left out). A box is replaced and a document added to, unless `replace` says otherwise. New lines are safe: they never send. Typing a password asks the owner first.',
      { ref: z.number().int().optional(), text: z.string(), replace: z.boolean().optional() },
      guard(async ({ ref, text: typed, replace }) => {
        let el
        let win
        if (ref != null) {
          el = control(ref)
          win = last.window
        } else {
          const f = await call('focused')
          el = f
          win = f.window
        }
        if (isOwnWindow(win?.title)) return fail(OWN)
        const field = fieldOf(el)
        if (field === 'password' && !(await allowed({ action: 'type', field, label: el.name }, win, 'apps_type', `Type a password into "${el.name || 'a box'}"`))) {
          return fail('The owner did not approve typing a password. Ask them to type it themselves.')
        }
        if (touchesSecrets(win?.title)) return fail('That window shows a file of keys or passwords; it is not changed.')
        await call('type', { ref, text: typed, replace })
        return text(`Typed into "${el.name || el.type || 'the focused box'}" in ${label(win)}.${await after(win?.id)}`)
      }),
    ),

    tool(
      'apps_press',
      'Press keys: "ctrl+s", "alt+f4", "down down enter", "f5". Give `window` to bring it to the front first. Enter outside a search box (it may send) and Shift+Delete ask the owner first.',
      { keys: z.string(), window: which.optional() },
      guard(async ({ keys, window }) => {
        const sendKeys = toSendKeys(keys)
        if (window != null) await call('focus', { window: String(window) })
        const f = await call('focused')
        if (isOwnWindow(f.window?.title)) return fail(OWN)
        if (touchesSecrets(f.window?.title) && !BESIDE_SECRETS.test(keys.trim())) {
          return fail('A file of keys or passwords is in front there; only ctrl+n (a new tab) or ctrl+tab is pressed in it.')
        }
        const what = `Press ${keys} in "${f.name || f.type || 'the window'}"`
        if (!(await allowed({ action: 'press', keys, label: f.name, field: fieldOf(f) }, f.window, 'apps_press', what))) {
          return fail(`The owner did not approve pressing ${keys} there. Leave it.`)
        }
        await call('keys', { keys: sendKeys })
        return text(`Pressed ${keys} in ${label(f.window)}.${await after(f.window?.id)}`)
      }),
    ),

    tool('apps_close', 'Close a window. If it asks to save, read it and decide with the owner.', { window: which }, guard(async ({ window }) => {
      const { window: target } = await call('describe', { window: String(window) })
      if (isOwnWindow(target.title)) return fail(OWN)
      const { window: w, waiting } = await call('close', { window: String(target.id) })
      if (last?.window.id === w.id) last = null
      return text(waiting ? `${label(w)} is asking something before it closes — read it.` : `Closed ${label(w)}.`)
    })),
  ]

  return allowWrites ? [...reading, ...acting] : reading
}

/** The `ayra_apps` server; options as appsTools. */
export const appsServer = (options) =>
  createSdkMcpServer({
    name: 'ayra_apps',
    version: '1.0.0',
    instructions:
      "The owner's Windows apps. Read a window before acting in it and act by ref; each action reports what changed.",
    alwaysLoad: true,
    tools: appsTools(options),
  })
