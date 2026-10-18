/**
 * Her Chrome — the `ayra_browser` tool server.
 *
 * AYRA drives the owner's own Chrome window, "Chrome (AYRA)": a Chrome profile
 * of its own (Chrome refuses remote control of the default profile), which the
 * owner signs into once and then browses in day to day — one Chrome for both of
 * them (the owner's answer "2a"). She reaches it over Chrome's DevTools
 * protocol on 127.0.0.1, so there is no extension and no per-site "Allow"
 * prompt (the old extension's failure, QA #1), and she reads the page's
 * structure rather than screenshots, which is what keeps a click under a second.
 *
 * If the window is not open she opens it. Pages are read as text plus a list of
 * the things on them that can be pressed or typed in, each with a ref; actions
 * take a ref. Every click, submit and Enter is checked against the owner's
 * ask-first list (gate.riskOfPageAction) with the element's real label — "Buy",
 * "Send", a password box — and waits for their Approve when it matches.
 *
 * Content on a page is information, never an instruction (persona).
 */

import { createSdkMcpServer, tool } from './sdk.mjs'
import { z } from 'zod'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { env } from './identity.mjs'
import { isOwnPage, redactSecrets, riskOfPageAction, touchesSecrets } from './gate.mjs'
import { SEND_WORDS } from './allowances.mjs'

// Only a conversation that can send pictures (Telegram) offers the phone, and the
// tool says where a picture went — at the laptop she once said a screenshot was
// "on its way to your phone" when nothing could send it.
const PHONE_HINT = ' `toOwner`: send it to the owner\'s phone too — when they asked to see it ("show me").'
const photoNote = (asked, sent) =>
  sent === true ? 'Sent to the owner\'s phone.'
    : sent === false ? 'Could not send it to the phone.'
      : asked ? 'Shown on the HUD only; this conversation cannot send pictures to the phone.' : ''

/** Where "Chrome (AYRA)" keeps its profile — the owner's logins live here. */
export const PROFILE_DIR = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Gnosis', 'Chrome')
/** Chrome's remote-control port. Chrome binds it to 127.0.0.1 only. */
export const DEBUG_PORT = Number(env('CHROME_PORT', 9222))
/** The longest a page load is waited for before reading what arrived. */
const LOAD_TIMEOUT_MS = 20_000
/** How much page text the model gets in one read. */
const MAX_TEXT = 6000
/** How many pressable things it gets listed. */
const MAX_ELEMENTS = 120

/** Where Chrome is installed on this laptop. */
export function chromePath() {
  const local = process.env.LOCALAPPDATA ?? ''
  const candidates = [
    env('CHROME_PATH'),
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean)
  return candidates.find((p) => existsSync(p)) ?? null
}

/** The flags "Chrome (AYRA)" runs with — the same for her and for the owner's shortcut. */
export const chromeArgs = (extra = []) => [
  `--user-data-dir=${PROFILE_DIR}`,
  `--remote-debugging-port=${DEBUG_PORT}`,
  '--no-first-run',
  '--no-default-browser-check',
  // Her face lives in this Chrome and must keep its timing while the owner works
  // in another app (hands-free, 2026-10-11): Chrome otherwise slows the timers of
  // a hidden or covered window to once a second, then once a minute.
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  ...extra,
]

/**
 * Only web pages. A model that has just read an untrusted page must not be
 * able to steer the browser to a local file or Chrome's own settings by URL.
 */
export function safeUrl(raw) {
  let url
  try {
    url = new URL(String(raw ?? '').trim())
  } catch {
    try {
      url = new URL(`https://${String(raw ?? '').trim()}`)
    } catch {
      return null
    }
  }
  return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null
}

/** Sites where AYRA may allow the microphone, camera and the like herself. */
export function trustedSites() {
  return ['localhost', '127.0.0.1', ...env('TRUSTED_SITES', '').split(',')]
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
}

export const isTrusted = (origin, sites = trustedSites()) => {
  let host
  try {
    host = new URL(origin).hostname.toLowerCase()
  } catch {
    return false
  }
  return sites.some((s) => host === s || host.endsWith(`.${s}`))
}

// ---------------------------------------------------------------------------
// The connection — one for every conversation
// ---------------------------------------------------------------------------

