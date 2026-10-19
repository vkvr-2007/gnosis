/** The owner's devices over Wi-Fi (bridge/devices.mjs) and the phone through the Gnosis app. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { createDeviceHub, lanAddress, setupPage } from '../bridge/devices.mjs'
import { createAppPhone, createPhoneRouter } from '../bridge/phone.mjs'
import { createGate } from '../bridge/gate.mjs'

let nextPort = 18790
const freshHub = (opts = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'gnosis-dev-'))
  const apk = join(dir, 'app.apk')
  writeFileSync(apk, 'APK')
  const port = nextPort++
  const hub = createDeviceHub({ port, file: join(dir, 'devices.json'), apk, host: () => '127.0.0.1', log: () => {}, ...opts })
  hub.start()
  return { hub, port, dir }
}
const until = (fn) => new Promise((resolve) => {
  const t = setInterval(() => {
    if (fn()) {
      clearInterval(t)
      resolve()
    }
  }, 10)
})

/** A fake phone app: connects, pairs or says hello, answers commands with `handlers`. */
async function phoneApp(port, first, handlers = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/link`)
  const got = []
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw))
    got.push(m)
    if (m.type === 'command') {
      const h = handlers[m.op]
      Promise.resolve().then(() => (h ? h(m.args) : null)).then(
        (data) => ws.send(JSON.stringify({ type: 'result', id: m.id, ok: true, data })),
        (err) => ws.send(JSON.stringify({ type: 'result', id: m.id, ok: false, error: err.message })))
    }
  })
  await new Promise((r) => ws.on('open', r))
  ws.send(JSON.stringify(first))
  await until(() => got.some((m) => ['paired', 'welcome', 'denied'].includes(m.type)))
  return { ws, got }
}

test('the laptop is found on the home network, not on a virtual adapter', () => {
  assert.equal(lanAddress({
    'vEthernet (WSL)': [{ family: 'IPv4', internal: false, address: '172.20.0.1' }],
    'Wi-Fi': [{ family: 'IPv4', internal: false, address: '192.168.1.5' }],
    Loopback: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
  }), '192.168.1.5')
  assert.equal(lanAddress({}), null)
  assert.match(setupPage({ code: '123456', host: '192.168.1.5:8790' }), /gnosis:\/\/pair\?host=192\.168\.1\.5%3A8790&code=123456/)
})

test('pairing: a fresh code gives the app its own key, kept only as a hash; the code works once', async () => {
  const { hub, port, dir } = freshHub()
  const { code } = hub.pair()
  const a = await phoneApp(port, { type: 'pair', code, name: 'Pixel', model: 'Google Pixel 8' })
  const paired = a.got.find((m) => m.type === 'paired')
  assert.match(paired.token, /^[0-9a-f]{64}$/)
  const saved = readFileSync(join(dir, 'devices.json'), 'utf8')
  assert.ok(!saved.includes(paired.token), 'the key itself is never stored')
  assert.deepEqual(hub.list().map((d) => [d.name, d.online]), [['Pixel', true]])
  const again = await phoneApp(port, { type: 'pair', code, name: 'Other' })
  assert.equal(again.got.at(-1).type, 'denied')
  a.ws.close()
  // Later: hello with the key.
  const b = await phoneApp(port, { type: 'hello', token: paired.token })
  assert.equal(b.got.at(-1).type, 'welcome')
  b.ws.close()
  hub.stop()
})

test('a wrong key, or five wrong codes, gets nowhere', async () => {
  const { hub, port } = freshHub()
  const bad = await phoneApp(port, { type: 'hello', token: 'f'.repeat(64) })
  assert.equal(bad.got.at(-1).type, 'denied')
  const { code } = hub.pair()
  for (let i = 0; i < 5; i++) await phoneApp(port, { type: 'pair', code: '000000' === code ? '111111' : '000000' })
  const late = await phoneApp(port, { type: 'pair', code })
  assert.equal(late.got.at(-1).type, 'denied', 'the code is spent after five wrong tries')
  hub.stop()
})

test('the setup page and the app download only while the code is valid', async () => {
  const { hub, port } = freshHub()
  assert.equal((await fetch(`http://127.0.0.1:${port}/gnosis.apk?code=123456`)).status, 404)
  const { code, url } = hub.pair()
  assert.equal(url, `http://127.0.0.1:${port}/setup/${code}`)
  const page = await fetch(url)
  assert.equal(page.status, 200)
  assert.match(await page.text(), /Download the Gnosis app/)
  const apk = await fetch(`http://127.0.0.1:${port}/gnosis.apk?code=${code}`)
  assert.equal(apk.headers.get('content-type'), 'application/vnd.android.package-archive')
  assert.equal(await apk.text(), 'APK')
  hub.stop()
})

