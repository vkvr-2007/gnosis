/** The owner's phone over ADB (bridge/phone.mjs), ported from Gnosis v1. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createPhone, findAdb, matchContacts, normalizeNumber, parseContacts, parseNotifications, parseUiDump, phoneServer, sh,
} from '../bridge/phone.mjs'
import { createGate } from '../bridge/gate.mjs'

const CONTACTS = [
  'Row: 0 display_name=Mom, data1=+91 98765 43210',
  'Row: 1 display_name=Asha Kumar, data1=99887 76655',
  'Row: 2 display_name=Asha Rao, data1=+91 90000 11111',
  'Row: 3 display_name=NULL, data1=123',
  'Row: 4 display_name=Bank, data1=not a number',
].join('\n')

/** A fake adb: a connected phone; records every command. */
function fakeAdb({ connected = true, ui = '<node text="Send" bounds="[900,1800][1000,1900]" />' } = {}) {
  const calls = []
  const run = async (args) => {
    calls.push(args.join(' '))
    if (args[0] === 'devices') return `List of devices attached\n${connected ? '192.168.1.5:40000\tdevice\n' : ''}`
    if (args[0] === 'connect') return connected ? `connected to ${args[1]}` : `failed to connect to ${args[1]}`
    if (args[0] === 'pair') return `Successfully paired to ${args[1]}`
    const cmd = args[1] ?? ''
    if (cmd.startsWith('dumpsys battery')) return 'AC powered: true\n  level: 76\n'
    if (cmd.startsWith('getprop')) return 'Pixel 8\n'
    if (cmd.startsWith('content query')) return CONTACTS
    if (cmd.startsWith('cat /sdcard/gnosis_ui.xml')) return `<?xml version="1.0"?><hierarchy>${ui}</hierarchy>`
    if (cmd.startsWith('pm list packages')) return 'package:com.whatsapp\npackage:com.zomato.app\n'
    return ''
  }
  return { run, calls }
}
const phoneWith = (adb) => createPhone({ run: adb.run, file: join(mkdtempSync(join(tmpdir(), 'gnosis-phone-')), 'phone.json'), sleep: async () => {} })