let browser = null
let connecting = null

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function reachable() {
  try {
    const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`, { signal: AbortSignal.timeout(800) })
    return res.ok
  } catch {
    return false
  }
}

/** Attach to "Chrome (AYRA)", starting it first if it isn't running. */
async function connect() {
  if (browser?.connected) return browser
  connecting ??= (async () => {
    const { default: puppeteer } = await import('puppeteer-core')
    if (!(await reachable())) {
      const exe = chromePath()
      if (!exe) throw new Error('Chrome is not installed on this laptop.')
      spawn(exe, chromeArgs(), { detached: true, stdio: 'ignore' }).unref()
      for (let i = 0; i < 40 && !(await reachable()); i++) await wait(250)
    }
    const b = await puppeteer.connect({ browserURL: `http://127.0.0.1:${DEBUG_PORT}`, defaultViewport: null })
    b.on('disconnected', () => {
      if (browser === b) browser = null
    })
    // Her own face always has the microphone in her own window.
    await b.defaultBrowserContext().overridePermissions('http://localhost:5173', ['microphone']).catch(() => {})
    browser = b
    return b
  })().finally(() => {
    connecting = null
  })
  return connecting
}

/**
 * Open an address in a new tab of her Chrome and bring it forward, without
 * waiting for the page: the fast path (fastpath.mjs) says "Opening …" while it
 * loads. Only http(s) addresses, never her own face.
 */
export async function openInChrome(url) {
  const target = safeUrl(url)
  if (!target || isOwnPage(target)) throw new Error('Only web addresses can be opened.')
  const b = await connect()
  const page = await b.newPage()
  void page.goto(target, { waitUntil: 'domcontentloaded', timeout: LOAD_TIMEOUT_MS }).catch(() => {})
  await page.bringToFront().catch(() => {})
}

/**
 * Normal web tabs, in window order — never her own face, which shares this
 * Chrome: its Approve card must stay out of reach of her own clicks.
 */
async function tabs() {
  const b = await connect()
  return (await b.pages()).filter((p) => !p.url().startsWith('devtools://') && !isOwnPage(p.url()))
}

/**
 * The tab to act in: the one asked for, else the one this conversation was in,
 * else the one in front. `me` is the conversation's own place (browserServer):
 * a background job and the HUD never share a tab or a set of refs.
 */
async function pick(me, index) {
  const all = await tabs()
  if (Number.isInteger(index)) {
    const page = all[index - 1]
    if (!page) throw new Error(`There is no tab ${index}; there are ${all.length}.`)
    return page
  }
  if (me.current && !me.current.isClosed() && all.includes(me.current)) return me.current
  for (const page of all) {
    const visible = await page.evaluate(() => document.visibilityState === 'visible').catch(() => false)
    if (visible) return page
  }
  return all.at(-1) ?? (await (await connect()).newPage())
}

const host = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/**
 * Runs inside the page: resolves once nothing in the document has changed for
 * `quietMs`, or after `capMs` whatever happens. Plain browser JavaScript.
 */
function domQuiet(quietMs, capMs) {
  return new Promise((resolve) => {
    let timer = 0
    const done = () => {
      obs.disconnect()
      clearTimeout(timer)
      clearTimeout(cap)
      resolve(true)
    }
    const obs = new MutationObserver(() => {
      clearTimeout(timer)
      timer = setTimeout(done, quietMs)
    })
    obs.observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
    timer = setTimeout(done, quietMs)
    const cap = setTimeout(done, capMs)
  })
}

/** Shortest settle: a click handler that navigates after a beat is still caught. */
const SETTLE_MIN_MS = 250

/**
 * After a click or Enter: wait for a navigation to land, or for the page to
 * stop changing. It used to be a flat race against 900 ms, paid in full on
 * every click that changed the page in place (most of them) — the audit of
 * 2026-10-12 counted ~2.5 s of fixed waits per click. Now a page that is quiet
 * 150 ms after the click goes on at once, and a navigation (seen by its main-
 * frame request) is still waited for.
 */
