// Unit tests for bridge/apps.mjs — what her Windows-app tools send, show and ask. `npm test`
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import {
  appsTools, createWorker, describeChanges, fieldOf, formatRead, formatWindows, toSendKeys,
} from '../bridge/apps.mjs'

test('after an action she hears what changed, or the whole window when its controls changed', () => {
  const window = { id: 1, title: 'Calculator', app: 'ApplicationFrameHost' }
  const before = [{ text: 'Display is 0' }, { ref: 1, type: 'button', name: 'Seven' }, { ref: 2, type: 'edit', name: 'Memo', value: '' }]
  const same = describeChanges(before, {
    window,
    items: [{ text: 'Display is 84' }, { ref: 1, type: 'button', name: 'Seven' }, { ref: 2, type: 'edit', name: 'Memo', value: 'hi' }],
  })
  assert.match(same, /refs are the same/)
  assert.match(same, /Display is 84/)
  assert.match(same, /\[2\] edit "Memo": "hi"/)
  assert.doesNotMatch(same, /Seven/)
  assert.match(describeChanges(before, { window, items: before }), /Nothing in the window changed/)
  const dialog = describeChanges(before, { window, items: [{ ref: 1, type: 'button', name: "Don't save" }] })
  assert.match(dialog, /refs renumbered/)
  assert.match(dialog, /\[1\] button "Don't save"/)
})

test('keys become the SendKeys form, and unknown keys are refused rather than guessed', () => {
  assert.equal(toSendKeys('ctrl+s'), '^s')
  assert.equal(toSendKeys('alt+f4'), '%{F4}')
  assert.equal(toSendKeys('down down enter'), '{DOWN}{DOWN}{ENTER}')
  assert.equal(toSendKeys('ctrl+shift+t'), '^+t')
  assert.equal(toSendKeys('shift+9'), '+9')
  assert.equal(toSendKeys('{'), '{{}')
  for (const bad of ['', 'win+d', 'hyper+x', 'ctrl+foo']) assert.throws(() => toSendKeys(bad), bad)
})

test('a box is a password, a search or plain text', () => {
  assert.equal(fieldOf({ password: true, name: 'Search' }), 'password')
  assert.equal(fieldOf({ name: 'Search Settings' }), 'search')
  assert.equal(fieldOf({ name: '', aid: 'SearchBox' }), 'search')
  assert.equal(fieldOf({ name: 'Message' }), 'text')
})

test('a window reads as text and numbered controls, with key-shaped text blanked', () => {
  const out = formatRead({
    window: { id: 42, title: 'Untitled - Notepad', app: 'Notepad' },
    items: [
      { text: 'Hello' },
      { ref: 1, type: 'button', name: 'Save' },
      { ref: 2, type: 'check box', name: 'Wrap', state: 'on' },
      { ref: 3, type: 'edit', name: 'Key', value: 'sk_0123456789abcdef0123456789abcdef' },
      { ref: 4, type: 'edit', name: 'Password', password: true },
    ],
  })
  assert.match(out, /^Window 42 · "Untitled - Notepad" \(Notepad\)/)
  assert.match(out, /\[1\] button "Save"/)
  assert.match(out, /\[2\] check box "Wrap" \(on\)/)
  assert.match(out, /\[4\] edit "Password" \(password box\)/)
  assert.doesNotMatch(out, /sk_0123/)
  assert.match(formatRead({ window: { id: 1, title: 't', app: 'a' }, items: [{ text: 'x'.repeat(50) }] }, 10), /and more not shown/)
  assert.equal(formatWindows([]), 'No windows are open.')
  assert.match(formatWindows([{ id: 7, title: 'Calculator', app: 'ApplicationFrameHost', minimized: true }]), /7 · Calculator .*minimised/)
})

