/**
 * The owner's other devices, connected to Gnosis over Wi-Fi: first the Gnosis Android app
 * (android/), which the owner asked for instead of developer-mode ADB (2026-10-19: "i want gnosis to
 * have an apk on my mobile so i can just connect all my devices to gnosis and it can access my phone").
 *
 * The bridge itself only listens on the laptop (127.0.0.1). Devices get their own port on the local
 * network, and nothing there works without a key:
 *   - pair_device makes a one-time six-digit code, good for ten minutes and five wrong tries, and a QR
 *     code for it in Gnosis's window. The QR opens http://<laptop>:<port>/setup/<code>: a page that
 *     downloads the app (only while that code is valid) and hands the code to it (gnosis://pair).
 *   - The app trades the code for its own long key; only the key's hash is kept (data/devices.json).
 *     Any device can be forgotten, which ends its key.
 * Over the link (one WebSocket per device, JSON):
 *   device → bridge  hello{token} | pair{code,name,model} | result{id,ok,data|error} | notification{app,title,text}
 *                    | ask{id,text}
 *   bridge → device  welcome | paired{token} | denied{reason} | command{id,op,args} | answer{id,text} | notice{text}
 */

import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { networkInterfaces } from 'node:os'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'

export const DEVICES_FILE = fileURLToPath(new URL('../data/devices.json', import.meta.url))
export const APK_FILE = fileURLToPath(new URL('../android/app/build/outputs/apk/debug/app-debug.apk', import.meta.url))
export const DEVICE_PORT = 8790

const PAIR_MS = 10 * 60_000
const PAIR_TRIES = 5
const hash = (token) => createHash('sha256').update(token).digest('hex')

/** The laptop's address on the home network: a private IPv4, Wi-Fi first. */
export function lanAddress(nets = networkInterfaces()) {
  const all = Object.entries(nets).flatMap(([name, list]) => (list ?? [])
    .filter((n) => n.family === 'IPv4' && !n.internal && /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(n.address))
    .map((n) => ({ name, address: n.address })))
  const wifi = all.find((n) => /wi-?fi|wlan|wireless/i.test(n.name))
  const virtual = /vethernet|virtualbox|vmware|hyper-v|wsl|docker|loopback|tailscale|zerotier/i
  return (wifi ?? all.find((n) => !virtual.test(n.name)) ?? all[0])?.address ?? null
}

