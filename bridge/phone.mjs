/**
 * The owner's Android phone, over ADB, ported from Gnosis v1 (gnosis/phone/adb.py).
 *
 * Wireless debugging, paired once (phone_pair with the code the phone shows); the address is kept in
 * data/phone.json and reconnected on the next use. Everything is a plain adb command: intents for
 * calls, messages and apps; `dumpsys` for battery and notifications; the contacts provider for
 * names; and `uiautomator dump` to find the Send button and tap it.
 *
 * Calling and sending as the owner are asked about first, every time (gate.mjs review): the owner's
 * "asks first: sending as you".
 */

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { createSdkMcpServer, tool } from './sdk.mjs'

export const PHONE_FILE = fileURLToPath(new URL('../data/phone.json', import.meta.url))

export const APP_ALIASES = {
  whatsapp: 'com.whatsapp', youtube: 'com.google.android.youtube', spotify: 'com.spotify.music',
  instagram: 'com.instagram.android', chrome: 'com.android.chrome', maps: 'com.google.android.apps.maps',
  gmail: 'com.google.android.gm', camera: 'com.android.camera', settings: 'com.android.settings',
  phone: 'com.google.android.dialer', dialer: 'com.google.android.dialer', messages: 'com.google.android.apps.messaging',
  photos: 'com.google.android.apps.photos', telegram: 'org.telegram.messenger',
  calendar: 'com.google.android.calendar', clock: 'com.google.android.deskclock',
}

/** adb from PATH or Android Studio's SDK, or null. */
export function findAdb(environ = process.env, exists = existsSync) {
  const sdk = environ.LOCALAPPDATA ? join(environ.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', 'adb.exe') : null
  const onPath = (environ.PATH ?? environ.Path ?? '').split(process.platform === 'win32' ? ';' : ':')
    .map((d) => join(d, process.platform === 'win32' ? 'adb.exe' : 'adb'))
  return [environ.ADB_PATH, ...onPath, sdk].find((p) => p && exists(p)) ?? null
}

/** Runs adb with arguments; resolves stdout, rejects with its error text. */
export function adbRunner(adbPath) {
  return (args, timeout = 20_000) => new Promise((resolve, reject) => {
    execFile(adbPath, args, { windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || stdout || err.message).trim() || `adb ${args[0]} failed`))
      else resolve(stdout)
    })
  })
}

/** A phone number as dialled: digits and a leading +. */
export function normalizeNumber(number) {
  const keep = String(number).replace(/[^\d+]/g, '')
  if (!/^\+?\d{3,15}$/.test(keep)) throw new Error(`"${number}" doesn't look like a phone number`)
  return keep
}

/** Quoted for the phone's shell. */
export const sh = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`

/** `uiautomator dump` → [{ text, desc, id, x, y }] with each node's middle. */
export function parseUiDump(xml) {
  const out = []
  for (const m of String(xml).matchAll(/<node\b[^>]*>/g)) {
    const attr = (k) => (new RegExp(`\\b${k}="([^"]*)"`).exec(m[0])?.[1] ?? '')
    const b = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(attr('bounds'))
    if (!b) continue
    const [l, t, r, bo] = b.slice(1).map(Number)
    out.push({ text: attr('text'), desc: attr('content-desc'), id: attr('resource-id'), x: (l + r) >> 1, y: (t + bo) >> 1 })
  }
  return out
}

