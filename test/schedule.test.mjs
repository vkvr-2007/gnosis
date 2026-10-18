/** Reminders, routines, the briefing and the watchers (bridge/schedule.mjs), ported from Gnosis v1. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createJobStore, createNotifier, createWatchers, inWindow, nextAfter, parseWhen, scheduleServer, setBriefing, startSchedule,
} from '../bridge/schedule.mjs'
import { createGate } from '../bridge/gate.mjs'

const at = (y, mo, d, h, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime()
const freshStore = () => createJobStore(join(mkdtempSync(join(tmpdir(), 'gnosis-sched-')), 'schedule.json'))

test('times: in N minutes, the next HH:MM (today or tomorrow), am/pm, and a local date-time', () => {
  const now = at(2026, 10, 18, 14, 30)
  assert.equal(parseWhen(null, 20, now), now + 20 * 60_000)
  assert.equal(parseWhen('18:00', null, now), at(2026, 10, 18, 18))
  assert.equal(parseWhen('09:00', null, now), at(2026, 10, 19, 9)) // already passed today
  assert.equal(parseWhen('7:15 pm', null, now), at(2026, 10, 18, 19, 15))
  assert.equal(parseWhen('2026-10-20T08:45', null, now), at(2026, 10, 20, 8, 45))
  assert.throws(() => parseWhen(null, 0, now), /more than 0/)
  assert.throws(() => parseWhen('', null, now), /Say when/)
})

test('repeats keep the time of day; weekdays skip the weekend', () => {
  const fri = at(2026, 10, 16, 9) // a Friday
  assert.equal(nextAfter({ next: fri, repeat: 'daily' }, fri), at(2026, 10, 17, 9))
  assert.equal(nextAfter({ next: fri, repeat: 'weekdays' }, fri), at(2026, 10, 19, 9)) // Monday
  assert.equal(nextAfter({ next: fri, repeat: 'minutes', every: 30 }, fri), fri + 30 * 60_000)
  assert.equal(nextAfter({ next: fri, repeat: 'once' }, fri), null)
  // Missed several runs (the laptop was off): the next one still comes after now.
  assert.equal(nextAfter({ next: fri, repeat: 'daily' }, at(2026, 10, 19, 10)), at(2026, 10, 20, 9))
})

test('the store: add, due, a one-off goes when fired, a daily one moves on, cancel and find', () => {
  const s = freshStore()
  const now = at(2026, 10, 18, 9)
  const a = s.add({ kind: 'reminder', text: 'stretch', next: now })
  const b = s.add({ kind: 'reminder', text: 'drink water', next: now, repeat: 'daily' })
  assert.deepEqual(s.due(now).map((j) => j.id), [a.id, b.id])
  s.fired(a.id, now)
  s.fired(b.id, now)
  assert.deepEqual(s.upcoming().map((j) => [j.text, j.next]), [['drink water', at(2026, 10, 19, 9)]])
  assert.equal(s.find('the water reminder').id, b.id)
  assert.equal(s.find(`#${b.id}`).id, b.id)
  assert.equal(s.cancel(b.id), true)
  assert.equal(s.upcoming().length, 0)
})

test('the briefing is one daily job, replaced when its time changes and removable', () => {
  const s = freshStore()
  setBriefing(s, '08:00')
  setBriefing(s, '07:30')
  const jobs = s.upcoming()
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].kind, 'briefing')
  assert.equal(new Date(jobs[0].next).getHours() * 60 + new Date(jobs[0].next).getMinutes(), 7 * 60 + 30)
  setBriefing(s, null)
  assert.equal(s.upcoming().length, 0)
})

test('the notifier: urgent always speaks; quiet hours and do-not-disturb hold the ordinary ones back', async () => {
  let clock = at(2026, 10, 18, 12)
  const toasts = []
  const spoken = []
  const n = createNotifier({ now: () => clock, toast: async (t, b) => (toasts.push(t), true), speak: (b) => (spoken.push(b), true) })
  assert.deepEqual(await n.notify({ title: 'Reminder', body: 'stretch', urgency: 'high' }), ['toast', 'speak'])
  assert.deepEqual(await n.notify({ title: 'Disk', body: 'full' }), ['toast'])
  n.doNotDisturb(30)
  assert.deepEqual(await n.notify({ title: 'Reminder', body: 'call mom', urgency: 'high' }), ['toast'])
  assert.deepEqual(await n.notify({ title: 'Disk', body: 'still full' }), [])
  assert.deepEqual(await n.notify({ title: 'Battery very low', body: '8%', urgency: 'urgent' }), ['toast', 'speak'])
  assert.deepEqual(n.takePending().map((p) => p.body), ['still full'])
  assert.deepEqual(n.takePending(), [])
  n.doNotDisturb(0)
  clock = at(2026, 10, 18, 23, 30) // quiet hours
  assert.deepEqual(await n.notify({ title: 'Disk', body: 'night' }), [])
  assert.deepEqual(spoken, ['stretch', '8%'])
  assert.equal(inWindow('23:00-07:00', new Date(at(2026, 10, 19, 6, 59))), true)
  assert.equal(inWindow('23:00-07:00', new Date(at(2026, 10, 19, 7))), false)
})

test('ordinary notices are capped at four an hour', async () => {
  const n = createNotifier({ now: () => at(2026, 10, 18, 12), toast: async () => true })
  const got = []
  for (let i = 0; i < 6; i++) got.push((await n.notify({ title: 't', body: `${i}` })).length)
  assert.deepEqual(got, [1, 1, 1, 1, 0, 0])
})

test('battery: warned at 20 and 10 percent while unplugged, once each, and again after charging', async () => {
  const told = []
  const notifier = { notify: async (x) => told.push(x.title) }
  let reading = { percent: 30, plugged: false }
  const w = createWatchers({ notifier, battery: async () => reading, disk: () => 50 })
  for (const [percent, plugged] of [[19, false], [18, false], [9, false], [8, false], [80, true], [19, false]]) {
    reading = { percent, plugged }
    await w.check()
  }
  assert.deepEqual(told, ['Battery low', 'Battery very low', 'Battery low'])
  assert.deepEqual(w.state.battery, { percent: 19, plugged: false })
})

test('a due reminder is told; a due routine runs as a request and its answer is told', async () => {
  const s = freshStore()
  const now = Date.now()
  s.add({ kind: 'reminder', text: 'stretch', next: now - 1000 })
  s.add({ kind: 'routine', text: "what's the weather?", next: now - 1000 })
  const told = []
  const notifier = { notify: async (x) => told.push([x.title, x.body]) }
  const asked = []
  const run = startSchedule({ store: s, notifier, watchers: null, every: 60_000,
    runRequest: async (text) => (asked.push(text), 'Sunny, 31 degrees.') })
  await run.tick()
  run.stop()
  await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(asked, ["what's the weather?"])
  assert.deepEqual(told, [['Reminder', 'stretch'], ['Routine finished', 'Sunny, 31 degrees.']])
  assert.equal(s.upcoming().length, 0)
})

test('the tools: set, list, cancel, do-not-disturb, briefing', async () => {
  const s = freshStore()
  const notifier = createNotifier({ toast: async () => true })
  const tools = Object.fromEntries(scheduleServer({ store: s, notifier, watchers: null }).tools.map((t) => [t.name, t.handler]))
  const said = async (name, args = {}) => (await tools[name](args)).content[0].text
  assert.match(await said('set_reminder', { text: 'stretch', in_minutes: 20 }), /^Scheduled #1 reminder: "stretch"/)
  assert.match(await said('schedule_routine', { goal: 'check the weather', at: '07:00', repeat: 'weekdays' }), /routine.*weekdays/)
  assert.match(await said('list_reminders'), /stretch[\s\S]*check the weather/)
  assert.match(await said('cancel_reminder', { which: 'stretch' }), /^Cancelled #1/)
  assert.match(await said('do_not_disturb', { minutes: 30 }), /^Do not disturb until \d\d:\d\d/)
  assert.match(await said('briefing'), /Coming up today:[\s\S]*Held back while you were busy: nothing/)
  assert.match(await said('set_reminder', { text: 'x', at: 'whenever' }), /couldn't read the time/)
})

test("the gate lets Gnosis's schedule tools run", () => {
  const gate = createGate({ allowWrites: false })
  for (const t of ['set_reminder', 'cancel_reminder', 'schedule_routine', 'briefing']) {
    assert.equal(gate.decide(`mcp__ayra_schedule__${t}`), true, t)
  }
})

test('a check with nothing due never stops later checks (the reminder that never fired)', async () => {
  const s = freshStore()
  const told = []
  const run = startSchedule({ store: s, notifier: { notify: async (x) => told.push(x.body) }, watchers: null, every: 60_000, runRequest: async () => '' })
  await run.tick() // nothing due: this used to leave the scheduler stuck
  s.add({ kind: 'reminder', text: 'stretch', next: Date.now() - 1000 })
  await run.tick()
  run.stop()
  assert.deepEqual(told, ['stretch'])
})