function watch(page) {
  // Watching starts BEFORE the click or key: a link's navigation request goes
  // out within the 80 ms press() waits, and a watcher attached afterwards
  // missed it and read the page being left (review, 2026-10-12).
  let navigating = false
  const onRequest = (req) => {
    if (req.isNavigationRequest() && req.frame() === page.mainFrame()) navigating = true
  }
  page.on('request', onRequest)
  const nav = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 4000 }).then(() => 'nav', () => null)
  return async () => {
    try {
      const quiet = Promise.all([page.evaluate(domQuiet, 150, 900), wait(SETTLE_MIN_MS)]).then(() => 'quiet', () => 'gone')
      const first = await Promise.race([nav, quiet])
      // The document went away under the probe, or a navigation began: wait for the new page.
      if (first !== 'nav' && (first === 'gone' || navigating)) await nav
    } finally {
      page.off('request', onRequest)
    }
  }
}
// ---------------------------------------------------------------------------
// Reading a page
// ---------------------------------------------------------------------------

/**
 * Runs inside the page: the visible text, and everything that can be pressed or
 * typed in, numbered in the conversation's own attribute (`attr`). Kept as plain
 * browser JavaScript — it is serialised into the page.
 */
function snapshot(maxText, maxElements, attr) {
  // Last read's numbers go first: an element that has since vanished must not
  // keep a number the new read hands to something else.
  for (const old of document.querySelectorAll(`[${attr}]`)) old.removeAttribute(attr)
  const sel = [
    'a[href]', 'button', 'input:not([type=hidden])', 'select', 'textarea', 'summary',
    '[role=button]', '[role=link]', '[role=tab]', '[role=menuitem]', '[role=option]',
    '[role=checkbox]', '[role=switch]', '[role=textbox]', '[role=searchbox]', '[role=combobox]',
    '[contenteditable=""]', '[contenteditable=true]',
  ].join(',')
  const seen = []
  let n = 0
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect()
    const style = getComputedStyle(el)
    if (r.width < 2 || r.height < 2 || style.visibility === 'hidden' || style.display === 'none') continue
    const tag = el.tagName.toLowerCase()
    const type = (el.getAttribute('type') || '').toLowerCase()
    const role = el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'input' || tag === 'textarea' ? 'textbox' : tag)
    const label = (
      el.getAttribute('aria-label') || el.innerText || el.getAttribute('placeholder') ||
      el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('name') || el.value || ''
    ).replace(/\s+/g, ' ').trim().slice(0, 80)
    const searchy = type === 'search' || role === 'searchbox' || role === 'combobox' ||
      /search|query|^q$/i.test(`${el.getAttribute('name') || ''} ${el.getAttribute('placeholder') || ''} ${el.getAttribute('aria-label') || ''}`)
    const field = type === 'password' ? 'password' : searchy ? 'search' : role === 'textbox' || el.isContentEditable ? 'text' : ''
    el.setAttribute(attr, String(++n))
    const inView = r.bottom > 0 && r.top < innerHeight
    seen.push({ ref: n, role, label, field, inView })
  }
  // What is on screen first: that is what the owner is looking at.
  seen.sort((a, b) => Number(b.inView) - Number(a.inView))
  return {
    title: document.title,
    url: location.href,
    text: (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n').trim().slice(0, maxText),
    elements: seen.slice(0, maxElements),
    more: Math.max(0, seen.length - maxElements),
  }
}

/**
 * The page as text the model can act on. `maxText` is smaller for the read an
 * action hands back by itself (see `now`).
 */
async function read(page, attr, maxText = MAX_TEXT) {
  const s = await page.evaluate(snapshot, maxText, MAX_ELEMENTS, attr)
  const list = s.elements
    .map((e) => `[${e.ref}] ${e.role}${e.field ? `(${e.field})` : ''} "${e.label}"`)
    .join('\n')
  return redactSecrets(
    `Tab: ${s.title} — ${s.url}\n\nThings you can press or type in (use the number as ref):\n${list || '(none)'}` +
    `${s.more ? `\n…and ${s.more} more further down; scroll and read again.` : ''}` +
    `\n\nPage text:\n${s.text}`
  )
}

/** Page text in the read an action hands back by itself. */
const AFTER_TEXT = 2000