export function setupPage({ code, host, appName = 'Gnosis' }) {
  const deep = `gnosis://pair?host=${encodeURIComponent(host)}&code=${code}`
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${appName} on your phone</title><style>
body{font:17px/1.5 system-ui,sans-serif;background:#141414;color:#eee;margin:0;padding:28px 20px;max-width:520px}
h1{font-size:26px;margin:0 0 6px}p{color:#bbb}a.b{display:block;text-align:center;padding:14px;border-radius:12px;
margin:16px 0;text-decoration:none;font-weight:600}a.p{background:#ef9a4c;color:#141414}a.s{border:1px solid #ef9a4c;color:#ef9a4c}
code{font-size:22px;letter-spacing:4px;color:#ef9a4c}</style></head><body>
<h1>${appName} on your phone</h1>
<p>1. Download the app and install it. Android may ask you to allow installing apps from your browser.</p>
<a class="b p" href="/gnosis.apk?code=${code}">Download the ${appName} app</a>
<p>2. Once it's installed, connect it:</p>
<a class="b s" href="${deep}">Open ${appName} and connect</a>
<p>Or type this in the app: address <b>${host}</b>, code <code>${code}</code>. The code works for ten minutes.</p>
</body></html>`
}

/**
 * @param {{ port?: number, file?: string, apk?: string, host?: () => string | null,
 *           onAsk?: (device: object, text: string, reply: (text: string, done: boolean) => void) => void,
 *           onNotification?: (device: object, n: object) => void, log?: (line: string) => void }} opts
 */
export function createDeviceHub({
  port = DEVICE_PORT, file = DEVICES_FILE, apk = APK_FILE, host = lanAddress, onAsk = null, onNotification = null,
  log = (line) => console.log(`[gnosis] ${line}`), now = Date.now,
} = {}) {
  let known = []
  try {
    known = JSON.parse(readFileSync(file, 'utf8')).devices ?? []
  } catch {
    known = []
  }
  const save = () => {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ devices: known }, null, 2))
  }
  /** The open links: device id → { device, send, pending }. */
  const live = new Map()
  /** The current pairing code, if any. */
  let pairing = null
  /** Recent notifications from devices, newest last. */
  const recent = []
  let server = null
  let wss = null
  let seq = 0

  function newCode() {
    pairing = { code: String(randomInt(0, 1_000_000)).padStart(6, '0'), until: now() + PAIR_MS, tries: 0 }
    return pairing
  }
  const codeOk = (code) => {
    if (!pairing || now() > pairing.until) return false
    const a = Buffer.from(String(code ?? ''))
    const b = Buffer.from(pairing.code)
    const ok = a.length === b.length && timingSafeEqual(a, b)
    if (!ok && ++pairing.tries >= PAIR_TRIES) pairing = null // too many wrong codes: this one is spent
    return ok
  }

  function attach(socket, req) {
    let me = null
    const send = (msg) => socket.readyState === 1 && socket.send(JSON.stringify(msg))
    const pending = new Map()
    const timer = setTimeout(() => !me && socket.close(4001, 'no hello'), 10_000)
    socket.on('message', (raw) => {
      let msg
      try {
        msg = JSON.parse(String(raw))
      } catch {
        return
      }
      if (!me) {
        if (msg.type === 'pair') {
          if (!codeOk(msg.code)) {
            send({ type: 'denied', reason: 'That code is wrong or has run out. Ask Gnosis for a new one.' })
            return socket.close(4003, 'bad code')
          }
          pairing = null // one use
          const token = randomBytes(32).toString('hex')
          const device = { id: randomBytes(6).toString('hex'), name: String(msg.name || msg.model || 'Phone').slice(0, 60),
            model: String(msg.model ?? '').slice(0, 60), kind: 'android', token: hash(token), paired: now(), seen: now() }
          known.push(device)
          save()
          log(`paired a new device: ${device.name} (${device.model})`)
          send({ type: 'paired', token, id: device.id })
          me = device
        } else if (msg.type === 'hello') {
          const h = hash(String(msg.token ?? ''))
          const device = known.find((d) => d.token === h)
          if (!device) {
            send({ type: 'denied', reason: 'This device is no longer paired. Pair it again from Gnosis.' })
            return socket.close(4003, 'unknown device')
          }
          me = device
          device.seen = now()
          if (msg.model) device.model = String(msg.model).slice(0, 60)
          save()
          send({ type: 'welcome', id: device.id })
        } else {
          return socket.close(4001, 'hello first')
        }
        clearTimeout(timer)
        // A second link from the same device replaces the first.
        live.get(me.id)?.socket.close(4000, 'replaced')
        live.set(me.id, { device: me, send, pending, socket })
        log(`${me.name} connected from ${req.socket.remoteAddress}`)
        return
      }
      if (msg.type === 'result' && pending.has(msg.id)) {
        const p = pending.get(msg.id)
        pending.delete(msg.id)
        clearTimeout(p.timer)
        if (msg.ok) p.resolve(msg.data)
        else p.reject(new Error(String(msg.error ?? 'the phone said no')))
      } else if (msg.type === 'notification') {
        const n = { device: me.name, app: String(msg.app ?? ''), title: String(msg.title ?? ''), text: String(msg.text ?? ''), at: now() }
        recent.push(n)
        if (recent.length > 100) recent.shift()
        onNotification?.(me, n)
      } else if (msg.type === 'ask' && typeof msg.text === 'string' && onAsk) {
        const id = msg.id
        onAsk(me, msg.text, (text, done) => send({ type: 'answer', id, text, done }))
      }
    })
    socket.on('close', () => {
      clearTimeout(timer)
      for (const p of pending.values()) {
        clearTimeout(p.timer)
        p.reject(new Error('the phone disconnected'))
      }
      if (me && live.get(me.id)?.socket === socket) {
        live.delete(me.id)
        log(`${me.name} disconnected`)
      }
    })
  }

  function handle(req, res) {
    const url = new URL(req.url, 'http://x')
    const setup = /^\/setup\/(\d{6})$/.exec(url.pathname)
    const valid = (code) => pairing && now() <= pairing.until && code === pairing.code
    if (setup && valid(setup[1])) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(setupPage({ code: setup[1], host: `${host()}:${port}` }))
    }
    if (url.pathname === '/gnosis.apk' && valid(url.searchParams.get('code')) && existsSync(apk)) {
      res.writeHead(200, { 'content-type': 'application/vnd.android.package-archive', 'content-length': statSync(apk).size,
        'content-disposition': 'attachment; filename="Gnosis.apk"' })
      return createReadStream(apk).pipe(res)
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('Nothing here. Ask Gnosis to set up your phone for a fresh link.')
  }

  return {
    start() {
      if (server) return
      server = http.createServer(handle)
      wss = new WebSocketServer({ server, path: '/link', maxPayload: 4 * 1024 * 1024 })
      wss.on('connection', attach)
      server.on('error', (err) => log(`devices: the link couldn't start on port ${port}: ${err.message}`))
      server.listen(port, '0.0.0.0', () => log(`devices: listening on ${host() ?? '?'}:${port} for paired devices`))
    },
    stop() {
      for (const l of live.values()) l.socket.close(1001, 'stopping')
      wss?.close()
      server?.close()
      server?.closeAllConnections()
      server = null
      wss = null
    },
    /** A fresh pairing code and the page the QR opens. */
    pair() {
      const p = newCode()
      const address = host()
      return { code: p.code, until: p.until, url: address ? `http://${address}:${port}/setup/${p.code}` : null,
        address: address ? `${address}:${port}` : null, apk: existsSync(apk) }
    },
    list: () => known.map(({ token, ...d }) => ({ ...d, online: live.has(d.id) })),
    forget(which) {
      const w = String(which).toLowerCase()
      const d = known.find((x) => x.id === which || x.name.toLowerCase().includes(w))
      if (!d) return null
      known = known.filter((x) => x !== d)
      save()
      live.get(d.id)?.socket.close(4003, 'forgotten')
      return d.name
    },
    /** The first connected Android device, or null. */
    phone: () => [...live.values()].find((l) => l.device.kind === 'android') ?? null,
    online: () => [...live.values()].map((l) => l.device.name),
    /** Asks a device to do something; resolves its data. */
    command(op, args = {}, { device = null, timeout = 20_000 } = {}) {
      const l = device ? live.get(device) : [...live.values()].find((x) => x.device.kind === 'android')
      if (!l) return Promise.reject(new Error("The Gnosis app on your phone isn't connected. Open it, or ask me to set up your phone."))
      const id = `c${++seq}`
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          l.pending.delete(id)
          reject(new Error('the phone took too long to answer'))
        }, timeout)
        l.pending.set(id, { resolve, reject, timer })
        l.send({ type: 'command', id, op, args })
      })
    },
    /** A reminder or a routine's answer, to every connected device. */
    notice(text) {
      for (const l of live.values()) l.send({ type: 'notice', text })
      return live.size
    },
    notifications: () => recent.slice(),
  }
}