/** A worker that answers from a script of replies and records what it was sent. */
function fakeApps(replies) {
  const sent = []
  return {
    sent,
    call: async (op, args = {}) => {
      sent.push({ op, ...args })
      const r = replies[op]
      if (r instanceof Error) throw r
      return typeof r === 'function' ? r(args) : r
    },
  }
}

const NOTEPAD = { id: 9, title: 'notes.txt - Notepad', app: 'Notepad' }
const handler = (tools, name) => tools.find((t) => t.name === name).handler

test('a click on a "Delete" button waits for the owner, and a no leaves it unpressed', async () => {
  const apps = fakeApps({
    read: { window: NOTEPAD, items: [{ ref: 1, type: 'button', name: 'Delete' }, { ref: 2, type: 'button', name: 'Open' }] },
    click: { how: 'invoke', waiting: false },
  })
  const asked = []
  const tools = appsTools({ allowWrites: true, channel: 'hud', apps, approve: async (r) => (asked.push(r), false) })
  await handler(tools, 'apps_read')({ window: 9 })
  const res = await handler(tools, 'apps_click')({ refs: [1] })
  assert.equal(res.isError, true)
  assert.equal(asked.length, 1)
  assert.equal(asked[0].reason, 'deletes something for good')
  assert.match(asked[0].detail, /Click "Delete" — in "notes.txt - Notepad"/)
  assert.equal(apps.sent.some((s) => s.op === 'click'), false)

  // An ordinary button just goes.
  const ok = await handler(tools, 'apps_click')({ refs: [2] })
  assert.equal(ok.isError, undefined)
  assert.equal(asked.length, 1)
  assert.deepEqual(apps.sent.filter((s) => s.op === 'click').at(-1), { op: 'click', ref: 2 })
  // …and she hears what the click changed without asking.
  assert.deepEqual(apps.sent.at(-1), { op: 'read', window: '9' })
  assert.match(ok.content[0].text, /Nothing in the window changed/)

  // Several in one go: pressed in order, and stopped at the first no.
  const batch = await handler(tools, 'apps_click')({ refs: [2, 1, 2] })
  assert.equal(batch.isError, true)
  assert.match(batch.content[0].text, /pressed first: "Open"/)
  assert.deepEqual(apps.sent.filter((s) => s.op === 'click').map((s) => s.ref), [2, 2])
})

test('Enter in a message box asks; Enter in a search box and Ctrl+S do not', async () => {
  let focused = { name: 'Type a message', type: 'edit', window: { id: 3, title: 'Chat', app: 'Teams' } }
  const apps = fakeApps({ focused: () => focused, keys: { done: true }, focus: { window: NOTEPAD } })
  const asked = []
  const tools = appsTools({ allowWrites: true, channel: 'hud', apps, approve: async (r) => (asked.push(r), false) })
  const press = handler(tools, 'apps_press')
  assert.equal((await press({ keys: 'enter' })).isError, true)
  assert.equal(asked.at(-1).reason, 'sends or posts something as you')
  assert.equal((await press({ keys: 'ctrl+enter' })).isError, true)
  assert.equal(apps.sent.some((s) => s.op === 'keys'), false)

  assert.equal((await press({ keys: 'ctrl+s' })).isError, undefined)
  focused = { name: 'Search', type: 'edit', window: { id: 4, title: 'File Explorer', app: 'explorer' } }
  assert.equal((await press({ keys: 'enter' })).isError, undefined)
  assert.equal(asked.length, 2)
  assert.deepEqual(apps.sent.filter((s) => s.op === 'keys').map((s) => s.keys), ['^s', '{ENTER}'])
})

test('a window showing a secrets file is not read, and its text never reaches the model', async () => {
  const apps = fakeApps({
    read: { window: { id: 5, title: '.env.local - Notepad', app: 'Notepad' }, items: [{ ref: 1, type: 'document', value: 'AYRA_X=1' }] },
  })
  const tools = appsTools({ allowWrites: true, channel: 'hud', apps, approve: async () => true })
  const res = await handler(tools, 'apps_read')({ window: 5 })
  assert.equal(res.isError, true)
  assert.doesNotMatch(res.content[0].text, /AYRA_X/)
  // …and with no read on record, nothing in it can be clicked either.
  assert.equal((await handler(tools, 'apps_click')({ refs: [1] })).isError, true)
})