/**
 * The page an action left behind, read at once — so she can usually go on
 * without a separate browser_read: one model step (~2–4 s) saved per action,
 * as apps.mjs already does for windows. Refs are renumbered by this read.
 */
async function now(page, attr) {
  try {
    return `\n\nThe page now (refs renumbered):\n${await read(page, attr, AFTER_TEXT)}`
  } catch {
    return '' // still loading or closed: she can read it herself
  }
}

/** What the element behind a ref is, for the ask-first check. */
async function describe(page, ref, attr) {
  const info = await page.evaluate((r, a) => {
    const el = document.querySelector(`[${a}="${r}"]`)
    if (!el) return null
    const type = (el.getAttribute('type') || '').toLowerCase()
    const label = (
      el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('placeholder') ||
      el.getAttribute('title') || el.getAttribute('name') || ''
    ).replace(/\s+/g, ' ').trim().slice(0, 80)
    const role = el.getAttribute('role') || ''
    const searchy = type === 'search' || role === 'searchbox' || role === 'combobox' ||
      /search|query|^q$/i.test(`${el.getAttribute('name') || ''} ${el.getAttribute('placeholder') || ''} ${el.getAttribute('aria-label') || ''}`)
    return { label, field: type === 'password' ? 'password' : searchy ? 'search' : 'text' }
  }, String(ref), attr)
  if (!info) throw new Error(`Nothing has ref ${ref} on this page any more — read the page again.`)
  return info
}

/**
 * Press an element: a real mouse click first, then a check that it landed.
 *
 * With the laptop left alone — display off, the owner on the phone — Chrome's
 * mouse clicks miss: measured 2026-10-07, the click arrived on the page itself,
 * not the button, while keyboard input was fine. So the click is checked:
 *   - it reached the element: done;
 *   - it reached nothing pressable (the page, an empty area): it is pressed from
 *     inside the page instead, with the pointer and mouse events a click makes;
 *   - it reached another button or link (a popup, an overlay in the way): that
 *     may already have done something, so it is reported, never followed by a
 *     second press.
 * Never two presses of anything: that is what keeps a "Post" from going twice.
 */
async function press(el) {
  // Heard on the window, first of anything on the page, wherever it lands.
  await el.evaluate((e) => {
    window.__ayraClick = null
    window.removeEventListener('click', window.__ayraProbe, true)
    window.__ayraProbe = (ev) => {
      const hit = ev.composedPath().includes(e)
      const other = !hit && ev.target instanceof Element &&
        Boolean(ev.target.closest('a[href],button,input,select,textarea,summary,label,[role=button],[role=link],[role=menuitem],[role=tab],[onclick]'))
      window.__ayraClick = { hit, other }
    }
    window.addEventListener('click', window.__ayraProbe, { capture: true, once: true })
  })
  await el.click().catch(() => {})
  await new Promise((r) => setTimeout(r, 80))
  // Gone with the page it was on: the click navigated, so it landed.
  const click = await el.evaluate(() => window.__ayraClick).catch(() => ({ hit: true }))
  if (click?.hit) return
  if (click?.other) {
    throw new Error('the click landed on another button or link (a popup or overlay?) — read the page again before trying again')
  }
  await el.evaluate((e) => {
    window.removeEventListener('click', window.__ayraProbe, true)
    e.scrollIntoView({ block: 'center' })
    const r = e.getBoundingClientRect()
    const at = {
      bubbles: true, cancelable: true, composed: true, view: window, button: 0,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
    }
    const pointer = { ...at, pointerId: 1, isPrimary: true, pointerType: 'mouse' }
    e.dispatchEvent(new PointerEvent('pointerdown', pointer))
    e.dispatchEvent(new MouseEvent('mousedown', at))
    e.focus?.()
    e.dispatchEvent(new PointerEvent('pointerup', pointer))
    e.dispatchEvent(new MouseEvent('mouseup', at))
    e.click()
  })
}