test('commands reach the app and come back; the phone through the app matches contacts on the laptop', async () => {
  const { hub, port } = freshHub()
  const { code } = hub.pair()
  const calls = []
  const app = await phoneApp(port, { type: 'pair', code, name: 'Pixel' }, {
    status: () => ({ model: 'Google Pixel 8', battery: 64, charging: false }),
    contacts: () => [{ name: 'Mom', number: '+91 98765 43210' }, { name: 'Asha Rao', number: '90000 11111' }],
    call: (a) => (calls.push(a), { calling: a.number }),
    whatsapp: (a) => (calls.push(a), { sent: true }),
    open_app: () => { throw new Error('There\'s no app called "zzz" on the phone.') },
  })
  const phone = createAppPhone(hub)
  assert.deepEqual(await phone.status(), { model: 'Google Pixel 8', battery: 64, charging: false })
  assert.equal(await phone.call('mom'), 'Calling Mom (+919876543210) on your phone.')
  assert.equal(await phone.sendWhatsapp('Asha', 'late'), 'Sent the WhatsApp message to Asha Rao (9000011111).')
  assert.deepEqual(calls, [{ number: '+919876543210' }, { number: '919000011111', text: 'late' }])
  await assert.rejects(phone.openApp('zzz'), /no app called "zzz"/)
  app.ws.close()
  await until(() => !hub.phone())
  await assert.rejects(phone.status(), /isn't connected/)
  hub.stop()
})

test('the phone tools use the app when it is connected, ADB otherwise', async () => {
  const app = { connected: () => true, status: async () => 'app' }
  const adb = { status: async () => 'adb', pair: async () => 'paired' }
  assert.equal(await createPhoneRouter({ app, adb }).status(), 'app')
  app.connected = () => false
  assert.equal(await createPhoneRouter({ app, adb }).status(), 'adb')
})

test('a question from the phone is answered back to it; notices reach it', async () => {
  const { hub, port } = freshHub({ onAsk: (d, text, reply) => reply(`You asked: ${text}`, true) })
  const { code } = hub.pair()
  const app = await phoneApp(port, { type: 'pair', code, name: 'Pixel' })
  app.ws.send(JSON.stringify({ type: 'ask', id: 'a1', text: 'hello' }))
  await until(() => app.got.some((m) => m.type === 'answer'))
  assert.deepEqual(app.got.find((m) => m.type === 'answer'), { type: 'answer', id: 'a1', text: 'You asked: hello', done: true })
  assert.equal(hub.notice('Reminder: stretch'), 1)
  await until(() => app.got.some((m) => m.type === 'notice'))
  app.ws.close()
  hub.stop()
})

test('forgetting a device ends its key; the gate asks first', async () => {
  const { hub, port } = freshHub()
  const { code } = hub.pair()
  const a = await phoneApp(port, { type: 'pair', code, name: 'Pixel' })
  const token = a.got.find((m) => m.type === 'paired').token
  assert.equal(hub.forget('pixel'), 'Pixel')
  const b = await phoneApp(port, { type: 'hello', token })
  assert.equal(b.got.at(-1).type, 'denied')
  hub.stop()
  const gate = createGate({ allowWrites: false })
  assert.equal(gate.review('mcp__ayra_phone__forget_device', { which: 'Pixel' }).verdict, 'ask')
  assert.equal(gate.review('mcp__ayra_phone__set_up_phone').verdict, 'allow')
})