/** `dumpsys notification --noredact` → [{ app, title, text }], newest first, without repeats. */
export function parseNotifications(dump) {
  const all = []
  let current = null
  for (const raw of String(dump).split(/\r?\n/)) {
    const line = raw.trim()
    const rec = /NotificationRecord\(.*?pkg=(\S+)/.exec(line)
    if (rec) {
      current = { app: rec[1], title: '', text: '' }
      all.push(current)
      continue
    }
    if (!current) continue
    const m = /^android\.(title|text)=\S+ \((.*)\)$/.exec(line) ?? /^android\.(title|text)=(.*)$/.exec(line)
    if (m && !current[m[1]]) current[m[1]] = m[2].trim()
  }
  const seen = new Set()
  return all.filter((n) => {
    const key = `${n.app}|${n.title}|${n.text}`
    if ((!n.title && !n.text) || n.app === 'android' || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** `content query` rows → [{ name, number }]. */
export function parseContacts(rows) {
  const out = []
  for (const line of String(rows).split(/\r?\n/)) {
    const m = /display_name=(.*?), data1=(.*)$/.exec(line.trim())
    if (!m || !m[1] || m[1] === 'NULL') continue
    try {
      out.push({ name: m[1].trim(), number: normalizeNumber(m[2]) })
    } catch {
      /* not a number */
    }
  }
  return out
}

/** Contacts whose name holds every word asked ("mom", "asha k"); an exact name wins outright. */
export function matchContacts(contacts, who) {
  const words = String(who).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  if (!words.length) return []
  const exact = contacts.filter((c) => c.name.toLowerCase() === String(who).trim().toLowerCase())
  if (exact.length) return dedupe(exact)
  return dedupe(contacts.filter((c) => {
    const name = c.name.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
    return words.every((w) => name.some((n) => n.startsWith(w)))
  }))
}
const dedupe = (list) => [...new Map(list.map((c) => [c.number.replace(/^\+?91/, ''), c])).values()]

/**
 * The phone.
 * @param {{ run: ((args: string[], timeout?: number) => Promise<string>) | null, file?: string,
 *           sleep?: (ms: number) => Promise<void> }} deps
 */
export function createPhone({ run, file = PHONE_FILE, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const adb = (args, timeout) => {
    if (!run) throw new Error("adb isn't installed on this laptop (Android platform-tools).")
    return run(args, timeout)
  }
  const shell = (command, timeout) => adb(['shell', command], timeout)
  const saved = () => {
    try {
      return JSON.parse(readFileSync(file, 'utf8')).address ?? null
    } catch {
      return null
    }
  }
  const save = (address) => {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ address }, null, 2))
  }

  async function devices() {
    // "List of devices attached", then "<serial>\tdevice" for each one ready (not "offline" or "unauthorized").
    return (await adb(['devices'])).split(/\r?\n/).slice(1).map((l) => l.trim().split(/\s+/))
      .filter((p) => p.length >= 2 && p[1] === 'device').map((p) => p[0])
  }

  async function connect(address = saved()) {
    if (!address) throw new Error('No phone paired yet. On the phone: Settings > Developer options > Wireless debugging > Pair device with pairing code, then give me the IP address, port and code.')
    const out = (await adb(['connect', address], 15_000)).trim()
    if (!/connected to|already connected/i.test(out) || /cannot|failed|unable/i.test(out)) throw new Error(out || "couldn't connect")
    save(address)
    return out
  }

  async function ready() {
    if ((await devices()).length) return
    try {
      await connect()
    } catch (err) {
      throw new Error(`Your phone isn't connected (${err.message}). Check that wireless debugging is on and the phone is on the same Wi-Fi.`)
    }
    if (!(await devices()).length) throw new Error("Your phone isn't connected. Check that wireless debugging is on.")
  }

  async function screen() {
    await shell('uiautomator dump /sdcard/gnosis_ui.xml', 30_000)
    return parseUiDump(await shell('cat /sdcard/gnosis_ui.xml'))
  }

  /** Finds the Send button on the phone's screen and taps it. */
  async function tapSend(ids = [], waitMs = 8000) {
    const until = Date.now() + waitMs
    while (Date.now() < until) {
      for (const n of await screen()) {
        const label = `${n.text} ${n.desc}`.trim().toLowerCase()
        if (ids.some((i) => n.id.endsWith(i)) || ['send', 'send message', 'send sms'].includes(label)) {
          await shell(`input tap ${n.x} ${n.y}`)
          return true
        }
      }
      await sleep(1000)
    }
    return false
  }

  let contactCache = null
  async function contacts() {
    if (contactCache && Date.now() - contactCache.at < 10 * 60_000) return contactCache.list
    const rows = await shell('content query --uri content://com.android.contacts/data/phones --projection display_name:data1', 60_000)
    contactCache = { at: Date.now(), list: parseContacts(rows) }
    return contactCache.list
  }

  /** A number for "who": a number as is, or exactly one contact. */
  async function numberFor(who) {
    if (/^[\s\d+()-]{3,}$/.test(String(who))) return { number: normalizeNumber(who), name: '' }
    const found = matchContacts(await contacts(), who)
    if (!found.length) throw new Error(`There's no contact called "${who}" on the phone.`)
    if (found.length > 1) throw new Error(`More than one contact matches "${who}": ${found.slice(0, 6).map((c) => c.name).join(', ')}. Which one?`)
    return found[0]
  }

  const named = (c) => (c.name ? `${c.name} (${c.number})` : c.number)

  return {
    devices,
    connect,
    async pair(address, code) {
      const out = (await adb(['pair', address, String(code)], 30_000)).trim()
      if (!/success/i.test(out)) throw new Error(out || 'pairing failed')
      return out
    },
    async status() {
      await ready()
      const battery = await shell('dumpsys battery')
      const level = /level: (\d+)/.exec(battery)?.[1]
      const charging = /(?:AC|USB|Wireless) powered: true/.test(battery)
      const model = (await shell('getprop ro.product.model')).trim()
      return { model, battery: level ? Number(level) : null, charging }
    },
    async call(who) {
      await ready()
      const c = await numberFor(who)
      await shell(`am start -a android.intent.action.CALL -d ${sh(`tel:${c.number}`)}`)
      return `Calling ${named(c)} on your phone.`
    },
    async hangUp() {
      await ready()
      await shell('input keyevent KEYCODE_ENDCALL')
      return 'Hung up.'
    },
    async sendSms(who, text) {
      await ready()
      const c = await numberFor(who)
      await shell(`am start -a android.intent.action.SENDTO -d ${sh(`sms:${c.number}`)} --es sms_body ${sh(text)} --ez exit_on_sent true`)
      await sleep(1500)
      if (!(await tapSend(['send_message_button_icon', 'send_button']))) {
        return `Opened the message to ${named(c)} with your text, but I couldn't find Send. It's waiting on your phone.`
      }
      return `Sent the text to ${named(c)}.`
    },
    async sendWhatsapp(who, text) {
      await ready()
      const c = await numberFor(who)
      const number = c.number.replace(/^\+/, '')
      // A number without a country code is taken as Indian, where the owner lives.
      const full = number.length === 10 ? `91${number}` : number
      await shell(`am start -a android.intent.action.VIEW -p com.whatsapp -d ${sh(`https://wa.me/${full}?text=${encodeURIComponent(text)}`)}`)
      await sleep(2500)
      if (!(await tapSend(['com.whatsapp:id/send']))) {
        return `Opened the WhatsApp chat with ${named(c)} and your text, but I couldn't find Send. It's waiting on your phone.`
      }
      return `Sent the WhatsApp message to ${named(c)}.`
    },
    async openApp(name) {
      await ready()
      const key = String(name).trim().toLowerCase()
      let pkg = APP_ALIASES[key]
      if (!pkg) {
        const words = key.split(/\W+/).filter(Boolean)
        const all = (await shell('pm list packages')).split(/\r?\n/).filter((l) => l.startsWith('package:'))
          .map((l) => l.slice(8).trim())
        pkg = all.find((p) => words.every((w) => p.toLowerCase().includes(w)))
      }
      if (!pkg) throw new Error(`I couldn't find an app called "${name}" on your phone.`)
      await shell(`monkey -p ${sh(pkg)} -c android.intent.category.LAUNCHER 1`)
      return `Opened ${name} on your phone.`
    },
    async notifications() {
      await ready()
      return parseNotifications(await shell('dumpsys notification --noredact', 30_000))
    },
    async findContact(who) {
      await ready()
      return matchContacts(await contacts(), who)
    },
  }
}

/** The phone tools (server ayra_phone). Calls and messages are asked about first (gate.mjs). */
export function phoneServer(phone) {
  const text = (t) => ({ content: [{ type: 'text', text: t }] })
  const fail = (t) => ({ content: [{ type: 'text', text: t }], isError: true })
  const guard = (fn) => async (args) => {
    try {
      return text(await fn(args))
    } catch (err) {
      return fail(`Phone: ${err?.message ?? err}`)
    }
  }
  const who = z.string().describe('A contact name as the owner said it, or a phone number')
  return createSdkMcpServer({
    name: 'gnosis_phone',
    tools: [
      tool('phone_status', "The owner's Android phone: whether it's connected, its model and battery.", {},
        guard(async () => {
          const s = await phone.status()
          return `${s.model} is connected, battery ${s.battery ?? '?'}%${s.charging ? ' and charging' : ''}.`
        })),
      tool('phone_pair',
        "Pair the owner's phone the first time: on the phone, Settings > Developer options > Wireless debugging > " +
          '"Pair device with pairing code" shows an IP address and port and a six-digit code. Then phone_connect with the ' +
          'address and port shown on the Wireless debugging screen itself (a different port).',
        { address: z.string().describe('IP:port from the pairing dialog'), code: z.string() },
        guard(async ({ address, code }) => `Paired: ${await phone.pair(address, code)}. Now connect with the address on the Wireless debugging screen.`)),
      tool('phone_connect', 'Connect to the paired phone, by the IP:port on its Wireless debugging screen (remembered after).',
        { address: z.string().optional() },
        guard(async ({ address }) => `Connected: ${await phone.connect(address)}`)),
      tool('phone_call', 'Call someone from the owner\'s phone. The owner is asked to approve first.', { who },
        guard(async ({ who: w }) => phone.call(w))),
      tool('phone_hang_up', 'End the call on the owner\'s phone.', {}, guard(async () => phone.hangUp())),
      tool('phone_send_message',
        'Send a text message or a WhatsApp message from the owner\'s phone. The owner is asked to approve first.',
        { who, text: z.string(), app: z.enum(['whatsapp', 'sms']).optional().describe('Default whatsapp') },
        guard(async ({ who: w, text: t, app = 'whatsapp' }) => (app === 'sms' ? phone.sendSms(w, t) : phone.sendWhatsapp(w, t)))),
      tool('phone_open_app', 'Open an app on the owner\'s phone by name.', { name: z.string() },
        guard(async ({ name }) => phone.openApp(name))),
      tool('phone_notifications', "Read the notifications on the owner's phone (messages, missed calls, apps).", {},
        guard(async () => {
          const list = await phone.notifications()
          return list.length ? list.slice(0, 20).map((n) => `${n.app.split('.').pop()}: ${n.title}${n.text ? ` — ${n.text}` : ''}`).join('\n')
            : 'No notifications on the phone.'
        })),
      tool('phone_find_contact', "Look up a contact's number on the owner's phone.", { who },
        guard(async ({ who: w }) => {
          const found = await phone.findContact(w)
          return found.length ? found.slice(0, 8).map((c) => `${c.name}: ${c.number}`).join('\n') : `No contact matches "${w}".`
        })),
    ],
  })
}