test('numbers, quoting, the screen, notifications and contacts are read as v1 read them', () => {
  assert.equal(normalizeNumber('+91 98765-43210'), '+919876543210')
  assert.throws(() => normalizeNumber('12'), /doesn't look like/)
  assert.equal(sh("it's"), `'it'\\''s'`)
  assert.deepEqual(parseUiDump('<node text="Send" content-desc="" resource-id="a:id/send" bounds="[0,0][100,50]" />'),
    [{ text: 'Send', desc: '', id: 'a:id/send', x: 50, y: 25 }])
  const dump = [
    'NotificationRecord(0x1: pkg=com.whatsapp user=UserHandle{0}', 'android.title=String (Asha)', 'android.text=String (are you coming?)',
    'NotificationRecord(0x2: pkg=com.whatsapp user=UserHandle{0}', 'android.title=String (Asha)', 'android.text=String (are you coming?)',
    'NotificationRecord(0x3: pkg=android', 'android.title=String (USB debugging)',
  ].join('\n')
  assert.deepEqual(parseNotifications(dump), [{ app: 'com.whatsapp', title: 'Asha', text: 'are you coming?' }])
  assert.deepEqual(parseContacts(CONTACTS).map((c) => c.name), ['Mom', 'Asha Kumar', 'Asha Rao'])
})

test('contacts: an exact name wins, words narrow it down, two matches are both returned', () => {
  const list = parseContacts(CONTACTS)
  assert.deepEqual(matchContacts(list, 'mom').map((c) => c.number), ['+919876543210'])
  assert.deepEqual(matchContacts(list, 'asha').map((c) => c.name), ['Asha Kumar', 'Asha Rao'])
  assert.deepEqual(matchContacts(list, 'asha r').map((c) => c.name), ['Asha Rao'])
  assert.deepEqual(matchContacts(list, 'dad'), [])
})

test('status, a call by contact name, and hanging up', async () => {
  const adb = fakeAdb()
  const p = phoneWith(adb)
  assert.deepEqual(await p.status(), { model: 'Pixel 8', battery: 76, charging: true })
  assert.equal(await p.call('Mom'), 'Calling Mom (+919876543210) on your phone.')
  assert.ok(adb.calls.includes("shell am start -a android.intent.action.CALL -d 'tel:+919876543210'"))
  await assert.rejects(p.call('asha'), /More than one contact matches "asha": Asha Kumar, Asha Rao/)
  assert.equal(await p.hangUp(), 'Hung up.')
})

test('WhatsApp: the chat opens with the text, Send is found on the screen and tapped', async () => {
  const adb = fakeAdb()
  const p = phoneWith(adb)
  assert.equal(await p.sendWhatsapp('Asha Kumar', "I'm on my way"), 'Sent the WhatsApp message to Asha Kumar (9988776655).')
  assert.ok(adb.calls.some((c) => c.includes("https://wa.me/919988776655?text=I'\\''m%20on%20my%20way")), adb.calls.join('\n'))
  assert.ok(adb.calls.includes('shell input tap 950 1850'))
})

test("no Send on the screen: says the message is waiting, never that it was sent", async () => {
  const p = createPhone({ run: fakeAdb({ ui: '' }).run, file: join(mkdtempSync(join(tmpdir(), 'gnosis-phone-')), 'p.json'), sleep: async () => {} })
  const said = await p.sendSms('+919876543210', 'hi')
  assert.match(said, /couldn't find Send\. It's waiting on your phone\./)
})

test('pairing, then connecting remembers the address; not connected says how to fix it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gnosis-phone-'))
  const adb = fakeAdb()
  const p = createPhone({ run: adb.run, file: join(dir, 'phone.json'), sleep: async () => {} })
  assert.match(await p.pair('192.168.1.5:37000', '123456'), /Successfully paired/)
  await p.connect('192.168.1.5:40000')
  assert.equal(JSON.parse(readFileSync(join(dir, 'phone.json'), 'utf8')).address, '192.168.1.5:40000')
  const off = createPhone({ run: fakeAdb({ connected: false }).run, file: join(dir, 'none.json') })
  await assert.rejects(off.status(), /No phone paired yet/)
  const none = createPhone({ run: null })
  await assert.rejects(async () => none.status(), /adb isn't installed/)
})

test('apps open by alias or by searching the installed packages', async () => {
  const adb = fakeAdb()
  const p = phoneWith(adb)
  await p.openApp('WhatsApp')
  await p.openApp('zomato')
  assert.ok(adb.calls.includes("shell monkey -p 'com.whatsapp' -c android.intent.category.LAUNCHER 1"))
  assert.ok(adb.calls.includes("shell monkey -p 'com.zomato.app' -c android.intent.category.LAUNCHER 1"))
  await assert.rejects(p.openApp('nonexistent thing'), /couldn't find an app/)
})

test('the tools: errors come back as a failed tool, not a crash', async () => {
  const tools = Object.fromEntries(phoneServer(phoneWith(fakeAdb({ connected: false }))).tools.map((t) => [t.name, t.handler]))
  const r = await tools.phone_status({})
  assert.equal(r.isError, true)
  assert.match(r.content[0].text, /^Phone: /)
})

test('the gate allows the phone, and asks the owner before a call or a message', () => {
  const gate = createGate({ allowWrites: false })
  assert.equal(gate.review('mcp__ayra_phone__phone_status').verdict, 'allow')
  assert.equal(gate.review('mcp__ayra_phone__phone_open_app', { name: 'maps' }).verdict, 'allow')
  const call = gate.review('mcp__ayra_phone__phone_call', { who: 'Mom' })
  assert.deepEqual([call.verdict, call.detail], ['ask', 'Call Mom'])
  const msg = gate.review('mcp__ayra_phone__phone_send_message', { who: 'Asha', text: 'late' })
  assert.deepEqual([msg.verdict, msg.detail], ['ask', 'WhatsApp to Asha: "late"'])
})

test('adb is found on PATH or in the Android SDK', () => {
  const sdk = join('C:/Users/x/AppData/Local', 'Android', 'Sdk', 'platform-tools', 'adb.exe')
  assert.equal(findAdb({ LOCALAPPDATA: 'C:/Users/x/AppData/Local', PATH: '' }, (p) => p === sdk), sdk)
  assert.equal(findAdb({ PATH: '' }, () => false), null)
})