/** The kind of box that has the keyboard, for an Enter. */
const focused = (page) =>
  page.evaluate(() => {
    const el = document.activeElement
    if (!el || el === document.body) return { label: '', field: '' }
    const type = (el.getAttribute('type') || '').toLowerCase()
    const role = el.getAttribute('role') || ''
    const searchy = type === 'search' || role === 'searchbox' || role === 'combobox' ||
      /search|query|^q$/i.test(`${el.getAttribute('name') || ''} ${el.getAttribute('placeholder') || ''} ${el.getAttribute('aria-label') || ''}`)
    return { label: (el.getAttribute('aria-label') || '').slice(0, 80), field: type === 'password' ? 'password' : searchy ? 'search' : 'text' }
  })

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

const text = (t) => ({ content: [{ type: 'text', text: t }] })
const fail = (t) => ({ isError: true, content: [{ type: 'text', text: t }] })

/**
 * @param {{ allowWrites: boolean, channel: string,
 *           approve: (request: object) => Promise<boolean>,
 *           emitBlade?: (blade: object) => void,
 *           sendPhoto?: (jpegBase64: string, caption: string) => void }} options
 *   allowWrites — without it only the reading tools exist (CLAUDE.md §7)
 *   approve     — the owner's Approve, for clicks and submits on the ask-first list
 *   emitBlade   — puts a screenshot on the HUD; absent on Telegram
 *   sendPhoto   — sends a screenshot to the owner's phone; Telegram only
 */