test('with a secrets file in front, only a new tab or another tab can be pressed', async () => {
  const secret = { id: 5, title: '.env.local - Notepad', app: 'Notepad' }
  const apps = fakeApps({ focused: { name: 'Text editor', type: 'document', window: secret }, keys: { done: true }, read: new Error('gone') })
  const tools = appsTools({ allowWrites: true, channel: 'hud', apps, approve: async () => true })
  const press = handler(tools, 'apps_press')
  assert.equal((await press({ keys: 'ctrl+a' })).isError, true)
  assert.equal((await press({ keys: 'delete' })).isError, true)
  assert.equal((await press({ keys: 'ctrl+n' })).isError, undefined)
  assert.deepEqual(apps.sent.filter((s) => s.op === 'keys').map((s) => s.keys), ['^n'])
  assert.equal((await handler(tools, 'apps_type')({ text: 'x' })).isError, true)
  assert.equal(apps.sent.some((s) => s.op === 'type'), false)
})

test('without writes only the reading tools exist', () => {
  const names = appsTools({ allowWrites: false, channel: 'hud', approve: async () => false }).map((t) => t.name)
  assert.deepEqual(names, ['apps_list', 'apps_screenshot', 'apps_read'])
})

test('the worker answers by id, and a stuck request restarts it', async () => {
  const procs = []
  const spawnWorker = () => {
    const proc = new EventEmitter()
    proc.stdin = new PassThrough()
    proc.stdout = new PassThrough()
    proc.stderr = new PassThrough()
    proc.kill = () => proc.emit('exit')
    proc.stdin.on('data', (line) => {
      const req = JSON.parse(line)
      if (req.op === 'hang') return
      proc.stdout.write(`noise\n${JSON.stringify({ id: req.id, ok: req.op !== 'bad', data: { op: req.op }, error: 'no such window' })}\n`)
    })
    procs.push(proc)
    return proc
  }
  const w = createWorker({ spawnWorker, idleMs: 10 })
  assert.deepEqual(await w.call('list'), { op: 'list' })
  await assert.rejects(w.call('bad'), /no such window/)
  await assert.rejects(w.call('hang', {}, 50), /took too long/)
  assert.deepEqual(await w.call('list'), { op: 'list' })
  assert.equal(procs.length, 2)
  w.stop()
})

test("her own window can't be read, typed in, pressed in or closed", async () => {
  const own = { id: 7, title: 'G.N.O.S.I.S.', app: 'chrome' }
  const apps = fakeApps({
    read: { window: own, items: [{ ref: 1, type: 'button', name: 'Yes' }] },
    focused: { name: '', type: 'document', window: own },
    describe: { window: own },
    keys: { done: true },
    type: { how: 'keys' },
    close: { window: own, waiting: false },
  })
  const tools = appsTools({ allowWrites: true, channel: 'hud', apps, approve: async () => true })
  assert.equal((await handler(tools, 'apps_read')({ window: 7 })).isError, true)
  assert.equal((await handler(tools, 'apps_click')({ refs: [1] })).isError, true)
  assert.equal((await handler(tools, 'apps_press')({ keys: 'y' })).isError, true)
  assert.equal((await handler(tools, 'apps_type')({ text: 'y' })).isError, true)
  assert.equal((await handler(tools, 'apps_close')({ window: 'A.Y.R.A.' })).isError, true)
  assert.equal(apps.sent.some((s) => ['click', 'keys', 'type', 'close'].includes(s.op)), false)
})