export function browserServer({ allowWrites, channel, approve, emitBlade, sendPhoto }) {
  /** This conversation's own tab and ref numbers (see pick). */
  const me = { current: null, attr: `data-ayra-${String(channel).replace(/[^a-z0-9-]/gi, '') || 'x'}` }
  /** Ask the owner when the action is on their list; true to go ahead. */
  const allowed = async (what, page, toolName, detail) => {
    const reason = riskOfPageAction({ ...what, url: page.url() })
    if (!reason) return true
    // "Always" names the exact address ("www.linkedin.com", never all of
    // google.com) and only a click on a plainly sending button — never an
    // Enter or a generic Submit, which can mean anything on a page.
    const site = new URL(page.url()).hostname.toLowerCase()
    const plain = what.action === 'click' && SEND_WORDS.test(what.label ?? '')
    return approve({
      channel, tool: toolName, reason, detail: `${detail} — on ${host(page.url())}`,
      scope: plain ? { kind: 'site', where: site } : null,
    })
  }

  const guard = (fn) => async (args) => {
    try {
      return await fn(args)
    } catch (err) {
      return fail(`Chrome: ${err?.message ?? err}`)
    }
  }

  const reading = [
    tool('browser_tabs', "List the tabs open in the owner's Chrome, numbered.", {}, guard(async () => {
      const all = await tabs()
      const lines = await Promise.all(all.map(async (p, i) => `${i + 1}. ${(await p.title()) || '(untitled)'} — ${p.url()}${p === me.current ? '  ← working here' : ''}`))
      return text(lines.join('\n') || 'No tabs open.')
    })),

    tool(
      'browser_open',
      "Open a web page in the owner's Chrome — in a new tab unless told otherwise — and read it.",
      { url: z.string().describe('The address, e.g. "https://github.com" or "github.com".'), newTab: z.boolean().optional() },
      guard(async ({ url, newTab = true }) => {
        const target = safeUrl(url)
        if (!target) return fail('Only web addresses (http or https) can be opened.')
        if (isOwnPage(target)) return fail("That is Gnosis's own window; her tools leave it alone.")
        const b = await connect()
        const page = newTab ? await b.newPage() : await pick(me)
        await page.goto(target, { waitUntil: 'domcontentloaded', timeout: LOAD_TIMEOUT_MS }).catch(() => {})
        await page.bringToFront().catch(() => {})
        me.current = page
        return text(await read(page, me.attr))
      }),
    ),

    tool(
      'browser_read',
      'Read a tab: its text, and everything on it that can be pressed or typed in, with refs to use. Read again after the page changes.',
      { tab: z.number().int().optional().describe('Tab number from browser_tabs; the current tab if left out.') },
      guard(async ({ tab }) => {
        const page = await pick(me, tab)
        me.current = page
        return text(await read(page, me.attr))
      }),
    ),

    tool('browser_switch', 'Bring a tab to the front and work in it.', { tab: z.number().int() }, guard(async ({ tab }) => {
      const page = await pick(me, tab)
      await page.bringToFront()
      me.current = page
      return text(`Now on tab ${tab}: ${await page.title()}`)
    })),

    tool(
      'browser_scroll',
      'Scroll the current tab up or down, then read it again to see what came into view.',
      { direction: z.enum(['up', 'down', 'top', 'bottom']) },
      guard(async ({ direction }) => {
        const page = await pick(me)
        await page.evaluate((d) => {
          if (d === 'top') scrollTo(0, 0)
          else if (d === 'bottom') scrollTo(0, document.body.scrollHeight)
          else scrollBy(0, (d === 'down' ? 1 : -1) * innerHeight * 0.85)
        }, direction)
        return text(`Scrolled ${direction}.`)
      }),
    ),

    tool('browser_back', 'Go back a page in the current tab.', {}, guard(async () => {
      const page = await pick(me)
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: LOAD_TIMEOUT_MS }).catch(() => {})
      return text(`Went back.${await now(page, me.attr)}`)
    })),

    tool(
      'browser_screenshot',
      `See the current tab as a picture (it also shows on the HUD).${sendPhoto ? PHONE_HINT : ''} Use when the layout matters or they want to see; reading is faster.`,
      { toOwner: z.boolean().optional() },
      guard(async ({ toOwner = false }) => {
        const page = await pick(me)
        // A picture can't be blanked the way read text is: a page showing a key,
        // a token or a password is not pictured at all.
        const words = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '')
        if (touchesSecrets(page.url()) || redactSecrets(words) !== words) {
          return fail('That page shows something like a key or a password, so it is not pictured. Say so in one sentence.')
        }
        const data = await page.screenshot({ type: 'jpeg', quality: 60, encoding: 'base64' })
        emitBlade?.({
          id: `shot-${Date.now().toString(36)}`,
          title: host(page.url()).toUpperCase().slice(0, 30) || 'CHROME',
          kind: 'image',
          url: `data:image/jpeg;base64,${data}`,
          size: 'wide',
          hold: 'turn',
        })
        const sent = toOwner && sendPhoto ? await sendPhoto(data, `${await page.title()} — ${host(page.url())}`) : null
        const note = photoNote(toOwner, sent)
        return { content: [{ type: 'image', data, mimeType: 'image/jpeg' }, ...(note ? [{ type: 'text', text: note }] : [])] }
      }),
    ),
  ]

  const acting = [
    tool(
      'browser_click',
      'Press a button or link by its ref from browser_read. Buying, sending, posting and deleting ask the owner first, by themselves.',
      { ref: z.number().int() },
      guard(async ({ ref }) => {
        const page = await pick(me)
        const { label } = await describe(page, ref, me.attr)
        if (!(await allowed({ action: 'click', label }, page, 'browser_click', `Click "${label}"`))) {
          return fail(`The owner did not approve clicking "${label}". Leave it and say so in one sentence.`)
        }
        const el = await page.$(`[${me.attr}="${ref}"]`)
        // A link that opens a new tab: she follows it there. A new tab shows up
        // within ~150 ms of the click, so it is looked for while the page
        // settles — not waited on for 1.5 s after every click that opens none.
        const b = page.browser()
        const before = new Set(b.targets())
        const isChild = (t) => t.opener() === page.target() && !before.has(t)
        const opened = b.waitForTarget(isChild, { timeout: 1500 }).catch(() => null)
        const settled = watch(page)
        await press(el)
        await settled()
        const target = (await Promise.race([opened, wait(100).then(() => null)])) ?? b.targets().find(isChild)
        const tab = target ? await target.page().catch(() => null) : null
        if (tab) {
          me.current = tab
          // A new tab starts on about:blank: wait for its own address before reading it.
          await tab.waitForFunction(() => location.href !== 'about:blank', { timeout: 4000 }).catch(() => {})
          await tab.waitForFunction(() => document.readyState !== 'loading', { timeout: 4000 }).catch(() => {})
          return text(`Clicked "${label}"; it opened a new tab: ${await tab.title()} — ${tab.url()}. Working there now.${await now(tab, me.attr)}`)
        }
        return text(`Clicked "${label}".${await now(page, me.attr)}`)
      }),
    ),

    tool(
      'browser_type',
      'Type into a box by its ref; `submit` presses Enter after. Typing a password, or submitting anything but a search, asks the owner first.',
      { ref: z.number().int(), text: z.string(), submit: z.boolean().optional() },
      guard(async ({ ref, text: typed, submit = false }) => {
        const page = await pick(me)
        const { label, field } = await describe(page, ref, me.attr)
        if (field === 'password' && !(await allowed({ action: 'type', field, label }, page, 'browser_type', `Type a password into "${label}"`))) {
          return fail('The owner did not approve typing a password. Ask them to sign in themselves.')
        }
        const el = await page.$(`[${me.attr}="${ref}"]`)
        // Select what is there from inside the page, so the typing replaces it —
        // a triple click is a mouse action, and those can be dropped (see press).
        await el.evaluate((e) => {
          e.focus()
          if (typeof e.select === 'function') e.select()
          else if (e.isContentEditable) {
            const range = document.createRange()
            range.selectNodeContents(e)
            const sel = getSelection()
            sel?.removeAllRanges()
            sel?.addRange(range)
          }
        })
        await el.type(typed)
        if (submit) {
          const shown = field === 'password' ? '••••' : `"${typed.slice(0, 80)}"`
          if (!(await allowed({ action: 'enter', field, label }, page, 'browser_type', `Send ${shown} from "${label}"`))) {
            return fail('Typed it, but the owner did not approve sending it — it is left unsent in the box.')
          }
          const settled = watch(page)
          await page.keyboard.press('Enter')
          await settled()
          return text(`Typed into "${label}" and pressed Enter.${await now(page, me.attr)}`)
        }
        return text(`Typed into "${label}". Now on: ${await page.title()}.`)
      }),
    ),

    tool(
      'browser_press',
      'Press a key in the current tab (Enter, Escape, Tab, ArrowDown…). Enter outside a search box asks the owner first.',
      { key: z.string() },
      guard(async ({ key }) => {
        const page = await pick(me)
        if (/^enter$/i.test(key)) {
          const f = await focused(page)
          if (!(await allowed({ action: 'enter', field: f.field, label: f.label }, page, 'browser_press', `Press Enter in "${f.label || 'the focused box'}"`))) {
            return fail('The owner did not approve pressing Enter there. Leave it.')
          }
        }
        const settled = watch(page)
        await page.keyboard.press(key)
        await settled()
        // Enter usually changes the page; Tab or an arrow key usually doesn't need a read.
        return text(`Pressed ${key}.${/^enter$/i.test(key) ? await now(page, me.attr) : ''}`)
      }),
    ),

    tool('browser_close', 'Close a tab by its number (the current tab if left out).', { tab: z.number().int().optional() }, guard(async ({ tab }) => {
      const page = await pick(me, tab)
      const title = await page.title()
      await page.close()
      if (me.current === page) me.current = null
      return text(`Closed "${title}".`)
    })),

    tool(
      'browser_allow',
      'Let a site use the microphone, camera, notifications or location in Chrome. Trusted sites get it at once; any other asks the owner.',
      {
        site: z.string().describe('The site, e.g. "https://meet.google.com".'),
        permissions: z.array(z.enum(['microphone', 'camera', 'notifications', 'geolocation'])),
      },
      guard(async ({ site, permissions }) => {
        const origin = safeUrl(site)
        if (!origin) return fail('That is not a web address.')
        const o = new URL(origin).origin
        if (!isTrusted(o)) {
          const ok = await approve({
            channel, tool: 'browser_allow', reason: 'touches passwords or security settings',
            detail: `Let ${host(o)} use: ${permissions.join(', ')}`,
          })
          if (!ok) return fail('The owner did not approve. Leave the permissions as they are.')
        }
        await (await connect()).defaultBrowserContext().overridePermissions(o, permissions)
        return text(`${host(o)} may now use: ${permissions.join(', ')}.`)
      }),
    ),
  ]

  return createSdkMcpServer({
    name: 'ayra_browser',
    version: '1.0.0',
    instructions:
      "The owner's Chrome. Read a page before acting on it and act by ref; clicks, Enter and going back hand back the page they leave, so read again only when that wasn't enough.",
    alwaysLoad: true,
    tools: allowWrites ? [...reading, ...acting] : reading,
  })
}