test('"show me": a window goes to the HUD and the phone, but never one of secrets', async () => {
  const shown = []
  const sent = []
  const apps = fakeApps({
    describe: ({ window }) => ({ window: window === 'env' ? { id: 5, title: '.env.local - Notepad', app: 'Notepad' } : NOTEPAD }),
    shot: { window: NOTEPAD, jpeg: 'AAAA' },
  })
  const tools = appsTools({
    allowWrites: false, channel: 'telegram', apps, approve: async () => false,
    emitBlade: (b) => shown.push(b), sendPhoto: async (jpeg, caption) => (sent.push({ jpeg, caption }), true),
  })
  const res = await handler(tools, 'apps_screenshot')({ window: 'notes', toOwner: true })
  assert.equal(res.content[0].type, 'image')
  assert.match(res.content[1].text, /Sent to the owner's phone/)
  assert.equal(shown[0].url, 'data:image/jpeg;base64,AAAA')
  assert.deepEqual(sent, [{ jpeg: 'AAAA', caption: 'notes.txt - Notepad (Notepad)' }])
  // Not asked to: the HUD only.
  await handler(tools, 'apps_screenshot')({ window: 'notes' })
  assert.equal(sent.length, 1)
  assert.equal((await handler(tools, 'apps_screenshot')({ window: 'env' })).isError, true)
  assert.equal(apps.sent.filter((s) => s.op === 'shot').length, 2)
})

test('a window whose words show a key is not pictured either', async () => {
  const apps = fakeApps({
    describe: { window: NOTEPAD },
    read: { window: NOTEPAD, items: [{ text: 'ELEVENLABS_API_KEY=sk_0123456789abcdef0123456789abcdef' }] },
    shot: { window: NOTEPAD, jpeg: 'AAAA' },
  })
  const tools = appsTools({ allowWrites: false, channel: 'hud', apps, approve: async () => false })
  assert.equal((await handler(tools, 'apps_screenshot')({ window: 'notes' })).isError, true)
  assert.equal(apps.sent.some((s) => s.op === 'shot'), false)
})

test("at the laptop the phone isn't offered, and a picture asked for there says it stayed on the HUD", async () => {
  const apps = fakeApps({ describe: { window: NOTEPAD }, shot: { window: NOTEPAD, jpeg: 'AAAA' } })
  const tools = appsTools({ allowWrites: false, channel: 'hud', apps, approve: async () => false, emitBlade: () => {} })
  assert.doesNotMatch(tools.find((t) => t.name === 'apps_screenshot').description, /phone/)
  const res = await handler(tools, 'apps_screenshot')({ window: 'notes', toOwner: true })
  assert.match(res.content[1].text, /HUD only/)
})

test('"Always" is offered only for a plainly sending click in an ordinary program', async () => {
  const asked = []
  const approve = async (r) => (asked.push(r), false)
  const run = async (win, label, how = 'click') => {
    const apps = fakeApps({
      read: { window: win, items: [{ ref: 1, type: 'button', name: label }] },
      focused: { name: label, type: 'edit', window: win },
    })
    const tools = appsTools({ allowWrites: true, channel: 'hud', apps, approve })
    await handler(tools, 'apps_read')({ window: win.id })
    if (how === 'click') await handler(tools, 'apps_click')({ refs: [1] })
    else await handler(tools, 'apps_press')({ keys: 'enter' })
    return asked.at(-1).scope
  }
  const teams = { id: 3, title: 'Chat', app: 'ms-teams' }
  assert.deepEqual(await run(teams, 'Send'), { kind: 'app', where: 'ms-teams' })
  assert.equal(await run(teams, 'Submit'), null, 'a generic submit')
  assert.equal(await run(teams, 'Type a message', 'enter'), null, 'an Enter')
  assert.equal(await run({ id: 4, title: 'Gmail - Google Chrome', app: 'chrome' }, 'Send'), null, 'a whole browser')
})
